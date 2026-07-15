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

async function apiPost(path, body) {
  try {
    const res = await fetch(API + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      let detail = ''
      try {
        const payload = await res.json()
        if (payload?.error) detail = ': ' + payload.error
      } catch (_) {}
      showMessage('Import failed: ' + res.status + detail)
      return null
    }
    return res.json()
  } catch (e) { showMessage('Import failed: ' + e.message); return null }
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

function createCollapsibleCard(title, startOpen = false) {
  const card = document.createElement('div')
  card.className = 'card mb-3'

  const header = document.createElement('div')
  header.className = 'card-header p-0'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-link btn-block text-start text-decoration-none px-3 py-2'
  button.style.textAlign = 'left'

  const body = document.createElement('div')
  body.className = 'card-body'
  body.style.display = startOpen ? '' : 'none'

  const syncLabel = () => {
    button.textContent = (body.style.display === 'none' ? '+ ' : '- ') + title
    button.setAttribute('aria-expanded', body.style.display === 'none' ? 'false' : 'true')
  }

  button.addEventListener('click', () => {
    body.style.display = body.style.display === 'none' ? '' : 'none'
    syncLabel()
  })
  syncLabel()

  header.appendChild(button)
  card.appendChild(header)
  card.appendChild(body)
  return { card, body }
}

function createPageCard(title) {
  const card = document.createElement('div')
  card.className = 'card mb-3'

  const header = document.createElement('div')
  header.className = 'card-header fw-bold text-uppercase'
  header.textContent = title

  const body = document.createElement('div')
  body.className = 'card-body'

  card.appendChild(header)
  card.appendChild(body)
  return { card, body }
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

function createPercentInput(key, value, opts, onSaved) {
  const wrap = document.createElement('span')
  const inp = document.createElement('input')
  inp.type = 'number'
  inp.className = 'form-control form-control-sm d-inline-block'
  inp.style.width = '90px'
  inp.value = Number.isFinite(value) ? (value * 100).toFixed(0) : (opts.defaultPercent ?? 100)
  if (opts.minPercent !== undefined) inp.min = opts.minPercent
  if (opts.maxPercent !== undefined) inp.max = opts.maxPercent
  if (opts.stepPercent !== undefined) inp.step = opts.stepPercent

  const suffix = document.createElement('span')
  suffix.className = 'ms-1 small text-muted'
  suffix.textContent = '%'

  inp.addEventListener('change', () => {
    const percent = Number(inp.value)
    if (!Number.isFinite(percent)) return
    apiPut('/settings', { [key]: percent / 100 }).then(s => {
      if (s) {
        settings = s
        inp.value = Number.isFinite(s[key]) ? (s[key] * 100).toFixed(0) : inp.value
        if (typeof onSaved === 'function') onSaved(s)
      }
    })
  })

  wrap.appendChild(inp)
  wrap.appendChild(suffix)
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
let importFormats = []
let importSources = []

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

async function refreshImportFormats() {
  const formats = await apiGet('/imports/formats')
  if (formats) importFormats = formats
}

async function refreshImportSources() {
  const sources = await apiGet('/imports/sources')
  if (sources) importSources = sources
}

async function refreshLibrary() {
  const activeId = settings?.activePolar
  if (!activeId) {
    if (libraryVersion !== '') {
      libraryVersion = ''; twsList = []; curves = {}
      if (polar) polar.setLibraryData([], {}, null)
    }
    return
  }

  const newList = await apiGet('/polars/' + encodeURIComponent(activeId) + '/axes/tws', { silent503: true })
  if (!newList) {
    // No polar loaded — clear any previously displayed curves
    if (libraryVersion !== '') {
      libraryVersion = ''; twsList = []; curves = {}
      if (polar) polar.setLibraryData([], {}, null)
    }
    return
  }
  const version = activeId + '|' + JSON.stringify(newList)
  if (version === libraryVersion) return
  libraryVersion = version; twsList = newList; curves = {}
  await Promise.all(twsList.map(async tws => {
    try {
      const c = await apiGet(
        '/polars/' + encodeURIComponent(activeId) + '/queries/curve?tws=' + tws.toFixed(5) + '&step=' + STEP,
        { silent503: true }
      )
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
    const activeId = settings?.activePolar
    if (tws !== null && (!liveTws || Math.abs(tws - liveTws) > 0.05)) {
      liveTws = tws
      try {
        liveCurve = activeId
          ? await apiGet('/polars/' + encodeURIComponent(activeId) + '/queries/curve?tws=' + tws.toFixed(5) + '&step=' + STEP)
          : null
      }
      catch (_) {}
    }
    polar.setLiveData(liveData, liveCurve)
  }

  // 4. Tick active page
  _tickActivePage()
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
  if (d?.tws != null && d?.polarState == null) warns.push('No polar loaded — configure in Polars')
  warns.push(...polarStateWarnings(d))
  updateWarnings(document.getElementById('ov-warnings'), warns)
}

// ── PAGE: Inputs ──────────────────────────────────────────────────────────────
function _buildInputsPage() {
  const wrap = document.createElement('div'); wrap.id = 'inputs-wrap'

  // Smoother settings (top)
  wrap.appendChild(sectionHeading('Smoother'))
  const smRows = [{ label: 'Smoother type', control: _smootherSelector() }]
  const pm = SMOOTHER_PARAMS[settings?.smootherType || 'Exponential']
  if (pm) smRows.push({ label: pm.label, control: createNumberInput(pm.key, settings?.[pm.key], pm, true) })
  wrap.appendChild(_settingsTable(smRows))

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
  // SOG toggle sits above the data paths
  wrap.appendChild(_settingsTable([
    { label: 'Use speed over ground (SOG)', desc: 'Off = navigation.speedThroughWater',
      control: createToggle(!!settings?.useSOG, v =>
        apiPut('/settings', { useSOG: v }).then(s => { if (s) { settings = s; switchPage('inputs') } })
      )},
  ]))
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

  // Resolve metadata for the currently active polar
  const activeMeta = (() => {
    const a = settings?.activePolar
    if (!a) return {}
    const entry = polarsList.find(p => (typeof p === 'string' ? p : p.id) === a)
    return (entry && typeof entry === 'object') ? entry : {}
  })()

  right.appendChild(_settingsTable([
    { label: 'Active polar',
      control: _polarSelector() },
    { label: 'Performance adjust', desc: '100% = polar speed unchanged',
      control: createPercentInput('perfAdjust', settings.perfAdjust, { minPercent: 10, maxPercent: 200, stepPercent: 5, defaultPercent: 100 }, async () => {
        libraryVersion = ''   // force full curve reload — perfAdjust changes speeds but not the TWS list
        await refreshLibrary()
        if (activePage === 'settings') switchPage('settings')
      }) },
    { label: 'Boat name',    control: _metaDisplay(activeMeta.name)   },
    { label: 'Boat type',    control: _metaDisplay(activeMeta.boatType)   },
    { label: 'Sail number',  control: _metaDisplay(activeMeta.sailnumber) },
    { label: 'Year',         control: _metaDisplay(activeMeta.year ? String(activeMeta.year) : '') },
    { label: 'Source',       control: _metaDisplay(activeMeta.source) },
  ]))

  // Smoother
  // (moved to Inputs page)

  // Speed source
  // (moved to Inputs page)

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

/** Read-only display span for polar metadata fields. */
function _metaDisplay(value) {
  const span = document.createElement('span')
  span.className = value ? 'small' : 'small text-muted'
  span.textContent = value || '—'
  return span
}

function readOptionalIntegerInput(input) {
  const text = String(input?.value || '').trim()
  if (!text) return undefined
  const value = Number(text)
  return Number.isInteger(value) ? value : undefined
}

function _polarSelector() {
  const sel = document.createElement('select')
  sel.className = 'form-select form-select-sm'; sel.style.width = '100%'
  const none = document.createElement('option'); none.value = ''; none.textContent = '— none —'
  sel.appendChild(none)
  polarsList.forEach(raw => {
    const p = typeof raw === 'string' ? { id: raw, name: raw } : raw
    const o = document.createElement('option'); o.value = p.id
    o.textContent = p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id
    sel.appendChild(o)
  })
  sel.value = settings?.activePolar || ''
  sel.addEventListener('change', () => {
    const request = sel.value
      ? apiPut('/polars/active', { id: sel.value })
      : apiDelete('/polars/active')

    request.then(async s => {
      if (!s) return
      settings = { ...(settings || {}), activePolar: s.id || '' }
      libraryVersion = ''   // force full reload — new polar may share the same TWS list
      await refreshLibrary()
      await refreshPolars()
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
      if (s) { settings = s; switchPage('inputs') }
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
function _buildPolarsPage() {
  const wrap = document.createDocumentFragment()

  const storedCard = createPageCard('Stored Polars')
  wrap.appendChild(storedCard.card)
  const listDiv = document.createElement('div'); listDiv.id = 'polars-list'
  _renderPolarsList(listDiv)
  storedCard.body.appendChild(listDiv)

  const textCard = createCollapsibleCard('Import Text Polar', false)
  wrap.appendChild(textCard.card)
  const textWrap = textCard.body

  const importMetaTable = document.createElement('table')
  importMetaTable.className = 'table table-sm table-borderless mb-2'
  const importMetaBody = document.createElement('tbody')

  const formatSel = document.createElement('select')
  formatSel.className = 'form-select form-select-sm'
  formatSel.style.width = '220px'
  if (!importFormats.length) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'No formats available'
    formatSel.appendChild(opt)
    formatSel.disabled = true
  } else {
    importFormats.forEach(format => {
      const opt = document.createElement('option')
      opt.value = format.id
      opt.textContent = format.name
      formatSel.appendChild(opt)
    })
  }

  const makeTextInput = (placeholder, width) => {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'form-control form-control-sm'
    if (width) input.style.width = width
    if (placeholder) input.placeholder = placeholder
    return input
  }

  const nameInp = makeTextInput('Optional display name')
  const sailInp = makeTextInput('Optional sail number')
  const typeInp = makeTextInput('Optional boat type')
  const yearInp = document.createElement('input')
  yearInp.type = 'number'
  yearInp.className = 'form-control form-control-sm'
  yearInp.style.width = '120px'
  yearInp.placeholder = 'Optional year'
  const sourceInp = makeTextInput('Defaults to format id')

  const addFormRow = (label, control, desc) => {
    const tr = document.createElement('tr')
    const tdL = document.createElement('td')
    tdL.textContent = label
    if (desc) {
      const sm = document.createElement('small')
      sm.className = 'text-muted d-block'
      sm.textContent = desc
      tdL.appendChild(sm)
    }
    const tdV = document.createElement('td')
    tdV.appendChild(control)
    tr.appendChild(tdL)
    tr.appendChild(tdV)
    importMetaBody.appendChild(tr)
  }

  addFormRow('Format', formatSel, 'Text formats currently supported by the plugin.')
  addFormRow('Name', nameInp)
  addFormRow('Sail number', sailInp)
  addFormRow('Boat type', typeInp)
  addFormRow('Year', yearInp)
  addFormRow('Source label', sourceInp, 'Optional metadata override stored with the canonical polar.')
  importMetaTable.appendChild(importMetaBody)
  textWrap.appendChild(importMetaTable)

  const importTextArea = document.createElement('textarea')
  importTextArea.className = 'form-control form-control-sm mb-2'
  importTextArea.rows = 12
  importTextArea.placeholder = 'Paste Jieter or Expedition polar text here'
  importTextArea.style.fontFamily = 'monospace'
  importTextArea.style.fontSize = '0.8rem'
  textWrap.appendChild(importTextArea)

  const notesArea = document.createElement('textarea')
  notesArea.className = 'form-control form-control-sm mb-2'
  notesArea.rows = 3
  notesArea.placeholder = 'Optional notes stored with the imported polar'
  textWrap.appendChild(notesArea)

  const importBtn = document.createElement('button')
  importBtn.className = 'btn btn-sm btn-primary mb-3'
  importBtn.textContent = 'Import'
  importBtn.disabled = !importFormats.length
  importBtn.addEventListener('click', async () => {
    const format = formatSel.value
    const content = importTextArea.value.trim()
    if (!format) { showMessage('Select an import format'); return }
    if (!content) { showMessage('Paste polar text first'); return }

    const body = {
      content,
      ...(nameInp.value.trim() ? { name: nameInp.value.trim() } : {}),
      ...(sailInp.value.trim() ? { sailnumber: sailInp.value.trim() } : {}),
      ...(typeInp.value.trim() ? { boatType: typeInp.value.trim() } : {}),
      ...(readOptionalIntegerInput(yearInp) !== undefined ? { year: readOptionalIntegerInput(yearInp) } : {}),
      ...(sourceInp.value.trim() ? { source: sourceInp.value.trim() } : {}),
      ...(notesArea.value.trim() ? { notes: notesArea.value.trim() } : {})
    }

    const result = await apiPost('/imports/text/' + encodeURIComponent(format), body)
    if (result) {
      showMessage('Imported "' + result.id + '"')
      nameInp.value = ''
      sailInp.value = ''
      typeInp.value = ''
      yearInp.value = ''
      sourceInp.value = ''
      importTextArea.value = ''
      notesArea.value = ''
      await refreshPolars()
      _renderPolarsList(document.getElementById('polars-list'))
    }
  })
  textWrap.appendChild(importBtn)

  const orcCard = createCollapsibleCard('Import ORC Certificate', false)
  wrap.appendChild(orcCard.card)
  const orcWrap = orcCard.body

  const orcSource = importSources.find(source => source.id === 'orc') || null
  if (!orcSource) {
    const unavailable = document.createElement('div')
    unavailable.className = 'text-muted small mb-3'
    unavailable.textContent = 'The plugin did not advertise an ORC source.'
    orcWrap.appendChild(unavailable)
  } else if (orcSource.available === false) {
    const unavailable = document.createElement('div')
    unavailable.className = 'text-muted small mb-3'
    unavailable.textContent = orcSource.availabilityMessage || 'ORC source unavailable: internet access is required for external source imports.'
    orcWrap.appendChild(unavailable)
  } else {
    const sourceBlurb = document.createElement('p')
    sourceBlurb.className = 'text-muted small mb-2'
    sourceBlurb.textContent = 'Search the official ORC active certificate index by RefNo, boat name, sail number, or class.'
    orcWrap.appendChild(sourceBlurb)

    const searchRow = document.createElement('div')
    searchRow.className = 'd-flex flex-wrap gap-2 align-items-center mb-2'

    const orcSearchInp = makeTextInput('RefNo, boat name, sail number, or class', '320px')
    const orcSearchBtn = document.createElement('button')
    orcSearchBtn.className = 'btn btn-sm btn-secondary'
    orcSearchBtn.textContent = 'Search'
    searchRow.appendChild(orcSearchInp)
    searchRow.appendChild(orcSearchBtn)
    orcWrap.appendChild(searchRow)

    const orcResults = document.createElement('div')
    orcResults.id = 'orc-results'
    orcResults.className = 'mb-3'
    orcWrap.appendChild(orcResults)

    const renderOrcResults = (items) => {
      orcResults.innerHTML = ''

      if (!items.length) {
        const empty = document.createElement('div')
        empty.className = 'text-muted small'
        empty.textContent = 'No ORC certificates matched the current search.'
        orcResults.appendChild(empty)
        return
      }

      const table = document.createElement('table')
      table.className = 'table table-sm table-hover mb-0'
      const tbody = document.createElement('tbody')

      items.forEach(item => {
        const tr = document.createElement('tr')

        const tdInfo = document.createElement('td')
        const title = document.createElement('div')
        title.className = 'fw-semibold'
        title.textContent = item.name || item.externalId
        tdInfo.appendChild(title)

        const meta = document.createElement('small')
        meta.className = 'text-muted d-block'
        const metaParts = [
          item.externalId,
          item.sailnumber,
          item.boatType,
          item.certificateName,
          item.familyName,
          item.countryId,
          Number.isInteger(item.year) ? String(item.year) : ''
        ].filter(Boolean)
        meta.textContent = metaParts.join(' | ')
        tdInfo.appendChild(meta)

        const tdAction = document.createElement('td')
        tdAction.className = 'polar-actions'
        const btn = document.createElement('button')
        btn.className = 'btn btn-sm btn-primary'
        btn.textContent = 'Import'
        btn.addEventListener('click', async () => {
          const result = await apiPost(
            '/imports/sources/' + encodeURIComponent(orcSource.id) + '/items/' + encodeURIComponent(item.externalId)
          )
          if (result) {
            showMessage('Imported "' + result.id + '" from ORC')
            await refreshPolars()
            _renderPolarsList(document.getElementById('polars-list'))
          }
        })
        tdAction.appendChild(btn)

        tr.appendChild(tdInfo)
        tr.appendChild(tdAction)
        tbody.appendChild(tr)
      })

      table.appendChild(tbody)
      orcResults.appendChild(table)
    }

    const runOrcSearch = async () => {
      const q = orcSearchInp.value.trim()
      if (!q) {
        showMessage('Enter an ORC search term first')
        return
      }

      const query = new URLSearchParams({ q })
      const results = await apiGet('/imports/sources/' + encodeURIComponent(orcSource.id) + '/search?' + query.toString())
      if (results) renderOrcResults(results)
    }

    orcSearchBtn.addEventListener('click', runOrcSearch)
    orcSearchInp.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        runOrcSearch()
      }
    })
  }

  return wrap
}

function _renderPolarsList(el) {
  el.innerHTML = ''
  if (!polarsList.length) {
    const p = document.createElement('p'); p.className = 'text-muted small mb-3'
    p.textContent = 'No canonical polars stored yet.'
    el.appendChild(p)
    return
  }

  const tbl = document.createElement('table')
  tbl.className = 'table table-sm table-borderless mb-2'
  const tbody = document.createElement('tbody')

  polarsList.forEach(raw => {
    const entry = typeof raw === 'string' ? { id: raw, name: raw } : raw
    const id = entry.id
    const isActive = id === settings?.activePolar
    const tr = document.createElement('tr')
    const tdN = document.createElement('td')
    const labelSpan = document.createElement('span')
    labelSpan.textContent = entry.name || id
    tdN.appendChild(labelSpan)
    if (isActive) {
      const badge = document.createElement('span')
      badge.className = 'badge bg-success ms-2'
      badge.textContent = 'active'
      tdN.appendChild(badge)
    }

    const sub = []
    if (entry.boatType) sub.push(entry.boatType)
    if (entry.sailnumber) sub.push(entry.sailnumber)
    if (sub.length) {
      const sm = document.createElement('small')
      sm.className = 'text-muted d-block'
      sm.textContent = sub.join(' \u00b7 ')
      tdN.appendChild(sm)
    }

    const tdA = document.createElement('td')
    tdA.className = 'polar-actions'
    if (!isActive) {
      const actBtn = document.createElement('button')
      actBtn.className = 'btn btn-sm btn-outline-primary me-1'
      actBtn.textContent = 'Activate'
      actBtn.addEventListener('click', async () => {
        const result = await apiPut('/polars/active', { id })
        if (result) {
          settings = { ...(settings || {}), activePolar: result.id }
          libraryVersion = ''
          await refreshLibrary()
          await refreshPolars()
          _renderPolarsList(el)
          if (activePage === 'settings') switchPage('settings')
        }
      })
      tdA.appendChild(actBtn)
    }

    const delBtn = document.createElement('button')
    delBtn.className = 'btn btn-sm btn-outline-danger'
    delBtn.textContent = 'Delete'
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete polar "' + id + '"?')) return
      await apiDelete('/polars/' + encodeURIComponent(id))
      await refreshSettings()
      await refreshPolars()
      libraryVersion = ''
      await refreshLibrary()
      _renderPolarsList(el)
    })
    tdA.appendChild(delBtn)

    tr.appendChild(tdN)
    tr.appendChild(tdA)
    tbody.appendChild(tr)
  })

  tbl.appendChild(tbody)
  el.appendChild(tbl)
}

// ── Navigation ────────────────────────────────────────────────────────────────
const PAGES = {
  overview: { title: 'Overview',          build: _buildOverviewPage  },
  inputs:   { title: 'Inputs',             build: _buildInputsPage   },
  settings: { title: 'Polar',              build: _buildSettingsPage },
  outputs:  { title: 'Outputs',            build: _buildOutputsPage  },
  polars:   { title: 'Polar management',   build: _buildPolarsPage   },
}

let _currentPageEl = null

function switchPage(page) {
  if (_currentPageEl?._cleanup) _currentPageEl._cleanup()
  if (activePage === 'overview') polar = null
  activePage = page

  document.querySelectorAll('#main-nav .nav-link').forEach(l =>
    l.classList.toggle('active', l.dataset.page === page)
  )
  const shell = document.getElementById('page-shell')
  const title = document.getElementById('card-title')
  const body = document.getElementById('card-body')
  title.textContent = PAGES[page].title
  body.innerHTML = ''
  shell.classList.toggle('page-shellless', page === 'polars')
  body.classList.toggle('page-shellless-body', page === 'polars')
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
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const isMobile = () => window.matchMedia('(max-width: 767.98px)').matches
  document.querySelectorAll('#main-nav .nav-link').forEach(link =>
    link.addEventListener('click', e => {
      e.preventDefault()
      switchPage(link.dataset.page)
      if (isMobile()) document.body.classList.remove('sidebar-mobile-show')
    })
  )
  document.getElementById('sidebarMinimizer')?.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-minimized')
    document.body.classList.toggle('brand-minimized')
  })
  document.getElementById('sidebarToggler')?.addEventListener('click', () => {
    if (isMobile()) {
      document.body.classList.toggle('sidebar-mobile-show')
    } else {
      document.body.classList.toggle('sidebar-hidden')
    }
  })

  await Promise.all([refreshSettings(), refreshPolars(), refreshImportFormats(), refreshImportSources()])
  await loadMeta()
  switchPage('overview')
  await refreshLibrary()
  await refreshLive()
  startPolling()
}

init()

