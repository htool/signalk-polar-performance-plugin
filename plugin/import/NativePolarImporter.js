'use strict'

class NativePolarImporter {
  constructor() {
    this.id = 'native'
    this.name = 'Native Polar (JSON)'
    this.description = 'Native Polar Performance JSON resource format.'
  }

  parse(content) {
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (_) {
      throw new Error('Native Polar content is not valid JSON')
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Native Polar JSON must be an object')
    }

    return { resource: parsed }
  }
}

module.exports = NativePolarImporter
