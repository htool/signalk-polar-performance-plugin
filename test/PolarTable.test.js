'use strict'

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const { PolarTable } = require('../plugin/PolarTable')
const SI = require('../plugin/SI')

// Real ORC CSV polar (Jieter format) — beat/run rows use per-column non-zero pattern
const CSV = `twa/tws;4;6;8;10;12;14;16;20;24
43.2; 3.24; 0; 0; 0; 0; 0; 0; 0; 0
43.2; 0; 4.4; 0; 0; 0; 0; 0; 0; 0
41.2; 0; 0; 5.1; 0; 0; 0; 0; 0; 0
40; 0; 0; 0; 5.57; 0; 0; 0; 0; 0
39.6; 0; 0; 0; 0; 5.84; 0; 0; 0; 0
39; 0; 0; 0; 0; 0; 5.93; 0; 0; 0
39.2; 0; 0; 0; 0; 0; 0; 6.03; 0; 0
39.4; 0; 0; 0; 0; 0; 0; 0; 6.08; 0
40.6; 0; 0; 0; 0; 0; 0; 0; 0; 6.11
52; 3.66; 4.87; 5.68; 6.16; 6.42; 6.55; 6.62; 6.68; 6.69
60; 3.88; 5.11; 5.9; 6.33; 6.58; 6.73; 6.8; 6.88; 6.91
75; 4; 5.26; 6.04; 6.46; 6.72; 6.91; 7.04; 7.19; 7.27
90; 3.9; 5.16; 6; 6.51; 6.82; 7.01; 7.14; 7.43; 7.61
110; 3.7; 5.04; 6.02; 6.57; 6.89; 7.16; 7.41; 7.81; 8.04
120; 3.54; 4.85; 5.84; 6.47; 6.83; 7.1; 7.37; 7.96; 8.44
135; 3.12; 4.34; 5.35; 6.13; 6.62; 6.94; 7.22; 7.82; 8.54
150; 2.56; 3.71; 4.74; 5.59; 6.25; 6.67; 6.96; 7.52; 8.18
147.5; 2.63; 0; 0; 0; 0; 0; 0; 0; 0
147.5; 0; 3.81; 0; 0; 0; 0; 0; 0; 0
152.1; 0; 0; 4.65; 0; 0; 0; 0; 0; 0
156.1; 0; 0; 0; 5.34; 0; 0; 0; 0; 0
162.4; 0; 0; 0; 0; 5.83; 0; 0; 0; 0
168.9; 0; 0; 0; 0; 0; 6.24; 0; 0; 0
177.7; 0; 0; 0; 0; 0; 0; 6.54; 0; 0
179; 0; 0; 0; 0; 0; 0; 0; 7.1; 0
178.6; 0; 0; 0; 0; 0; 0; 0; 0; 7.63`

function approxEqual(a, b, tol = 0.01) {
  return Math.abs(a - b) <= tol
}

describe('PolarTable — empty table', () => {
  const polar = new PolarTable()

  it('defaults to perfAdjust 1.0', () => {
    assert.equal(polar.getPerformanceAdjustment(), 1)
  })

  it('setBeatAngle returns null', () => assert.equal(polar.getBeatAngle(SI.fromKnots(10)), null))
  it('getRunAngle returns null', () => assert.equal(polar.getRunAngle(SI.fromKnots(10)), null))
  it('getBeatVMG returns null', () => assert.equal(polar.getBeatVMG(SI.fromKnots(10)), null))
  it('getRunVMG returns null', () => assert.equal(polar.getRunVMG(SI.fromKnots(10)), null))
  it('getMaxSpeed returns null', () => assert.equal(polar.getMaxSpeed(SI.fromKnots(10)), null))
  it('getBoatSpeed returns null', () => assert.equal(polar.getBoatSpeed(SI.fromKnots(10), SI.fromDegrees(90)), null))
})

