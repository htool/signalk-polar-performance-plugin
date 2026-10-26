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

  it('keeps subscriptions through silence and receives resumed wind without replay', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const subscribers = new Map()
    let subscriptions = 0
    let unsubscriptions = 0
    let messages = 0
    app.handleMessage = () => { messages++ }
    app.subscriptionmanager.subscribe = (msg, unsubscribes, _err, callback) => {
      subscriptions++
      for (const { path } of msg.subscribe) {
        if (!subscribers.has(path)) subscribers.set(path, new Set())
        subscribers.get(path).add(callback)
      }
      unsubscribes.push(() => {
        unsubscriptions++
        for (const { path } of msg.subscribe) subscribers.get(path).delete(callback)
      })
    }
    const routes = {}
    plugin.registerWithRouter({
      use: () => {}, get: (p, cb) => { routes[p] = cb },
      put: (p, cb) => { routes[`PUT ${p}`] = cb }, post: () => {}, delete: () => {}
    })
    plugin.start({ tackTrue: true })
    const deliver = (path, value) => {
      for (const callback of subscribers.get(path)) {
        callback({ updates: [{ values: [{ path, value }] }] })
      }
    }
    deliver('environment.wind.speedTrue', 5)
    deliver('environment.wind.angleTrueWater', 0.4)
    const initialSubscriptions = subscriptions
    const initialMessages = messages
    t.mock.timers.tick(120000)
    assert.equal(subscriptions, initialSubscriptions)
    assert.equal(unsubscriptions, 0)
    assert.equal(messages, initialMessages, 'silence must not publish cached inputs')
    let status
    routes['/status']({}, { json: value => { status = value } })
    for (const id of ['wind.smoothed', 'bsp.smoothed', 'hdg.smoothed']) {
      const warning = status.lifecycleWarnings.find(w => w.id === id)
      assert.equal(warning?.status, 'idle', id)
      assert.doesNotMatch(warning.message, /resubscrib/i)
    }
    assert.equal(status.inputs.smoothed.tws, null)
    deliver('environment.wind.speedTrue', 6)
    deliver('environment.wind.angleTrueWater', 0.5)
    routes['/status']({}, { json: value => { status = value } })
    assert.equal(status.lifecycleWarnings.some(w => w.id === 'wind.smoothed'), false)
    assert.equal(status.inputs.smoothed.tws, 6)
    assert.equal(subscriptions, initialSubscriptions)

    routes['PUT /settings']({ body: { useSOG: true } }, { json: () => {} })
    assert.equal(subscriptions, initialSubscriptions + 1, 'a source change must still resubscribe')
    assert.equal(unsubscriptions, 1)
    assert.equal(subscribers.get('navigation.speedThroughWater').size, 0)
    assert.equal(subscribers.get('navigation.speedOverGround').size, 1)

    routes['PUT /settings']({ body: { tackTrue: false } }, { json: () => {} })
    routes['PUT /settings']({ body: { tackTrue: true } }, { json: () => {} })
    const configuredSubscriptions = subscriptions
    const configuredUnsubscriptions = unsubscriptions
    t.mock.timers.tick(120000)
    routes['/status']({}, { json: value => { status = value } })
    assert.equal(status.lifecycleWarnings.find(w => w.id === 'hdg.smoothed')?.status, 'idle')
    assert.equal(subscriptions, configuredSubscriptions)
    assert.equal(unsubscriptions, configuredUnsubscriptions)
  })
})
