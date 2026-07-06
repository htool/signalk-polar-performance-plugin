'use strict'

const fs = require('fs')
const path = require('path')
const { PolarTable } = require('./PolarTable')

// ── ORC data provider ───────────────────────────────────────────────────────
// Switch ORC_PROVIDER to 'jieter' to fall back to the original jieter site
// (currently AUS-only index). Both sites expose the same two-stage API:
//   index.json          — compact [[sailnumber, name, type], ...] search index
//   data/<sn>.json      — full boat entry including VPP
const ORC_PROVIDER = 'dakk'
const ORC_BASE_URLS = {
  dakk:   'https://dakk.github.io/orc-data/site',
  jieter: 'https://jieter.github.io/orc-data/site',
}
const ORC_BASE = ORC_BASE_URLS[ORC_PROVIDER] || ORC_BASE_URLS.dakk
// ---------------------------------------------------------------------------

/**
 * PolarFileStore — manages polar CSV files stored in the plugin data directory.
 *
 * All file names are bare names (no path, no extension).
 * Files are stored as <name>.csv in the configured data directory.
 */
class PolarFileStore {
  /**
   * @param {string} dataDir - Absolute path to the directory where polar files are stored.
   */
  constructor(dataDir) {
    this.dataDir = dataDir
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  }

  /** Resolves a bare name to its full CSV file path. */
  _filePath(name) {
    // Prevent path traversal
    const safe = path.basename(name)
    return path.join(this.dataDir, `${safe}.csv`)
  }

  /** Resolves a bare name to its full JSON file path. */
  _jsonPath(name) {
    const safe = path.basename(name)
    return path.join(this.dataDir, `${safe}.json`)
  }

  /**
   * List all polar files in the data directory (both .json and .csv).
   * @returns {string[]} Array of bare names, sorted alphabetically.
   */
  list() {
    const names = new Set()
    fs.readdirSync(this.dataDir).forEach(f => {
      if (f.endsWith('.json')) names.add(f.slice(0, -5))
      else if (f.endsWith('.csv')) names.add(f.slice(0, -4))
    })
    return [...names].sort()
  }

  /**
   * Read the raw content of a polar file (.json or .csv).
   * @param {string} name - Bare name of the polar.
   * @returns {string} Raw file content.
   * @throws {Error} If neither file exists.
   */
  read(name) {
    const jp = this._jsonPath(name)
    if (fs.existsSync(jp)) return fs.readFileSync(jp, 'utf8')
    const fp = this._filePath(name)
    if (!fs.existsSync(fp)) throw new Error(`Polar not found: ${name}`)
    return fs.readFileSync(fp, 'utf8')
  }

  /** Returns true if this polar is stored as JSON (ORC format). */
  isJson(name) {
    return fs.existsSync(this._jsonPath(name))
  }

  /**
   * Load a polar file and return a populated PolarTable.
   * Tries .json (ORC format) first, falls back to .csv (Jieter format).
   * @param {string} name - Bare name of the polar.
   * @returns {PolarTable}
   * @throws {Error} If neither file exists or cannot be parsed.
   */
  load(name) {
    const jp = this._jsonPath(name)
    if (fs.existsSync(jp)) {
      const stored = JSON.parse(fs.readFileSync(jp, 'utf8'))
      return new PolarTable().loadFromOrcVpp(stored.vpp)
    }
    const csv = this.read(name)   // throws if .csv also missing
    return new PolarTable().loadFromJieter(csv)
  }

  /**
   * Parse the metadata comment from a CSV first line.
   * Format: # polar: boatName=X; boatType=Y; sailnumber=Z
   * @param {string} firstLine
   * @returns {{ boatName?: string, boatType?: string, sailnumber?: string }}
   */
  _parseMeta(firstLine) {
    if (!firstLine || !firstLine.startsWith('# polar:')) return {}
    const meta = {}
    firstLine.slice('# polar:'.length).split(';').forEach(pair => {
      const eq = pair.indexOf('=')
      if (eq < 0) return
      const k = pair.slice(0, eq).trim()
      const v = pair.slice(eq + 1).trim()
      if (k && v) meta[k] = v
    })
    return meta
  }

  /**
   * Read metadata for a polar.
   * For JSON polars reads from the stored object; for CSV reads the # polar: comment.
   */
  readMeta(name) {
    const jp = this._jsonPath(name)
    if (fs.existsSync(jp)) {
      try {
        const stored = JSON.parse(fs.readFileSync(jp, 'utf8'))
        return {
          ...(stored.name            ? { boatName:   stored.name          } : {}),
          ...(stored.boat?.type     ? { boatType:   stored.boat.type     } : {}),
          ...(stored.sailnumber     ? { sailnumber: stored.sailnumber    } : {}),
        }
      } catch (_) { return {} }
    }
    return this._readCsvMeta(name)
  }

