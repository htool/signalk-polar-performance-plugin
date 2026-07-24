'use strict'

class SourceRegistry {
  constructor(sources = []) {
    this.sources = new Map(sources.map(source => [source.id, source]))
  }

  get(id) {
    return this.sources.get(id) || null
  }

  list() {
    return [...this.sources.values()].map(source => source.descriptor())
  }
}

module.exports = SourceRegistry