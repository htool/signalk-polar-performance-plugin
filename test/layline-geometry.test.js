'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { bearingToLocal, forwardRayIntersection, validGraph } = require('../public/layline-geometry.js')

const graph = {
  available: true, frame: 'ground', waypointBearing: 0, selectedTack: 'port',
  heading: 0,
  portTrack: Math.PI / 4, starboardTrack: (2 * Math.PI) - Math.PI / 4,
  actual: { speed: 2, track: 0 }, current: { speed: 1, track: Math.PI / 2 }, crossing: null
}

describe('layline graph geometry', () => {
  it('maps compass bearings to north-up, east-right canvas directions', () => {
    assert.deepEqual(bearingToLocal(0), { x: 0, y: -1 })
    assert.ok(Math.abs(bearingToLocal(Math.PI / 2).x - 1) < 1e-12)
  })

  it('requires complete frame-consistent inputs', () => {
    assert.equal(validGraph(graph), true)
    assert.equal(validGraph({ ...graph, heading: null }), true)
    assert.equal(validGraph({ ...graph, current: null }), false)
    assert.equal(validGraph({ ...graph, frame: 'water', current: { speed: 1, track: 0 } }), false)
    assert.equal(validGraph({ ...graph, actual: { speed: 0, track: 0 } }), false)
  })

  it('finds only forward intersections with the waypoint layline', () => {
    const crossing = forwardRayIntersection(0, Math.PI / 4, 0, 100)
    assert.ok(crossing)
    assert.ok(crossing.rayDistance > 0)
    assert.equal(forwardRayIntersection(0, 0, 0, 100), null)
    assert.equal(forwardRayIntersection(Math.PI, Math.PI / 4, 0, 100), null)
  })
})