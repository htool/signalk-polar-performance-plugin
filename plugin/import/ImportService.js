'use strict'

const FormatRegistry = require('./FormatRegistry')
const SourceRegistry = require('./SourceRegistry')
const OrcSource = require('./OrcSource')
const JieterImporter = require('./JieterImporter')
const ExpeditionImporter = require('./ExpeditionImporter')
const { applyMetadata, validateCanonicalPolarResourceBody } = require('./canonical')

class ImportError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function autoId(value, fallback = 'imported-polar') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || fallback
}

function timestampIdPart(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    't',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    'z'
  ].join('')
}

function createTimestampedId(baseValue, fallback, exists, now) {
  const baseId = autoId(baseValue, fallback)
  const timestampedBaseId = `${baseId}-${timestampIdPart(now())}`
  let id = timestampedBaseId
  let suffix = 2
  while (exists(id)) {
    id = `${timestampedBaseId}-${suffix}`
    suffix += 1
  }
  return id
}

function validateRequestedId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new ImportError(400, "'id' must be a non-empty string when provided")
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id.trim())) {
    throw new ImportError(400, "'id' may contain only letters, numbers, '.', '_' and '-' characters")
  }
  return id.trim()
}

class ImportService {
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now || (() => Date.now())
    this.registry = new FormatRegistry([
      new JieterImporter(),
      new ExpeditionImporter()
    ])
    this.sourceRegistry = new SourceRegistry([
      new OrcSource({
        dataDir: store.dataDir,
        fetcher: options.fetcher,
        now: this.now
      })
    ])
  }

  listFormats() {
    return this.registry.list()
  }

  async listSources() {
    const descriptors = this.sourceRegistry.list()
    return Promise.all(descriptors.map(async (descriptor) => {
      const source = this.sourceRegistry.get(descriptor.id)
      if (source && typeof source.getStatus === 'function') {
        return {
          ...descriptor,
          ...(await source.getStatus())
        }
      }

      return {
        ...descriptor,
        available: true,
        availabilityMessage: ''
      }
    }))
  }

  importText(formatId, body) {
    if (!body || typeof body !== 'object') {
      throw new ImportError(400, 'Expected a JSON object')
    }

    if (typeof body.content !== 'string' || !body.content.trim()) {
      throw new ImportError(400, "'content' is required")
    }

    const importer = this.registry.get(formatId)
    if (!importer) {
      throw new ImportError(400, `Unsupported import format: ${formatId}`)
    }

    let parsed
    try {
      parsed = importer.parse(body.content)
    } catch (error) {
      throw new ImportError(400, error.message)
    }

    const resource = applyMetadata(
      parsed.resource,
      { ...body, source: body.source || importer.defaultSource },
      body.name || importer.name
    )

    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new ImportError(400, validationError)
    }

    const id = createTimestampedId(
      resource.sailnumber || resource.name || formatId,
      `${formatId}-polar`,
      (candidate) => this.store.exists(candidate),
      this.now
    )

    this.store.saveCanonical(id, resource)
    return { id, resource: { ...resource, id } }
  }

  async searchSource(sourceId, query) {
    const source = this.sourceRegistry.get(sourceId)
    if (!source) {
      throw new ImportError(404, `Unsupported import source: ${sourceId}`)
    }

    try {
      return await source.search(query)
    } catch (error) {
      if (Number.isInteger(error.status)) {
        throw new ImportError(error.status, error.message)
      }
      throw error
    }
  }

  async importSource(sourceId, externalId, body) {
    const source = this.sourceRegistry.get(sourceId)
    if (!source) {
      throw new ImportError(404, `Unsupported import source: ${sourceId}`)
    }

    if (body != null && typeof body !== 'object') {
      throw new ImportError(400, 'Expected a JSON object')
    }

    if (body && Object.keys(body).length > 0) {
      throw new ImportError(400, 'External source imports do not accept metadata overrides')
    }

    let parsed
    try {
      parsed = await source.importByExternalId(externalId)
    } catch (error) {
      if (Number.isInteger(error.status)) {
        throw new ImportError(error.status, error.message)
      }
      throw error
    }

    const resource = applyMetadata(
      parsed.resource,
      { source: parsed.resource.source || source.defaultSource },
      parsed.fallbackName || source.name
    )

    const validationError = validateCanonicalPolarResourceBody(resource)
    if (validationError) {
      throw new ImportError(400, validationError)
    }

    const id = (() => {
      const baseId = autoId(externalId || resource.name || resource.sailnumber, `${sourceId}-polar`)
      let candidate = baseId
      let suffix = 2
      while (this.store.exists(candidate)) {
        candidate = `${baseId}-${suffix}`
        suffix += 1
      }
      return candidate
    })()

    this.store.saveCanonical(id, resource)
    return { id, resource: { ...resource, id } }
  }
}

module.exports = { ImportService, ImportError, autoId, timestampIdPart, createTimestampedId }