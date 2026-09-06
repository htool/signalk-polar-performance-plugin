'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LAYLINE_PATHS = [
  'navigation.racing.layline.distance',
  'navigation.racing.layline.time',
  'navigation.racing.oppositeLayline.distance',
  'navigation.racing.oppositeLayline.time'
]

const TEST_POLAR = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Navigation Test',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: {
    tws: [5, 10],
    twa: [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]
  },
  values: {
    boatSpeedMatrix: [
      [3, 4, 3],
      [4, 5, 4]
    ]
  },
  derived: {
    rows: [5, 10].map((tws, index) => ({
      tws,
      beat: { twa: Math.PI / 4, tbs: 3 + index, vmg: (3 + index) * Math.SQRT1_2 },
      run: { twa: 3 * Math.PI / 4, tbs: 3 + index, vmg: (3 + index) * Math.SQRT1_2 },
      maxSpeed: 4 + index,
      maxSpeedAngle: Math.PI / 2
    }))
  }
}

function makeRouter() {
  const routes = { get: {}, put: {} }
  return {
    routes,
    use: () => {},
    get: (route, handler) => { routes.get[route] = handler },
    put: (route, handler) => { routes.put[route] = handler },
    post: () => {},
    delete: () => {}
  }
}

function makeResponse() {
  return {
    body: null,
    status() { return this },
    json(value) { this.body = value; return this }
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
        const callbacks = subscriptions.get(subscribedPath) ?? new Set()
        callbacks.add(onDelta)
        subscriptions.set(subscribedPath, callbacks)
        unsubscribes.push(() => {
          callbacks.delete(onDelta)
          if (callbacks.size === 0) subscriptions.delete(subscribedPath)
        })
      }
    }
  }
}

function send(app, path, value) {
  const callbacks = app.subscriptions.get(path)
  assert.ok(callbacks, `No subscription for ${path}`)
  const delta = { updates: [{ values: [{ path, value }] }] }
  callbacks.forEach(callback => callback(delta))
}

function publishedValues(messages) {
  return messages.flatMap(message => message.updates ?? []).flatMap(update => update.values ?? [])
}

