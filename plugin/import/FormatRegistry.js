'use strict'

class FormatRegistry {
  constructor(importers = []) {
    this.importers = new Map(importers.map(importer => [importer.id, importer]))
  }

  get(id) {
    return this.importers.get(id)
  }

  list() {
    return Array.from(this.importers.values()).map(importer => ({
      id: importer.id,
      name: importer.name,
      description: importer.description
    }))
  }
}

module.exports = FormatRegistry