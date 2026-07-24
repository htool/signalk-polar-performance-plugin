'use strict'

const { parseMatrixPolarText } = require('./matrixText')

class JieterImporter {
  constructor() {
    this.id = 'jieter'
    this.name = 'Jieter'
    this.description = 'Semicolon-delimited Jieter/ORC table with TWS header, TWA rows, and optional beat/run target rows.'
    this.defaultSource = 'jieter'
  }

  parse(content) {
    return parseMatrixPolarText(content, { preferredDelimiters: [';'] })
  }
}

module.exports = JieterImporter