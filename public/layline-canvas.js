// Canvas renderer for the relative layline display. It consumes only the
// authoritative /status laylineGraph object and never derives vessel data.
(function (global) {
  'use strict'

  function LaylineCanvas(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.data = null
  }

  LaylineCanvas.prototype.resize = function () {
    const width = this.canvas.offsetWidth
    const height = this.canvas.offsetHeight
    if (!width || !height) return
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  LaylineCanvas.prototype.setData = function (data) {
    this.data = data
    this.draw()
  }

  LaylineCanvas.prototype.draw = function () {
    const canvas = this.canvas
    const ctx = this.ctx
    const width = canvas.width / (window.devicePixelRatio || 1)
    const height = canvas.height / (window.devicePixelRatio || 1)
    if (!width || !height) return
    ctx.clearRect(0, 0, width, height)
    const graph = this.data
    if (!global.LaylineGeometry.validGraph(graph)) {
      ctx.fillStyle = '#6b7280'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Layline data unavailable', width / 2, height / 2)
      return
    }

    const cx = width / 2
    const cy = height / 2
    const radius = Math.max(32, Math.min(width, height) / 2 - 46)
    const heading = Number.isFinite(graph.heading) ? graph.heading : graph.actual.track
    const local = (bearing) => global.LaylineGeometry.bearingToLocal(bearing - heading)
    const point = (bearing, length) => {
      const vector = local(bearing)
      return { x: cx + vector.x * length, y: cy + vector.y * length }
    }
    const drawArrow = (bearing, length, color, widthPx) => {
      const end = point(bearing, length)
      const unit = local(bearing)
      const normal = { x: -unit.y, y: unit.x }
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(end.x, end.y)
      ctx.strokeStyle = color
      ctx.lineWidth = widthPx
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(end.x, end.y)
      ctx.lineTo(end.x - unit.x * 10 + normal.x * 5, end.y - unit.y * 10 + normal.y * 5)
      ctx.lineTo(end.x - unit.x * 10 - normal.x * 5, end.y - unit.y * 10 - normal.y * 5)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    const drawLayline = (track, tack) => {
      const color = tack === 'port' ? '#c62828' : '#16803c'
      const end = point(track, radius)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(end.x, end.y)
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.stroke()

      const waypoint = point(graph.waypointBearing, radius)
      const reciprocal = local(track + Math.PI)
      ctx.beginPath()
      ctx.moveTo(waypoint.x, waypoint.y)
      ctx.lineTo(waypoint.x + reciprocal.x * radius, waypoint.y + reciprocal.y * radius)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()
    }

    ctx.strokeStyle = '#ccc'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI)
    ctx.stroke()
    ctx.fillStyle = '#6b7280'
    ctx.font = Math.max(10, Math.min(13, radius / 18)) + 'px sans-serif'
    for (let degrees = 0; degrees < 360; degrees += 30) {
      const end = point(degrees * Math.PI / 180, radius)
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(end.x, end.y)
      ctx.stroke()

      const labelRadius = radius + 10
      const labelPoint = point(degrees * Math.PI / 180, labelRadius)
      const vector = local(degrees * Math.PI / 180)
      const cardinalDirections = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
      const label = cardinalDirections[degrees] || degrees + String.fromCharCode(176)
      ctx.textAlign = Math.abs(vector.x) < 0.1 ? 'center' : vector.x > 0 ? 'left' : 'right'
      ctx.textBaseline = vector.y < -0.1 ? 'bottom' : vector.y > 0.1 ? 'top' : 'middle'
      ctx.fillText(label, labelPoint.x, labelPoint.y)
    }

    drawLayline(graph.portTrack, 'port')
    drawLayline(graph.starboardTrack, 'starboard')
    if (Number.isFinite(graph.leewayAngle) && Number.isFinite(graph.heading)) {
      const start = -Math.PI / 2
      const end = start + graph.leewayAngle
      ctx.beginPath()
      ctx.arc(cx, cy, 22, start, end, graph.leewayAngle < 0)
      ctx.strokeStyle = '#0f766e'
      ctx.lineWidth = 3
      ctx.stroke()
    }
    if (graph.frame === 'ground') {
      const scale = radius * 0.72 / Math.max(graph.actual.speed, graph.current.speed, 0.1)
      drawArrow(graph.current.track, graph.current.speed * scale, '#64748b', 2)
    }
    const velocityScale = radius * 0.72 / Math.max(graph.actual.speed, graph.frame === 'ground' ? graph.current.speed : 0, 0.1)
    drawArrow(graph.actual.track, graph.actual.speed * velocityScale, '#2563eb', 3)

    const waypoint = point(graph.waypointBearing, radius)
    ctx.beginPath(); ctx.arc(waypoint.x, waypoint.y, 6, 0, 2 * Math.PI)
    ctx.fillStyle = '#d97706'; ctx.fill()

    if (graph.crossing) {
      const selectedTrack = graph.selectedTack === 'port' ? graph.portTrack : graph.starboardTrack
      const crossing = global.LaylineGeometry.forwardRayIntersection(graph.actual.track, selectedTrack, graph.waypointBearing, radius)
      if (crossing && crossing.rayDistance < radius * 2) {
        const crossingBearing = Math.atan2(crossing.x, -crossing.y)
        const crossingPoint = point(crossingBearing, Math.hypot(crossing.x, crossing.y))
        ctx.beginPath(); ctx.arc(crossingPoint.x, crossingPoint.y, 5, 0, 2 * Math.PI)
        ctx.fillStyle = '#111827'; ctx.fill()
      }
    }
  }

  global.LaylineCanvas = LaylineCanvas
})(window)