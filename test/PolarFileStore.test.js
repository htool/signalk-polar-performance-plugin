'use strict'

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const PolarFileStore = require('../plugin/PolarFileStore')
const { PolarTable } = require('../plugin/PolarTable')

// Minimal but valid Jieter CSV
const SAMPLE_CSV = `twa/tws;6;10;14
52;4.87;6.16;6.55
90;5.16;6.51;7.01
135;4.34;6.13;6.94
43.2;0;0;5.93
152.1;0;5.34;0`

// Minimal ORC vpp object (3 TWS columns, 2 angles)
const SAMPLE_VPP = {
  angles: [52, 90],
  speeds: [6, 10, 14],
  '52':  [4.87, 6.16, 6.55],
  '90':  [5.16, 6.51, 7.01],
  beat_angle: [43.2, 40.0, 39.6],
  beat_vmg:   [2.49, 3.45, 4.21],
  run_angle:  [152.1, 156.1, 162.4],
  run_vmg:    [2.26, 3.28, 4.21]
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

  it('save() writes a file; list() returns its name', () => {
    store.save('test1', SAMPLE_CSV)
    assert.ok(fs.existsSync(path.join(dir, 'test1.csv')))
    assert.deepEqual(store.list(), ['test1'])
  })

  it('list() returns multiple names sorted alphabetically', () => {
    store.save('bravo', SAMPLE_CSV)
    store.save('alpha', SAMPLE_CSV)
    const names = store.list()
    assert.deepEqual(names, ['alpha', 'bravo', 'test1'])
  })

  it('read() returns the saved CSV content', () => {
    store.save('readtest', SAMPLE_CSV)
    assert.equal(store.read('readtest'), SAMPLE_CSV)
  })

  it('read() throws for a non-existent file', () => {
    assert.throws(() => store.read('does-not-exist'), /not found/)
  })

  it('save() overwrites an existing file', () => {
    store.save('overwrite', 'original')
    store.save('overwrite', 'updated')
    assert.equal(store.read('overwrite'), 'updated')
  })

  it('copy() creates a duplicate file with the new name', () => {
    store.save('source', SAMPLE_CSV)
    store.copy('source', 'dest')
    assert.equal(store.read('dest'), SAMPLE_CSV)
  })

  it('copy() throws when source does not exist', () => {
    assert.throws(() => store.copy('missing', 'dest2'), /not found/)
  })

  it('delete() removes the file', () => {
    store.save('todelete', SAMPLE_CSV)
    store.delete('todelete')
    assert.ok(!fs.existsSync(path.join(dir, 'todelete.csv')))
  })

  it('delete() throws for a non-existent file', () => {
    assert.throws(() => store.delete('ghost'), /not found/)
  })

  it('save()/read() reject path traversal in the name', () => {
    // path.basename strips the directory part so '../escape' becomes 'escape'
    store.save('../escape', SAMPLE_CSV)
    assert.ok(fs.existsSync(path.join(dir, 'escape.csv')))
    assert.doesNotThrow(() => store.read('../escape'))
    store.delete('../escape')
  })
})

describe('PolarFileStore — load()', () => {
  let dir, store

  before(() => {
    dir = makeTempDir()
    store = new PolarFileStore(dir)
    store.save('sample', SAMPLE_CSV)
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

describe('PolarFileStore — importFromORC()', () => {
  let dir, store

  before(() => {
    dir = makeTempDir()
    store = new PolarFileStore(dir)
  })

  after(() => {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f))
    fs.rmdirSync(dir)
  })

  it('creates a .csv file with the given name', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-import')
    assert.ok(fs.existsSync(path.join(dir, 'orc-import.csv')))
  })

  it('returns the name that was saved', () => {
    const name = store.importFromORC(SAMPLE_VPP, 'orc-return')
    assert.equal(name, 'orc-return')
  })

  it('generated CSV has correct header row', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-header')
    const csv = store.read('orc-header')
    const header = csv.split('\n')[0]
    assert.equal(header, 'twa/tws;6;10;14')
  })

  it('generated CSV contains a speed row for each angle', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-rows')
    const csv = store.read('orc-rows')
    const lines = csv.split('\n')
    assert.ok(lines.some(l => l.startsWith('52;')), 'Missing row for angle 52')
    assert.ok(lines.some(l => l.startsWith('90;')), 'Missing row for angle 90')
  })

  it('generated CSV speed values match vpp data', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-values')
    const csv = store.read('orc-values')
    const row52 = csv.split('\n').find(l => l.startsWith('52;'))
    assert.equal(row52, '52;4.87;6.16;6.55')
  })

  it('generated CSV contains beat/run rows', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-beatrun')
    const csv = store.read('orc-beatrun')
    const lines = csv.split('\n')
    // Beat rows: 3 TWS columns → 3 beat rows with one non-zero each
    const beatRows = lines.filter(l => {
      const cells = l.split(';')
      return cells.slice(1).filter(c => parseFloat(c) > 0).length === 1 &&
             parseFloat(cells[0]) < 90
    })
    assert.ok(beatRows.length >= SAMPLE_VPP.speeds.length,
      `Expected ${SAMPLE_VPP.speeds.length} beat rows, found ${beatRows.length}`)
  })

  it('generated CSV can be loaded into a PolarTable without error', () => {
    store.importFromORC(SAMPLE_VPP, 'orc-loadable')
    assert.doesNotThrow(() => {
      const pt = store.load('orc-loadable')
      assert.ok(pt.table.length > 0)
    })
  })
})
