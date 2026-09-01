'use strict'

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const { PolarTable } = require('../plugin/PolarTable')
const SI = require('../plugin/SI')

function targetPoint(twaDeg, tbsKn) {
  const twa = SI.fromDegrees(twaDeg)
  const tbs = SI.fromKnots(tbsKn)
  return { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
}

const CANONICAL = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'Reference Polar',
  units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
  symmetry: { portStarboardSymmetric: true },
  axes: {
    tws: [SI.fromKnots(4), SI.fromKnots(12), SI.fromKnots(24)],
    twa: [52, 60, 75, 90, 110, 120, 135, 150].map(SI.fromDegrees)
  },
  values: {
    boatSpeedMatrix: [
      [3.66, 3.88, 4.00, 3.90, 3.70, 3.54, 3.12, 2.56].map(SI.fromKnots),
      [6.42, 6.58, 6.72, 6.82, 6.89, 6.83, 6.62, 6.25].map(SI.fromKnots),
      [6.69, 6.91, 7.27, 7.61, 8.04, 8.44, 8.54, 8.18].map(SI.fromKnots)
    ]
  },
  derived: {
    rows: [
      {
        tws: SI.fromKnots(4),
        beat: targetPoint(43.2, 3.24),
        run: targetPoint(147.5, 2.63),
        maxSpeed: SI.fromKnots(4),
        maxSpeedAngle: SI.fromDegrees(75)
      },
      {
        tws: SI.fromKnots(12),
        beat: targetPoint(39.6, 5.84),
        run: targetPoint(162.4, 5.83),
        maxSpeed: SI.fromKnots(6.89),
        maxSpeedAngle: SI.fromDegrees(110)
      },
      {
        tws: SI.fromKnots(24),
        beat: targetPoint(40.6, 6.11),
        run: targetPoint(178.6, 7.63),
        maxSpeed: SI.fromKnots(8.54),
        maxSpeedAngle: SI.fromDegrees(135)
      }
    ]
  }
}

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
  it('loadFromCanonical returns the instance (chainable)', () => {
    const polar = new PolarTable()
    assert.equal(polar.loadFromCanonical(CANONICAL), polar)
  })

  it('table is a non-empty array after loading', () => {
    const polar = new PolarTable().loadFromCanonical(CANONICAL)
    assert.ok(Array.isArray(polar.table))
    assert.ok(polar.table.length > 0)
  })

  it('each TWS entry has required properties', () => {
    const polar = new PolarTable().loadFromCanonical(CANONICAL)
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
    const polar = new PolarTable().loadFromCanonical(CANONICAL)
    for (const entry of polar.table) {
      for (let i = 1; i < entry.twa.length; i++) {
        assert.ok(entry.twa[i].twa >= entry.twa[i - 1].twa,
          `TWA array not sorted at TWS ${SI.toKnots(entry.tws).toFixed(0)} kt`)
      }
    }
  })

  it('derived beat/run points are merged without duplicate TWAs', () => {
    const polar = new PolarTable().loadFromCanonical(CANONICAL)
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

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

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

})

