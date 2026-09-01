'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { LaylineCalculator } = require('../plugin/LaylineCalculator')

const calculator = new LaylineCalculator()
const ROOT_HALF = Math.SQRT1_2
const TARGETS = {
  port: { vector: { x: ROOT_HALF, y: -ROOT_HALF } },
  starboard: { vector: { x: ROOT_HALF, y: ROOT_HALF } }
}

function positionForMeters(north, east) {
  return {
    latitude: north / 111195,
    longitude: east / 111195
  }
}

function calculate(overrides = {}) {
  return calculator.calculate({
    enabled: true,
    structural: { ready: true, missing: [], stale: [] },
    position: { latitude: 0, longitude: 0 },
    waypoint: positionForMeters(1000, 0),
    sailingMode: 'upwind',
    currentTack: 'starboard',
    targets: TARGETS,
    currentVector: { x: 0, y: 0 },
    ignoreCurrent: false,
    ...overrides
  })
}

describe('LaylineCalculator', () => {
  it('calculates both symmetric layline crossings', () => {
    const result = calculate()

    assert.equal(result.status, 'valid')
    assert.ok(Math.abs(result.temporal.layline.distance - 707.1) < 0.5)
    assert.ok(Math.abs(result.temporal.oppositeLayline.distance - 707.1) < 0.5)
    assert.equal(result.current.mode, 'used')
  })

  it('returns a negative current-layline result after overstanding', () => {
    const result = calculate({ waypoint: positionForMeters(1000, -1500) })

    assert.equal(result.temporal.layline.status, 'valid')
    assert.ok(result.temporal.layline.distance < 0)
    assert.ok(result.temporal.layline.time < 0)
  })

  it('rejects an intersection whose onward leg points away from the waypoint', () => {
    const result = calculator.solveLeg(
      { x: 1000, y: 1500 },
      TARGETS.starboard.vector,
      TARGETS.port.vector
    )

    assert.deepEqual(result, {
      status: 'unavailable',
      reason: 'noForwardIntersection',
      distance: null,
      time: null
    })
  })

  it('falls back to zero current and records a warning', () => {
    const result = calculate({ currentVector: null })

    assert.equal(result.status, 'valid')
    assert.deepEqual(result.current, { mode: 'fallbackZero', warning: true })
  })

  it('reports reaching as temporal unavailability', () => {
    const result = calculate({ sailingMode: 'reaching' })

    assert.equal(result.status, 'unavailable')
    assert.equal(result.structural.ready, true)
    assert.equal(result.temporal.layline.reason, 'reaching')
    assert.equal(result.temporal.oppositeLayline.reason, 'reaching')
  })

  it('reports every missing structural prerequisite', () => {
    const result = calculate({
      structural: { missing: ['polar'], stale: ['wind'] },
      position: null,
      waypoint: null,
      targets: null,
      currentTack: null
    })

    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.structural.missing, ['polar', 'position', 'waypoint', 'targetVectors', 'currentTack'])
    assert.deepEqual(result.structural.stale, ['wind'])
  })
})