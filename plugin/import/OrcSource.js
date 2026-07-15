'use strict'

const fs = require('fs')
const path = require('path')

const ACTIVE_CERTIFICATES_URL = 'https://data.orc.org/public/WPub.dll?action=activecerts'
const CERTIFICATE_URL_PREFIX = 'https://data.orc.org/public/WPub.dll/CC/'
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_STATUS_TIMEOUT_MS = 2000
const MAX_SEARCH_RESULTS = 100
const KNOT_TO_MPS = 0.514444
const DEG_TO_RAD = Math.PI / 180

function sourceError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function normalize(value) {
  return String(value || '').trim().toLowerCase()
}

function parseNumber(value) {
  const number = Number.parseFloat(String(value || '').replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(number) ? number : null
}

function parseYearText(value) {
  const match = String(value || '').match(/(19|20)\d{2}/)
  if (!match) return undefined
  const year = Number.parseInt(match[0], 10)
  return Number.isInteger(year) ? year : undefined
}

function parseXmlRows(xmlText) {
  const rows = []
  const rowMatches = xmlText.matchAll(/<ROW\b[^>]*>([\s\S]*?)<\/ROW>/g)
  for (const rowMatch of rowMatches) {
    const body = rowMatch[1]
    const row = {}
    for (const fieldMatch of body.matchAll(/<([A-Za-z0-9_:-]+)>([\s\S]*?)<\/\1>/g)) {
      row[fieldMatch[1]] = decodeEntities(fieldMatch[2]).trim()
    }
    rows.push(row)
  }
  return rows
}

function parseTableRows(tableHtml) {
  return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(match => {
    const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map(cellMatch => stripTags(cellMatch[1]))
    return cells.filter(cell => cell.length > 0)
  }).filter(cells => cells.length > 0)
}

function matrixFromAngleRows(angleRows, twsCount) {
  return Array.from({ length: twsCount }, (_unused, twsIndex) => angleRows.map(row => row.values[twsIndex]))
}

function createDerivedRows(twsValues, twaValues, speedMatrix, beatAngles, beatVmgs, runAngles, runVmgs) {
  return {
    rows: twsValues.map((tws, index) => {
      const speedRow = speedMatrix[index]
      const maxSpeed = Math.max(...speedRow)
      const maxSpeedAngle = twaValues[speedRow.indexOf(maxSpeed)]
      const beatAngle = beatAngles[index]
      const beatVmg = beatVmgs[index]
      const runAngle = runAngles[index]
      const runVmg = runVmgs[index]

      const beat = Number.isFinite(beatAngle) && Number.isFinite(beatVmg)
        ? {
            twa: beatAngle,
            tbs: beatVmg / Math.abs(Math.cos(beatAngle)),
            vmg: beatVmg
          }
        : null

      const run = Number.isFinite(runAngle) && Number.isFinite(runVmg)
        ? {
            twa: runAngle,
            tbs: runVmg / Math.abs(Math.cos(runAngle)),
            vmg: runVmg
          }
        : null

      return {
        tws,
        ...(beat ? { beat } : {}),
        ...(run ? { run } : {}),
        maxSpeed,
        maxSpeedAngle
      }
    })
  }
}

function extractFieldText(htmlText, fieldId) {
  const pattern = new RegExp(`<span class="data"[^>]*id="${fieldId}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i')
  const match = htmlText.match(pattern)
  return match ? stripTags(match[1]) : ''
}

function extractCertificateYear(htmlText, fallbackYear) {
  const seriesYear = parseYearText(extractFieldText(htmlText, 'field_Series_VPP'))
  if (Number.isInteger(seriesYear)) return seriesYear
  const ageYear = parseYearText(extractFieldText(htmlText, 'field_AgeDt'))
  if (Number.isInteger(ageYear)) return ageYear
  return Number.isInteger(fallbackYear) ? fallbackYear : undefined
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(sourceError(503, message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

class OrcSource {
  constructor({
    dataDir,
    fetcher,
    now = () => Date.now(),
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    statusTimeoutMs = DEFAULT_STATUS_TIMEOUT_MS
  } = {}) {
    this.fetcher = typeof fetcher === 'function'
      ? fetcher
      : (...args) => {
          if (typeof globalThis.fetch !== 'function') {
            throw new Error('A fetch implementation is required for ORC source imports')
          }
          return globalThis.fetch(...args)
        }

    if (typeof this.fetcher !== 'function') {
      throw new Error('A fetch implementation is required for ORC source imports')
    }

    this.id = 'orc'
    this.name = 'ORC Active Certificates'
    this.defaultSource = 'orc'
    this.now = now
    this.cacheTtlMs = cacheTtlMs
    this.statusTimeoutMs = statusTimeoutMs
    this.cacheDir = path.join(dataDir, 'import-cache')
    this.activeCachePath = path.join(this.cacheDir, 'orc-activecerts.json')
    ensureDir(this.cacheDir)
  }

  descriptor() {
    return {
      id: this.id,
      name: this.name,
      description: 'Official ORC active certificates and certificate pages',
      url: ACTIVE_CERTIFICATES_URL
    }
  }

  async getStatus() {
    try {
      await withTimeout(
        this.refreshActiveCertificates(),
        this.statusTimeoutMs,
        'ORC source unavailable: internet access is required for external source imports'
      )

      return {
        available: true,
        availabilityMessage: ''
      }
    } catch (_error) {
      return {
        available: false,
        availabilityMessage: 'ORC source unavailable: internet access is required for external source imports'
      }
    }
  }

  async search(query = '') {
    const entries = await this.getActiveCertificates()
    const needle = normalize(query)
    const matches = needle
      ? entries.filter(entry => this.matchesQuery(entry, needle))
      : entries

    return matches.slice(0, MAX_SEARCH_RESULTS).map(entry => ({
      externalId: entry.refNo,
      name: entry.yachtName || entry.refNo,
      sailnumber: entry.sailNo || undefined,
      boatType: entry.boatClass || undefined,
      year: entry.vppYear,
      source: this.id,
      dxtId: entry.dxtId,
      countryId: entry.countryId,
      certificateName: entry.certName || undefined,
      familyName: entry.familyName || undefined
    }))
  }

  async importByExternalId(externalId) {
    const refNo = String(externalId || '').trim()
    if (!refNo) {
      throw sourceError(400, 'External ORC id is required')
    }

    const entries = await this.getActiveCertificates()
    const entry = entries.find(candidate => candidate.refNo === refNo)
    if (!entry) {
      throw sourceError(404, `ORC certificate not found: ${refNo}`)
    }

    const certificateHtml = await this.fetchText(`${CERTIFICATE_URL_PREFIX}${entry.dxtId}`, `ORC certificate ${entry.dxtId}`)
    return {
      resource: this.parseCertificateHtml(certificateHtml, entry),
      fallbackName: entry.yachtName || refNo
    }
  }

  matchesQuery(entry, needle) {
    return [
      entry.refNo,
      entry.yachtName,
      entry.sailNo,
      entry.boatClass,
      entry.countryId,
      entry.certName,
      entry.familyName,
      entry.vppYear
    ].some(value => normalize(value).includes(needle))
  }

  async getActiveCertificates() {
    const cached = this.readCache()
    const isFresh = cached && (this.now() - cached.fetchedAtMs) < this.cacheTtlMs
    if (isFresh) {
      return cached.entries
    }

    try {
      return await this.refreshActiveCertificates()
    } catch (error) {
      if (cached?.entries?.length) {
        return cached.entries
      }
      throw error
    }
  }

  readCache() {
    try {
      if (!fs.existsSync(this.activeCachePath)) return null
      const payload = JSON.parse(fs.readFileSync(this.activeCachePath, 'utf8'))
      if (!Array.isArray(payload.entries) || !Number.isFinite(payload.fetchedAtMs)) return null
      return payload
    } catch (_error) {
      return null
    }
  }

  writeCache(entries) {
    fs.writeFileSync(this.activeCachePath, JSON.stringify({
      fetchedAtMs: this.now(),
      entries
    }, null, 2), 'utf8')
  }

  async refreshActiveCertificates() {
    const xmlText = await this.fetchText(ACTIVE_CERTIFICATES_URL, 'ORC active certificates index')
    const entries = this.parseActiveCertificates(xmlText)
    this.writeCache(entries)
    return entries
  }

  async fetchText(url, label) {
    let response
    try {
      response = await this.fetcher(url)
    } catch (error) {
      throw sourceError(503, `External source unavailable while fetching ${label}: ${error.message}`)
    }

    if (!response || typeof response.text !== 'function') {
      throw sourceError(502, `Invalid response from ${label}`)
    }

    if (!response.ok) {
      const status = response.status === 404 ? 404 : 502
      throw sourceError(status, `Failed to fetch ${label}: HTTP ${response.status}`)
    }

    return response.text()
  }

  parseActiveCertificates(xmlText) {
    const rows = parseXmlRows(xmlText)
    if (!rows.length) {
      throw sourceError(502, 'ORC active certificates response did not contain any rows')
    }

    return rows
      .filter(row => row.RefNo && row.dxtID)
      .map(row => ({
        refNo: row.RefNo.trim(),
        dxtId: row.dxtID.trim(),
        countryId: row.CountryId?.trim() || '',
        yachtName: row.YachtName?.trim() || '',
        sailNo: row.SailNo?.trim() || '',
        vppYear: Number.parseInt(row.VPPYear, 10) || undefined,
        boatClass: row.Class?.trim() || '',
        certName: row.CertName?.trim() || '',
        familyName: row.FamilyName?.trim() || '',
        issuedAt: row.dxtDate?.trim() || '',
        expiry: row.Expiry?.trim() || ''
      }))
  }

  parseCertificateHtml(htmlText, entry) {
    const tableMatch = htmlText.match(/<table class="boatspeeds">([\s\S]*?)<\/table>/i)
    if (!tableMatch) {
      throw sourceError(502, `ORC certificate page did not contain a boatspeeds table for ${entry.refNo}`)
    }

    const rows = parseTableRows(tableMatch[0])
    const windRow = rows.find(cells => normalize(cells[0]) === 'wind velocity')
    const beatAnglesRow = rows.find(cells => normalize(cells[0]) === 'beat angles')
    const beatVmgRow = rows.find(cells => normalize(cells[0]) === 'beat vmg')
    const runVmgRow = rows.find(cells => normalize(cells[0]) === 'run vmg')
    const gybeAnglesRow = rows.find(cells => normalize(cells[0]) === 'gybe angles')
    const angleRows = rows.filter(cells => /^\d+(?:\.\d+)?°$/.test(cells[0]))

    if (!windRow || !beatAnglesRow || !beatVmgRow || !runVmgRow || !gybeAnglesRow || angleRows.length === 0) {
      throw sourceError(502, `ORC certificate page structure was incomplete for ${entry.refNo}`)
    }

    const twsValues = windRow.slice(1).map(parseNumber).map(value => value * KNOT_TO_MPS)
    const twaValues = angleRows.map(row => parseNumber(row[0]) * DEG_TO_RAD)
    const beatAngles = beatAnglesRow.slice(1).map(parseNumber).map(value => value * DEG_TO_RAD)
    const beatVmgs = beatVmgRow.slice(1).map(parseNumber).map(value => value * KNOT_TO_MPS)
    const runVmgs = runVmgRow.slice(1).map(parseNumber).map(value => value * KNOT_TO_MPS)
    const runAngles = gybeAnglesRow.slice(1).map(parseNumber).map(value => value * DEG_TO_RAD)
    const angleSpeedRows = angleRows.map(row => ({
      twa: parseNumber(row[0]) * DEG_TO_RAD,
      values: row.slice(1).map(parseNumber).map(value => value * KNOT_TO_MPS)
    }))

    if (
      twsValues.some(value => !Number.isFinite(value)) ||
      twaValues.some(value => !Number.isFinite(value)) ||
      beatAngles.some(value => !Number.isFinite(value)) ||
      beatVmgs.some(value => !Number.isFinite(value)) ||
      runAngles.some(value => !Number.isFinite(value)) ||
      runVmgs.some(value => !Number.isFinite(value)) ||
      angleSpeedRows.some(row => row.values.length !== twsValues.length || row.values.some(value => !Number.isFinite(value)))
    ) {
      throw sourceError(502, `ORC certificate page contained invalid numeric data for ${entry.refNo}`)
    }

    const boatSpeedMatrix = matrixFromAngleRows(angleSpeedRows, twsValues.length)
    const certificateYear = extractCertificateYear(htmlText, entry.vppYear)

    return {
      kind: 'polarTable',
      schemaVersion: '1.0.0',
      name: entry.yachtName || entry.refNo,
      ...(entry.sailNo ? { sailnumber: entry.sailNo.replace(/\s+/g, '') } : {}),
      ...(entry.boatClass ? { boatType: entry.boatClass } : {}),
      ...(Number.isInteger(certificateYear) ? { year: certificateYear } : {}),
      source: this.defaultSource,
      units: {
        tws: 'm/s',
        twa: 'rad',
        boatSpeed: 'm/s'
      },
      symmetry: {
        portStarboardSymmetric: true
      },
      axes: {
        tws: twsValues,
        twa: twaValues
      },
      values: {
        boatSpeedMatrix
      },
      derived: createDerivedRows(twsValues, twaValues, boatSpeedMatrix, beatAngles, beatVmgs, runAngles, runVmgs)
    }
  }
}

module.exports = OrcSource