describe('PolarTable — interpolation state', () => {
  // Test CSV at 12 kt: beat angle ≈ 39.6°, last tabulated TWA = 162.4° (run angle row),
  // extrapLimit = 162.4 + (180−162.4)×0.3 ≈ 167.7°
  let polar

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

  it('returns null for an empty table', () => {
    assert.equal(new PolarTable().getInterpolationState(SI.fromKnots(12), SI.fromDegrees(90)), null)
  })

  // ── TWS axis ──────────────────────────────────────────────────────────────
  it('TWS below_range (2 kt — below polar minimum of 4 kt)', () => {
    const { tws } = polar.getInterpolationState(SI.fromKnots(2), SI.fromDegrees(90))
    assert.equal(tws, 'below_range')
  })

  it('TWS in_range (12 kt)', () => {
    const { tws } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(90))
    assert.equal(tws, 'in_range')
  })

  it('TWS above_range (30 kt — above polar maximum of 24 kt)', () => {
    const { tws } = polar.getInterpolationState(SI.fromKnots(30), SI.fromDegrees(90))
    assert.equal(tws, 'above_range')
  })

  // ── TWA axis at 12 kt ─────────────────────────────────────────────────────
  it('TWA in_irons (10° — below 90 % of beat angle ≈ 35.6°)', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(10))
    assert.equal(twa, 'in_irons')
  })

  it('TWA pinching (95 % of beat angle — between pinch and beat)', () => {
    const beatAngle = polar.getBeatAngle(SI.fromKnots(12))
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), 0.95 * beatAngle)
    assert.equal(twa, 'pinching')
  })

  it('TWA in_range (90°)', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(90))
    assert.equal(twa, 'in_range')
  })

  it('TWA in_range at last tabulated angle (162° — just inside run angle 162.4°)', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(162))
    assert.equal(twa, 'in_range')
  })

  it('TWA extrapolated (165° — between run angle 162.4° and extrap limit ≈ 167.7°)', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(165))
    assert.equal(twa, 'extrapolated')
  })

  it('TWA above_range (170° — beyond extrap limit ≈ 167.7°)', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(170))
    assert.equal(twa, 'above_range')
  })

  it('dead downwind (180°) is above_range at 12 kt', () => {
    const { twa } = polar.getInterpolationState(SI.fromKnots(12), Math.PI)
    assert.equal(twa, 'above_range')
  })

  it('port tack (-90°) gives the same state as starboard (+90°)', () => {
    const port = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(-90))
    const stbd = polar.getInterpolationState(SI.fromKnots(12), SI.fromDegrees(90))
    assert.equal(port.twa, stbd.twa)
    assert.equal(port.tws, stbd.tws)
  })
})

