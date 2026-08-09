// polar-canvas.js
// Renders a 360° sailing polar diagram on an HTML <canvas> element.
//
// Uses two layers:
//   offscreen canvas — grid + library curves (rebuilt only when polar data changes)
//   live canvas      — interpolated current-TWS curve + live dots + wind arrow
//
// No ES modules, no CDN dependencies, no build step.
// Exposed as window.PolarCanvas.

(function (global) {
  'use strict'

  const GRAPH_MARKER_RADIUS = 5
  const BEARING_DOT_RADIUS = 7

  // ---------------------------------------------------------------------------
  // Unit helpers — all data from endpoints is SI (m/s, rad).
  // Display units are read from the /meta endpoint so the server's user
  // preferences (kn vs m/s, ° vs rad) are respected.
  // ---------------------------------------------------------------------------

  // Canvas XY for a point at (angleRad, speedMs) in polar space.
  // angleRad=0 is straight up (head to wind); clockwise.
  // maxMs is the full-scale speed in m/s.
  function polarToXY(cx, cy, R, maxMs, angleRad, speedMs) {
    const r = (speedMs / maxMs) * R
    return {
      x: cx + r * Math.sin(angleRad),
      y: cy - r * Math.cos(angleRad)
    }
  }

  // ---------------------------------------------------------------------------
  // PolarCanvas constructor
  // ---------------------------------------------------------------------------

  function PolarCanvas(canvas, opts) {
    this._canvas     = canvas
    this._ctx        = canvas.getContext('2d')
    this._offscreen  = null
    this._offCtx     = null
    this._cacheValid = false

    // Display options
    this._showLibrary   = (opts && opts.showLibrary  !== undefined) ? opts.showLibrary  : true
    this._showLiveCurve = (opts && opts.showLiveCurve !== undefined) ? opts.showLiveCurve : true
    this._mode          = (opts && opts.mode) ? opts.mode : 'performance'

    // Library data (set once per polar load)
    this._twsList  = []   // [number] — TWS values in m/s
    this._curves   = {}   // twsMs → { tws, points:[{twa,tbs}], beat, run }

    // Live data (updated every poll cycle)
    this._live      = null  // { tws, twa, bsp, polarSpeed, performance } — SI
    this._liveCurve = null  // curve for current live TWS (same shape as library curve)

    // Navigation mode data
    this._navCurve = null   // { points:[{headingTrue, vmc}], ... }
    this._navLive  = null   // { actualAngle, actualValue, targetAngle, targetValue, oppositeAngle, oppositeValue, course, routeSuppressed, statusMessage }

    // Display unit metadata from GET /meta
    this._meta         = null
    this._formulaCache = new Map()

    this._initOffscreen()
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value)
  }

  function wrapPi(a) {
    let v = a
    while (v > Math.PI) v -= 2 * Math.PI
    while (v <= -Math.PI) v += 2 * Math.PI
    return v
  }

  function orderAngularPoints(points, angleKey) {
    const sorted = points.slice().sort(function (a, b) { return a[angleKey] - b[angleKey] })
    if (sorted.length < 2) return sorted

    let largestGap = -1
    let splitIndex = 0
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i][angleKey]
      const next = sorted[(i + 1) % sorted.length][angleKey]
      const gap = i === sorted.length - 1
        ? (next + (2 * Math.PI)) - current
        : next - current
      if (gap > largestGap) {
        largestGap = gap
        splitIndex = i + 1
      }
    }

    if (splitIndex <= 0 || splitIndex >= sorted.length) return sorted
    return sorted.slice(splitIndex).concat(sorted.slice(0, splitIndex))
  }

  function drawHollowCircle(ctx, x, y, radius, strokeColor, fillColor, lineWidth) {
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = fillColor
    ctx.fill()
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = lineWidth
    ctx.stroke()
  }

  PolarCanvas.prototype._initOffscreen = function () {
    const w = this._canvas.width
    const h = this._canvas.height
    if (typeof OffscreenCanvas !== 'undefined') {
      this._offscreen = new OffscreenCanvas(w, h)
    } else {
      this._offscreen        = document.createElement('canvas')
      this._offscreen.width  = w
      this._offscreen.height = h
    }
    this._offCtx     = this._offscreen.getContext('2d')
    this._cacheValid = false
  }

  PolarCanvas.prototype._dims = function () {
    // Return CSS-pixel dimensions — drawing calls use CSS coordinates because
    // the context transform is scaled by devicePixelRatio in resize().
    const dpr = window.devicePixelRatio || 1
    const w  = this._canvas.width  / dpr
    const h  = this._canvas.height / dpr
    const cx = w / 2
    const cy = h / 2
    const R  = Math.min(w, h) / 2 * 0.82
    return { w, h, cx, cy, R }
  }

  // Highest speed across all loaded curves in m/s.
  PolarCanvas.prototype._maxSpeedMs = function () {
    if (this._mode === 'navigation') return this._maxNavigationSpeedMs()

    let maxMs = 0
    const allCurves = Object.values(this._curves)
    if (this._liveCurve) allCurves.push(this._liveCurve)
    for (const curve of allCurves) {
      for (const pt of curve.points) {
        if (pt.tbs > maxMs) maxMs = pt.tbs
      }
    }
    return maxMs || (10 / 1.943844)  // default ~5 m/s
  }

  PolarCanvas.prototype._maxNavigationSpeedMs = function () {
    let maxMs = 0
    const points = this._navCurve && this._navCurve.points ? this._navCurve.points : []
    for (let i = 0; i < points.length; i++) {
      const vmc = points[i].vmc
      if (isFiniteNumber(vmc)) maxMs = Math.max(maxMs, Math.abs(vmc))
    }

    const nav = this._navLive || {}
    ;['actualValue', 'targetValue', 'oppositeValue'].forEach((k) => {
      if (isFiniteNumber(nav[k])) maxMs = Math.max(maxMs, Math.abs(nav[k]))
    })

    return maxMs || (10 / 1.943844)
  }

  // Apply a formula string (e.g. 'value * 1.943844') to a value, using a cache
  // to avoid repeated Function allocations.
  PolarCanvas.prototype._applyFormula = function (formula, value) {
    let fn = this._formulaCache.get(formula)
    // eslint-disable-next-line no-new-func
    if (!fn) { fn = new Function('value', 'return ' + formula); this._formulaCache.set(formula, fn) }
    return fn(value)
  }

  // Format a SI value as a display string using displayUnits from /meta.
  // Defaults: m/s → kn, rad → °.
  PolarCanvas.prototype._formatUnit = function (value, displayUnits, rawUnits) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'
    const decimals = (fmt) => { if (!fmt) return 0; const d = fmt.indexOf('.'); return d < 0 ? 0 : fmt.length - d - 1 }
    const defaults =
      rawUnits === 'm/s'               ? { formula: 'value * 1.943844',      symbol: 'kn', displayFormat: '0' } :
      (!rawUnits || rawUnits === 'rad') ? { formula: 'value * 57.29577951308231', symbol: '\u00b0',  displayFormat: '0' } :
                                          { formula: 'value',                 symbol: rawUnits, displayFormat: '0' }
    const du = { ...defaults, ...(displayUnits || {}) }
    const converted = this._applyFormula(du.formula, value)
    return converted.toFixed(decimals(du.displayFormat)) + '\u00a0' + du.symbol
  }

  // Compute speed ring parameters using display units from /meta.
  // Returns { stepMs, maxMs, labelFn } where stepMs is the m/s between rings.
  PolarCanvas.prototype._ringParams = function (rawMaxMs) {
    const du  = this._meta && this._meta.tws && this._meta.tws.displayUnits
    const inv = (du && du.inverseFormula) || 'value / 1.943844'
    const fwd = (du && du.formula)        || 'value * 1.943844'

    // Convert max to display units to pick a nice step
    const maxDisplay = this._applyFormula(fwd, rawMaxMs)
    const stepDisplay = maxDisplay > 30 ? 5 : maxDisplay > 10 ? 2 : 1
    const stepsCount  = Math.ceil(maxDisplay / stepDisplay)

    const stepMs = this._applyFormula(inv, stepDisplay)
    const maxMs  = stepMs * stepsCount
    const sym    = (du && du.symbol) || 'kn'
    const labelFn = (ms) => {
      const disp = this._applyFormula(fwd, ms)
      return String(Math.round(disp))
    }
    return { stepMs, maxMs, labelFn, sym }
  }

  // Color for library curve index i — matches the getChartData() formula in index.js.
  // c is the dataset index (same formula: rgb(c*10, 130+(c*20)%100, 80+(c*30)%120)).
  PolarCanvas.prototype._curveColor = function (i) {
    const c = i  // dataset index, 0-based (zero-padding entry already excluded from twsList)
    const r = c * 10
    const g = 130 + (c * 20) % 100
    const b = 80  + (c * 30) % 120
    return `rgb(${r},${g},${b})`
  }

  // ---------------------------------------------------------------------------
  // Offscreen cache — grid + library curves
  // ---------------------------------------------------------------------------

  PolarCanvas.prototype._buildCache = function () {
    if (this._mode === 'navigation') {
      this._buildNavigationCache()
      return
    }

    const { w, h, cx, cy, R } = this._dims()
    const oc = this._offCtx
    const { stepMs, maxMs, labelFn, sym } = this._ringParams(this._maxSpeedMs())
    const deadR = (stepMs / maxMs) * R   // dead zone = first ring radius

    // Sync offscreen to physical pixels, then scale context to CSS pixels
    const dpr = window.devicePixelRatio || 1
    this._offscreen.width  = Math.round(w * dpr)
    this._offscreen.height = Math.round(h * dpr)
    oc.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Clear and fill background — colour driven by CSS custom property --polar-bg
    const cs      = getComputedStyle(this._canvas)
    const bg      = cs.getPropertyValue('--polar-bg').trim()
    const gridCol = cs.getPropertyValue('--polar-grid').trim()      || '#1e2535'
    const gridDash= cs.getPropertyValue('--polar-grid-dash').trim() || '#3a4555'
    const lblCol  = cs.getPropertyValue('--polar-label').trim()     || '#4e5a6a'
    const unitCol = cs.getPropertyValue('--polar-unit').trim()      || '#6b7a8d'
    oc.clearRect(0, 0, w, h)
    if (bg && bg !== 'transparent') {
      oc.fillStyle = bg
      oc.fillRect(0, 0, w, h)
    }

    // --- Speed rings ---
    const fontSize = Math.max(10, Math.min(13, R / 18))
    oc.font         = `${fontSize}px sans-serif`

    let firstRing = true
    for (let ringMs = stepMs; ringMs <= maxMs + stepMs * 0.01; ringMs += stepMs) {
      const r = (ringMs / maxMs) * R
      oc.beginPath()
      oc.arc(cx, cy, r, 0, 2 * Math.PI)

      if (firstRing) {
        oc.setLineDash([4, 4])
        oc.strokeStyle = gridDash
        oc.lineWidth   = 0.8
      } else {
        oc.setLineDash([])
        oc.strokeStyle = gridCol
        oc.lineWidth   = 0.8
      }
      oc.stroke()

      // Speed label on the 0° spoke (top), just inside the ring
      oc.setLineDash([])
      oc.fillStyle    = lblCol
      oc.textAlign    = 'center'
      oc.textBaseline = 'bottom'
      oc.fillText(labelFn(ringMs), cx, cy - r - 2)

      firstRing = false
    }
    oc.setLineDash([])

    // Unit label once above the outer ring, at 0°
    const outerR = (maxMs / maxMs) * R
    oc.fillStyle    = unitCol
    oc.font         = `${fontSize}px sans-serif`
    oc.textAlign    = 'center'
    oc.textBaseline = 'bottom'
    oc.fillText(sym, cx, cy - outerR - fontSize - 2)

    // --- Angle spokes every 30° — skip 0° (head to wind, no meaningful label) ---
    const twaDU = this._meta && this._meta.twa && this._meta.twa.displayUnits
    for (let deg = 0; deg < 360; deg += 30) {
      if (deg === 0) continue  // skip head-to-wind spoke and label
      const rad  = deg * Math.PI / 180
      const sinA = Math.sin(rad)
      const cosA = Math.cos(rad)

      oc.beginPath()
      oc.moveTo(cx + deadR * sinA, cy - deadR * cosA)
      oc.lineTo(cx + R * sinA,     cy - R * cosA)
      oc.strokeStyle = gridCol
      oc.lineWidth   = 0.8
      oc.stroke()

      // Label just outside the outermost ring using display units for angle
      const labelR = R + fontSize * 1.6
      const lx = cx + labelR * sinA
      const ly = cy - labelR * cosA

      const absSin = Math.abs(sinA)
      oc.textAlign    = absSin < 0.1 ? 'center' : sinA > 0 ? 'left' : 'right'
      oc.textBaseline = cosA > 0.1 ? 'bottom' : cosA < -0.1 ? 'top' : 'middle'
      oc.fillStyle    = lblCol
      oc.fillText(this._formatUnit(rad, twaDU, 'rad'), lx, ly)
    }

    // --- Library curves ---
    if (this._showLibrary) {
      const n = this._twsList.length
      for (let i = 0; i < n; i++) {
        const tws   = this._twsList[i]
        const curve = this._curves[tws]
        if (!curve || curve.points.length === 0) continue
        const color = this._curveColor(i)
        this._drawCurve(oc, cx, cy, R, maxMs, curve, color, 1.2, GRAPH_MARKER_RADIUS)
        this._drawCurveLabel(oc, cx, cy, R, maxMs, curve, tws, color)
      }
    }

    this._cacheValid = true
  }

  PolarCanvas.prototype._buildNavigationCache = function () {
    const { w, h, cx, cy, R } = this._dims()
    const oc = this._offCtx
    const { stepMs, maxMs, labelFn, sym } = this._ringParams(this._maxNavigationSpeedMs())

    const dpr = window.devicePixelRatio || 1
    this._offscreen.width  = Math.round(w * dpr)
    this._offscreen.height = Math.round(h * dpr)
    oc.setTransform(dpr, 0, 0, dpr, 0, 0)

    const cs      = getComputedStyle(this._canvas)
    const bg      = cs.getPropertyValue('--polar-bg').trim()
    const gridCol = cs.getPropertyValue('--polar-grid').trim()      || '#1e2535'
    const lblCol  = cs.getPropertyValue('--polar-label').trim()     || '#4e5a6a'
    const unitCol = cs.getPropertyValue('--polar-unit').trim()      || '#6b7a8d'

    oc.clearRect(0, 0, w, h)
    if (bg && bg !== 'transparent') {
      oc.fillStyle = bg
      oc.fillRect(0, 0, w, h)
    }

    const fontSize = Math.max(10, Math.min(13, R / 18))
    oc.font = `${fontSize}px sans-serif`

    for (let ringMs = stepMs; ringMs <= maxMs + stepMs * 0.01; ringMs += stepMs) {
      const r = (ringMs / maxMs) * R
      oc.beginPath()
      oc.arc(cx, cy, r, 0, 2 * Math.PI)
      oc.strokeStyle = gridCol
      oc.lineWidth = 0.8
      oc.stroke()

      oc.fillStyle    = lblCol
      oc.textAlign    = 'center'
      oc.textBaseline = 'bottom'
      oc.fillText(labelFn(ringMs), cx, cy - r - 2)
    }

    const outerR = R
    oc.fillStyle    = unitCol
    oc.font         = `${fontSize}px sans-serif`
    oc.textAlign    = 'center'
    oc.textBaseline = 'bottom'
    oc.fillText(sym, cx, cy - outerR - fontSize - 2)

    const headingDU = this._meta && this._meta['vmc.heading'] && this._meta['vmc.heading'].displayUnits
    for (let deg = 0; deg < 360; deg += 30) {
      const rad  = deg * Math.PI / 180
      const sinA = Math.sin(rad)
      const cosA = Math.cos(rad)

      oc.beginPath()
      oc.moveTo(cx, cy)
      oc.lineTo(cx + R * sinA, cy - R * cosA)
      oc.strokeStyle = gridCol
      oc.lineWidth = 0.8
      oc.stroke()

      const labelR = R + fontSize * 1.6
      const lx = cx + labelR * sinA
      const ly = cy - labelR * cosA
      const absSin = Math.abs(sinA)
      oc.textAlign    = absSin < 0.1 ? 'center' : sinA > 0 ? 'left' : 'right'
      oc.textBaseline = cosA > 0.1 ? 'bottom' : cosA < -0.1 ? 'top' : 'middle'
      oc.fillStyle    = lblCol
      oc.fillText(this._formatUnit(rad, headingDU, 'rad'), lx, ly)
    }

    this._cacheValid = true
  }

  PolarCanvas.prototype._drawNavigationCurve = function (ctx, cx, cy, R, maxMs) {
    const points = this._navCurve && this._navCurve.points ? this._navCurve.points : []
    if (!points.length) return

    const tackColors = {
      starboard: '#16a34a',
      port: '#dc2626'
    }

    const drawTackCurve = function (tack) {
      const tackPoints = orderAngularPoints(
        points.filter(function (pt) {
          return pt && pt.tack === tack && isFiniteNumber(pt.headingTrue) && isFiniteNumber(pt.vmc)
        }),
        'headingTrue'
      )

      if (!tackPoints.length) return

      ctx.beginPath()
      let started = false
      for (let i = 0; i < tackPoints.length; i++) {
        const pt = tackPoints[i]
        const radial = Math.max(0, pt.vmc)
        const xy = polarToXY(cx, cy, R, maxMs, pt.headingTrue, radial)
        if (!started) {
          ctx.moveTo(xy.x, xy.y)
          started = true
        } else {
          ctx.lineTo(xy.x, xy.y)
        }
      }

      ctx.strokeStyle = tackColors[tack]
      ctx.lineWidth = 2
      ctx.stroke()
    }

    drawTackCurve('starboard')
    drawTackCurve('port')
  }

  PolarCanvas.prototype._drawNavigationRay = function (ctx, cx, cy, R, angle, color) {
    if (!isFiniteNumber(angle)) return
    const x = cx + R * Math.sin(angle)
    const y = cy - R * Math.cos(angle)
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(x, y)
    ctx.strokeStyle = color
    ctx.setLineDash([])
    ctx.lineWidth = 2
    ctx.stroke()

    // Waypoint marker on outer ring
    ctx.beginPath()
    ctx.arc(x, y, BEARING_DOT_RADIUS, 0, 2 * Math.PI)
    ctx.fillStyle = color
    ctx.fill()
  }

  PolarCanvas.prototype._drawNavigationMarker = function (ctx, cx, cy, R, maxMs, angle, value, color, radius) {
    if (!isFiniteNumber(angle) || !isFiniteNumber(value)) return
    const dotBg = getComputedStyle(this._canvas).getPropertyValue('--polar-dot-bg').trim() || '#fff'
    const radial = Math.max(0, value)
    const xy = polarToXY(cx, cy, R, maxMs, angle, radial)
    const markerRadius = Number.isFinite(radius) ? radius : GRAPH_MARKER_RADIUS
    drawHollowCircle(ctx, xy.x, xy.y, markerRadius, color, dotBg, 2)
  }

  PolarCanvas.prototype._drawVectorLine = function (ctx, cx, cy, R, maxMs, angle, value, color) {
    if (!isFiniteNumber(angle) || !isFiniteNumber(value) || value <= 0) return
    const xy = polarToXY(cx, cy, R, maxMs, angle, value)
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(xy.x, xy.y)
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.stroke()

    const vx = xy.x - cx
    const vy = xy.y - cy
    const len = Math.hypot(vx, vy)
    if (len < 1e-6) return

    const ux = vx / len
    const uy = vy / len
    const nx = -uy
    const ny = ux
    const arrowLength = 11
    const arrowWidth = 7
    const bx = xy.x - ux * arrowLength
    const by = xy.y - uy * arrowLength

    ctx.beginPath()
    ctx.moveTo(xy.x, xy.y)
    ctx.lineTo(bx + nx * (arrowWidth / 2), by + ny * (arrowWidth / 2))
    ctx.lineTo(bx - nx * (arrowWidth / 2), by - ny * (arrowWidth / 2))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }

  PolarCanvas.prototype._drawLivePerformanceCurve = function (ctx, cx, cy, R, maxMs, curve) {
    if (!curve || !curve.points || curve.points.length === 0) return

    const starColor = '#16a34a'
    const portColor = '#dc2626'
    const dotBg = getComputedStyle(this._canvas).getPropertyValue('--polar-dot-bg').trim() || '#fff'

    const drawSide = (mirror, color) => {
      ctx.beginPath()
      let first = true
      for (let i = 0; i < curve.points.length; i++) {
        const pt = curve.points[i]
        const angleRad = mirror ? 2 * Math.PI - pt.twa : pt.twa
        const xy = polarToXY(cx, cy, R, maxMs, angleRad, pt.tbs)
        if (first) {
          ctx.moveTo(xy.x, xy.y)
          first = false
        } else {
          ctx.lineTo(xy.x, xy.y)
        }
      }
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()

      const markers = [curve.beat, curve.run]
      for (let m = 0; m < markers.length; m++) {
        const marker = markers[m]
        if (!marker) continue
        const angleRad = mirror ? 2 * Math.PI - marker.twa : marker.twa
        const xy = polarToXY(cx, cy, R, maxMs, angleRad, marker.tbs)
        drawHollowCircle(ctx, xy.x, xy.y, GRAPH_MARKER_RADIUS, color, dotBg, 2)
      }
    }

    drawSide(false, starColor)
    drawSide(true, portColor)
  }

  PolarCanvas.prototype._drawNavigationMessage = function (ctx, text, color) {
    if (!text) return
    ctx.font = '12px sans-serif'
    const padX = 10
    const padY = 8
    const tw = ctx.measureText(text).width
    const boxW = tw + padX * 2
    const boxH = 28
    const x = 8
    const y = 8
    ctx.fillStyle = 'rgba(13,17,23,0.82)'
    ctx.fillRect(x, y, boxW, boxH)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.strokeRect(x, y, boxW, boxH)
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + padX, y + boxH / 2)
  }

  // Draw one polar curve (starboard half + port mirror) with optional beat/run dots.
  // curve.points: [{twa: rad, tbs: m/s}, ...], curve.beat/run: {twa: rad, tbs: m/s}
  PolarCanvas.prototype._drawCurve = function (ctx, cx, cy, R, maxMs, curve, color, lineWidth, dotRadius) {
    const dotBg = getComputedStyle(this._canvas).getPropertyValue('--polar-dot-bg').trim() || '#fff'
    ctx.strokeStyle = color
    ctx.fillStyle   = color
    ctx.lineWidth   = lineWidth

    const drawSide = (mirror) => {
      ctx.beginPath()
      let first = true
      for (const pt of curve.points) {
        const angleRad = mirror ? 2 * Math.PI - pt.twa : pt.twa
        const { x, y } = polarToXY(cx, cy, R, maxMs, angleRad, pt.tbs)
        if (first) { ctx.moveTo(x, y); first = false }
        else        ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Beat and run markers — ring style: background fill, curve-color stroke
      for (const marker of [curve.beat, curve.run]) {
        if (!marker) continue
        const angleRad = mirror ? 2 * Math.PI - marker.twa : marker.twa
        const { x, y } = polarToXY(cx, cy, R, maxMs, angleRad, marker.tbs)
        const markerRadius = Number.isFinite(dotRadius) ? dotRadius : GRAPH_MARKER_RADIUS
        drawHollowCircle(ctx, x, y, markerRadius, color, dotBg, Math.max(1.5, lineWidth * 0.8))
        // restore for next iteration
        ctx.strokeStyle = color
        ctx.lineWidth   = lineWidth
      }
    }

    drawSide(false)  // starboard (0–π)
    drawSide(true)   // port mirror (π–2π)
  }

  // Draw a TWS label for a curve at the label angle.
  // labelAngle is chosen as (run.twa - 10°) or (lastPoint.twa - 10°) — whichever is valid.
  // The label is drawn on the starboard side only.
  PolarCanvas.prototype._drawCurveLabel = function (ctx, cx, cy, R, maxMs, curve, twsMs, color) {
    const points = curve.points
    if (!points || points.length === 0) return

    const tenDeg = 10 * Math.PI / 180

    // Label angle: run.twa − 10° or lastPoint.twa − 10°, clamped to data range
    const refTwa = curve.run ? curve.run.twa : points[points.length - 1].twa
    const labelTwa = Math.max(points[0].twa, refTwa - tenDeg)

    // Interpolate bsp at labelTwa from the sorted points array
    let bsp = null
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1]
      if (labelTwa >= p0.twa && labelTwa <= p1.twa) {
        const ratio = (labelTwa - p0.twa) / (p1.twa - p0.twa)
        bsp = p0.tbs + ratio * (p1.tbs - p0.tbs)
        break
      }
    }
    // Exact match or clamp to last point
    if (bsp === null) bsp = points[points.length - 1].tbs

    const { x, y } = polarToXY(cx, cy, R, maxMs, labelTwa, bsp)

    // Format the TWS value using meta display units
    const twsDU = this._meta && this._meta.tws && this._meta.tws.displayUnits
    const label = this._formatUnit(twsMs, twsDU, 'm/s')

    const fontSize = Math.max(9, Math.min(11, R / 20))
    ctx.font        = `bold ${fontSize}px sans-serif`
    ctx.textAlign   = 'left'
    ctx.textBaseline = 'middle'

    // Background pill — positioned to the right of the curve point
    const pad = 3
    const tw  = ctx.measureText(label).width
    const bx  = x + pad
    const by  = y - fontSize / 2 - pad
    const bw  = tw + pad * 2
    const bh  = fontSize + pad * 2
    const br  = 3

    ctx.beginPath()
    ctx.moveTo(bx + br, by)
    ctx.lineTo(bx + bw - br, by)
    ctx.arcTo(bx + bw, by, bx + bw, by + br, br)
    ctx.lineTo(bx + bw, by + bh - br)
    ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br)
    ctx.lineTo(bx + br, by + bh)
    ctx.arcTo(bx, by + bh, bx, by + bh - br, br)
    ctx.lineTo(bx, by + br)
    ctx.arcTo(bx, by, bx + br, by, br)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.fill()

    ctx.fillStyle = 'rgba(0,0,0,0.85)'
    ctx.fillText(label, bx + pad, y)
  }

  // ---------------------------------------------------------------------------
  // Live layer — composited over the offscreen cache on every frame
  // ---------------------------------------------------------------------------

  PolarCanvas.prototype._drawLive = function () {
    if (this._mode === 'navigation') {
      this._drawNavigationLive()
      return
    }

    const canvas = this._canvas
    const ctx    = this._ctx
    const { w, h, cx, cy, R } = this._dims()
    const { stepMs, maxMs } = this._ringParams(this._maxSpeedMs())

    // Stamp offscreen cache onto the live canvas.
    // Destination is specified in CSS pixels (the context is DPR-scaled).
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(this._offscreen, 0, 0, w, h)

    if (!this._live) return

    const live = this._live
    const twa  = live.twa   // rad, signed (+starboard, -port), may be null

    // --- Interpolated curve for current live TWS ---
    if (this._showLiveCurve && this._liveCurve && this._liveCurve.points.length > 0) {
      this._drawLivePerformanceCurve(ctx, cx, cy, R, maxMs, this._liveCurve)
      if (this._liveCurve.tws != null) {
        this._drawCurveLabel(ctx, cx, cy, R, maxMs, this._liveCurve, this._liveCurve.tws, '#16a34a')
      }
    }

    // --- Actual performance vector (blue) ---
    if (Number.isFinite(twa)) {
      this._drawVectorLine(ctx, cx, cy, R, maxMs, twa, live.bsp, '#2563eb')
    }
  }

  PolarCanvas.prototype._drawNavigationLive = function () {
    const ctx = this._ctx
    const { w, h, cx, cy, R } = this._dims()
    const { maxMs } = this._ringParams(this._maxNavigationSpeedMs())

    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(this._offscreen, 0, 0, w, h)

    this._drawNavigationCurve(ctx, cx, cy, R, maxMs)

    const nav = this._navLive || {}
    const twd = nav.twd
    const tackFromHeading = (heading) => {
      if (!isFiniteNumber(heading) || !isFiniteNumber(twd)) return null
      return wrapPi(heading - twd) >= 0 ? 'starboard' : 'port'
    }
    const tackColor = (tack) => tack === 'starboard' ? '#16a34a' : '#dc2626'

    this._drawNavigationRay(ctx, cx, cy, R, nav.course, '#facc15')

    const targetTack = tackFromHeading(nav.targetAngle)
    const oppositeTack = tackFromHeading(nav.oppositeAngle)
    this._drawNavigationMarker(ctx, cx, cy, R, maxMs, nav.targetAngle, nav.targetValue, tackColor(targetTack), GRAPH_MARKER_RADIUS)
    this._drawNavigationMarker(ctx, cx, cy, R, maxMs, nav.oppositeAngle, nav.oppositeValue, tackColor(oppositeTack), GRAPH_MARKER_RADIUS)

    this._drawVectorLine(ctx, cx, cy, R, maxMs, nav.actualAngle, nav.actualValue, '#2563eb')

    const message = nav.statusMessage || (nav.routeSuppressed ? 'No active route - VMC markers suppressed' : '')
    if (message) this._drawNavigationMessage(ctx, message, '#fbbf24')
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set display unit metadata from GET /meta.
   * Invalidates the offscreen cache so rings and spokes are redrawn with new units.
   * @param {Object} meta - response from GET /meta
   */
  PolarCanvas.prototype.setMeta = function (meta) {
    this._meta = meta
    this._cacheValid = false
    this.draw()
  }

  /**
   * Replace all library curve data and rebuild the offscreen cache.
    * @param {number[]} twsList   - TWS values in m/s (from GET /polars/{id}/axes/tws)
    * @param {Object}   curves    - twsMs → curve object (from GET /polars/{id}/queries/curve?tws=...)
   * @param {Object}   liveCurve - optional pre-fetched live-TWS curve
   */
  PolarCanvas.prototype.setLibraryData = function (twsList, curves, liveCurve) {
    this._twsList    = twsList
    this._curves     = curves
    this._liveCurve  = liveCurve || null
    this._cacheValid = false
    this.draw()
  }

  PolarCanvas.prototype.setNavigationData = function (navCurve, navLive) {
    this._navCurve = navCurve || null
    this._navLive = navLive || null
    this._cacheValid = false
    this.draw()
  }

  PolarCanvas.prototype.setMode = function (mode) {
    const next = mode === 'navigation' ? 'navigation' : 'performance'
    if (this._mode === next) return
    this._mode = next
    this._cacheValid = false
    this.draw()
  }

  /**
   * Update live values and redraw the live layer.
   * @param {Object}  live        - { tws, twa, bsp, polarSpeed, performance } — all SI
   * @param {Object}  [liveCurve] - updated interpolated curve for current live TWS
   */
  PolarCanvas.prototype.setLiveData = function (live, liveCurve) {
    this._live = live
    if (liveCurve !== undefined) this._liveCurve = liveCurve
    this.draw()
  }

  /**
   * Show or hide all library TWS curves.
   * When false, only the live (current-TWS) curve is drawn.
   * @param {boolean} show
   */
  PolarCanvas.prototype.setShowAllTwsLines = function (show) {
    if (this._showLibrary === show) return
    this._showLibrary = show
    this._cacheValid  = false
    this.draw()
  }

  /**
   * Invalidate the offscreen cache and redraw.
   * Call after resizing the canvas element.
   */
  PolarCanvas.prototype.resize = function () {
    const w = this._canvas.offsetWidth
    const h = this._canvas.offsetHeight
    if (w === 0 || h === 0) return  // not yet laid out; caller must retry
    const dpr = window.devicePixelRatio || 1
    // Set the backing store to physical pixels; CSS size is controlled by stylesheet
    this._canvas.width  = Math.round(w * dpr)
    this._canvas.height = Math.round(h * dpr)
    this._initOffscreen()
    // Scale all drawing operations so coordinates stay in CSS pixels
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  /** Build cache if stale, then composite live layer. */
  PolarCanvas.prototype.draw = function () {
    if (this._canvas.width === 0 || this._canvas.height === 0) return
    if (!this._cacheValid) this._buildCache()
    this._drawLive()
  }

  // expose
  global.PolarCanvas = PolarCanvas

})(window)
