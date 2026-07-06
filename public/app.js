// app.js — Polar Performance Plugin webapp
// Pages: Overview | Inputs | Settings | Outputs | Polars
// No build step. Uses window.PolarCanvas from polar-canvas.js (loaded before this module).
// Live data is updated in-place every second — DOM is only rebuilt on page switch.

'use strict'

const API = '/plugins/signalk-polar-performance-plugin'

// ── Unit conversion ───────────────────────────────────────────────────────────
let meta = {}

const SPEED_DEFAULT = { formula: 'value * 1.943844',          symbol: 'kn', displayFormat: '0.0' }
const ANGLE_DEFAULT = { formula: 'value * 57.29577951308231', symbol: '°',  displayFormat: '0'   }
const RATIO_DEFAULT = { formula: 'value * 100',               symbol: '%',  displayFormat: '0.1' }

function isSafeFormula(f) {
  return typeof f === 'string' && /^[\d\s+\-*/.()eE]*$/.test(f.replace(/\bvalue\b/g, '0'))
}

const _fmtCache = new Map()
function getConverter(displayUnits) {
  if (!displayUnits || !isSafeFormula(displayUnits.formula)) return null
  const key = displayUnits.formula + '|' + (displayUnits.symbol || '') + '|' + (displayUnits.displayFormat || '')
  if (_fmtCache.has(key)) return _fmtCache.get(key)
  let fn
  try { fn = new Function('value', 'return ' + displayUnits.formula); fn(1) }
  catch (_) { _fmtCache.set(key, null); return null }
  const parts = (displayUnits.displayFormat || '0.0').split('.')
  const decimals = parts.length > 1 ? parts[1].length : 0
  const conv = { fn, symbol: displayUnits.symbol || '', decimals }
  _fmtCache.set(key, conv)
  return conv
}

