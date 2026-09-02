'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { getNavigationTargetHeadings, NAVIGATION_OUTPUT_DEFS } = require('../public/app.js')

describe('navigation UI target heading mapping', () => {
  it('selects port target heading on port tack (negative TWA)', () => {
    const outputs = {
      'performance/targetHeadingTrue/port': 0.785398,
      'performance/targetHeadingTrue/starboard': 5.497787
    }
    const result = getNavigationTargetHeadings(outputs, -0.785398)
    assert.equal(result.targetHeading, 0.785398)
    assert.equal(result.oppositeHeading, 5.497787)
  })

  it('selects starboard target heading on starboard tack (positive TWA)', () => {
    const outputs = {
      'performance/targetHeadingTrue/port': 0.785398,
      'performance/targetHeadingTrue/starboard': 5.497787
    }
    const result = getNavigationTargetHeadings(outputs, 0.785398)
    assert.equal(result.targetHeading, 5.497787)
    assert.equal(result.oppositeHeading, 0.785398)
  })

  it('preserves zero heading when pointing due north', () => {
    const outputs = {
      'performance/targetHeadingTrue/port': 0,
      'performance/targetHeadingTrue/starboard': 3.14159
    }
    const result = getNavigationTargetHeadings(outputs, -0.5)
    assert.equal(result.targetHeading, 0)
    assert.equal(result.oppositeHeading, 3.14159)
  })

  it('supports dot-keyed outputs from status objects', () => {
    const outputs = {
      'performance.targetHeadingTrue.port': 1.0,
      'performance.targetHeadingTrue.starboard': 4.0
    }
    const resultPort = getNavigationTargetHeadings(outputs, -0.5)
    assert.equal(resultPort.targetHeading, 1.0)
    assert.equal(resultPort.oppositeHeading, 4.0)

    const resultStbd = getNavigationTargetHeadings(outputs, 0.5)
    assert.equal(resultStbd.targetHeading, 4.0)
    assert.equal(resultStbd.oppositeHeading, 1.0)
  })

  it('returns nulls when tack/TWA is missing or invalid', () => {
    const outputs = {
      'performance/targetHeadingTrue/port': 0.785398,
      'performance/targetHeadingTrue/starboard': 5.497787
    }
    assert.deepEqual(getNavigationTargetHeadings(outputs, null), { targetHeading: null, oppositeHeading: null })
    assert.deepEqual(getNavigationTargetHeadings(outputs, undefined), { targetHeading: null, oppositeHeading: null })
    assert.deepEqual(getNavigationTargetHeadings(outputs, NaN), { targetHeading: null, oppositeHeading: null })
  })

  it('returns null for individual heading if required output is unavailable', () => {
    const partialOutputs = {
      'performance/targetHeadingTrue/port': 0.785398
    }
    const result = getNavigationTargetHeadings(partialOutputs, -0.5)
    assert.equal(result.targetHeading, 0.785398)
    assert.equal(result.oppositeHeading, null)
  })

  it('NAVIGATION_OUTPUT_DEFS correctly extracts target and opposite headings', () => {
    const targetDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'performance/targetHeadingTrue')
    const oppositeDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'performance/oppositeTackHeadingTrue')

    assert.ok(targetDef, 'Target heading definition should exist')
    assert.ok(oppositeDef, 'Opposite tack heading definition should exist')

    const headings = { targetHeading: 1.2345, oppositeHeading: 4.5678 }
    assert.equal(targetDef.getValue({}, headings), 1.2345)
    assert.equal(oppositeDef.getValue({}, headings), 4.5678)

    const nullHeadings = { targetHeading: null, oppositeHeading: null }
    assert.equal(targetDef.getValue({}, nullHeadings), null)
    assert.equal(oppositeDef.getValue({}, nullHeadings), null)
  })
})
