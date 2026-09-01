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
        subscriptions.set(subscribedPath, onDelta)
        unsubscribes.push(() => subscriptions.delete(subscribedPath))
      }
    }
  }
}

function send(app, path, value) {
  const callback = app.subscriptions.get(path)
  assert.ok(callback, `No subscription for ${path}`)
  callback({ updates: [{ values: [{ path, value }] }] })
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

      send(app, 'environment.wind.speedTrue', 5)
      send(app, 'environment.wind.angleTrueWater', Math.PI / 4)
      send(app, 'environment.wind.directionTrue', 0)
      send(app, 'navigation.speedOverGround', 3)
      send(app, 'navigation.courseOverGroundTrue', -0.2)
      send(app, 'navigation.course.calcValues.bearingTrue', 0)
      send(app, 'navigation.position', { latitude: 0, longitude: 0 })
      send(app, 'navigation.courseGreatCircle.nextPoint.position', { latitude: 0.01, longitude: 0 })

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
        mode: 'fallbackZero',
        warning: true
      })
      assert.ok(statusResponse.body.inputs.smoothed.cog > 2 * Math.PI - 0.21)
      assert.deepEqual(statusResponse.body.inputs.raw.position, { latitude: 0, longitude: 0 })
      assert.deepEqual(statusResponse.body.inputs.raw.waypoint, { latitude: 0.01, longitude: 0 })

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
})