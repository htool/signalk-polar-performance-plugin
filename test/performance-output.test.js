'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_POLAR = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Performance Test',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: {
    tws: [5, 10],
    twa: [Math.PI / 2, 3 * Math.PI / 4]
  },
  values: {
    boatSpeedMatrix: [
      [4, 3],
      [5, 4]
    ]
  },
  derived: {
    rows: [5, 10].map((tws, index) => ({
      tws,
      beat: { twa: Math.PI / 2, tbs: 4 + index, vmg: 2 + index },
      run: { twa: 3 * Math.PI / 4, tbs: 3 + index, vmg: (3 + index) * Math.SQRT1_2 },
      maxSpeed: 4 + index,
      maxSpeedAngle: Math.PI / 2
    }))
  }
}

function makeApp(dataDir) {
  const subscriptions = new Map()
  const messages = []
  return {
    subscriptions,
    messages,
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (_options, callback) => callback?.(),
    getDataDirPath: () => dataDir,
    handleMessage: (_pluginId, message) => messages.push(message),
    config: { port: 3000 },
    subscriptionmanager: {
      subscribe: (request, unsubscribes, _onError, onDelta) => {
        const subscribedPath = request.subscribe[0].path
        subscriptions.set(subscribedPath, onDelta)
        unsubscribes.push(() => subscriptions.delete(subscribedPath))
      }
    }
  }
}

function send(app, signalKPath, value) {
  assert.ok(app.subscriptions.has(signalKPath), `No subscription for ${signalKPath}`)
  const delta = { updates: [{ values: [{ path: signalKPath, value }] }] }
  for (const callback of app.subscriptions.values()) {
    callback(delta)
  }
}

function sendValues(app, values) {
  for (const entry of values) {
    assert.ok(app.subscriptions.has(entry.path), `No subscription for ${entry.path}`)
  }
  const delta = { updates: [{ values }] }
  for (const callback of app.subscriptions.values()) {
    callback(delta)
  }
}

function publishedValues(messages) {
  return messages.flatMap(message => message.updates ?? []).flatMap(update => update.values ?? [])
}

function lastValue(values, signalKPath) {
  return values.findLast(entry => entry.path === signalKPath)?.value
}

function assertClose(actual, expected, tolerance = 1e-2) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}

describe('performance output publication', () => {
  it('keeps actual VMG live in irons and clears stale polar-derived VMG outputs', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-performance-'))
    fs.writeFileSync(path.join(dataDir, 'test.json'), JSON.stringify(TEST_POLAR))
    const app = makeApp(dataDir)
    const plugin = require('../plugin/index.js')(app)

    try {
      plugin.start({
        settingsVersion: 1,
        activePolar: 'test',
        smootherType: 'None',
        VMG: true
      })

      send(app, 'navigation.speedThroughWater', 3)
      sendValues(app, [
        { path: 'environment.wind.speedTrue', value: 5 },
        { path: 'environment.wind.angleTrueWater', value: Math.PI / 2 }
      ])

      const validValues = publishedValues(app.messages)
      assert.equal(Number.isFinite(lastValue(validValues, 'performance.velocityMadeGood')), true)
      assert.equal(Number.isFinite(lastValue(validValues, 'performance.polarVelocityMadeGood')), true)
      assert.equal(Number.isFinite(lastValue(validValues, 'performance.polarVelocityMadeGoodRatio')), true)

      const beforeInvalid = app.messages.length
      sendValues(app, [
        { path: 'environment.wind.speedTrue', value: NaN },
        { path: 'environment.wind.angleTrueWater', value: NaN }
      ])
      const invalidValues = publishedValues(app.messages.slice(beforeInvalid))
      assert.equal(invalidValues.every(entry => entry.value === null || Number.isFinite(entry.value)), true)

      const beforeIrons = app.messages.length
      sendValues(app, [
        { path: 'environment.wind.speedTrue', value: 0.05 },
        { path: 'environment.wind.angleTrueWater', value: 0.1 }
      ])

      const ironsValues = publishedValues(app.messages.slice(beforeIrons))
    assert.equal(Number.isFinite(lastValue(ironsValues, 'performance.velocityMadeGood')), true)
      assert.equal(lastValue(ironsValues, 'performance.polarVelocityMadeGood'), null)
      assert.equal(lastValue(ironsValues, 'performance.polarVelocityMadeGoodRatio'), null)
    } finally {
      plugin.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})