function fmtVal(value, metaKey, fallback) {
  if (value === null || value === undefined || !Number.isFinite(+value)) return '—'
  const v = +value
  const du = meta[metaKey]?.displayUnits ?? fallback
  const c = getConverter(du)
  if (!c) return v.toFixed(2)
  return c.fn(v).toFixed(c.decimals) + '\u00a0' + c.symbol
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function apiGet(path, opts = {}) {
  try {
    const res = await fetch(API + path, { credentials: 'same-origin' })
    if (!res.ok) {
      if (!opts.silent503 || res.status !== 503) showMessage('API error ' + res.status + ': ' + path)
      return null
    }
    return res.json()
  } catch (e) { showMessage('Server unreachable: ' + e.message); return null }
}

async function apiPut(path, body) {
  try {
    const res = await fetch(API + path, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) { showMessage('Save failed: ' + res.status); return null }
    return res.json()
  } catch (e) { showMessage('Save failed: ' + e.message); return null }
}

async function apiPostJSON(path, body) {
  try {
    const res = await fetch(API + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    if (!res.ok) { showMessage('Upload failed: ' + res.status); return null }
    return res.json()
  } catch (e) { showMessage('Upload failed: ' + e.message); return null }
}

async function apiDelete(path) {
  try {
    const res = await fetch(API + path, { method: 'DELETE', credentials: 'same-origin' })
    if (!res.ok) { showMessage('Delete failed: ' + res.status); return null }
    return res.json()
  } catch (e) { showMessage('Delete failed: ' + e.message); return null }
}

// Fetch a single scalar value from the SK REST API
// ── Message bar ───────────────────────────────────────────────────────────────
let _msgTimer = null
function showMessage(text) {
  const el = document.getElementById('message')
  if (!el) return
  el.textContent = text
  clearTimeout(_msgTimer)
  _msgTimer = setTimeout(() => { el.textContent = '' }, 5000)
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function sectionHeading(text) {
  const h = document.createElement('h6')
  h.className = 'text-uppercase fw-bold text-muted border-bottom pb-1 mb-2 mt-3 small'
  h.textContent = text
  return h
}

// Set text of a span by id (fast in-place update, no DOM rebuild)
function setVal(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

// Toggle 'stale' class on the <tr> ancestor of an element by id
function setStale(id, stale) {
  const el = document.getElementById(id)
  const row = el?.closest('tr')
  if (row) row.classList.toggle('stale', stale)
}

// Build a two-column table. Each row has { label, id?, control?, desc? }
// When id is provided, a <span id="...">—</span> is placed in the value cell
// for in-place updates via setVal().
function buildTable(rows) {
  const tbl = document.createElement('table')
  tbl.className = 'table table-sm table-borderless mb-0'
  const tbody = document.createElement('tbody')
  rows.forEach(r => {
    const tr = document.createElement('tr')
    if (r.rowClass) tr.className = r.rowClass
    const tdL = document.createElement('td')
    tdL.textContent = r.label
    if (r.desc) {
      const s = document.createElement('small'); s.className = 'text-muted d-block'; s.textContent = r.desc
      tdL.appendChild(s)
    }
    const tdV = document.createElement('td')
    if (r.id) {
      const span = document.createElement('span'); span.id = r.id; span.textContent = '—'
      tdV.appendChild(span)
    } else if (r.control) {
      tdV.appendChild(r.control)
    }
    tr.appendChild(tdL); tr.appendChild(tdV)
    tbody.appendChild(tr)
  })
  tbl.appendChild(tbody)
  return tbl
}

function createToggle(checked, onChange) {
  const lbl = document.createElement('label')
  lbl.className = 'switch switch-text switch-primary mb-0'
  const cb = document.createElement('input')
  cb.type = 'checkbox'; cb.className = 'switch-input form-check-input'; cb.checked = !!checked
  cb.addEventListener('change', () => onChange(cb.checked))
  const sl = document.createElement('span')
  sl.className = 'switch-label'; sl.setAttribute('data-on', 'On'); sl.setAttribute('data-off', 'Off')
  const sh = document.createElement('span'); sh.className = 'switch-handle'
  lbl.appendChild(cb); lbl.appendChild(sl); lbl.appendChild(sh)
  return lbl
}

function createNumberInput(key, value, opts, showRevert, onSaved) {
  const wrap = document.createElement('span')
  const inp = document.createElement('input')
  inp.type = 'number'
  inp.className = 'form-control form-control-sm d-inline-block'
  inp.style.width = '90px'
  inp.value = value !== undefined ? value : (opts.default ?? '')
  if (opts.min  !== undefined) inp.min  = opts.min
  if (opts.max  !== undefined) inp.max  = opts.max
  if (opts.step !== undefined) inp.step = opts.step
  const revertBtn = document.createElement('button')
  revertBtn.className = 'btn btn-link btn-sm p-0 ms-1'
  revertBtn.title = `Reset to default (${opts.default})`
  revertBtn.textContent = '↺'
  revertBtn.style.display = (showRevert && opts.default !== undefined && value !== opts.default) ? '' : 'none'
  revertBtn.addEventListener('click', () => {
    apiPut('/settings', { [key]: opts.default }).then(s => {
      if (s) { settings = s; inp.value = opts.default; revertBtn.style.display = 'none' }
    })
  })
  inp.addEventListener('change', () => {
    const v = Number(inp.value)
    if (!Number.isFinite(v)) return
    apiPut('/settings', { [key]: v }).then(s => {
      if (s) {
        settings = s
        revertBtn.style.display = (showRevert && opts.default !== undefined && v !== opts.default) ? '' : 'none'
        if (typeof onSaved === 'function') onSaved(s)
      }
    })
  })
  wrap.appendChild(inp); wrap.appendChild(revertBtn)
  return wrap
}

// Update warnings container in-place. Skips DOM write when content unchanged.
function updateWarnings(el, items) {
  if (!el) return
  const key = items.join('\n')
  if (el._lastKey === key) return
  el._lastKey = key
  el.innerHTML = ''
  if (!items.length) return
  el.appendChild(sectionHeading('Warnings'))
  const ul = document.createElement('ul')
  ul.className = 'list-unstyled text-danger small ps-3 mb-0'
  items.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li) })
  el.appendChild(ul)
}

// ── App state ─────────────────────────────────────────────────────────────────
let liveData     = null  // from /live — smoothed values (tws, twa, bsp, polarSpeed, performance)
let statusData   = null  // from /status — raw inputs + computed outputs
let rawValues    = {}    // raw sensor values from /status, keyed by short name (tws/twa/bsp/hdg)
let outputValues = {}    // computed output values from /status, keyed by SK path string
let settings     = null
let polarsList   = []
let hasInternet  = null  // null = checking, true, false

// Canvas state
let polar          = null
let twsList        = []
let curves         = {}
let libraryVersion = ''
let liveTws        = null
let liveCurve      = null
const STEP = (2 * Math.PI / 180).toFixed(6)

let activePage = 'overview'

// ── Output path definitions ───────────────────────────────────────────────────
const OUTPUT_DEFS = [
  { key: 'beatAngle',        label: 'Beat & run angles',
    paths: [
      { sk: 'performance/beatAngle',  label: 'Beat angle',           mk: 'twa',         fb: ANGLE_DEFAULT },
      { sk: 'performance/gybeAngle',  label: 'Gybe angle',           mk: 'twa',         fb: ANGLE_DEFAULT },
    ]},
  { key: 'beatVMG',          label: 'Beat & run VMG',
    paths: [
      { sk: 'performance/beatAngleVelocityMadeGood', label: 'Beat VMG',  mk: 'bsp', fb: SPEED_DEFAULT },
      { sk: 'performance/gybeAngleVelocityMadeGood', label: 'Gybe VMG',  mk: 'bsp', fb: SPEED_DEFAULT },
    ]},
  { key: 'targetTWA',        label: 'Target TWA & VMG',
    paths: [
      { sk: 'performance/targetAngle',              label: 'Target angle', mk: 'twa', fb: ANGLE_DEFAULT },
      { sk: 'performance/targetVelocityMadeGood',    label: 'Target VMG',   mk: 'bsp', fb: SPEED_DEFAULT },
    ]},
  { key: 'optimumWindAngle', label: 'Optimum wind angle',
    paths: [
      { sk: 'performance/optimumWindAngle', label: 'Optimum angle',  mk: 'twa',         fb: ANGLE_DEFAULT },
    ]},
  { key: 'VMG',              label: 'VMG & polar VMG',
    paths: [
      { sk: 'performance/velocityMadeGood',              label: 'VMG',             mk: 'bsp',         fb: SPEED_DEFAULT },
      { sk: 'performance/polarVelocityMadeGood',         label: 'Polar VMG',       mk: 'bsp',         fb: SPEED_DEFAULT },
      { sk: 'performance/polarVelocityMadeGoodRatio',    label: 'Polar VMG ratio', mk: 'performance', fb: RATIO_DEFAULT },
    ]},
  { key: 'polarSpeed',        label: 'Polar speed & ratio',
    paths: [
      { sk: 'performance/polarSpeed',      label: 'Polar target speed', mk: 'bsp', fb: SPEED_DEFAULT },
      { sk: 'performance/targetSpeed',     label: 'Target boat speed',  mk: 'bsp', fb: SPEED_DEFAULT },
      { sk: 'performance/polarSpeedRatio', label: 'Speed ratio',        mk: 'performance', fb: RATIO_DEFAULT },
    ]},
  { key: 'maxSpeed',         label: 'Max polar speed',
    paths: [
      { sk: 'performance/maxSpeed',      label: 'Max speed',         mk: 'bsp',         fb: SPEED_DEFAULT },
      { sk: 'performance/maxSpeedAngle', label: 'Max speed angle',   mk: 'twa',         fb: ANGLE_DEFAULT },
    ]},
  { key: 'tackTrue',         label: 'Opposite tack heading',
    paths: [
      { sk: 'performance/tackTrue',     label: 'Tack heading',       mk: 'twa',         fb: ANGLE_DEFAULT },
    ]},
  { key: 'smoothedInputs',   label: 'Smoothed inputs',
    paths: [
      { sk: 'environment/wind/angleTrueWaterDamped', label: 'True wind angle (smoothed)', mk: 'twa', fb: ANGLE_DEFAULT },
      { sk: 'performance/boatSpeedDamped',           label: 'Boat speed (smoothed)',      mk: 'bsp', fb: SPEED_DEFAULT },
    ]},
]

// Unique SK path id used as DOM element id (slashes → dashes)
function skId(sk) { return 'out-' + sk.replace(/\//g, '-') }

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadMeta() {
  const m = await apiGet('/meta')
  if (m) { meta = m; if (polar) polar.setMeta(meta) }
}

async function refreshSettings() {
  const s = await apiGet('/settings')
  if (s) settings = s
}

async function refreshPolars() {
  const list = await apiGet('/polars')
  if (list) polarsList = list
}

async function refreshLibrary() {
  const newList = await apiGet('/polar/tws', { silent503: true })
  if (!newList) {
    // No polar loaded — clear any previously displayed curves
    if (libraryVersion !== '') {
      libraryVersion = ''; twsList = []; curves = {}
      if (polar) polar.setLibraryData([], {}, null)
    }
    return
  }
  const version = JSON.stringify(newList)
  if (version === libraryVersion) return
  libraryVersion = version; twsList = newList; curves = {}
  await Promise.all(twsList.map(async tws => {
    try {
      const c = await apiGet('/polar/curve?tws=' + tws.toFixed(5) + '&step=' + STEP, { silent503: true })
      if (c) curves[tws] = c
    } catch (_) {}
  }))
  if (polar) polar.setLibraryData(twsList, curves, liveCurve)
}

// Main 1-second refresh: all data from plugin endpoints only
async function refreshLive() {
  // 1. Plugin live snapshot (smoothed wind/bsp + polar state)
  const d = await apiGet('/live')
  if (d) liveData = d

  // 2. Plugin status snapshot (raw inputs + smoothed inputs + outputs)
  const st = await apiGet('/status')
  if (st) {
    statusData = st
    // Populate rawValues and outputValues from /status for the Inputs/Outputs pages
    if (st.inputs) {
      rawValues.tws = st.inputs.raw.tws
      rawValues.twa = st.inputs.raw.twa
      rawValues.bsp = st.inputs.raw.bsp
      rawValues.hdg = st.inputs.raw.hdg ?? null
    }
    if (st.outputs) {
      const converted = {}
      Object.entries(st.outputs).forEach(([k, v]) => { converted[k.replace(/\./g, '/')] = v })
      Object.assign(outputValues, converted)
    }
  }

  // 3. Update live TWS curve for canvas
  if (liveData && polar) {
    const tws = liveData.tws
    if (tws !== null && (!liveTws || Math.abs(tws - liveTws) > 0.05)) {
      liveTws = tws
      try { liveCurve = await apiGet('/polar/curve?tws=' + tws.toFixed(5) + '&step=' + STEP) }
      catch (_) {}
    }
    polar.setLiveData(liveData, liveCurve)
  }

  // 4. Tick active page
  _tickActivePage()
}

async function checkInternet() {
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), 5000)
    await fetch('https://raw.githubusercontent.com/jieter/orc-data/master/orc-data.json', {
      method: 'HEAD', cache: 'no-store', mode: 'no-cors', signal: controller.signal
    })
    clearTimeout(tid)
    hasInternet = true
  } catch (_) {
    hasInternet = false
  }
  _updateOrcInternetState()
}

