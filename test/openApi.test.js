'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const openApi = require('../openApi.json')

describe('OpenAPI runtime contract', () => {
  it('documents the runtime endpoints used by the webapp', () => {
    const operations = [
      openApi.paths['/live']?.get,
      openApi.paths['/status']?.get,
      openApi.paths['/meta']?.get,
      openApi.paths['/settings']?.get,
      openApi.paths['/settings']?.put
    ]

    for (const operation of operations) {
      assert.ok(operation)
      assert.equal(operation['x-internal'], true)
      assert.match(operation.description, /Internal/)
    }
    assert.match(openApi.info.description, /must use the Signal K API/)
  })

  it('documents current performance heading outputs without retired scalar paths', () => {
    const outputs = openApi.components.schemas.SignalKOutputSnapshot.properties
    const meta = openApi.components.schemas.RuntimeMeta.properties

    assert.ok(outputs['performance.targetHeadingTrue.port'])
    assert.ok(outputs['performance.targetHeadingTrue.starboard'])
    assert.ok(outputs['performance.tackTrue'])
    assert.equal(outputs['performance.targetHeadingTrue'], undefined)
    assert.equal(outputs['performance.oppositeTackHeadingTrue'], undefined)

    assert.ok(meta['performance.targetHeadingTrue.port'])
    assert.ok(meta['performance.targetHeadingTrue.starboard'])
    assert.ok(meta['performance.tackTrue'])
    assert.equal(meta['performance.targetHeadingTrue'], undefined)
    assert.equal(meta['performance.oppositeTackHeadingTrue'], undefined)
  })

  it('keeps VMC query headings separate from published Signal K paths', () => {
    const operation = openApi.paths['/polars/{id}/queries/vmc-performance'].get
    const response = openApi.components.schemas.VmcPerformanceResult.properties

    assert.match(operation.description, /not published as Signal K output paths/)
    assert.ok(response.targetHeadingTrue)
    assert.ok(response.oppositeTackHeadingTrue)
  })

  it('has resolvable local schema references', () => {
    const document = JSON.stringify(openApi)
    const refs = Array.from(document.matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)"/g), match => match[1])

    for (const schemaName of refs) {
      assert.ok(openApi.components.schemas[schemaName], `Missing schema referenced as ${schemaName}`)
    }
  })
})