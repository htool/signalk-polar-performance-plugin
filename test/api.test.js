'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CANONICAL_BODY = {
  kind: 'polarTable',
  schemaVersion: '1.0.0',
  name: 'API Boat',
  sailnumber: 'API-1',
  boatType: 'API Test Boat',
  year: 2025,
  source: 'custom',
  notes: 'api roundtrip',
  units: {
    tws: 'm/s',
    twa: 'rad',
    boatSpeed: 'm/s'
  },
  symmetry: {
    portStarboardSymmetric: true
  },
  axes: {
    tws: [3.0864, 5.144],
    twa: [0.75398, 1.5708, 2.65465]
  },
  values: {
    boatSpeedMatrix: [
      [2.5051, 2.65465, 2.23368],
      [3.16888, 3.34861, 2.74799]
    ]
  },
  derived: {
    rows: [
      {
        tws: 3.0864,
        beat: { twa: 0.75398, tbs: 2.5051, vmg: 1.82652 },
        run: { twa: 2.65465, tbs: 2.23368, vmg: 1.97371 },
        maxSpeed: 2.65465,
        maxSpeedAngle: 1.5708
      },
      {
        tws: 5.144,
        beat: { twa: 0.75398, tbs: 3.16888, vmg: 2.31042 },
        run: { twa: 2.65465, tbs: 2.74799, vmg: 2.42813 },
        maxSpeed: 3.34861,
        maxSpeedAngle: 1.5708
      }
    ]
  }
}

const JIETER_TEXT = [
  'twa/tws;6;8',
  '52;4.57;5.59',
  '60;4.93;5.93',
  '75;5.17;6.18',
  '90;5.29;6.43',
  '120;5.20;6.38',
  '135;4.65;5.84',
  '150;3.92;5.05',
  '46.9;4.23;0',
  '44.8;0;5.09',
  '144.2;4.19;0',
  '146.4;0;5.25'
].join('\n')

const EXPEDITION_TEXT = [
  '!NED5436',
  '6\t0\t0\t43.2\t4.47\t52\t4.94\t60\t5.17\t70\t5.29\t75\t5.30\t80\t5.29\t90\t5.21\t110\t5.09\t120\t4.91\t135\t4.40\t146.15\t3.90\t150\t3.73\t165\t3.19\t180\t2.99',
  '8\t0\t0\t41.25\t5.19\t52\t5.75\t60\t5.96\t70\t6.07\t75\t6.09\t80\t6.09\t90\t6.04\t110\t6.08\t120\t5.92\t135\t5.41\t150\t4.77\t150.95\t4.73\t165\t4.18\t180\t3.95',
  '10\t0\t0\t40\t5.65\t52\t6.24\t60\t6.39\t70\t6.49\t75\t6.51\t80\t6.52\t90\t6.56\t110\t6.64\t120\t6.55\t135\t6.20\t150\t5.62\t154.775\t5.41\t165\t5.03\t180\t4.80',
  '12\t0\t0\t39.6\t5.92\t52\t6.50\t60\t6.64\t70\t6.75\t75\t6.77\t80\t6.79\t90\t6.87\t110\t6.96\t120\t6.90\t135\t6.68\t150\t6.29\t161.45\t5.88\t165\t5.77\t180\t5.54',
  '14\t0\t0\t39.075\t6.01\t52\t6.63\t60\t6.79\t70\t6.92\t75\t6.96\t80\t6.99\t90\t7.06\t110\t7.23\t120\t7.17\t135\t7.00\t150\t6.71\t165\t6.35\t175.4\t6.19\t180\t6.17',
  '16\t0\t0\t39.175\t6.10\t52\t6.69\t60\t6.86\t70\t7.03\t75\t7.10\t80\t7.14\t90\t7.19\t110\t7.49\t120\t7.44\t135\t7.28\t150\t7.01\t165\t6.74\t179\t6.61\t180\t6.61',
  '20\t0\t0\t39.4\t6.16\t52\t6.75\t60\t6.95\t70\t7.15\t75\t7.24\t80\t7.33\t90\t7.49\t110\t7.88\t120\t8.03\t135\t7.88\t150\t7.56\t165\t7.28\t179.45\t7.18\t180\t7.18',
  '24\t0\t0\t40.6\t6.18\t52\t6.75\t60\t6.97\t70\t7.22\t75\t7.33\t80\t7.44\t90\t7.67\t110\t8.12\t120\t8.51\t135\t8.59\t150\t8.20\t165\t7.84\t179.225\t7.72\t180\t7.71'
].join('\n')