// ── Polar state warnings ──────────────────────────────────────────────────────
// Returns an array of warning strings based on getInterpolationState() result.
function polarStateWarnings(d) {
  const s = d?.polarState
  if (!s) return []
  const msgs = []
  if (s.tws === 'below_range') msgs.push('Wind speed is below the polar table range — values are extrapolated')
  if (s.tws === 'above_range') msgs.push('Wind speed is above the polar table range — values are extrapolated')
  if (s.twa === 'in_irons')    msgs.push('Sailing in irons — too close to the wind for polar data')
  if (s.twa === 'pinching')    msgs.push('Pinching — sailing closer to wind than the polar beat angle')
  if (s.twa === 'extrapolated') msgs.push('Running deeper than the polar table — values are extrapolated beyond run angle')
  if (s.twa === 'above_range') msgs.push('Wind angle is beyond the polar table range — values are extrapolated')
  return msgs
}

// ── Live-tick dispatcher ──────────────────────────────────────────────────────
function _tickActivePage() {
  if (activePage === 'overview') _tickOverview()
  else if (activePage === 'inputs')  _tickInputs()
  else if (activePage === 'outputs') _tickOutputs()
}

// ── PAGE: Overview ────────────────────────────────────────────────────────────
function _buildOverviewPage() {
  const row = document.createElement('div')
  row.className = 'row g-3'

  // Canvas (left)
  const left = document.createElement('div')
  left.className = 'col-md-6'
  const canvasEl = document.createElement('canvas')
  canvasEl.id = 'polar-canvas'
  canvasEl.className = 'polar-canvas'
  left.appendChild(canvasEl)

  // Live numbers (right) — skeleton built once; values updated in-place via setVal()
  const right = document.createElement('div')
  right.className = 'col-md-6'
  right.appendChild(sectionHeading('Live Performance'))
  right.appendChild(buildTable([
    { label: 'True Wind Speed',  id: 'ov-tws'  },
    { label: 'True Wind Angle',  id: 'ov-twa'  },
    { label: 'Boat Speed',       id: 'ov-bsp'  },
    { label: 'Polar Target',     id: 'ov-pol'  },
    { label: 'Performance',      id: 'ov-perf' },
  ]))

  // Targets and warnings — appended lazily by _tickOverview
  const targetsDiv = document.createElement('div'); targetsDiv.id = 'ov-targets'
  const warningsDiv = document.createElement('div'); warningsDiv.id = 'ov-warnings'
  right.appendChild(targetsDiv); right.appendChild(warningsDiv)

  row.appendChild(left); row.appendChild(right)

  if (window.PolarCanvas) {
    polar = new window.PolarCanvas(canvasEl, { showLibrary: false })
  }

  function _applyPolarData() {
    if (!polar) return
    if (Object.keys(meta).length) polar.setMeta(meta)
    if (twsList.length) polar.setLibraryData(twsList, curves, liveCurve)
    if (liveData)       polar.setLiveData(liveData, liveCurve)
  }

  // Use ResizeObserver to resize and redraw the canvas whenever its CSS size
  // changes — this handles both the async CoreUI stylesheet arriving and any
  // later window resize events. We debounce with one RAF so the aspect-ratio
  // constraint has settled before we read offsetWidth.
  if (window.ResizeObserver) {
    let _rafPending = false
    const obs = new ResizeObserver(() => {
      if (_rafPending) return
      _rafPending = true
      requestAnimationFrame(() => {
        _rafPending = false
        if (canvasEl.offsetWidth > 0 && polar) {
          polar.resize()
          _applyPolarData()
          _tickOverview()
        }
      })
    })
    obs.observe(canvasEl)
    row._cleanup = () => {
      obs.disconnect()
      window.removeEventListener('resize', onResize)
    }
  } else {
    // Fallback for browsers without ResizeObserver
    requestAnimationFrame(() => {
      if (polar) polar.resize()
      _applyPolarData()
      _tickOverview()
    })
    row._cleanup = () => window.removeEventListener('resize', onResize)
  }

  const onResize = () => { if (activePage === 'overview' && polar) polar.resize() }
  window.addEventListener('resize', onResize)
  return row
}

