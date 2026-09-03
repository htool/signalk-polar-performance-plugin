// Shared pure geometry for the relative layline canvas. Coordinates are canvas
// local: north is up and east is right. Rim coordinates are visual only.
(function (global) {
  'use strict'

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value)
  }

  function bearingToLocal(bearing) {
    return { x: Math.sin(bearing), y: -Math.cos(bearing) }
  }

  function validGraph(graph) {
    if (!graph || graph.available !== true || (graph.frame !== 'ground' && graph.frame !== 'water')) return false
    const values = [graph.waypointBearing, graph.portTrack, graph.starboardTrack, graph.actual?.speed, graph.actual?.track]
    if (!values.every(isFiniteNumber) || graph.actual.speed <= 0) return false
    if (graph.frame === 'ground') {
      return isFiniteNumber(graph.current?.speed) && graph.current.speed >= 0 && isFiniteNumber(graph.current?.track)
    }
    return graph.current == null
  }

  function forwardRayIntersection(rayTrack, laylineTrack, waypointBearing, waypointDistance) {
    if (![rayTrack, laylineTrack, waypointBearing, waypointDistance].every(isFiniteNumber) || waypointDistance <= 0) return null
    const ray = bearingToLocal(rayTrack)
    const line = bearingToLocal(laylineTrack)
    const waypointUnit = bearingToLocal(waypointBearing)
    const determinant = ray.x * line.y - ray.y * line.x
    if (Math.abs(determinant) < 1e-8) return null
    const toWaypoint = { x: waypointUnit.x * waypointDistance, y: waypointUnit.y * waypointDistance }
    const rayDistance = (toWaypoint.x * line.y - toWaypoint.y * line.x) / determinant
    const lineDistance = (ray.x * toWaypoint.y - ray.y * toWaypoint.x) / determinant
    if (rayDistance <= 1e-8 || lineDistance < -1e-8) return null
    return { x: ray.x * rayDistance, y: ray.y * rayDistance, rayDistance, lineDistance }
  }

  const api = { bearingToLocal, validGraph, forwardRayIntersection }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  global.LaylineGeometry = api
})(typeof window !== 'undefined' ? window : globalThis)