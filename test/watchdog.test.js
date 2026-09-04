'use strict'

const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const WIND_SPEED = 'environment.wind.speedTrue'
const WIND_ANGLE = 'environment.wind.angleTrueWater'
const STALE_RESUBSCRIBE_PERIOD = 60000
const STALE_PERIOD = 4000 // Exponential tau=1 → max(tau*3000, 4000)

function makeApp(dataDir) {
  const listeners = new Map()
  const app = {
    subscribeCalls: [],
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (_options, callback) => callback(null),
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    config: { port: 3000 },
    deliver(skPath, value) {
      for (const cb of listeners.get(skPath) || []) {
        cb({ updates: [{ values: [{ path: skPath, value }] }] })
      }
    },
    subscriptionmanager: {
      subscribe: (sub, unsubscribes, _onErr, onDelta) => {
        const skPath = sub.subscribe[0].path
        app.subscribeCalls.push(skPath)
        const list = listeners.get(skPath) || []
        list.push(onDelta)
        listeners.set(skPath, list)
        unsubscribes.push(() => {
          const remaining = (listeners.get(skPath) || []).filter(cb => cb !== onDelta)
          listeners.set(skPath, remaining)
        })
      }
    }
  }
  return app
}

function windSubscribeCount(app) {
  return app.subscribeCalls.filter(p => p === WIND_SPEED || p === WIND_ANGLE).length
}

function freshPlugin(app) {
  delete require.cache[require.resolve('../plugin/index.js')]
  return require('../plugin/index.js')(app)
}

describe('Stale input resubscribe watchdog', () => {
  let dataDir, app, plugin

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-watchdog-'))
    app = makeApp(dataDir)
    plugin = freshPlugin(app)
  })

  afterEach(() => {
    try { plugin.stop() } catch (_) {}
    mock.timers.reset()
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('does not resubscribe on the 4s stale tick after data has arrived', () => {
    plugin.start({})
    const afterStart = windSubscribeCount(app)
    app.deliver(WIND_SPEED, 5)
    app.deliver(WIND_ANGLE, 0.8)
    mock.timers.tick(STALE_PERIOD)
    assert.equal(windSubscribeCount(app), afterStart)
  })

  it('resubscribes 60s after becoming stale, not only when never-seen', () => {
    plugin.start({})
    const afterStart = windSubscribeCount(app)
    app.deliver(WIND_SPEED, 5)
    app.deliver(WIND_ANGLE, 0.8)
    mock.timers.tick(STALE_PERIOD)
    mock.timers.tick(STALE_RESUBSCRIBE_PERIOD - 1)
    assert.equal(windSubscribeCount(app), afterStart, 'must wait the full 60s after stale')
    mock.timers.tick(1)
    assert.equal(windSubscribeCount(app), afterStart + 2)
  })

  it('cancels a pending stale resubscribe when data returns', () => {
    plugin.start({})
    const afterStart = windSubscribeCount(app)
    app.deliver(WIND_SPEED, 5)
    app.deliver(WIND_ANGLE, 0.8)
    mock.timers.tick(STALE_PERIOD)
    app.deliver(WIND_SPEED, 5.2)
    app.deliver(WIND_ANGLE, 0.9)
    mock.timers.tick(STALE_RESUBSCRIBE_PERIOD)
    assert.equal(windSubscribeCount(app), afterStart)
  })

  it('retries resubscribe if the input stays dead after the first recover', () => {
    plugin.start({})
    const afterStart = windSubscribeCount(app)
    app.deliver(WIND_SPEED, 5)
    app.deliver(WIND_ANGLE, 0.8)
    mock.timers.tick(STALE_PERIOD)
    mock.timers.tick(STALE_RESUBSCRIBE_PERIOD)
    assert.equal(windSubscribeCount(app), afterStart + 2)
    mock.timers.tick(STALE_RESUBSCRIBE_PERIOD)
    assert.equal(windSubscribeCount(app), afterStart + 4)
  })
})
