'use strict'

const SI = require('../SI')
const { createCanonicalResource } = require('./canonical')

function parseNumber(value) {
  if (typeof value !== 'string') return Number.NaN
  const normalized = value.replace(/^"|"$/g, '').trim()
  if (!normalized) return Number.NaN
  return Number(normalized)
}

function detectDelimiter(line, preferredDelimiters) {
  let bestDelimiter = null
  let bestScore = -1

  preferredDelimiters.forEach((delimiter) => {
    const score = line.split(delimiter).length
    if (score > bestScore) {
      bestScore = score
      bestDelimiter = delimiter
    }
  })

  return bestScore > 1 ? bestDelimiter : null
}

function toRows(content, preferredDelimiters) {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))

  if (lines.length === 0) {
    throw new Error('Import text is empty')
  }

  const delimiter = detectDelimiter(lines[0], preferredDelimiters)
  if (!delimiter) {
    throw new Error('Unable to detect a supported field delimiter')
  }

  return lines.map(line => line.split(delimiter).map(cell => cell.trim()))
}

function headerLooksLikeTwsAxis(row) {
  if (!Array.isArray(row) || row.length < 3) return false
  return row.slice(1).every(cell => Number.isFinite(parseNumber(cell)))
}

function parseMatrixPolarText(content, options = {}) {
  const rows = toRows(content, options.preferredDelimiters || [';', ',', '\t'])
  const headerIndex = rows.findIndex(headerLooksLikeTwsAxis)

  if (headerIndex === -1) {
    throw new Error('Expected a header row with TWS values')
  }

  const headerRow = rows[headerIndex]
  const twsAxis = headerRow.slice(1).map((cell) => {
    const knots = parseNumber(cell)
    if (!Number.isFinite(knots) || knots <= 0) {
      throw new Error(`Invalid TWS value '${cell}' in header row`)
    }
    return SI.fromKnots(knots)
  })

  const angleMap = new Map()
  const derivedMap = new Map(twsAxis.map((tws, index) => [index, { tws }]))

  for (const row of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(row) || row.length < 2) continue

    const angleDeg = parseNumber(row[0])
    if (!Number.isFinite(angleDeg)) continue

    const angleRad = SI.fromDegrees(angleDeg)
    const values = twsAxis.map((_, index) => parseNumber(row[index + 1] || ''))
    const nonZeroEntries = []

    values.forEach((knots, index) => {
      if (Number.isFinite(knots) && knots > 0) {
        nonZeroEntries.push({ index, knots })
      }
    })

    if (nonZeroEntries.length === 0) continue

    const isTargetRow = options.allowTargetRows !== false && nonZeroEntries.length === 1
    if (isTargetRow) {
      const { index, knots } = nonZeroEntries[0]
      const tbs = SI.fromKnots(knots)
      const targetKey = angleRad < (Math.PI / 2) ? 'beat' : 'run'
      derivedMap.set(index, {
        ...derivedMap.get(index),
        [targetKey]: {
          twa: angleRad,
          tbs,
          vmg: tbs * Math.abs(Math.cos(angleRad))
        }
      })
      continue
    }

    angleMap.set(angleRad, values.map(knots => Number.isFinite(knots) && knots > 0 ? SI.fromKnots(knots) : 0))
  }

  const twaAxis = Array.from(angleMap.keys()).sort((left, right) => left - right)
  if (twaAxis.length === 0) {
    throw new Error('No boat speed rows were found in the import text')
  }

  const boatSpeedMatrix = twsAxis.map((_, twsIndex) => {
    const row = twaAxis.map((twa) => angleMap.get(twa)[twsIndex] || 0)
    if (!row.some(value => value > 0)) {
      throw new Error('Each TWS column must contain at least one positive boat speed')
    }
    return row
  })

  const derivedRows = Array.from(derivedMap.values()).filter((row) => row.beat || row.run)

  return {
    resource: createCanonicalResource({
      axes: { tws: twsAxis, twa: twaAxis },
      values: { boatSpeedMatrix },
      ...(derivedRows.length ? { derived: { rows: derivedRows } } : {})
    })
  }
}

module.exports = { parseMatrixPolarText }