'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Minimal v0 settings matching the real-world shape (no settingsVersion)
const V0_SETTINGS = {
  useTWSsource: '',
  beatAngle: true,
  beatVMG: true,
  targetTWA: true,
  optimumWindAngle: true,
  VMG: true,
  useSOG: false,
  useSOGsource: '',
  perfAdjust: 1,
  dampingTWA: 2,
  dampingTWS: 1,
  dampingBSP: 3,
  trueWindSpeedPath: 'environment.wind.speedTrue'
}

function makeApp(dataDir) {
  const saved = []
  const errors = []
  return {
    _saved: saved,
    _errors: errors,
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: (msg) => errors.push(msg),
    savePluginOptions: (opts) => saved.push(JSON.parse(JSON.stringify(opts))),
    getDataDirPath: () => dataDir,
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes, _onErr, _onDelta) => {
        // Push a no-op unsubscribe so stop() can cleanly drain the array
        unsubscribes.push(() => {})
      }
    },
    handleMessage: () => {}
  }
}

describe('Settings migration v0 → v1', () => {
  let dataDir
  let app
  let plugin

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-migration-'))
    app = makeApp(dataDir)
    // Fresh require — clear module cache so module-level state is reset
    delete require.cache[require.resolve('../plugin/index.js')]
    plugin = require('../plugin/index.js')(app)
  })

  afterEach(() => {
    try { plugin.stop() } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('persists settings at v1 without csvTable', () => {
    plugin.start({ ...V0_SETTINGS })
    assert.ok(app._saved.length > 0, 'savePluginOptions was never called')
    const saved = app._saved[app._saved.length - 1]
    assert.equal(saved.settingsVersion, 1, 'settingsVersion should be 1 after migration')
    assert.ok(!('csvTable' in saved), 'csvTable should be removed from saved settings')
  })

  it('migrates dampingTWA/TWS/BSP to smootherParamExponential (max of the three)', () => {
    plugin.start({ ...V0_SETTINGS })
    const saved = app._saved[app._saved.length - 1]
    assert.equal(saved.smootherType, 'Exponential')
    assert.equal(saved.smootherParamExponential, 3, 'should be max(dampingTWA=2, dampingTWS=1, dampingBSP=3)')
    assert.ok(!('dampingTWA' in saved))
    assert.ok(!('dampingTWS' in saved))
    assert.ok(!('dampingBSP' in saved))
  })

  it('removes legacy fields useTWSsource and useSOGsource', () => {
    plugin.start({ ...V0_SETTINGS })
    const saved = app._saved[app._saved.length - 1]
    assert.ok(!('useTWSsource' in saved))
    assert.ok(!('useSOGsource' in saved))
  })

  it('does not repeat migration on second start (settings already v1)', () => {
    plugin.start({ ...V0_SETTINGS })
    const savedAfterFirst = app._saved.length

    plugin.stop()
    // Simulate second start with the already-migrated settings
    const migratedSettings = app._saved[app._saved.length - 1]
    plugin.start({ ...migratedSettings })

    // savePluginOptions should not have been called again for migration
    assert.equal(app._saved.length, savedAfterFirst, 'migration should not repeat on second start')
  })

  it('sets no plugin errors during a successful migration', () => {
    plugin.start({ ...V0_SETTINGS })
    assert.deepEqual(app._errors, [])
  })
})