describe('PolarTable — loading', () => {
  it('loadFromJieter returns the instance (chainable)', () => {
    const polar = new PolarTable()
    assert.equal(polar.loadFromJieter(CSV), polar)
  })

  it('table is a non-empty array after loading', () => {
    const polar = new PolarTable().loadFromJieter(CSV)
    assert.ok(Array.isArray(polar.table))
    assert.ok(polar.table.length > 0)
  })

  it('each TWS entry has required properties', () => {
    const polar = new PolarTable().loadFromJieter(CSV)
    for (const entry of polar.table) {
      assert.ok(typeof entry.tws === 'number', 'tws is a number')
      assert.ok(Array.isArray(entry.twa), 'twa array exists')
      assert.ok(typeof entry['Beat angle'] === 'number', 'Beat angle set')
      assert.ok(typeof entry['Run angle'] === 'number', 'Run angle set')
      assert.ok(typeof entry['Beat VMG'] === 'number', 'Beat VMG set')
      assert.ok(typeof entry['Run VMG'] === 'number', 'Run VMG set')
      assert.ok(typeof entry['Max speed'] === 'number', 'Max speed set')
    }
  })

  it('TWA arrays are sorted ascending', () => {
    const polar = new PolarTable().loadFromJieter(CSV)
    for (const entry of polar.table) {
      for (let i = 1; i < entry.twa.length; i++) {
        assert.ok(entry.twa[i].twa >= entry.twa[i - 1].twa,
          `TWA array not sorted at TWS ${SI.toKnots(entry.tws).toFixed(0)} kt`)
      }
    }
  })

  it('duplicate TWA entries are deduplicated (upsert keeps last)', () => {
    // CSV has two rows at 43.2° (one for tws=4, one for tws=6) and two rows at 147.5°
    // After loading, each TWS column should have exactly one entry per angle
    const polar = new PolarTable().loadFromJieter(CSV)
    for (const entry of polar.table) {
      const angles = entry.twa.map(t => t.twa)
      const unique = new Set(angles.map(a => a.toFixed(6)))
      assert.equal(unique.size, angles.length,
        `Duplicate TWA found in TWS ${SI.toKnots(entry.tws).toFixed(0)} kt column`)
    }
  })
})

describe('PolarTable — interpolation', () => {
  let polar

  before(() => { polar = new PolarTable().loadFromJieter(CSV) })

  it('getBoatSpeed at exact data point (90° / 12 kt)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(90))
    assert.ok(approxEqual(speed, SI.fromKnots(6.82), 0.05),
      `Expected ~6.82 kt, got ${SI.toKnots(speed).toFixed(3)} kt`)
  })

  it('getBoatSpeed interpolates between TWS values (13 kt)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(13), SI.fromDegrees(90))
    const expected = (SI.fromKnots(6.82) + SI.fromKnots(7.01)) / 2
    assert.ok(approxEqual(speed, expected, 0.1),
      `Expected ~${SI.toKnots(expected).toFixed(2)} kt, got ${SI.toKnots(speed).toFixed(2)} kt`)
  })

  it('getBoatSpeed interpolates between TWA values (82.5°)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(82.5))
    const expected = (SI.fromKnots(6.72) + SI.fromKnots(6.82)) / 2
    assert.ok(approxEqual(speed, expected, 0.15),
      `Expected ~${SI.toKnots(expected).toFixed(2)} kt, got ${SI.toKnots(speed).toFixed(2)} kt`)
  })

  it('getBoatSpeed clamps above TWS range (30 kt)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(30), SI.fromDegrees(90))
    assert.ok(speed !== null && speed > 0)
  })

  it('getBoatSpeed handles very low TWS (2 kt)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(2), SI.fromDegrees(90))
    assert.ok(speed !== null && speed >= 0)
  })

  it('getBoatSpeed returns null at 0° (in irons, below 90% of beat angle)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(12), 0)
    assert.equal(speed, null)
  })

  it('getBoatSpeed returns interpolated value in pinching region (between 90% and 100% of beat angle)', () => {
    // Beat angle at 12 kt is ~39.6°. 90% = ~35.6°. Test at 95% (just inside the ramp).
    const beatAngle = polar.getBeatAngle(SI.fromKnots(12))
    const testAngle = 0.95 * beatAngle  // inside the ramp
    const speed = polar.getBoatSpeed(SI.fromKnots(12), testAngle)
    assert.ok(speed !== null && speed > 0 && speed < polar.getBoatSpeed(SI.fromKnots(12), beatAngle),
      `Expected interpolated speed between 0 and beat speed, got ${speed}`)
  })

  it('getBoatSpeed handles 180° (dead downwind)', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(12), Math.PI)
    assert.ok(speed !== null)
  })
})

