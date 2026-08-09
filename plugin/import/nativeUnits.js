'use strict'

const SI = require('../SI')

const EXPORT_SPEED_DECIMALS = 2
const EXPORT_ANGLE_DECIMALS = 1

const SPEED_UNIT_ALIASES = new Map([
  ['m/s', 'm/s'],
  ['mps', 'm/s'],
  ['ms', 'm/s'],
  ['kn', 'kn'],
  ['kt', 'kn'],
  ['kts', 'kn'],
  ['knot', 'kn'],
  ['knots', 'kn']
])

const ANGLE_UNIT_ALIASES = new Map([
  ['rad', 'rad'],
  ['radian', 'rad'],
  ['radians', 'rad'],
  ['deg', 'deg'],
  ['degree', 'deg'],
  ['degrees', 'deg'],
  ['°', 'deg']
])

const DISPLAY_UNIT_LOOKUP = {
  'm/s': [
    { unit: 'm/s', formulas: ['value'], symbols: ['m/s'] },
    { unit: 'kn', formulas: ['value*1.943844', 'value*1.94384'], symbols: ['kn', 'kt', 'kts'] }
  ],
  rad: [
    { unit: 'rad', formulas: ['value'], symbols: ['rad'] },
    { unit: 'deg', formulas: ['value*57.29577951308231'], symbols: ['°', 'deg', 'degrees'] }
  ]
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function normalizeFormula(formula) {
  return String(formula || '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function normalizeSpeedUnit(value) {
  return SPEED_UNIT_ALIASES.get(normalizeToken(value)) || null
}

function normalizeAngleUnit(value) {
  return ANGLE_UNIT_ALIASES.get(normalizeToken(value)) || null
}

function assertSupportedSpeedUnit(value, fieldName) {
  const unit = normalizeSpeedUnit(value)
  if (!unit) throw new Error(`Unsupported ${fieldName} unit: ${value}`)
  return unit
}

function assertSupportedAngleUnit(value, fieldName) {
  const unit = normalizeAngleUnit(value)
  if (!unit) throw new Error(`Unsupported ${fieldName} unit: ${value}`)
  return unit
}

function speedToSi(value, unit) {
  return unit === 'kn' ? SI.fromKnots(value) : value
}

function speedFromSi(value, unit) {
  return unit === 'kn' ? SI.toKnots(value) : value
}

function angleToSi(value, unit) {
  return unit === 'deg' ? SI.fromDegrees(value) : value
}

function angleFromSi(value, unit) {
  return unit === 'deg' ? SI.toDegrees(value) : value
}

function mapFinite(value, converter) {
  return Number.isFinite(value) ? converter(value) : value
}

function roundTo(value, decimals) {
  if (!Number.isFinite(value)) return value
  return Number(value.toFixed(decimals))
}

function mapArray(values, converter) {
  return Array.isArray(values) ? values.map(value => mapFinite(value, converter)) : values
}

function mapMatrix(matrix, converter) {
  return Array.isArray(matrix)
    ? matrix.map(row => Array.isArray(row) ? row.map(value => mapFinite(value, converter)) : row)
    : matrix
}

function mapDerivedRows(rows, convertAngle, convertSpeed) {
  if (!Array.isArray(rows)) return rows
  return rows.map(row => ({
    ...row,
    tws: mapFinite(row.tws, convertSpeed),
    beat: row.beat
      ? {
        ...row.beat,
        twa: mapFinite(row.beat.twa, convertAngle),
        tbs: mapFinite(row.beat.tbs, convertSpeed),
        vmg: mapFinite(row.beat.vmg, convertSpeed)
      }
      : row.beat,
    run: row.run
      ? {
        ...row.run,
        twa: mapFinite(row.run.twa, convertAngle),
        tbs: mapFinite(row.run.tbs, convertSpeed),
        vmg: mapFinite(row.run.vmg, convertSpeed)
      }
      : row.run,
    maxSpeed: mapFinite(row.maxSpeed, convertSpeed),
    maxSpeedAngle: mapFinite(row.maxSpeedAngle, convertAngle)
  }))
}

function transformResource(resource, units, convertAngle, convertSpeedTws, convertSpeedBoat) {
  return {
    ...resource,
    units,
    axes: {
      ...resource.axes,
      tws: mapArray(resource.axes?.tws, convertSpeedTws),
      twa: mapArray(resource.axes?.twa, convertAngle)
    },
    values: {
      ...resource.values,
      boatSpeedMatrix: mapMatrix(resource.values?.boatSpeedMatrix, convertSpeedBoat)
    },
    ...(resource.derived
      ? {
        derived: {
          ...resource.derived,
          rows: mapDerivedRows(resource.derived.rows, convertAngle, convertSpeedBoat)
        }
      }
      : {})
  }
}

function normalizeImportedNativePolarResource(resource) {
  const sourceUnits = {
    tws: assertSupportedSpeedUnit(resource?.units?.tws || 'm/s', 'tws'),
    twa: assertSupportedAngleUnit(resource?.units?.twa || 'rad', 'twa'),
    boatSpeed: assertSupportedSpeedUnit(resource?.units?.boatSpeed || 'm/s', 'boatSpeed')
  }

  return transformResource(
    resource,
    { tws: 'm/s', twa: 'rad', boatSpeed: 'm/s' },
    value => angleToSi(value, sourceUnits.twa),
    value => speedToSi(value, sourceUnits.tws),
    value => speedToSi(value, sourceUnits.boatSpeed)
  )
}

function exportNativePolarResource(resource, units) {
  const targetUnits = {
    tws: assertSupportedSpeedUnit(units?.tws || 'm/s', 'tws'),
    twa: assertSupportedAngleUnit(units?.twa || 'rad', 'twa'),
    boatSpeed: assertSupportedSpeedUnit(units?.boatSpeed || 'm/s', 'boatSpeed')
  }

  const convertAngle = value => roundTo(angleFromSi(value, targetUnits.twa), EXPORT_ANGLE_DECIMALS)
  const convertTws = value => roundTo(speedFromSi(value, targetUnits.tws), EXPORT_SPEED_DECIMALS)
  const convertBoatSpeed = value => roundTo(speedFromSi(value, targetUnits.boatSpeed), EXPORT_SPEED_DECIMALS)

  return transformResource(
    resource,
    targetUnits,
    convertAngle,
    convertTws,
    convertBoatSpeed
  )
}

function inferNativeExportUnits(metaByField = {}) {
  const tws = inferDisplayUnit(metaByField.tws, 'm/s', 'speed')
  const twa = inferDisplayUnit(metaByField.twa, 'rad', 'angle')
  const boatSpeed = inferDisplayUnit(metaByField.boatSpeed, 'm/s', 'speed')
  return { tws, twa, boatSpeed }
}

function inferDisplayUnit(displayUnits, rawUnit, quantity) {
  const normalizedRawUnit = quantity === 'speed'
    ? assertSupportedSpeedUnit(rawUnit, 'raw')
    : assertSupportedAngleUnit(rawUnit, 'raw')

  const formula = normalizeFormula(displayUnits?.formula)
  const symbol = normalizeToken(displayUnits?.symbol)
  const candidates = DISPLAY_UNIT_LOOKUP[normalizedRawUnit] || []

  for (const candidate of candidates) {
    const formulaMatch = candidate.formulas.includes(formula)
    const symbolMatch = candidate.symbols.includes(symbol)
    if (formulaMatch || symbolMatch) return candidate.unit
  }

  return normalizedRawUnit
}

module.exports = {
  exportNativePolarResource,
  inferNativeExportUnits,
  normalizeImportedNativePolarResource
}