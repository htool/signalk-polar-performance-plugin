'use strict'

const DEFAULT_SCHEMA_VERSION = '1.0.0'

function createCanonicalResource({ axes, values, derived }) {
  return {
    kind: 'polarTable',
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    units: {
      tws: 'm/s',
      twa: 'rad',
      boatSpeed: 'm/s'
    },
    symmetry: {
      portStarboardSymmetric: true
    },
    axes,
    values,
    ...(derived ? { derived } : {})
  }
}

function applyMetadata(resource, metadata = {}, fallbackName = '') {
  const merged = { ...resource }
  const name = typeof metadata.name === 'string' && metadata.name.trim()
    ? metadata.name.trim()
    : (resource.name || fallbackName)

  if (name) merged.name = name
  if (typeof metadata.sailnumber === 'string' && metadata.sailnumber.trim()) merged.sailnumber = metadata.sailnumber.trim()
  if (typeof metadata.boatType === 'string' && metadata.boatType.trim()) merged.boatType = metadata.boatType.trim()
  if (Number.isInteger(metadata.year)) merged.year = metadata.year
  if (typeof metadata.source === 'string' && metadata.source.trim()) merged.source = metadata.source.trim()
  if (typeof metadata.notes === 'string' && metadata.notes.trim()) merged.notes = metadata.notes.trim()

  return merged
}

function validateCanonicalPolarResourceBody(resource) {
  if (!resource || typeof resource !== 'object') return 'Expected a JSON object'
  if (resource.kind !== 'polarTable') return "'kind' must be 'polarTable'"
  if (typeof resource.schemaVersion !== 'string' || !resource.schemaVersion.trim()) {
    return "'schemaVersion' is required"
  }
  if (resource.units?.tws !== 'm/s' || resource.units?.twa !== 'rad' || resource.units?.boatSpeed !== 'm/s') {
    return 'Only SI units are supported: tws=m/s, twa=rad, boatSpeed=m/s'
  }
  if (resource.symmetry?.portStarboardSymmetric !== true) {
    return 'Only port/starboard symmetric polars are supported'
  }
  if (!Array.isArray(resource.axes?.tws) || resource.axes.tws.length === 0) {
    return "'axes.tws' must be a non-empty array"
  }
  if (!Array.isArray(resource.axes?.twa) || resource.axes.twa.length === 0) {
    return "'axes.twa' must be a non-empty array"
  }
  if (!Array.isArray(resource.values?.boatSpeedMatrix) || resource.values.boatSpeedMatrix.length !== resource.axes.tws.length) {
    return "'values.boatSpeedMatrix' row count must match 'axes.tws'"
  }
  for (const row of resource.values.boatSpeedMatrix) {
    if (!Array.isArray(row) || row.length !== resource.axes.twa.length) {
      return "Each 'boatSpeedMatrix' row must match 'axes.twa' length"
    }
  }
  return null
}

module.exports = {
  DEFAULT_SCHEMA_VERSION,
  createCanonicalResource,
  applyMetadata,
  validateCanonicalPolarResourceBody
}