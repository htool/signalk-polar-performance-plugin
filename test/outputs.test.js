'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Polar } = require('polar-math')

const KNOTS = 1 / 1.94384
const rad = degrees => degrees * Math.PI / 180
const target = (degrees, knots) => {
  const twa = rad(degrees)
  const tbs = knots * KNOTS
  return { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
}

const TABLE = {
  kind: 'polarTable', schemaVersion: '1.0.0', name: 'Reference Polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { tws: [4, 12, 24].map(k => k * KNOTS), twa: [52, 60, 75, 90, 110, 120, 135, 150].map(rad) },
  values: { boatSpeedMatrix: [
    [3.66, 3.88, 4, 3.9, 3.7, 3.54, 3.12, 2.56],
    [6.42, 6.58, 6.72, 6.82, 6.89, 6.83, 6.62, 6.25],
    [6.69, 6.91, 7.27, 7.61, 8.04, 8.44, 8.54, 8.18]
  ].map(row => row.map(k => k * KNOTS)) },
  derived: { rows: [
    { tws: 4 * KNOTS, beat: target(43.2, 3.24), run: target(147.5, 2.63) },
    { tws: 12 * KNOTS, beat: target(39.6, 5.84), run: target(162.4, 5.83) },
    { tws: 24 * KNOTS, beat: target(40.6, 6.11), run: target(178.6, 7.63) }
  ] }
}

// Downwind-only polar: no beat targets exist, so upwind targets are unavailable.
const DOWNWIND_ONLY = {
  kind: 'polarTable', schemaVersion: '1.0.0', name: 'Downwind Only',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: { tws: [12 * KNOTS], twa: [90, 120, 150].map(rad) },
  values: { boatSpeedMatrix: [[6.8, 6.8, 6.2].map(k => k * KNOTS)] }
}

// settingsVersion skips migration, which would otherwise force Exponential smoothing
const ALL_OUTPUTS = {
  settingsVersion: 2, smootherType: 'None',
  beatAngle: true, beatVMG: true, targetTWA: true, optimumWindAngle: true,
  VMG: true, maxSpeed: true, polarSpeed: true, tackTrue: true, smoothedInputs: true
}

const TWS = 12 * KNOTS
const reference = Polar.fromTable(TABLE)
const targets = reference.targetsAt({ tws: TWS }).value
const close = (actual, expected, msg) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`)

function harness(table = TABLE) {
  const subscribers = new Map()
  const bus = new Map()      // latest value per path written by the plugin
  const writes = []          // every { path, value } written, in order
  const app = {
    debug: () => {}, error: () => {},
    setPluginStatus: () => {}, setPluginError: () => {},
    savePluginOptions: (_o, cb) => cb(null),
    getDataDirPath: () => '.',
    handleMessage: (_id, delta) => {
      for (const update of delta.updates) {
        for (const { path, value } of update.values || []) {
          bus.set(path, value)
          writes.push({ path, value })
        }
      }
    },
    resourcesApi: {
      listResources: async () => ({}),
      getResource: async () => table
    },
    subscriptionmanager: {
      subscribe: (msg, unsubscribes, _err, callback) => {
        for (const { path } of msg.subscribe) {
          if (!subscribers.has(path)) subscribers.set(path, new Set())
          subscribers.get(path).add(callback)
        }
        unsubscribes.push(() => {
          for (const { path } of msg.subscribe) subscribers.get(path).delete(callback)
        })
      }
    }
  }
  delete require.cache[require.resolve('../plugin/index.js')]
  const plugin = require('../plugin/index.js')(app)
  const routes = {}
  plugin.registerWithRouter({
    use: () => {}, get: (p, cb) => { routes[p] = cb },
    put: (p, cb) => { routes[`PUT ${p}`] = cb }, post: () => {}, delete: () => {}
  })

  const deliver = (path, value) => {
    for (const callback of subscribers.get(path) || []) {
      callback({ updates: [{ $source: 'test', values: [{ path, value }] }] })
    }
  }
  return {
    app, plugin, bus, writes, routes, deliver,
    async start(options = ALL_OUTPUTS) {
      plugin.start(options)
      deliver('polars.activePolar', { href: '/resources/polars/ref' })
      await new Promise(resolve => setImmediate(resolve))
    },
    sail({ tws = TWS, twa, bsp, hdg }) {
      if (bsp !== undefined) deliver('navigation.speedThroughWater', bsp)
      if (hdg !== undefined) deliver('navigation.headingTrue', hdg)
      deliver('environment.wind.speedTrue', tws)
      deliver('environment.wind.angleTrueWater', twa)
    },
    status() {
      let result
      routes['/status']({}, { json: value => { result = value } })
      return result
    }
  }
}

describe('computeAndSend output validity', () => {
  let h

  beforeEach(() => { h = harness() })
  afterEach(() => {
    try { h.plugin.stop() } catch (_) {}
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('publishes every output while sailing normally upwind on starboard', async () => {
    await h.start()
    const twa = rad(50)
    const bsp = 6 * KNOTS
    h.sail({ twa, bsp, hdg: 1 })
    const polarSpeed = reference.speedAt({ tws: TWS, twa }).value
    const vmg = bsp * Math.cos(twa)
    close(h.bus.get('performance.polarSpeed'), polarSpeed, 'polarSpeed')
    close(h.bus.get('performance.polarSpeedRatio'), bsp / polarSpeed, 'polarSpeedRatio')
    close(h.bus.get('performance.targetSpeed'), targets.beat.vmg / Math.cos(targets.beat.twa), 'targetSpeed')
    close(h.bus.get('performance.targetAngle'), targets.beat.twa, 'targetAngle')
    close(h.bus.get('performance.targetVelocityMadeGood'), targets.beat.vmg, 'targetVMG')
    close(h.bus.get('performance.velocityMadeGood'), vmg, 'VMG')
    close(h.bus.get('performance.polarVelocityMadeGood'), targets.beat.vmg, 'polarVMG')
    close(h.bus.get('performance.polarVelocityMadeGoodRatio'), vmg / targets.beat.vmg, 'VMG ratio')
    close(h.bus.get('performance.beatAngle'), targets.beat.twa, 'beatAngle')
    close(h.bus.get('performance.gybeAngle'), targets.run.twa, 'gybeAngle')
    close(h.bus.get('performance.optimumWindAngle'), twa - targets.beat.twa, 'optimumWindAngle')
    close(h.bus.get('performance.tackTrue'), 1 + targets.beat.twa, 'tackTrue')
    close(h.bus.get('environment.wind.angleTrueWaterDamped'), twa, 'damped TWA')
    close(h.bus.get('performance.boatSpeedDamped'), bsp, 'damped BSP')
  })

  it('in irons clears polar values, keeps steering advice and VMG live, and restores them on leaving', async () => {
    await h.start()
    const bsp = 4 * KNOTS
    h.sail({ twa: rad(50), bsp, hdg: 1 })
    assert.ok(h.bus.get('performance.polarSpeed') > 0)

    const ironsTwa = rad(20)
    assert.equal(reference.speedAt({ tws: TWS, twa: ironsTwa }).state.twa, 'in_irons')
    h.sail({ twa: ironsTwa, bsp, hdg: 1 })
    for (const path of ['performance.polarSpeed', 'performance.polarSpeedRatio', 'performance.targetSpeed',
      'performance.targetVelocityMadeGood', 'performance.polarVelocityMadeGood',
      'performance.polarVelocityMadeGoodRatio', 'performance.beatAngle', 'performance.gybeAngle',
      'performance.beatAngleVelocityMadeGood', 'performance.gybeAngleVelocityMadeGood',
      'performance.maxSpeed', 'performance.maxSpeedAngle']) {
      assert.equal(h.bus.get(path), null, path)
    }
    close(h.bus.get('performance.targetAngle'), targets.beat.twa, 'targetAngle in irons')
    close(h.bus.get('performance.optimumWindAngle'), ironsTwa - targets.beat.twa, 'optimumWindAngle in irons')
    close(h.bus.get('performance.tackTrue'), 1 + targets.beat.twa, 'tackTrue in irons')
    close(h.bus.get('performance.velocityMadeGood'), bsp * Math.cos(ironsTwa), 'VMG in irons')

    // VMG must keep updating while in irons, not freeze
    h.sail({ twa: ironsTwa, bsp: 2 * KNOTS })
    close(h.bus.get('performance.velocityMadeGood'), 2 * KNOTS * Math.cos(ironsTwa), 'VMG updates in irons')

    const status = h.status()
    assert.equal(status.outputs['performance.polarSpeed'], null)
    assert.equal(status.outputs['performance.targetSpeed'], null)

    // Pinching is not in irons, so nothing is cleared
    const pinchTwa = rad(38)
    assert.equal(reference.speedAt({ tws: TWS, twa: pinchTwa }).state.twa, 'pinching')
    h.sail({ twa: pinchTwa, bsp })
    close(h.bus.get('performance.targetSpeed'), targets.beat.vmg / Math.cos(targets.beat.twa), 'targetSpeed pinching')
    close(h.bus.get('performance.targetVelocityMadeGood'), targets.beat.vmg, 'targetVMG pinching')
    close(h.bus.get('performance.polarVelocityMadeGood'), targets.beat.vmg, 'polarVMG pinching')
    close(h.bus.get('performance.polarVelocityMadeGoodRatio'), bsp * Math.cos(pinchTwa) / targets.beat.vmg, 'ratio pinching')
    close(h.bus.get('performance.beatAngle'), targets.beat.twa, 'beatAngle pinching')
    assert.ok(h.bus.get('performance.maxSpeed') > 0)

    h.sail({ twa: rad(50), bsp })
    const polarSpeed = reference.speedAt({ tws: TWS, twa: rad(50) }).value
    close(h.bus.get('performance.polarSpeed'), polarSpeed, 'polarSpeed after irons')
    close(h.bus.get('performance.polarSpeedRatio'), bsp / polarSpeed, 'ratio after irons')
    close(h.bus.get('performance.targetSpeed'), targets.beat.vmg / Math.cos(targets.beat.twa), 'targetSpeed after irons')
  })

  it('clears unavailable outputs only once per transition', async () => {
    await h.start()
    h.sail({ twa: rad(50), bsp: 4 * KNOTS })
    h.sail({ twa: rad(20), bsp: 4 * KNOTS })
    h.sail({ twa: rad(21), bsp: 4 * KNOTS })
    const polarSpeedNulls = h.writes.filter(w => w.path === 'performance.polarSpeed' && w.value === null)
    assert.equal(polarSpeedNulls.length, 1)
  })

  it('mirrors signed angles and keeps magnitudes on port tack', async () => {
    await h.start()
    const twa = rad(-50)
    const bsp = 6 * KNOTS
    h.sail({ twa, bsp, hdg: 1 })
    close(h.bus.get('performance.targetAngle'), -targets.beat.twa, 'targetAngle port')
    close(h.bus.get('performance.beatAngle'), -targets.beat.twa, 'beatAngle port')
    close(h.bus.get('performance.optimumWindAngle'), -(rad(50) - targets.beat.twa), 'optimumWindAngle port')
    close(h.bus.get('performance.tackTrue'), 1 - targets.beat.twa, 'tackTrue port')
    close(h.bus.get('performance.targetSpeed'), targets.beat.vmg / Math.cos(targets.beat.twa), 'targetSpeed port')
    close(h.bus.get('performance.velocityMadeGood'), bsp * Math.cos(rad(50)), 'VMG port')

    h.sail({ twa: rad(-20), bsp })
    assert.equal(h.bus.get('performance.polarSpeed'), null)
    assert.equal(h.bus.get('performance.targetSpeed'), null)
    assert.equal(h.bus.get('performance.targetVelocityMadeGood'), null)
    assert.equal(h.bus.get('performance.beatAngle'), null)
    close(h.bus.get('performance.targetAngle'), -targets.beat.twa, 'targetAngle port irons')
    close(h.bus.get('performance.optimumWindAngle'), -(rad(20) - targets.beat.twa), 'optimumWindAngle port irons')
    close(h.bus.get('performance.tackTrue'), 1 - targets.beat.twa, 'tackTrue port irons')
  })

  it('selects run targets when sailing downwind', async () => {
    await h.start()
    const twa = rad(150)
    const bsp = 6 * KNOTS
    h.sail({ twa, bsp, hdg: 1 })
    const vmg = bsp * Math.cos(twa)
    close(h.bus.get('performance.targetAngle'), targets.run.twa, 'run targetAngle')
    close(h.bus.get('performance.targetVelocityMadeGood'), targets.run.vmg, 'run targetVMG')
    close(h.bus.get('performance.targetSpeed'), targets.run.vmg / Math.abs(Math.cos(targets.run.twa)), 'run targetSpeed')
    close(h.bus.get('performance.velocityMadeGood'), vmg, 'downwind VMG is negative')
    assert.ok(vmg < 0)
    close(h.bus.get('performance.polarVelocityMadeGoodRatio'), Math.abs(vmg) / targets.run.vmg, 'downwind ratio')
    close(h.bus.get('performance.optimumWindAngle'), twa - targets.run.twa, 'downwind optimumWindAngle')
    close(h.bus.get('performance.tackTrue'), 1 + targets.run.twa, 'downwind tackTrue')
  })

  it('clears BSP-dependent outputs when boat speed is missing', async () => {
    await h.start()
    h.sail({ twa: rad(50), bsp: 6 * KNOTS })
    assert.ok(h.bus.get('performance.velocityMadeGood') > 0)
    h.sail({ twa: rad(50), bsp: null })
    for (const path of ['performance.velocityMadeGood', 'performance.polarVelocityMadeGoodRatio',
      'performance.polarSpeedRatio', 'performance.boatSpeedDamped']) {
      assert.equal(h.bus.get(path), null, path)
    }
    assert.ok(h.bus.get('performance.polarSpeed') > 0)
    assert.ok(h.bus.get('performance.targetSpeed') > 0)
    close(h.bus.get('performance.polarVelocityMadeGood'), targets.beat.vmg, 'polarVMG without BSP')
  })

  it('clears target-dependent outputs when polar targets are unavailable', async () => {
    h = harness(DOWNWIND_ONLY)
    await h.start()
    const noBeat = Polar.fromTable(DOWNWIND_ONLY).targetsAt({ tws: TWS }).value
    assert.equal(noBeat.beat, null)

    h.sail({ twa: rad(150), bsp: 6 * KNOTS, hdg: 1 })
    assert.ok(h.bus.get('performance.targetSpeed') > 0)
    assert.ok(h.bus.get('performance.polarVelocityMadeGood') > 0)

    h.sail({ twa: rad(60), bsp: 6 * KNOTS, hdg: 1 })
    for (const path of ['performance.targetSpeed', 'performance.targetAngle',
      'performance.targetVelocityMadeGood', 'performance.polarVelocityMadeGood',
      'performance.polarVelocityMadeGoodRatio', 'performance.beatAngle',
      'performance.beatAngleVelocityMadeGood', 'performance.optimumWindAngle', 'performance.tackTrue']) {
      assert.equal(h.bus.get(path), null, path)
    }
    close(h.bus.get('performance.velocityMadeGood'), 6 * KNOTS * Math.cos(rad(60)), 'actual VMG without targets')
  })

  it('does not publish disabled outputs and clears outputs toggled off or on stop', async () => {
    await h.start({ settingsVersion: 2, smootherType: 'None', polarSpeed: true })
    h.sail({ twa: rad(50), bsp: 4 * KNOTS })
    const published = new Set(h.writes.map(w => w.path))
    assert.deepEqual([...published].sort(),
      ['performance.polarSpeed', 'performance.polarSpeedRatio', 'performance.targetSpeed'])
    assert.ok(h.bus.get('performance.targetSpeed') > 0)

    h.routes['PUT /settings']({ body: { polarSpeed: false } }, { json: () => {} })
    assert.equal(h.bus.get('performance.targetSpeed'), null)
    const before = h.writes.length
    h.sail({ twa: rad(50), bsp: 4 * KNOTS })
    assert.equal(h.writes.length, before, 'disabled outputs must not be written')

    h.routes['PUT /settings']({ body: { polarSpeed: true } }, { json: () => {} })
    h.sail({ twa: rad(50), bsp: 4 * KNOTS })
    assert.ok(h.bus.get('performance.polarSpeed') > 0)
    h.plugin.stop()
    for (const path of ['performance.polarSpeed', 'performance.targetSpeed', 'performance.polarSpeedRatio']) {
      assert.equal(h.bus.get(path), null, path)
    }
  })
})