function _tickOverview() {
  const d = liveData
  setVal('ov-tws',  fmtVal(d?.tws,         'tws',         SPEED_DEFAULT))
  setVal('ov-twa',  fmtVal(d?.twa  != null  ? Math.abs(d.twa)  : null, 'twa', ANGLE_DEFAULT))
  setVal('ov-bsp',  fmtVal(d?.bsp,         'bsp',         SPEED_DEFAULT))
  setVal('ov-pol',  fmtVal(d?.polarSpeed,  'polarSpeed',  SPEED_DEFAULT))
  setVal('ov-perf', fmtVal(d?.performance, 'performance', RATIO_DEFAULT))

  // Targets — build sub-table on first appearance, then update in-place
  const tEl = document.getElementById('ov-targets')
  if (tEl && (liveCurve?.beat || liveCurve?.run)) {
    if (!document.getElementById('ov-beat-twa')) {
      tEl.appendChild(sectionHeading('Targets'))
      tEl.appendChild(buildTable([
        { label: 'Beat angle', id: 'ov-beat-twa' },
        { label: 'Beat VMG',   id: 'ov-beat-vmg' },
        { label: 'Run angle',  id: 'ov-run-twa'  },
        { label: 'Run VMG',    id: 'ov-run-vmg'  },
      ]))
    }
    setVal('ov-beat-twa', liveCurve?.beat ? fmtVal(liveCurve.beat.twa, 'curve.twa', ANGLE_DEFAULT) : '—')
    setVal('ov-beat-vmg', liveCurve?.beat ? fmtVal(liveCurve.beat.vmg, 'curve.vmg', SPEED_DEFAULT) : '—')
    setVal('ov-run-twa',  liveCurve?.run  ? fmtVal(liveCurve.run.twa,  'curve.twa', ANGLE_DEFAULT) : '—')
    setVal('ov-run-vmg',  liveCurve?.run  ? fmtVal(liveCurve.run.vmg,  'curve.vmg', SPEED_DEFAULT) : '—')
  }

  const warns = []
  if (d?.tws        == null) warns.push('True wind speed — no data (environment.wind.speedTrue)')
  if (d?.twa        == null) warns.push('True wind angle — no data (environment.wind.angleTrueWater)')
  if (d?.bsp        == null) warns.push('Boat speed — no data')
  if (d?.polarSpeed == null && d?.tws != null) warns.push('No polar loaded — configure in Polars')
  warns.push(...polarStateWarnings(d))
  updateWarnings(document.getElementById('ov-warnings'), warns)
}

// ── PAGE: Inputs ──────────────────────────────────────────────────────────────
function _buildInputsPage() {
  const wrap = document.createElement('div'); wrap.id = 'inputs-wrap'

  wrap.appendChild(sectionHeading('True Wind Speed'))
  wrap.appendChild(buildTable([
    { label: 'Raw  — environment.wind.speedTrue',      id: 'in-tws-raw' },
    { label: 'Smoothed — plugin',                      id: 'in-tws-smo' },
  ]))

  wrap.appendChild(sectionHeading('True Wind Angle'))
  wrap.appendChild(buildTable([
    { label: 'Raw  — environment.wind.angleTrueWater', id: 'in-twa-raw' },
    { label: 'Smoothed — plugin',                      id: 'in-twa-smo' },
  ]))

  wrap.appendChild(sectionHeading('Boat Speed'))
  // Row labels updated on tick to reflect useSOG setting
  wrap.appendChild(buildTable([
    { label: 'Raw', id: 'in-bsp-raw' },
    { label: 'Smoothed — plugin', id: 'in-bsp-smo' },
  ]))

  // Heading — only if tackTrue enabled
  if (settings?.tackTrue) {
    wrap.appendChild(sectionHeading('Heading (True)'))
    wrap.appendChild(buildTable([
      { label: 'Raw — navigation.headingTrue', id: 'in-hdg-raw' },
    ]))
  }

  const warningsDiv = document.createElement('div'); warningsDiv.id = 'in-warnings'
  wrap.appendChild(warningsDiv)

  _tickInputs()
  return wrap
}

