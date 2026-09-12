'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// Minimal app shim
// ---------------------------------------------------------------------------

function makeApp(dataDir) {
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (_options, callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('callback is not a function')
      }
      callback(null)
    },
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    config: { port: 3000 },
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes, _onErr, _onDelta) => {
        unsubscribes.push(() => {})
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshPlugin(app) {
  delete require.cache[require.resolve('../plugin/index.js')]
  return require('../plugin/index.js')(app)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plugin lifecycle — start() → stop() → start()', () => {
  let dataDir, app, plugin

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-lifecycle-'))
    app = makeApp(dataDir)
    plugin = freshPlugin(app)
  })

  afterEach(() => {
    try { plugin.stop() } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('start() with empty config does not throw', () => {
    assert.doesNotThrow(() => plugin.start({}))
  })

  it('stop() after start() does not throw', () => {
    plugin.start({})
    assert.doesNotThrow(() => plugin.stop())
  })

  it('second start() after stop() does not throw', () => {
    plugin.start({})
    plugin.stop()
    assert.doesNotThrow(() => plugin.start({}))
  })

  it('multiple start/stop cycles do not throw', () => {
    for (let i = 0; i < 3; i++) {
      assert.doesNotThrow(() => plugin.start({}), `start() threw on cycle ${i + 1}`)
      assert.doesNotThrow(() => plugin.stop(),  `stop() threw on cycle ${i + 1}`)
    }
  })

  it('plugin id and name are stable across restarts', () => {
    const id1 = plugin.id
    const name1 = plugin.name
    plugin.start({})
    plugin.stop()
    plugin.start({})
    assert.equal(plugin.id,   id1,   'plugin.id changed after restart')
    assert.equal(plugin.name, name1, 'plugin.name changed after restart')
  })

  it('registerWithRouter can be called before start()', () => {
    const routes = []
    const router = {
      use: () => {},
      get:    (p) => routes.push(`GET ${p}`),
      put:    (p) => routes.push(`PUT ${p}`),
      post:   (p) => routes.push(`POST ${p}`),
      delete: (p) => routes.push(`DELETE ${p}`),
    }
    assert.doesNotThrow(() => plugin.registerWithRouter(router))
    assert.ok(routes.some(r => r.startsWith('GET')), 'no GET routes registered')
  })

  it('registerWithRouter + start() + stop() + start() does not throw', () => {
    const router = {
      use: () => {},
      get: () => {}, put: () => {}, post: () => {}, delete: () => {}
    }
    plugin.registerWithRouter(router)
    plugin.start({})
    plugin.stop()
    assert.doesNotThrow(() => plugin.start({}))
  })

  it('signalKApiRoutes exposes GET under plugin id and omits writes', () => {
    const admin = { get: {}, put: {}, post: {}, delete: {} }
    const api = { get: {}, put: {}, post: {}, delete: {} }
    function make(store) {
      return {
        use: () => {},
        get: (p, h) => { store.get[p] = h },
        put: (p, h) => { store.put[p] = h },
        post: (p, h) => { store.post[p] = h },
        delete: (p, h) => { store.delete[p] = h }
      }
    }
    plugin.registerWithRouter(make(admin))
    const returned = plugin.signalKApiRoutes(make(api))
    assert.equal(typeof returned.get, 'function')
    const prefix = '/signalk-polar-performance-plugin'
    assert.equal(typeof api.get[prefix + '/live'], 'function')
    assert.equal(typeof api.get[prefix + '/settings'], 'function')
    assert.equal(typeof api.get[prefix + '/polar/axes/tws'], 'function')
    assert.equal(api.put[prefix + '/settings'], undefined)
    assert.equal(typeof admin.put['/settings'], 'function')
  })
})