describe('PolarTable — port/starboard symmetry', () => {
  let polar

  before(() => { polar = new PolarTable().loadFromJieter(CSV) })

  for (const deg of [45, 90, 135]) {
    it(`getBoatSpeed is symmetric at ±${deg}°`, () => {
      const port = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(-deg))
      const stbd = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(deg))
      assert.ok(approxEqual(port, stbd, 0.001),
        `Port ${-deg}°: ${SI.toKnots(port).toFixed(3)} kt, stbd ${deg}°: ${SI.toKnots(stbd).toFixed(3)} kt`)
    })
  }

  it('getVMG magnitude is symmetric at ±60°', () => {
    const port = polar.getVMG(SI.fromKnots(12), SI.fromDegrees(-60))
    const stbd = polar.getVMG(SI.fromKnots(12), SI.fromDegrees(60))
    assert.ok(approxEqual(port, stbd, 0.001))
  })

  it('getVMG at ±90° is near zero', () => {
    for (const sign of [1, -1]) {
      const vmg = polar.getVMG(SI.fromKnots(12), SI.fromDegrees(sign * 90))
      assert.ok(Math.abs(vmg) < 0.05, `VMG at ${sign * 90}° = ${vmg.toFixed(4)} — expected ~0`)
    }
  })
})

describe('PolarTable — optimal angles', () => {
  let polar

  before(() => { polar = new PolarTable().loadFromJieter(CSV) })

  it('beat angle is in (0, π/2)', () => {
    const a = polar.getBeatAngle(SI.fromKnots(12))
    assert.ok(a > 0 && a < Math.PI / 2, `Beat angle ${SI.toDegrees(a).toFixed(1)}° out of range`)
  })

  it('run angle is in (π/2, π]', () => {
    const a = polar.getRunAngle(SI.fromKnots(12))
    assert.ok(a > Math.PI / 2 && a <= Math.PI, `Run angle ${SI.toDegrees(a).toFixed(1)}° out of range`)
  })

  it('beat VMG is positive', () => {
    assert.ok(polar.getBeatVMG(SI.fromKnots(12)) > 0)
  })

  it('run VMG is positive', () => {
    assert.ok(polar.getRunVMG(SI.fromKnots(12)) > 0)
  })

  it('max speed angle is in [0, π]', () => {
    const a = polar.getMaxSpeedAngle(SI.fromKnots(12))
    assert.ok(a >= 0 && a <= Math.PI)
  })
})

describe('PolarTable — performance adjustment', () => {
  let polar

  before(() => { polar = new PolarTable().loadFromJieter(CSV) })

  it('setPerformanceAdjustment / getPerformanceAdjustment round-trips', () => {
    polar.setPerformanceAdjustment(0.85)
    assert.equal(polar.getPerformanceAdjustment(), 0.85)
    polar.setPerformanceAdjustment(1)
  })

  it('getBoatSpeed scales linearly with perfAdjust', () => {
    polar.setPerformanceAdjustment(1)
    const base = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(90))
    polar.setPerformanceAdjustment(0.9)
    const scaled = polar.getBoatSpeed(SI.fromKnots(12), SI.fromDegrees(90))
    assert.ok(approxEqual(scaled, base * 0.9, 0.001))
    polar.setPerformanceAdjustment(1)
  })

  it('getBeatVMG scales linearly with perfAdjust', () => {
    polar.setPerformanceAdjustment(1)
    const base = polar.getBeatVMG(SI.fromKnots(12))
    polar.setPerformanceAdjustment(0.9)
    const scaled = polar.getBeatVMG(SI.fromKnots(12))
    assert.ok(approxEqual(scaled, base * 0.9, 0.001))
    polar.setPerformanceAdjustment(1)
  })

  it('getMaxSpeed scales linearly with perfAdjust', () => {
    polar.setPerformanceAdjustment(1)
    const base = polar.getMaxSpeed(SI.fromKnots(12))
    polar.setPerformanceAdjustment(0.9)
    const scaled = polar.getMaxSpeed(SI.fromKnots(12))
    assert.ok(approxEqual(scaled, base * 0.9, 0.001))
    polar.setPerformanceAdjustment(1)
  })

  it('angles are NOT affected by perfAdjust', () => {
    polar.setPerformanceAdjustment(1)
    const base = polar.getBeatAngle(SI.fromKnots(12))
    polar.setPerformanceAdjustment(0.7)
    const adjusted = polar.getBeatAngle(SI.fromKnots(12))
    assert.ok(approxEqual(base, adjusted, 0.0001))
    polar.setPerformanceAdjustment(1)
  })
})