function _tickInputs() {
  const d = liveData

  setVal('in-tws-raw', fmtVal(rawValues.tws, 'tws', SPEED_DEFAULT))
  setVal('in-tws-smo', fmtVal(d?.tws,        'tws', SPEED_DEFAULT))
  setVal('in-twa-raw', fmtVal(rawValues.twa !== null && rawValues.twa !== undefined ? Math.abs(rawValues.twa) : null, 'twa', ANGLE_DEFAULT))
  setVal('in-twa-smo', fmtVal(d?.twa !== null && d?.twa !== undefined ? Math.abs(d.twa) : null, 'twa', ANGLE_DEFAULT))
  setVal('in-bsp-raw', fmtVal(rawValues.bsp, 'bsp', SPEED_DEFAULT))
  setVal('in-bsp-smo', fmtVal(d?.bsp,        'bsp', SPEED_DEFAULT))
  if (settings?.tackTrue) setVal('in-hdg-raw', fmtVal(rawValues.hdg, 'twa', ANGLE_DEFAULT))

  // Update boat speed raw label to show actual path
  const bspLabelEl = document.querySelector('#in-bsp-raw')?.closest('tr')?.cells?.[0]
  if (bspLabelEl) bspLabelEl.textContent = 'Raw — ' + (settings?.useSOG ? 'navigation.speedOverGround' : 'navigation.speedThroughWater')

  setStale('in-tws-raw', rawValues.tws == null)
  setStale('in-tws-smo', d?.tws        == null)
  setStale('in-twa-raw', rawValues.twa == null)
  setStale('in-twa-smo', d?.twa        == null)
  setStale('in-bsp-raw', rawValues.bsp == null)
  setStale('in-bsp-smo', d?.bsp        == null)

  const warns = []
  if (rawValues.tws == null) warns.push('environment.wind.speedTrue — no data from instruments')
  if (rawValues.twa == null) warns.push('environment.wind.angleTrueWater — no data from instruments')
  if (rawValues.bsp == null) warns.push((settings?.useSOG ? 'navigation.speedOverGround' : 'navigation.speedThroughWater') + ' — no data from instruments')
  updateWarnings(document.getElementById('in-warnings'), warns)
}

// ── PAGE: Settings ─────────────────────────────────────────────────────────────
const SMOOTHER_PARAMS = {
  Exponential:   { key: 'smootherParamExponential',   label: 'Time constant τ (s)',      min: 0.1,   max: 60,  step: 0.1,   default: 1    },
  MovingAverage: { key: 'smootherParamMovingAverage', label: 'Window size (s)',           min: 1,     max: 120, step: 1,     default: 10   },
  Kalman:        { key: 'smootherParamKalman',        label: 'Steady-state gain (0–1)',   min: 0.001, max: 1,   step: 0.001, default: 0.1  },
}

function _buildSettingsPage() {
  if (!settings) {
    const p = document.createElement('p'); p.className = 'text-muted small mt-2'
    p.textContent = 'Loading settings…'; return p
  }

  const row = document.createElement('div')
  row.className = 'row g-3'

  // ── Left: polar canvas ────────────────────────────────────────────────────
  const left = document.createElement('div')
  left.className = 'col-md-6'
  const canvasEl = document.createElement('canvas')
  canvasEl.id = 'settings-polar-canvas'
  canvasEl.className = 'polar-canvas'
  left.appendChild(canvasEl)
  row.appendChild(left)

  // ── Right: settings controls ──────────────────────────────────────────────
  const right = document.createElement('div')
  right.className = 'col-md-6'

  // Polar
  right.appendChild(sectionHeading('Polar'))
  right.appendChild(_settingsTable([
    { label: 'Active polar',
      control: _polarSelector() },
    { label: 'Performance adjust', desc: '1.0 = 100%, 0.9 = 90%',
      control: createNumberInput('perfAdjust', settings.perfAdjust, { min: 0.1, max: 2, step: 0.05, default: 1 }, false, async () => {
        libraryVersion = ''   // force full curve reload — perfAdjust changes speeds but not the TWS list
        await refreshLibrary()
        if (activePage === 'settings') switchPage('settings')
      }) },
  ]))

  // Smoother
  right.appendChild(sectionHeading('Smoother'))
  const smRows = [{ label: 'Smoother type', control: _smootherSelector() }]
  const pm = SMOOTHER_PARAMS[settings.smootherType || 'Exponential']
  if (pm) smRows.push({ label: pm.label, control: createNumberInput(pm.key, settings[pm.key], pm, true) })
  right.appendChild(_settingsTable(smRows))

  // Speed source
  right.appendChild(sectionHeading('Speed Source'))
  right.appendChild(_settingsTable([
    { label: 'Use speed over ground (SOG)', desc: 'Off = navigation.speedThroughWater',
      control: createToggle(!!settings.useSOG, v =>
        apiPut('/settings', { useSOG: v }).then(s => { if (s) settings = s })
      )},
  ]))

  row.appendChild(right)

  // ── Canvas init + ResizeObserver ──────────────────────────────────────────
  let settingsPolar = null

  // Wrap canvas in a relative container so we can overlay a message
  const canvasWrap = document.createElement('div')
  canvasWrap.style.position = 'relative'
  canvasWrap.appendChild(canvasEl)
  left.innerHTML = ''
  left.appendChild(canvasWrap)

  const noPolarMsg = document.createElement('div')
  noPolarMsg.textContent = 'No polar loaded — select one above'
  noPolarMsg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:0.85rem;color:#888;pointer-events:none;'
  noPolarMsg.style.display = twsList.length ? 'none' : 'flex'
  canvasWrap.appendChild(noPolarMsg)

  if (window.PolarCanvas) {
    settingsPolar = new window.PolarCanvas(canvasEl, { showLibrary: true, showLiveCurve: false })
    if (Object.keys(meta).length) settingsPolar.setMeta(meta)
    if (twsList.length) settingsPolar.setLibraryData(twsList, curves, null)
  }

  if (window.ResizeObserver) {
    let _rafPending = false
    const obs = new ResizeObserver(() => {
      if (_rafPending) return
      _rafPending = true
      requestAnimationFrame(() => {
        _rafPending = false
        if (canvasEl.offsetWidth > 0 && settingsPolar) {
          settingsPolar.resize()
          settingsPolar.draw()
        }
      })
    })
    obs.observe(canvasEl)
    row._cleanup = () => { obs.disconnect(); settingsPolar = null }
  } else {
    requestAnimationFrame(() => {
      if (settingsPolar) { settingsPolar.resize(); settingsPolar.draw() }
    })
    row._cleanup = () => { settingsPolar = null }
  }

  return row
}

