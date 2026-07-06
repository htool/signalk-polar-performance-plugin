'use strict'

const fs = require('fs')
const path = require('path')
const { PolarTable } = require('./PolarTable')

const ORC_DATA_URL = 'https://raw.githubusercontent.com/jieter/orc-data/master/orc-data.json'

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

  /** Resolves a bare name to its full file path. */
  _filePath(name) {
    // Prevent path traversal
    const safe = path.basename(name)
    return path.join(this.dataDir, `${safe}.csv`)
  }

  /**
   * List all polar files in the data directory.
   * @returns {string[]} Array of bare names (without .csv extension), sorted alphabetically.
   */
  list() {
    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.csv'))
      .map(f => f.slice(0, -4))
      .sort()
  }

  /**
   * Read the raw CSV content of a polar file.
   * @param {string} name - Bare name of the polar.
   * @returns {string} CSV content.
   * @throws {Error} If the file does not exist.
   */
  read(name) {
    const fp = this._filePath(name)
    if (!fs.existsSync(fp)) throw new Error(`Polar file not found: ${name}.csv`)
    return fs.readFileSync(fp, 'utf8')
  }

  /**
   * Load a polar file and return a populated PolarTable.
   * @param {string} name - Bare name of the polar.
   * @returns {PolarTable}
   * @throws {Error} If the file does not exist or cannot be parsed.
   */
  load(name) {
    const csv = this.read(name)
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
   * Read metadata from the first line of a stored polar file.
   * @param {string} name - Bare name of the polar.
   * @returns {{ boatName?: string, boatType?: string, sailnumber?: string }}
   */
  readMeta(name) {
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
   * Copy a polar file to a new name.
   * @param {string} srcName - Source bare name.
   * @param {string} dstName - Destination bare name.
   * @throws {Error} If the source file does not exist.
   */
  copy(srcName, dstName) {
    const src = this._filePath(srcName)
    if (!fs.existsSync(src)) throw new Error(`Polar file not found: ${srcName}.csv`)
    fs.copyFileSync(src, this._filePath(dstName))
  }

  /**
   * Delete a polar file.
   * @param {string} name - Bare name of the polar to delete.
   * @throws {Error} If the file does not exist.
   */
  delete(name) {
    const fp = this._filePath(name)
    if (!fs.existsSync(fp)) throw new Error(`Polar file not found: ${name}.csv`)
    fs.unlinkSync(fp)
  }

  /**
   * Convert an ORC vpp object to Jieter CSV format and save it as a polar file.
   *
   * Beat/run rows use the "one non-zero per TWS column" format that PolarTable.loadFromJieter
   * expects: each beat/run row contains the optimal angle for one TWS column, with the
   * corresponding VMG as the single non-zero speed value.
   *
   * @param {Object} vpp - The vpp object from an ORC data entry.
   * @param {string} name - Bare name to save the file as.
   * @returns {string} The saved file name.
   */
  importFromORC(vpp, name, meta = {}) {
    const rows = []

    // Header row
    rows.push(['twa/tws', ...vpp.speeds].join(';'))

    // Speed rows — one per TWA angle
    for (const angle of vpp.angles) {
      const speeds = vpp[String(angle)]
      rows.push([angle, ...speeds].join(';'))
    }

    // Beat rows — one per TWS column so each column gets its own optimal beat angle
    for (let i = 0; i < vpp.speeds.length; i++) {
      const row = new Array(vpp.speeds.length).fill(0)
      row[i] = vpp.beat_vmg[i]
      rows.push([vpp.beat_angle[i], ...row].join(';'))
    }

    // Run rows — same pattern
    for (let i = 0; i < vpp.speeds.length; i++) {
      const row = new Array(vpp.speeds.length).fill(0)
      row[i] = vpp.run_vmg[i]
      rows.push([vpp.run_angle[i], ...row].join(';'))
    }

    this.save(name, rows.join('\n'), meta)
    return name
  }

  /**
   * Fetch the full ORC data index from GitHub.
   * This is a static method — callers are responsible for caching the result.
   *
   * @returns {Promise<Object[]>} Array of ORC boat objects.
   */
  static async fetchOrcIndex() {
    const response = await fetch(ORC_DATA_URL)
    if (!response.ok) {
      throw new Error(`ORC data fetch failed: HTTP ${response.status}`)
    }
    return response.json()
  }
}

module.exports = PolarFileStore
