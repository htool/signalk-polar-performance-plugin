'use strict'

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const PolarFileStore = require('../plugin/PolarFileStore')
const { PolarTable } = require('../plugin/PolarTable')

const SAMPLE_CANONICAL = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Canonical Boat',
  sailnumber: 'CAN42',
  boatType: 'Test Sloop',
  year: 2024,
  source: 'custom',
  notes: 'roundtrip',
  units: {
    tws: 'm/s',
    twa: 'rad',
    boatSpeed: 'm/s'
  },
  symmetry: {
    portStarboardSymmetric: true
  },
  axes: {
    tws: [3.0864, 5.144],
    twa: [0.75398, 1.5708, 2.65465]
  },
  values: {
    boatSpeedMatrix: [
      [2.5051, 2.65465, 2.23368],
      [3.16888, 3.34861, 2.74799]
    ]
  },
  derived: {
    rows: [
      {
        tws: 3.0864,
        beat: { twa: 0.75398, tbs: 2.5051, vmg: 1.82652 },
        run: { twa: 2.65465, tbs: 2.23368, vmg: 1.97371 },
        maxSpeed: 2.65465,
        maxSpeedAngle: 1.5708
      },
      {
        tws: 5.144,
        beat: { twa: 0.75398, tbs: 3.16888, vmg: 2.31042 },
        run: { twa: 2.65465, tbs: 2.74799, vmg: 2.42813 },
        maxSpeed: 3.34861,
        maxSpeedAngle: 1.5708
      }
    ]
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polar-test-'))
}

describe('PolarFileStore — constructor', () => {
  it('creates the data directory if it does not exist', () => {
    const dir = path.join(os.tmpdir(), `polar-new-${Date.now()}`)
    assert.ok(!fs.existsSync(dir))
    new PolarFileStore(dir)
    assert.ok(fs.existsSync(dir))
    fs.rmdirSync(dir)
  })

  it('accepts an already-existing directory without throwing', () => {
    const dir = makeTempDir()
    try {
      assert.doesNotThrow(() => new PolarFileStore(dir))
    } finally {
      fs.rmdirSync(dir)
    }
  })
})

describe('PolarFileStore — file operations', () => {
  let dir, store

  before(() => {
    dir = makeTempDir()
    store = new PolarFileStore(dir)
  })

  after(() => {
    // Clean up temp dir
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.rmdirSync(dir)
  })

  it('list() returns empty array on empty directory', () => {
    assert.deepEqual(store.list(), [])
  })

  it('saveCanonical() writes a JSON file; list() returns its name', () => {
    store.saveCanonical('test1', SAMPLE_CANONICAL)
    assert.ok(fs.existsSync(path.join(dir, 'test1.json')))
    assert.deepEqual(store.list(), ['test1'])
  })

  it('list() returns multiple names sorted alphabetically', () => {
    store.saveCanonical('bravo', SAMPLE_CANONICAL)
    store.saveCanonical('alpha', SAMPLE_CANONICAL)
    const names = store.list()
    assert.deepEqual(names, ['alpha', 'bravo', 'test1'])
  })

  it('readObject() returns the saved canonical resource', () => {
    store.saveCanonical('readtest', SAMPLE_CANONICAL)
    assert.equal(store.readObject('readtest').kind, 'polarTable')
    assert.equal(store.readObject('readtest').name, 'Canonical Boat')
  })

  it('read() throws for a non-existent file', () => {
    assert.throws(() => store.readObject('does-not-exist'), /not found/)
  })

  it('saveCanonical() overwrites an existing file', () => {
    store.saveCanonical('overwrite', SAMPLE_CANONICAL)
    store.saveCanonical('overwrite', { ...SAMPLE_CANONICAL, name: 'Updated Boat' })
    assert.equal(store.readObject('overwrite').name, 'Updated Boat')
  })

  it('copy() creates a duplicate file with the new name', () => {
    store.saveCanonical('source', SAMPLE_CANONICAL)
    store.copy('source', 'dest')
    assert.deepEqual(store.readObject('dest').axes, SAMPLE_CANONICAL.axes)
  })

  it('copy() throws when source does not exist', () => {
    assert.throws(() => store.copy('missing', 'dest2'), /not found/)
  })

  it('delete() removes the file', () => {
    store.saveCanonical('todelete', SAMPLE_CANONICAL)
    store.delete('todelete')
    assert.ok(!fs.existsSync(path.join(dir, 'todelete.json')))
  })

  it('delete() throws for a non-existent file', () => {
    assert.throws(() => store.delete('ghost'), /not found/)
  })

  it('saveCanonical()/readObject() reject path traversal in the name', () => {
    // path.basename strips the directory part so '../escape' becomes 'escape'
    store.saveCanonical('../escape', SAMPLE_CANONICAL)
    assert.ok(fs.existsSync(path.join(dir, 'escape.json')))
    assert.doesNotThrow(() => store.readObject('../escape'))
    store.delete('../escape')
  })
})

describe('PolarFileStore — load()', () => {
  let dir, store

  before(() => {
    dir = makeTempDir()
    store = new PolarFileStore(dir)
    store.saveCanonical('sample', SAMPLE_CANONICAL)
  })

  after(() => {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.rmdirSync(dir)
  })

  it('returns a PolarTable instance', () => {
    const pt = store.load('sample')
    assert.ok(pt instanceof PolarTable)
  })

  it('returned PolarTable has non-empty table', () => {
    const pt = store.load('sample')
    assert.ok(pt.table.length > 0)
  })

  it('throws for a non-existent polar', () => {
    assert.throws(() => store.load('missing'), /not found/)
  })
})

describe('PolarFileStore — saveCanonical()', () => {
  let dir, store

  before(() => {
    dir = makeTempDir()
    store = new PolarFileStore(dir)
  })

  after(() => {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.rmdirSync(dir)
  })

  it('stores canonical JSON and exposes its metadata', () => {
    store.saveCanonical('canonical', SAMPLE_CANONICAL)
    const meta = store.readMeta('canonical')
    assert.equal(meta.boatName, 'Canonical Boat')
    assert.equal(meta.boatType, 'Test Sloop')
    assert.equal(meta.sailnumber, 'CAN42')
    assert.equal(meta.year, 2024)
    assert.equal(meta.source, 'custom')
    assert.equal(meta.notes, 'roundtrip')
  })

  it('loads a canonical resource into a PolarTable', () => {
    store.saveCanonical('canonical-load', SAMPLE_CANONICAL)
    const polar = store.load('canonical-load')
    assert.ok(polar instanceof PolarTable)
    assert.ok(polar.getBoatSpeed(3.0864, 1.5708) > 0)
  })
})