function _settingsTable(rows) {
  const tbl = document.createElement('table')
  tbl.className = 'table table-sm table-borderless mb-0'
  const tbody = document.createElement('tbody')
  rows.forEach(r => {
    const tr = document.createElement('tr')
    const tdL = document.createElement('td'); tdL.textContent = r.label
    if (r.desc) {
      const s = document.createElement('small'); s.className = 'text-muted d-block'; s.textContent = r.desc
      tdL.appendChild(s)
    }
    const tdC = document.createElement('td')
    if (r.control) tdC.appendChild(r.control)
    tr.appendChild(tdL); tr.appendChild(tdC)
    tbody.appendChild(tr)
  })
  tbl.appendChild(tbody); return tbl
}

function _polarSelector() {
  const sel = document.createElement('select')
  sel.className = 'form-select form-select-sm'; sel.style.width = '100%'
  const none = document.createElement('option'); none.value = ''; none.textContent = '— none —'
  sel.appendChild(none)
  polarsList.forEach(raw => {
    const p = typeof raw === 'string' ? { name: raw } : raw
    const o = document.createElement('option'); o.value = p.name
    o.textContent = p.boatName ? `${p.boatName} (${p.name})` : p.name
    sel.appendChild(o)
  })
  sel.value = settings?.activePolar || ''
  sel.addEventListener('change', () => {
    if (!sel.value) return
    apiPut('/settings', { activePolar: sel.value }).then(async s => {
      if (!s) return
      settings = s
      await refreshLibrary()
      if (activePage === 'settings') switchPage('settings')
    })
  })
  return sel
}

function _smootherSelector() {
  const sel = document.createElement('select')
  sel.className = 'form-select form-select-sm'; sel.style.width = '100%'
  ;['None', 'Exponential', 'MovingAverage', 'Kalman'].forEach(opt => {
    const o = document.createElement('option'); o.value = opt; o.textContent = opt; sel.appendChild(o)
  })
  sel.value = settings?.smootherType || 'Exponential'
  sel.addEventListener('change', () => {
    apiPut('/settings', { smootherType: sel.value }).then(s => {
      if (s) { settings = s; switchPage('settings') }
    })
  })
  return sel
}