describe('PolarTable — derived target gap filling', () => {
  // Polar shaped like real Jieter/Expedition exports: derived beat/run targets
  // only exist for a subset of TWS columns (here 6 kt has both, 12 kt only a
  // run target, 16 kt only a beat target). Before the fix, the missing targets
  // fell back to argmax-VMG over tabulated angles (beat angle = 52°, the lowest
  // tabulated angle), nulling the pinch zone for every TWS interpolated
  // against the gap — polar speed read 0 kn while sailing upwind at 11–15 kt.
  const GAPPED = {
    kind: 'polarTable',
    schemaVersion: '1.0.0',
    name: 'Gapped Polar',
    units: { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    symmetry: { portStarboardSymmetric: true },
    axes: {
      tws: [6, 12, 16].map(SI.fromKnots),
      twa: [52, 60, 75, 90, 110, 120, 135, 150, 160].map(SI.fromDegrees)
    },
    values: {
      boatSpeedMatrix: [
        [3.3, 3.2, 3.59, 3.51, 3.38, 2.95, 2.93, 2.56, 2.65].map(SI.fromKnots),
        [4.84, 5.32, 5.52, 5.69, 5.46, 5.22, 4.93, 4.82, 4.98].map(SI.fromKnots),
        [5.41, 5.8, 6.18, 6.18, 6.03, 6.02, 5.87, 5.62, 5.7].map(SI.fromKnots)
      ]
    },
    derived: {
      rows: [
        { tws: SI.fromKnots(6), beat: targetPoint(39, 3.308), run: targetPoint(175, 4.435) },
        { tws: SI.fromKnots(12), run: targetPoint(177, 5.177) },
        { tws: SI.fromKnots(16), beat: targetPoint(38, 5.316) }
      ]
    }
  }
  let polar

  before(() => { polar = new PolarTable().loadFromCanonical(GAPPED) })

  it('interpolates a missing beat target across TWS (12 kt: between 39° and 38°)', () => {
    const beat = polar.getBeatAngle(SI.fromKnots(12))
    assert.ok(approxEqual(SI.toDegrees(beat), 38.4, 0.5),
      `Expected ~38.4°, got ${SI.toDegrees(beat).toFixed(1)}°`)  
  })

  it('does not snap a gapped beat angle to the lowest tabulated angle (52°)', () => {
    for (const tws of [7, 9, 11, 13, 15]) {
      const beat = SI.toDegrees(polar.getBeatAngle(SI.fromKnots(tws)))
      assert.ok(beat < 45, `Beat angle ${beat.toFixed(1)}° at ${tws} kt should stay below 45°`)
    }
  })

  it('clamps a missing run target at the end of the TWS axis (16 kt ← 12 kt)', () => {
    const run = polar.getRunAngle(SI.fromKnots(16))
    assert.ok(approxEqual(SI.toDegrees(run), 177, 0.5),
      `Expected ~177°, got ${SI.toDegrees(run).toFixed(1)}°`)
  })

  it('returns polar speed upwind between gapped TWS brackets (was 0 kn / null)', () => {
    for (const tws of [9, 11, 13, 15]) {
      const speed = polar.getBoatSpeed(SI.fromKnots(tws), SI.fromDegrees(40))
      assert.ok(speed !== null && SI.toKnots(speed) > 3,
        `Expected > 3 kn at ${tws} kt / 40°, got ${speed === null ? 'null' : SI.toKnots(speed).toFixed(2) + ' kn'}`)
    }
  })

  it('keeps dead-downwind data at TWS interpolated against a run-angle gap', () => {
    // 14–15 kt interpolate against the 16 kt bracket whose run target is filled
    const speed = polar.getBoatSpeed(SI.fromKnots(15), SI.fromDegrees(170))
    assert.ok(speed !== null && SI.toKnots(speed) > 4,
      `Expected > 4 kn at 15 kt / 170°, got ${speed === null ? 'null' : SI.toKnots(speed).toFixed(2) + ' kn'}`)
  })

  it('interpolates toward zero below the first TWS column in the pinch zone', () => {
    // 3 kt is below the 6 kt minimum: pinch zone (35.1° … 39°) must ramp
    // toward zero instead of returning null
    const speed = polar.getBoatSpeed(SI.fromKnots(3), SI.fromDegrees(37))
    assert.ok(speed !== null && SI.toKnots(speed) > 0 && SI.toKnots(speed) < 3.308,
      `Expected 0 < speed < 3.3 kn at 3 kt / 37°, got ${speed === null ? 'null' : SI.toKnots(speed).toFixed(2) + ' kn'}`)
  })

  it('interpolates toward zero below the first TWS column beyond the last TWA', () => {
    const speed = polar.getBoatSpeed(SI.fromKnots(3), SI.fromDegrees(176))
    assert.ok(speed !== null && SI.toKnots(speed) > 0 && SI.toKnots(speed) < 4.435,
      `Expected 0 < speed < 4.4 kn at 3 kt / 176°, got ${speed === null ? 'null' : SI.toKnots(speed).toFixed(2) + ' kn'}`)
  })
})

describe('PolarTable — getBoatSpeed / getInterpolationState consistency', () => {
  // getBoatSpeed must return null exactly when the state machine reports
  // in_irons or above_range — the two share the interpolated beat angle and
  // the interpolated run-extrapolation limit.
  let polar

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

  it('null ⇔ in_irons or above_range across a TWS/TWA sweep', () => {
    for (let tws = 3; tws <= 26; tws += 0.5) {
      for (let twa = 5; twa <= 180; twa += 1) {
        const speed = polar.getBoatSpeed(SI.fromKnots(tws), SI.fromDegrees(twa))
        const state = polar.getInterpolationState(SI.fromKnots(tws), SI.fromDegrees(twa))
        const expectNull = state.twa === 'in_irons' || state.twa === 'above_range'
        assert.equal(speed === null, expectNull,
          `TWS ${tws} kt / ${twa}°: speed=${speed} but state=${state.tws}/${state.twa}`)
      }
    }
  })

  it('pinching zone returns a speed between 0 and the beat-angle speed', () => {
    const tws = SI.fromKnots(12)
    const beatAngle = polar.getBeatAngle(tws)
    const speed = polar.getBoatSpeed(tws, 0.95 * beatAngle)
    const beatSpeed = polar.getBoatSpeed(tws, beatAngle)
    assert.ok(speed !== null && speed > 0 && speed < beatSpeed,
      `Expected 0 < speed < ${SI.toKnots(beatSpeed).toFixed(2)} kn, got ${speed}`)
  })
})

describe('PolarTable — port/starboard symmetry', () => {
  let polar

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

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

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

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

  before(() => { polar = new PolarTable().loadFromCanonical(CANONICAL) })

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
