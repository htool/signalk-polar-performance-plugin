'use strict'

const fs = require('fs')
const path = require('path')
const { PolarTable } = require('./PolarTable')

/**
 * PolarFileStore — manages stored polar resources in the plugin data directory.
 *
 * All file names are bare names (no path, no extension).
 * Files are stored as canonical <name>.json resources in the configured data directory.
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

  /** Resolves a bare name to its full JSON file path. */
  _jsonPath(name) {
    const safe = path.basename(name)
    return path.join(this.dataDir, `${safe}.json`)
  }

  /** Checks whether a canonical polar resource exists. */
  exists(name) {
    return fs.existsSync(this._jsonPath(name))
  }

  /**
   * List all canonical polar resources in the data directory.
   * @returns {string[]} Array of bare names, sorted alphabetically.
   */
  list() {
    return fs.readdirSync(this.dataDir)
      .filter(fileName => fileName.endsWith('.json'))
      .map(fileName => fileName.slice(0, -5))
      .sort()
  }

  /**
   * Read the raw JSON content of a stored canonical polar resource.
   * @param {string} name - Bare name of the polar.
   * @returns {string} Raw file content.
   * @throws {Error} If the file does not exist.
   */
  read(name) {
    const jp = this._jsonPath(name)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${name}`)
    return fs.readFileSync(jp, 'utf8')
  }

  /**
   * Load a canonical polar resource and return a populated PolarTable.
   * @param {string} name - Bare name of the polar.
   * @returns {PolarTable}
   * @throws {Error} If the file does not exist or is not a canonical resource.
   */
  load(name) {
    const stored = this.readObject(name)
    if (stored.kind !== 'polarTable') {
      throw new Error(`Stored polar is not a canonical polarTable resource: ${name}`)
    }
    return new PolarTable().loadFromCanonical(stored)
  }

  /** Reads and parses a stored JSON polar resource. */
  readObject(name) {
    const jp = this._jsonPath(name)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${name}`)
    return JSON.parse(fs.readFileSync(jp, 'utf8'))
  }

  /**
   * Read metadata for a polar.
   * Reads directly from the stored canonical resource.
   */
  readMeta(name) {
    try {
      const stored = this.readObject(name)
      return {
        ...(stored.name       ? { boatName:   stored.name       } : {}),
        ...(stored.boatType   ? { boatType:   stored.boatType   } : {}),
        ...(stored.sailnumber ? { sailnumber: stored.sailnumber } : {}),
        ...(Number.isInteger(stored.year) ? { year: stored.year } : {}),
        ...(stored.source     ? { source:     stored.source     } : {}),
        ...(stored.notes      ? { notes:      stored.notes      } : {}),
      }
    } catch (_) { return {} }
  }

  /**
   * List all polar files with their stored metadata.
   * @returns {{ name: string, boatName?: string, boatType?: string, sailnumber?: string }[]}
   */
  listWithMeta() {
    return this.list().map(name => ({ name, ...this.readMeta(name) }))
  }

  /** Save a canonical polar resource as JSON. */
  saveCanonical(name, resource) {
    const stored = { ...resource, id: name, kind: 'polarTable' }
    fs.writeFileSync(this._jsonPath(name), JSON.stringify(stored, null, 2), 'utf8')
    return name
  }

  /**
   * Copy a stored canonical polar resource to a new name.
   */
  copy(srcName, dstName) {
    const srcJson = this._jsonPath(srcName)
    if (!fs.existsSync(srcJson)) throw new Error(`Polar not found: ${srcName}`)
    fs.copyFileSync(srcJson, this._jsonPath(dstName))
  }

  /**
   * Delete a stored canonical polar resource.
   * @param {string} name - Bare name of the polar to delete.
   * @throws {Error} If the file does not exist.
   */
  delete(name) {
    const jp = this._jsonPath(name)
    if (!fs.existsSync(jp)) throw new Error(`Polar not found: ${name}`)
    fs.unlinkSync(jp)
  }
}

module.exports = PolarFileStore