// ── PAGE: Outputs ──────────────────────────────────────────────────────────────
function _buildOutputsPage() {
  const wrap = document.createElement('div'); wrap.id = 'outputs-wrap'
  wrap.appendChild(sectionHeading('Output Paths'))

  OUTPUT_DEFS.forEach(def => {
    const block = document.createElement('div'); block.className = 'mb-2'

    // Header row: label left, toggle right — same two-column layout as settings tables
    const enabled = !!(settings && settings[def.key])
    const toggle = createToggle(enabled, checked => {
      apiPut('/settings', { [def.key]: checked }).then(s => {
        if (!s) return
        settings = s
        const sub = document.getElementById('out-sub-' + def.key)
        if (sub) sub.style.display = checked ? '' : 'none'
      })
    })
    block.appendChild(buildTable([{ label: def.label, control: toggle, rowClass: 'fw-semibold' }]))

    // Sub-table: individual paths + live values (shown only when enabled)
    const sub = document.createElement('div')
    sub.id = 'out-sub-' + def.key
    sub.style.display = enabled ? '' : 'none'
    sub.style.display = enabled ? '' : 'none'
    sub.appendChild(buildTable(def.paths.map(p => ({
      label: p.label + '\u2002(' + p.sk.replace(/\//g, '.') + ')',
      id: skId(p.sk),
    }))))
    block.appendChild(sub)
    wrap.appendChild(block)
  })

  const warningsDiv = document.createElement('div'); warningsDiv.id = 'out-warnings'
  wrap.appendChild(warningsDiv)

  _tickOutputs()
  return wrap
}

function _tickOutputs() {
  OUTPUT_DEFS.forEach(def => {
    if (!settings || !settings[def.key]) return
    def.paths.forEach(p => {
      setVal(skId(p.sk), fmtVal(outputValues[p.sk], p.mk, p.fb))
    })
  })
  updateWarnings(document.getElementById('out-warnings'), polarStateWarnings(liveData))
}

// ── PAGE: Polars ───────────────────────────────────────────────────────────────
let _orcResults = []

function _buildPolarsPage() {
  const wrap = document.createElement('div'); wrap.id = 'polars-wrap'

  // Stored polars
  wrap.appendChild(sectionHeading('Stored Polars'))
  const listDiv = document.createElement('div'); listDiv.id = 'polars-list'
  _renderPolarsList(listDiv)
  wrap.appendChild(listDiv)

  // Upload CSV
  wrap.appendChild(sectionHeading('Upload CSV'))

  // Meta fields
  const metaGrid = document.createElement('div')
  metaGrid.className = 'd-flex flex-wrap gap-2 mb-2'
  const mkInp = (ph, w) => {
    const i = document.createElement('input')
    i.type = 'text'; i.className = 'form-control form-control-sm'
    i.style.width = w; i.placeholder = ph; return i
  }
  const nameInp     = mkInp('File name (required, no .csv)', '180px')
  const boatNameInp = mkInp('Boat name (optional)', '160px')
  const boatTypeInp = mkInp('Boat type (optional)', '140px')
  const sailNumInp  = mkInp('Sail number (optional)', '140px')
  metaGrid.appendChild(nameInp); metaGrid.appendChild(boatNameInp)
  metaGrid.appendChild(boatTypeInp); metaGrid.appendChild(sailNumInp)
  wrap.appendChild(metaGrid)

  // Custom file picker — hides the OS-locale "Browse"/"Bladeren" button
  const fileRow = document.createElement('div')
  fileRow.className = 'd-flex flex-wrap gap-2 align-items-center mb-3'
  const fileInp = document.createElement('input')
  fileInp.type = 'file'; fileInp.accept = '.csv,text/plain'; fileInp.style.display = 'none'
  const fileNameSpan = document.createElement('span')
  fileNameSpan.className = 'form-control form-control-sm text-muted'
  fileNameSpan.style.width = '240px'; fileNameSpan.textContent = 'No file selected'
  const browseBtn = document.createElement('button')
  browseBtn.className = 'btn btn-sm btn-outline-secondary'; browseBtn.textContent = 'Browse…'
  browseBtn.addEventListener('click', () => fileInp.click())
  fileInp.addEventListener('change', () => {
    fileNameSpan.textContent = fileInp.files[0]?.name || 'No file selected'
    fileNameSpan.classList.toggle('text-muted', !fileInp.files[0])
    if (fileInp.files[0] && !nameInp.value.trim())
      nameInp.value = fileInp.files[0].name.replace(/\.csv$/i, '')
  })
  const uploadBtn = document.createElement('button')
  uploadBtn.className = 'btn btn-sm btn-primary'; uploadBtn.textContent = 'Upload'
  uploadBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim()
    if (!name)             { showMessage('Enter a polar name'); return }
    if (!fileInp.files[0]) { showMessage('Select a CSV file'); return }
    const csv = await fileInp.files[0].text()
    const body = { csv,
      boatName:   boatNameInp.value.trim() || undefined,
      boatType:   boatTypeInp.value.trim() || undefined,
      sailnumber: sailNumInp.value.trim()  || undefined
    }
    const ok = await apiPostJSON('/polars/' + encodeURIComponent(name), body)
    if (ok) {
      showMessage('"' + name + '" uploaded')
      nameInp.value = ''; boatNameInp.value = ''; boatTypeInp.value = ''; sailNumInp.value = ''
      fileInp.value = ''; fileNameSpan.textContent = 'No file selected'; fileNameSpan.classList.add('text-muted')
      await refreshPolars(); _renderPolarsList(document.getElementById('polars-list'))
    }
  })
  fileRow.appendChild(fileInp); fileRow.appendChild(fileNameSpan)
  fileRow.appendChild(browseBtn); fileRow.appendChild(uploadBtn)
  wrap.appendChild(fileRow)

  // ORC import
  const orcSection = document.createElement('div'); orcSection.id = 'orc-section'
  _buildOrcSection(orcSection)
  wrap.appendChild(orcSection)

  checkInternet()
  return wrap
}

function _buildOrcSection(container) {
  container.innerHTML = ''
  container.appendChild(sectionHeading('Import from ORC'))

  // Internet warning (hidden by default, shown when offline)
  const warn = document.createElement('div'); warn.id = 'orc-internet-warn'
  warn.className = 'alert alert-warning small py-1 px-2 mb-2'
  warn.style.display = 'none'
  warn.textContent = 'No internet connection detected — ORC import is unavailable.'
  container.appendChild(warn)

  const searchRow = document.createElement('div')
  searchRow.className = 'd-flex gap-2 align-items-center mb-2'
  const searchInp = document.createElement('input')
  searchInp.type = 'text'; searchInp.id = 'orc-search-inp'
  searchInp.className = 'form-control form-control-sm'
  searchInp.style.width = '240px'; searchInp.placeholder = 'Boat name, type or sail number'
  const searchBtn = document.createElement('button')
  searchBtn.id = 'orc-search-btn'
  searchBtn.className = 'btn btn-sm btn-outline-secondary'; searchBtn.textContent = 'Search'
  const resultsDiv = document.createElement('div'); resultsDiv.id = 'orc-results'
  if (_orcResults.length) _renderOrcResults(resultsDiv)

  async function doSearch() {
    if (hasInternet === false) { showMessage('No internet connection'); return }
    searchBtn.disabled = true; searchBtn.textContent = 'Searching…'
    const res = await apiGet('/polars/import/search?q=' + encodeURIComponent(searchInp.value.trim()))
    searchBtn.disabled = false; searchBtn.textContent = 'Search'
    if (!res) return
    _orcResults = res; _renderOrcResults(resultsDiv)
  }
  searchBtn.addEventListener('click', doSearch)
  searchInp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch() })
  searchRow.appendChild(searchInp); searchRow.appendChild(searchBtn)
  container.appendChild(searchRow); container.appendChild(resultsDiv)
  _updateOrcInternetState()
}

function _updateOrcInternetState() {
  const warn = document.getElementById('orc-internet-warn')
  const inp  = document.getElementById('orc-search-inp')
  const btn  = document.getElementById('orc-search-btn')
  if (!warn) return
  const offline = hasInternet === false
  warn.style.display = offline ? '' : 'none'
  if (inp) inp.disabled = offline
  if (btn) btn.disabled = offline
}