describe('navigation layline publication', () => {
  it('publishes both pairs, reports current fallback, then clears once and stays silent', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-navigation-'))
    fs.writeFileSync(path.join(dataDir, 'test.json'), JSON.stringify(TEST_POLAR))
    const app = makeApp(dataDir)
    const router = makeRouter()
    const plugin = require('../plugin/index.js')(app)
    plugin.registerWithRouter(router)

    try {
      plugin.start({
        activePolar: 'test',
        vmcNavigation: true,
        smootherType: 'None',
        ignoreCurrent: false
      })
      const settingsResponse = makeResponse()
      router.routes.get['/settings']({}, settingsResponse)
      assert.equal(settingsResponse.body.laylineAngleAllowance, 0)

      const invalidAllowanceResponse = makeResponse()
      router.routes.put['/settings']({ body: { laylineAngleAllowance: 11 * Math.PI / 180 } }, invalidAllowanceResponse)
      assert.match(invalidAllowanceResponse.body.error, /between -5 and 10 degrees/)

      const validAllowanceResponse = makeResponse()
      router.routes.put['/settings']({ body: { laylineAngleAllowance: 5 * Math.PI / 180 } }, validAllowanceResponse)
      assert.equal(validAllowanceResponse.body.laylineAngleAllowance, 5 * Math.PI / 180)

      assert.equal(app.subscriptions.get('environment.wind.speedTrue').size, 1)
      assert.equal(app.subscriptions.get('environment.wind.angleTrueWater').size, 1)

      send(app, 'environment.wind.speedTrue', 5)
      send(app, 'environment.wind.angleTrueWater', Math.PI / 4)
      send(app, 'environment.wind.directionTrue', 0)
      send(app, 'navigation.speedOverGround', 3)
      send(app, 'navigation.courseOverGroundTrue', -0.2)
      send(app, 'navigation.speedThroughWater', 3)
      send(app, 'navigation.headingTrue', -0.1)
      send(app, 'navigation.course.calcValues.bearingTrue', 0)
      send(app, 'navigation.position', { latitude: 0, longitude: 0 })
      send(app, 'navigation.courseGreatCircle.nextPoint.position', { latitude: 0.01, longitude: 0 })
      send(app, 'environment.current.drift', 2)
      send(app, 'environment.current.setTrue', 0.3)

      const values = publishedValues(app.messages)
      for (const outputPath of LAYLINE_PATHS) {
        const publication = values.findLast(entry => entry.path === outputPath)
        assert.ok(publication, `No publication for ${outputPath}`)
        assert.ok(Number.isFinite(publication.value), `Expected finite ${outputPath}`)
      }

      const statusResponse = makeResponse()
      router.routes.get['/status']({}, statusResponse)
      assert.equal(statusResponse.body.navigationState.status, 'valid')
      assert.deepEqual(statusResponse.body.navigationState.current, {
        mode: 'used',
        warning: false
      })
      assert.ok(((statusResponse.body.inputs.smoothed.cog % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) > 2 * Math.PI - 0.21)
      assert.deepEqual(statusResponse.body.inputs.raw.position, { latitude: 0, longitude: 0 })
      assert.deepEqual(statusResponse.body.inputs.raw.waypoint, { latitude: 0.01, longitude: 0 })
      assert.equal(statusResponse.body.inputs.raw.currentDrift, statusResponse.body.inputs.smoothed.currentDrift)
      assert.equal(statusResponse.body.inputs.raw.currentSetTrue, statusResponse.body.inputs.smoothed.currentSetTrue)
      assert.equal(Number.isFinite(statusResponse.body.inputs.navigation.tws), true)
      assert.equal(Number.isFinite(statusResponse.body.inputs.navigation.twa), true)
      assert.equal(statusResponse.body.laylineGraph.available, true)
      assert.equal(statusResponse.body.laylineGraph.frame, 'ground')
      assert.equal(statusResponse.body.laylineGraph.selectedTack, 'port')
      assert.ok(Math.abs(statusResponse.body.laylineGraph.heading - statusResponse.body.inputs.smoothed.hdg) < 1e-5)
      assert.equal(Number.isFinite(statusResponse.body.laylineGraph.portTrack), true)
      assert.equal(Number.isFinite(statusResponse.body.laylineGraph.starboardTrack), true)
      assert.equal(statusResponse.body.laylineGraph.actual.speed, 3)
      assert.ok(Math.abs(statusResponse.body.laylineGraph.actual.track - statusResponse.body.inputs.smoothed.cog) < 1e-5)
      assert.equal(statusResponse.body.laylineGraph.current.speed, 2)

      router.routes.put['/settings']({ body: { ignoreCurrent: true } }, makeResponse())
      send(app, 'navigation.speedThroughWater', 3)
      const waterResponse = makeResponse()
      router.routes.get['/status']({}, waterResponse)
      assert.equal(Number.isFinite(waterResponse.body.inputs.smoothed.hdg), true, JSON.stringify(waterResponse.body.inputs.smoothed))
      assert.equal(waterResponse.body.laylineGraph.available, true, JSON.stringify(waterResponse.body.laylineGraph))
      assert.equal(waterResponse.body.laylineGraph.frame, 'water')
      assert.equal(waterResponse.body.laylineGraph.current, null)
      assert.ok(Math.abs(waterResponse.body.laylineGraph.heading - waterResponse.body.inputs.smoothed.hdg) < 1e-5)
      assert.equal(waterResponse.body.laylineGraph.actual.speed, 3)
      assert.ok(Math.abs(waterResponse.body.laylineGraph.actual.track - ((2 * Math.PI) - 0.1)) < 1e-5)

      const beforeDisable = app.messages.length
      router.routes.put['/settings']({ body: { vmcNavigation: false } }, makeResponse())
      const disableValues = publishedValues(app.messages.slice(beforeDisable))
      for (const outputPath of LAYLINE_PATHS) {
        assert.equal(disableValues.filter(entry => entry.path === outputPath && entry.value === null).length, 1)
      }

      const afterDisable = app.messages.length
      send(app, 'environment.wind.speedTrue', 6)
      const postDisableValues = publishedValues(app.messages.slice(afterDisable))
      assert.equal(postDisableValues.some(entry => LAYLINE_PATHS.includes(entry.path)), false)

      const beforeStop = app.messages.length
      plugin.stop()
      const stopValues = publishedValues(app.messages.slice(beforeStop))
      assert.equal(stopValues.some(entry => LAYLINE_PATHS.includes(entry.path)), false)
    } finally {
      plugin.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('requires fresh post-manoeuvre leeway when correction is enabled', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-leeway-'))
    fs.writeFileSync(path.join(dataDir, 'test.json'), JSON.stringify(TEST_POLAR))
    const app = makeApp(dataDir)
    const router = makeRouter()
    const plugin = require('../plugin/index.js')(app)
    plugin.registerWithRouter(router)

    try {
      plugin.start({ activePolar: 'test', vmcNavigation: true, correctForLeeway: true, smootherType: 'None', ignoreCurrent: true })
      assert.equal(app.subscriptions.get('navigation.leewayAngle').size, 1)

      send(app, 'environment.wind.speedTrue', 5)
      send(app, 'environment.wind.angleTrueWater', Math.PI / 4)
      send(app, 'environment.wind.directionTrue', 0)
      send(app, 'navigation.speedOverGround', 3)
      send(app, 'navigation.courseOverGroundTrue', -0.2)
      send(app, 'navigation.speedThroughWater', 3)
      send(app, 'navigation.headingTrue', -0.1)
      send(app, 'navigation.course.calcValues.bearingTrue', 0)
      send(app, 'navigation.position', { latitude: 0, longitude: 0 })
      send(app, 'navigation.courseGreatCircle.nextPoint.position', { latitude: 0.01, longitude: 0 })
      send(app, 'navigation.leewayAngle', 0.08)

      const beforeTack = makeResponse()
      router.routes.get['/status']({}, beforeTack)
      assert.equal(beforeTack.body.navigationState.status, 'valid')
      assert.deepEqual(beforeTack.body.navigationState.leeway, { mode: 'used', warning: false })
      assert.equal(beforeTack.body.laylineGraph.leewayAngle, 0.08)
      assert.deepEqual(beforeTack.body.inputs.raw.waypoint, { latitude: 0.01, longitude: 0 })
      assert.equal(beforeTack.body.inputs.paths.waypoint, 'navigation.courseGreatCircle.nextPoint.position')

      send(app, 'environment.wind.angleTrueWater', 0)
      const duringTack = makeResponse()
      router.routes.get['/status']({}, duringTack)
      assert.equal(duringTack.body.navigationState.status, 'unavailable')
      assert.ok(duringTack.body.navigationState.structural.missing.includes('leeway'))
      assert.deepEqual(duringTack.body.navigationState.leeway, { mode: 'unavailable', warning: true })
      for (const outputPath of LAYLINE_PATHS) {
        assert.equal(duringTack.body.outputs[outputPath], null)
      }

      send(app, 'environment.wind.angleTrueWater', -Math.PI / 4)
      send(app, 'navigation.leewayAngle', -0.08)
      const afterTack = makeResponse()
      router.routes.get['/status']({}, afterTack)
      assert.equal(afterTack.body.navigationState.status, 'valid')
      assert.equal(afterTack.body.laylineGraph.leewayAngle, -0.08)
    } finally {
      plugin.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})