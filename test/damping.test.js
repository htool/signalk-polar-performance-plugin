'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ExponentialSmoother, MovingAverageSmoother } = require('signalkutilities')

describe('calculation input damping', () => {
  it('moves exponential performance damping toward a new scalar using its time constant', () => {
    const originalNow = Date.now
    let now = 0
    Date.now = () => now
    try {
      const smoother = new ExponentialSmoother({ tau: 5 })
      smoother.add(0)
      now = 5000
      smoother.add(10)
      assert.ok(Math.abs(smoother.estimate - (10 * (1 - Math.exp(-1)))) < 1e-9)
    } finally {
      Date.now = originalNow
    }
  })

  it('averages angles through north using Cartesian components', () => {
    const originalNow = Date.now
    let now = 0
    Date.now = () => now
    try {
      const x = new MovingAverageSmoother({ timeSpan: 30 })
      const y = new MovingAverageSmoother({ timeSpan: 30 })
      for (const degrees of [359, 1]) {
        const radians = degrees * Math.PI / 180
        x.add(Math.cos(radians))
        y.add(Math.sin(radians))
      }
      assert.ok(Math.abs(Math.atan2(y.estimate, x.estimate)) < 1e-9)
    } finally {
      Date.now = originalNow
    }
  })

  it('uses only navigation samples inside its moving-average window', () => {
    const originalNow = Date.now
    let now = 0
    Date.now = () => now
    try {
      const smoother = new MovingAverageSmoother({ timeSpan: 30 })
      smoother.add(10)
      now = 29000
      smoother.add(20)
      assert.equal(smoother.estimate, 15)
      now = 31000
      smoother.add(30)
      assert.equal(smoother.estimate, 25)
    } finally {
      Date.now = originalNow
    }
  })
})