function _renderPolarsList(el) {
  el.innerHTML = ''
  if (!polarsList.length) {
    const p = document.createElement('p'); p.className = 'text-muted small mb-3'
    p.textContent = 'No polars stored. Upload a CSV or import from ORC below.'
    el.appendChild(p); return
  }
  const tbl = document.createElement('table')
  tbl.className = 'table table-sm table-borderless mb-2'
  const tbody = document.createElement('tbody')
  polarsList.forEach(raw => {
    const entry = typeof raw === 'string' ? { name: raw } : raw
    const name = entry.name
    const isActive = name === settings?.activePolar
    const tr = document.createElement('tr')
    const tdN = document.createElement('td')
    const label = entry.boatName || name
    tdN.textContent = label
    const sub = []
    if (entry.boatType)   sub.push(entry.boatType)
    if (entry.sailnumber) sub.push(entry.sailnumber)
    if (entry.boatName)   sub.push(name)
    if (sub.length) {
      const sm = document.createElement('small'); sm.className = 'text-muted d-block'
      sm.textContent = sub.join(' \u00b7 ')
      tdN.appendChild(sm)
    }
    if (isActive) {
      const badge = document.createElement('span')
      badge.className = 'badge bg-success ms-2'; badge.textContent = 'active'
      tdN.appendChild(badge)
    }
    const tdA = document.createElement('td'); tdA.className = 'polar-actions'
    if (!isActive) {
      const actBtn = document.createElement('button')
      actBtn.className = 'btn btn-sm btn-outline-primary me-1'; actBtn.textContent = 'Activate'
      actBtn.addEventListener('click', async () => {
        const s = await apiPut('/settings', { activePolar: name })
        if (s) { settings = s; await refreshLibrary(); await refreshPolars(); _renderPolarsList(el) }
      })
      tdA.appendChild(actBtn)
    }
    const delBtn = document.createElement('button')
    delBtn.className = 'btn btn-sm btn-outline-danger'; delBtn.textContent = 'Delete'
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete polar "' + name + '"?')) return
      await apiDelete('/polars/' + encodeURIComponent(name))
      await refreshPolars(); _renderPolarsList(el)
    })
    tdA.appendChild(delBtn)
    tr.appendChild(tdN); tr.appendChild(tdA); tbody.appendChild(tr)
  })
  tbl.appendChild(tbody); el.appendChild(tbl)
}

function _renderOrcResults(el) {
  el.innerHTML = ''
  if (!_orcResults.length) {
    const p = document.createElement('p'); p.className = 'text-muted small'
    p.textContent = 'No results.'; el.appendChild(p); return
  }
  const tbl = document.createElement('table')
  tbl.className = 'table table-sm table-borderless mb-0'
  const tbody = document.createElement('tbody')
  _orcResults.slice(0, 25).forEach(boat => {
    const tr = document.createElement('tr')
    const tdN = document.createElement('td')
    tdN.textContent = boat.name + (boat.type ? ' (' + boat.type + ')' : '')
    const s = document.createElement('small'); s.className = 'text-muted d-block'; s.textContent = boat.sailnumber
    tdN.appendChild(s)
    const tdA = document.createElement('td'); tdA.className = 'polar-actions'
    const importBtn = document.createElement('button')
    importBtn.className = 'btn btn-sm btn-outline-success'; importBtn.textContent = 'Import'
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true; importBtn.textContent = 'Importing…'
      const res = await fetch(API + '/polars/import/' + encodeURIComponent(boat.sailnumber), {
        method: 'POST', credentials: 'same-origin'
      })
      importBtn.disabled = false; importBtn.textContent = 'Import'
      if (res.ok) {
        showMessage('Imported "' + boat.name + '"')
        await refreshPolars(); _renderPolarsList(document.getElementById('polars-list'))
      } else {
        showMessage('Import failed: ' + res.status)
      }
    })
    tdA.appendChild(importBtn); tr.appendChild(tdN); tr.appendChild(tdA); tbody.appendChild(tr)
  })
  tbl.appendChild(tbody); el.appendChild(tbl)
}

// ── Navigation ────────────────────────────────────────────────────────────────
const PAGES = {
  overview: { title: 'Overview', build: _buildOverviewPage },
  inputs:   { title: 'Inputs',   build: _buildInputsPage   },
  settings: { title: 'Settings', build: _buildSettingsPage },
  outputs:  { title: 'Outputs',  build: _buildOutputsPage  },
  polars:   { title: 'Polars',   build: _buildPolarsPage   },
}

let _currentPageEl = null

function switchPage(page) {
  if (_currentPageEl?._cleanup) _currentPageEl._cleanup()
  if (activePage === 'overview') polar = null
  activePage = page

  document.querySelectorAll('#main-nav .nav-link').forEach(l =>
    l.classList.toggle('active', l.dataset.page === page)
  )
  document.getElementById('card-title').textContent = PAGES[page].title

  const body = document.getElementById('card-body')
  body.innerHTML = ''
  body.classList.toggle('polar-layout', page === 'overview' || page === 'settings')

  _currentPageEl = PAGES[page].build()
  body.appendChild(_currentPageEl)
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  setInterval(refreshLive, 1000)
  setInterval(async () => {
    await refreshLibrary()
    if (activePage === 'overview' && polar) polar.setLibraryData(twsList, curves, liveCurve)
  }, 5000)
  setInterval(checkInternet, 30000)
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  document.querySelectorAll('#main-nav .nav-link').forEach(link =>
    link.addEventListener('click', e => { e.preventDefault(); switchPage(link.dataset.page) })
  )
  document.getElementById('sidebarMinimizer')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-minimized')
    document.body.classList.toggle('brand-minimized')
  })
  document.getElementById('sidebarToggler')?.addEventListener('click', () =>
    document.body.classList.toggle('sidebar-hidden')
  )

  await Promise.all([refreshSettings(), refreshPolars()])
  await loadMeta()
  switchPage('overview')
  await refreshLibrary()
  await refreshLive()
  startPolling()
}

init()

