'use strict'

const EARTH_RADIUS_METERS = 6371008.8
const PARALLEL_EPSILON = 1e-8
const FORWARD_EPSILON_SECONDS = 1e-6

function isFiniteVector(vector) {
  return Number.isFinite(vector?.x) && Number.isFinite(vector?.y)
}

function addVectors(left, right) {
  return { x: left.x + right.x, y: left.y + right.y }
}

function vectorMagnitude(vector) {
  return Math.hypot(vector.x, vector.y)
}

function cross(left, right) {
  return left.x * right.y - left.y * right.x
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y
}

function toRadians(degrees) {
  return degrees * Math.PI / 180
}

function projectWaypoint(position, waypoint) {
  const latitude1 = toRadians(position.latitude)
  const latitude2 = toRadians(waypoint.latitude)
  const deltaLatitude = latitude2 - latitude1
  const deltaLongitude = toRadians(waypoint.longitude - position.longitude)

  const sinHalfLatitude = Math.sin(deltaLatitude / 2)
  const sinHalfLongitude = Math.sin(deltaLongitude / 2)
  const haversine = sinHalfLatitude * sinHalfLatitude +
    Math.cos(latitude1) * Math.cos(latitude2) * sinHalfLongitude * sinHalfLongitude
  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
  const distance = EARTH_RADIUS_METERS * angularDistance

  const east = Math.sin(deltaLongitude) * Math.cos(latitude2)
  const north = Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude)
  const bearing = Math.atan2(east, north)

  return {
    x: distance * Math.cos(bearing),
    y: distance * Math.sin(bearing)
  }
}

function unavailable(reason) {
  return { status: 'unavailable', reason, distance: null, time: null }
}

class LaylineCalculator {
  solveLeg(waypointVector, sailingVector, onwardVector) {
    if (!isFiniteVector(waypointVector) || !isFiniteVector(sailingVector) || !isFiniteVector(onwardVector)) {
      return unavailable('invalidVector')
    }

    const speed = vectorMagnitude(sailingVector)
    const onwardSpeed = vectorMagnitude(onwardVector)
    if (speed <= PARALLEL_EPSILON || onwardSpeed <= PARALLEL_EPSILON) {
      return unavailable('zeroGroundSpeed')
    }

    const determinant = cross(sailingVector, onwardVector)
    if (Math.abs(determinant) <= PARALLEL_EPSILON * speed * onwardSpeed) {
      return unavailable('parallelTracks')
    }

    const time = cross(waypointVector, onwardVector) / determinant
    const onwardTime = cross(sailingVector, waypointVector) / determinant
    if (onwardTime < -FORWARD_EPSILON_SECONDS) {
      return unavailable('noForwardIntersection')
    }

    return {
      status: 'valid',
      reason: null,
      distance: time * speed,
      time,
      onwardTime: Math.max(0, onwardTime)
    }
  }

  calculate({
    enabled = true,
    structural = {},
    position,
    waypoint,
    sailingMode,
    currentTack,
    targets,
    currentVector,
    ignoreCurrent = false
  }) {
    if (!enabled) {
      return this._state('disabled', structural, sailingMode, currentTack, 'ignored')
    }

    const missing = [...(structural.missing ?? [])]
    const stale = [...(structural.stale ?? [])]
    if (!position && !missing.includes('position')) missing.push('position')
    if (!waypoint && !missing.includes('waypoint')) missing.push('waypoint')
    if (!targets && !missing.includes('targetVectors')) missing.push('targetVectors')
    if (!currentTack && !missing.includes('currentTack')) missing.push('currentTack')

    const currentAvailable = isFiniteVector(currentVector)
    const currentMode = ignoreCurrent ? 'ignored' : (currentAvailable ? 'used' : 'fallbackZero')
    const normalizedStructural = { ready: missing.length === 0 && stale.length === 0, missing, stale }
    if (!normalizedStructural.ready) {
      return this._state('unavailable', normalizedStructural, sailingMode, currentTack, currentMode)
    }

    if (sailingMode === 'reaching') {
      return this._state('unavailable', normalizedStructural, sailingMode, currentTack, currentMode, 'reaching')
    }

    const current = currentMode === 'used' ? currentVector : { x: 0, y: 0 }
    const port = targets?.port?.vector
    const starboard = targets?.starboard?.vector
    if (!isFiniteVector(port) || !isFiniteVector(starboard)) {
      normalizedStructural.ready = false
      normalizedStructural.missing.push('targetVectors')
      return this._state('unavailable', normalizedStructural, sailingMode, currentTack, currentMode)
    }

    const ground = {
      port: addVectors(port, current),
      starboard: addVectors(starboard, current)
    }
    const waypointVector = projectWaypoint(position, waypoint)
    const oppositeTack = currentTack === 'port' ? 'starboard' : 'port'

    let layline
    let oppositeLayline
    if (dot(waypointVector, ground.port) <= 0 && dot(waypointVector, ground.starboard) <= 0) {
      layline = unavailable('waypointOvershot')
      oppositeLayline = unavailable('waypointOvershot')
    } else {
      layline = this.solveLeg(waypointVector, ground[currentTack], ground[oppositeTack])
      oppositeLayline = this.solveLeg(waypointVector, ground[oppositeTack], ground[currentTack])
    }

    const validCount = [layline, oppositeLayline].filter(result => result.status === 'valid').length
    const status = validCount === 2 ? 'valid' : (validCount === 1 ? 'partial' : 'unavailable')
    return this._state(status, normalizedStructural, sailingMode, currentTack, currentMode, null, layline, oppositeLayline)
  }

  _state(status, structural, sailingMode, currentTack, currentMode, reason = null, layline, oppositeLayline) {
    const result = reason ? unavailable(reason) : unavailable(null)
    return {
      status,
      structural: {
        ready: structural.ready ?? false,
        missing: [...(structural.missing ?? [])],
        stale: [...(structural.stale ?? [])]
      },
      temporal: {
        sailingMode: sailingMode ?? null,
        currentTack: currentTack ?? null,
        layline: layline ?? result,
        oppositeLayline: oppositeLayline ?? result
      },
      current: {
        mode: currentMode,
        warning: currentMode === 'fallbackZero'
      }
    }
  }
}

module.exports = { LaylineCalculator, projectWaypoint }