const ORC_ACTIVECERTS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ROOT><DATA>',
  '<ROW RowNum="1">',
  '<Family>1</Family>',
  '<CountryId>NED</CountryId>',
  '<dxtID>225333</dxtID>',
  '<RefNo>04310004HPB</RefNo>',
  '<dxtDate>2026-03-14T06:02:25.271Z</dxtDate>',
  '<dxtName>vertigo.dxt</dxtName>',
  '<YachtName>Vertigo</YachtName>',
  '<SailNo>NED 8818</SailNo>',
  '<VPPYear>2026</VPPYear>',
  '<CertType>2</CertType>',
  '<Expiry>2026-12-31T00:00:00.000Z</Expiry>',
  '<IsOd>False</IsOd>',
  '<Class>Swan 53</Class>',
  '<CertName>International</CertName>',
  '<FamilyName>ORC Standard</FamilyName>',
  '</ROW>',
  '<ROW RowNum="2">',
  '<Family>1</Family>',
  '<CountryId>ESP</CountryId>',
  '<dxtID>999999</dxtID>',
  '<RefNo>ESP-SECOND</RefNo>',
  '<dxtDate>2026-04-01T00:00:00.000Z</dxtDate>',
  '<dxtName>second.dxt</dxtName>',
  '<YachtName>Second Wind</YachtName>',
  '<SailNo>ESP 1</SailNo>',
  '<VPPYear>2026</VPPYear>',
  '<CertType>2</CertType>',
  '<Expiry>2026-12-31T00:00:00.000Z</Expiry>',
  '<IsOd>False</IsOd>',
  '<Class>Custom 40</Class>',
  '<CertName>International</CertName>',
  '<FamilyName>ORC Standard</FamilyName>',
  '</ROW>',
  '</DATA></ROOT>'
].join('')

const ORC_CERTIFICATE_HTML = [
  '<html><body>',
  '<div class="p1group"><span class="title">BOAT</span><div class="tabular2">',
  '<span class="label">Age date</span><span class="data" id="field_AgeDt"><span>01/2004</span></span>',
  '<span class="label">Series date</span><span class="data" id="field_Series_VPP"><span>01/2004</span></span>',
  '</div></div>',
  '<table class="boatspeeds">',
  '<caption>Rated boat velocities in knots</caption>',
  '<tr><td>Wind Velocity</td><td>6 kt</td><td>8 kt</td></tr>',
  '<tr class="data"><td>Beat Angles</td><td>44.8°</td><td>42.5°</td></tr>',
  '<tr class="data"><td>Beat VMG</td><td>5.09</td><td>6.81</td></tr>',
  '<tr class="data"><td>52°</td><td>5.75</td><td>6.75</td></tr>',
  '<tr class="data"><td>90°</td><td>6.04</td><td>7.49</td></tr>',
  '<tr class="data"><td>150°</td><td>4.77</td><td>7.56</td></tr>',
  '<tr class="data"><td>Run VMG</td><td>5.25</td><td>7.15</td></tr>',
  '<tr class="data"><td>Gybe Angles</td><td>146.4°</td><td>144.9°</td></tr>',
  '</table>',
  '</body></html>'
].join('')

const ORC_ACTIVECERTS_URL = 'https://data.orc.org/public/WPub.dll?action=activecerts'
const ORC_CERTIFICATE_URL = 'https://data.orc.org/public/WPub.dll/CC/225333'

function makeFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  }
}

function makeApp(dataDir) {
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    savePluginOptions: (_options, callback) => callback && callback(),
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    config: { port: 3000 },
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes) => {
        unsubscribes.push(() => {})
      }
    }
  }
}

function freshPlugin(app) {
  delete require.cache[require.resolve('../plugin/index.js')]
  return require('../plugin/index.js')(app)
}

function makeRouter() {
  const routes = { get: {}, put: {}, post: {}, delete: {} }
  return {
    routes,
    use: () => {},
    get: (path, handler) => { routes.get[path] = handler },
    put: (path, handler) => { routes.put[path] = handler },
    post: (path, handler) => { routes.post[path] = handler },
    delete: (path, handler) => { routes.delete[path] = handler }
  }
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    type(value) {
      this.headers['content-type'] = value
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    send(payload) {
      this.body = payload
      return this
    }
  }
}