  /** Read metadata from the # polar: comment in a CSV file. */
  _readCsvMeta(name) {
    try {
      const fp = this._filePath(name)
      if (!fs.existsSync(fp)) return {}
      const buf = Buffer.alloc(512)
      const fd = fs.openSync(fp, 'r')
      const n = fs.readSync(fd, buf, 0, 512, 0)
      fs.closeSync(fd)
      const firstLine = buf.slice(0, n).toString('utf8').split('\n')[0]
      return this._parseMeta(firstLine)
    } catch (_) { return {} }
  }

  /**
   * List all polar files with their stored metadata.
   * @returns {{ name: string, boatName?: string, boatType?: string, sailnumber?: string }[]}
   */
  listWithMeta() {
    return this.list().map(name => ({ name, ...this.readMeta(name) }))
  }

  /**
   * Save a CSV string as a polar file.
   * @param {string} name - Bare name of the polar.
   * @param {string} csv - CSV content in Jieter format.
   * @param {{ boatName?: string, boatType?: string, sailnumber?: string }} [meta]
   */
  save(name, csv, meta = null) {
    let content = csv
    if (meta && (meta.boatName || meta.boatType || meta.sailnumber)) {
      const parts = []
      if (meta.boatName)   parts.push(`boatName=${meta.boatName}`)
      if (meta.boatType)   parts.push(`boatType=${meta.boatType}`)
      if (meta.sailnumber) parts.push(`sailnumber=${meta.sailnumber}`)
      content = `# polar: ${parts.join('; ')}\n` + csv
    }
    fs.writeFileSync(this._filePath(name), content, 'utf8')
  }

  /**
   * Copy a polar file to a new name (supports both .json and .csv).
   */
  copy(srcName, dstName) {
    const srcJson = this._jsonPath(srcName)
    if (fs.existsSync(srcJson)) {
      fs.copyFileSync(srcJson, this._jsonPath(dstName))
      return
    }
    const srcCsv = this._filePath(srcName)
    if (!fs.existsSync(srcCsv)) throw new Error(`Polar not found: ${srcName}`)
    fs.copyFileSync(srcCsv, this._filePath(dstName))
  }

  /**
   * Delete a polar file (.json or .csv, whichever exists).
   * @param {string} name - Bare name of the polar to delete.
   * @throws {Error} If neither file exists.
   */
  delete(name) {
    const jp = this._jsonPath(name)
    const cp = this._filePath(name)
    let deleted = false
    if (fs.existsSync(jp)) { fs.unlinkSync(jp); deleted = true }
    if (fs.existsSync(cp)) { fs.unlinkSync(cp); deleted = true }
    if (!deleted) throw new Error(`Polar not found: ${name}`)
  }

  /**
   * Convert an ORC vpp object to JSON and save it directly (no CSV conversion).
   * The stored object contains the full vpp plus boat metadata.
   *
   * @param {Object} vpp - The vpp object from an ORC data entry.
   * @param {string} name - Bare name to save the file as.
   * @param {{ boatName?, boatType?, sailnumber? }} [meta]
   * @returns {string} The saved file name.
   */
  importFromORC(vpp, name, meta = {}) {
    const stored = {
      sailnumber: meta.sailnumber || name,
      name:       meta.boatName  || null,
      boat:       { type: meta.boatType || null },
      vpp
    }
    fs.writeFileSync(this._jsonPath(name), JSON.stringify(stored, null, 2), 'utf8')
    return name
  }

  /**
   * Fetch the compact search index from the ORC provider site.
   * Format on the site: [[sailnumber, name, type], ...]
   * Returns: [{sailnumber, name, type}, ...]
   *
   * @returns {Promise<{sailnumber: string, name: string, type: string}[]>}
   */
  static async fetchOrcIndex() {
    const response = await fetch(`${ORC_BASE}/index.json`)
    if (!response.ok) {
      throw new Error(`ORC index fetch failed: HTTP ${response.status}`)
    }
    const tuples = await response.json()
    return tuples.map(([sailnumber, name, type]) => ({ sailnumber, name, type }))
  }

  /**
   * Fetch the full boat entry (including VPP) for a given sail number.
   * URL pattern: <ORC_BASE>/data/<sailnumber>.json
   * The sailnumber slash acts as a path separator: e.g. AUS/10001 → data/AUS/10001.json
   *
   * @param {string} sailnumber
   * @returns {Promise<Object>} Full ORC boat object with .vpp, .name, .boat, etc.
   */
  static async fetchBoat(sailnumber) {
    const response = await fetch(`${ORC_BASE}/data/${sailnumber}.json`)
    if (!response.ok) {
      throw new Error(`ORC boat fetch failed: HTTP ${response.status}`)
    }
    return response.json()
  }
}

module.exports = PolarFileStore
