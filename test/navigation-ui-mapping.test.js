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

  it('NAVIGATION_OUTPUT_DEFS exposes port, starboard, and layline outputs directly', () => {
    const portDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'performance/targetHeadingTrue/port')
    const starboardDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'performance/targetHeadingTrue/starboard')
    const distanceDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'navigation/racing/layline/distance')
    const timeDef = NAVIGATION_OUTPUT_DEFS.find(d => d.sk === 'navigation/racing/layline/time')

    assert.ok(portDef, 'Port heading definition should exist')
    assert.ok(starboardDef, 'Starboard heading definition should exist')
    assert.ok(distanceDef, 'Distance to layline definition should exist')
    assert.ok(timeDef, 'Time to layline definition should exist')

    assert.equal(portDef.label, 'Port heading (true)')
    assert.equal(starboardDef.label, 'Starboard heading (true)')
    assert.equal(distanceDef.label, 'Distance to layline')
    assert.equal(timeDef.label, 'Time to layline')
  })
})