describe('Polar manager/query API', () => {
  let dataDir, app, plugin, router, originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polar-api-'))
    app = makeApp(dataDir)
    plugin = freshPlugin(app)
    router = makeRouter()
    plugin.registerWithRouter(router)
    plugin.start({})
  })

  afterEach(() => {
    try { plugin.stop() } catch (_) {}
    global.fetch = originalFetch
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete require.cache[require.resolve('../plugin/index.js')]
  })

  it('stores, activates, and queries a canonical polar resource', () => {
    let res = makeResponse()
    router.routes.post['/polars']({ body: CANONICAL_BODY }, res)
    assert.equal(res.statusCode, 201)
    assert.match(res.body.id, /^api-1-\d{8}t\d{6}z(?:-\d+)?$/)
    const storedId = res.body.id

    res = makeResponse()
    router.routes.get['/polars/:id']({ params: { id: storedId }, query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.kind, 'polarTable')
    assert.equal(res.body.id, storedId)
    assert.equal(res.body.name, 'API Boat')

    res = makeResponse()
    router.routes.put['/polars/active']({ body: { id: storedId } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.id, storedId)

    res = makeResponse()
    router.routes.get['/polars/active']({ query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.id, storedId)

    res = makeResponse()
    router.routes.get['/polars/:id/queries/speed']({
      params: { id: storedId },
      query: { tws: '3.0864', twa: '1.5708' }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.tbs > 0)
    assert.equal(res.body.state.tws, 'in_range')

    res = makeResponse()
    router.routes.get['/polars/:id/meta']({ params: { id: storedId }, query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.year, 2025)
    assert.equal(res.body.source, 'custom')
    assert.equal(res.body.notes, 'api roundtrip')

    res = makeResponse()
    router.routes.put['/polars/active']({ body: { id: '' } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.id, '')

    res = makeResponse()
    router.routes.get['/polars/active']({ query: {} }, res)
    assert.equal(res.statusCode, 404)

    res = makeResponse()
    router.routes.put['/polars/active']({ body: { id: storedId } }, res)
    assert.equal(res.statusCode, 200)

    res = makeResponse()
    router.routes.delete['/polars/active']({}, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.id, '')

    res = makeResponse()
    router.routes.get['/polars/active']({ query: {} }, res)
    assert.equal(res.statusCode, 404)
  })

  it('lists supported text import formats and imports Jieter text', () => {
    let res = makeResponse()
    router.routes.get['/imports/formats']({}, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.map(entry => entry.id), ['jieter', 'expedition'])

    res = makeResponse()
    router.routes.post['/imports/text/:format']({
      params: { format: 'jieter' },
      body: {
        content: JIETER_TEXT,
        name: 'Imported Jieter Boat',
        sailnumber: 'J-001',
        boatType: 'J Test',
        year: 2026,
        notes: 'Imported from Jieter text'
      }
    }, res)
    assert.equal(res.statusCode, 201)
    assert.match(res.body.id, /^j-001-\d{8}t\d{6}z(?:-\d+)?$/)
    const importedId = res.body.id

    res = makeResponse()
    router.routes.get['/polars/:id/meta']({ params: { id: importedId }, query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.name, 'Imported Jieter Boat')
    assert.equal(res.body.sailnumber, 'J-001')
    assert.equal(res.body.year, 2026)
    assert.equal(res.body.source, 'jieter')

    res = makeResponse()
    router.routes.get['/polars/:id/queries/targets']({
      params: { id: importedId },
      query: { tws: '3.0867' }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.beat)
    assert.ok(res.body.run)
  })

  it('imports Expedition-style delimited text into a canonical polar', () => {
    let res = makeResponse()
    router.routes.post['/imports/text/:format']({
      params: { format: 'expedition' },
      body: {
        content: EXPEDITION_TEXT,
        name: 'Imported Expedition Boat'
      }
    }, res)
    assert.equal(res.statusCode, 201)
    assert.match(res.body.id, /^ned5436-\d{8}t\d{6}z(?:-\d+)?$/)
    const importedId = res.body.id

    res = makeResponse()
    router.routes.get['/polars/:id/meta']({ params: { id: importedId }, query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.name, 'Imported Expedition Boat')
    assert.equal(res.body.sailnumber, 'NED5436')
    assert.equal(res.body.source, 'expedition')

    res = makeResponse()
    router.routes.get['/polars/:id/queries/speed']({
      params: { id: importedId },
      query: { tws: '6.1734', twa: '1.5708' }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.tbs > 0)

    res = makeResponse()
    router.routes.get['/polars/:id/queries/targets']({
      params: { id: importedId },
      query: { tws: '3.0867' }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.beat)
    assert.ok(res.body.run)
  })

  it('searches the official ORC source and imports a certificate by RefNo', async () => {
    const calls = []
    global.fetch = async (url) => {
      const href = String(url)
      calls.push(href)
      if (href === ORC_ACTIVECERTS_URL) {
        return makeFetchResponse(ORC_ACTIVECERTS_XML)
      }
      if (href === ORC_CERTIFICATE_URL) {
        return makeFetchResponse(ORC_CERTIFICATE_HTML)
      }
      throw new Error(`Unexpected fetch URL: ${href}`)
    }

    let res = makeResponse()
    await router.routes.get['/imports/sources']({}, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, [{
      id: 'orc',
      name: 'ORC Active Certificates',
      description: 'Official ORC active certificates and certificate pages',
      url: ORC_ACTIVECERTS_URL,
      available: true,
      availabilityMessage: ''
    }])

    res = makeResponse()
    await router.routes.get['/imports/sources/:source/search']({
      params: { source: 'orc' },
      query: { q: 'vertigo' }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.length, 1)
    assert.equal(res.body[0].externalId, '04310004HPB')
    assert.equal(res.body[0].name, 'Vertigo')
    assert.equal(res.body[0].boatType, 'Swan 53')
    assert.equal(res.body[0].year, 2026)
    assert.equal(res.body[0].source, 'orc')

    res = makeResponse()
    await router.routes.post['/imports/sources/:source/items/:externalId']({
      params: { source: 'orc', externalId: '04310004HPB' }
    }, res)
    assert.equal(res.statusCode, 201)
    assert.equal(res.body.id, '04310004hpb')
    const orcImportedId = res.body.id

    res = makeResponse()
    router.routes.get['/polars/:id/meta']({ params: { id: orcImportedId }, query: {} }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.name, 'Vertigo')
    assert.equal(res.body.sailnumber, 'NED8818')
    assert.equal(res.body.year, 2004)
    assert.equal(res.body.source, 'orc')

    res = makeResponse()
    await router.routes.post['/imports/sources/:source/items/:externalId']({
      params: { source: 'orc', externalId: 'ESP-SECOND' },
      body: { name: 'No longer allowed' }
    }, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'External source imports do not accept metadata overrides')

    res = makeResponse()
    router.routes.get['/polars/:id/queries/targets']({
      params: { id: orcImportedId },
      query: { tws: String(6 * 0.514444) }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.beat)
    assert.ok(res.body.run)

    assert.equal(calls.filter(url => url === ORC_ACTIVECERTS_URL).length, 1)
    assert.equal(calls.filter(url => url === ORC_CERTIFICATE_URL).length, 1)
  })

  it('does not register removed legacy polar routes', () => {
    assert.equal(router.routes.get['/polar/tws'], undefined)
    assert.equal(router.routes.get['/polar/curve'], undefined)
    assert.equal(router.routes.get['/polars/formats'], undefined)
    assert.equal(router.routes.get['/polars/import/search'], undefined)
    assert.equal(router.routes.post['/polars/import/:sailnumber'], undefined)
    assert.equal(router.routes.put['/polars/active/:name'], undefined)
    assert.equal(router.routes.post['/polars/:name'], undefined)
  })

  it('reports ORC as unavailable without internet instead of failing source discovery', async () => {
    global.fetch = async () => {
      throw new Error('network unreachable')
    }

    const res = makeResponse()
    await router.routes.get['/imports/sources']({}, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, [{
      id: 'orc',
      name: 'ORC Active Certificates',
      description: 'Official ORC active certificates and certificate pages',
      url: ORC_ACTIVECERTS_URL,
      available: false,
      availabilityMessage: 'ORC source unavailable: internet access is required for external source imports'
    }])
  })
})