'use strict'

const SI = require('../SI')
const { createCanonicalResource } = require('./canonical')

function parseNumber(value) {
  if (typeof value !== 'string') return Number.NaN
  const normalized = value.replace(/^"|"$/g, '').trim()
  if (!normalized) return Number.NaN
  return Number(normalized)
}

class ExpeditionImporter {
  constructor() {
    this.id = 'expedition'
    this.name = 'Expedition'
    this.description = 'Expedition polar text with one TWS row followed by repeated TWA/boat-speed pairs and optional inline beat/run target points.'
    this.defaultSource = 'expedition'
  }

  parse(content) {
    const lines = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      throw new Error('Import text is empty')
    }

    let sailnumber = null
    let startIndex = 0
    if (lines[0].startsWith('!')) {
      sailnumber = lines[0].slice(1).trim() || null
      startIndex = 1
    }

    const rowData = []
    const angleFrequency = new Map()

    for (const rawLine of lines.slice(startIndex)) {
      const cells = rawLine.split(/\t+/).map(cell => cell.trim()).filter(cell => cell.length > 0)
      if (cells.length < 3) continue

      const twsKnots = parseNumber(cells[0])
      if (!Number.isFinite(twsKnots) || twsKnots <= 0) {
        throw new Error(`Invalid Expedition TWS value '${cells[0]}'`)
      }

      if ((cells.length - 1) % 2 !== 0) {
        throw new Error(`Expedition row for TWS ${cells[0]} has an incomplete TWA/BSP pair`)
      }

      const pairs = []
      for (let index = 1; index < cells.length; index += 2) {
        const angleDeg = parseNumber(cells[index])
        const speedKnots = parseNumber(cells[index + 1])
        if (!Number.isFinite(angleDeg) || angleDeg < 0 || angleDeg > 180) {
          throw new Error(`Invalid Expedition TWA value '${cells[index]}'`)
        }
        if (!Number.isFinite(speedKnots) || speedKnots < 0) {
          throw new Error(`Invalid Expedition boat speed value '${cells[index + 1]}'`)
        }

        const angleKey = angleDeg.toFixed(6)
        angleFrequency.set(angleKey, (angleFrequency.get(angleKey) || 0) + 1)
        pairs.push({
          angleDeg,
          angleRad: SI.fromDegrees(angleDeg),
          speed: SI.fromKnots(speedKnots)
        })
      }

      rowData.push({
        tws: SI.fromKnots(twsKnots),
        pairs
      })
    }

    if (rowData.length === 0) {
      throw new Error('No Expedition polar rows were found')
    }

    const commonAngleKeys = new Set(
      Array.from(angleFrequency.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    )

    const twaAxis = Array.from(commonAngleKeys)
      .map(key => SI.fromDegrees(Number(key)))
      .sort((left, right) => left - right)

    if (twaAxis.length === 0) {
      throw new Error('No repeated Expedition TWA grid was detected')
    }

    const boatSpeedMatrix = []
    const derivedRows = []

    rowData.forEach((row) => {
      const pairByKey = new Map(row.pairs.map(pair => [pair.angleDeg.toFixed(6), pair]))
      const uncommonPairs = row.pairs.filter(pair => !commonAngleKeys.has(pair.angleDeg.toFixed(6)) && pair.speed > 0)
      const beatPair = uncommonPairs.length ? uncommonPairs[0] : null
      const runPair = uncommonPairs.length > 1 ? uncommonPairs[uncommonPairs.length - 1] : null

      boatSpeedMatrix.push(
        twaAxis.map((angleRad) => {
          const pair = pairByKey.get(SI.toDegrees(angleRad).toFixed(6))
          return pair ? pair.speed : 0
        })
      )

      if (beatPair || runPair) {
        derivedRows.push({
          tws: row.tws,
          ...(beatPair ? {
            beat: {
              twa: beatPair.angleRad,
              tbs: beatPair.speed,
              vmg: beatPair.speed * Math.abs(Math.cos(beatPair.angleRad))
            }
          } : {}),
          ...(runPair ? {
            run: {
              twa: runPair.angleRad,
              tbs: runPair.speed,
              vmg: runPair.speed * Math.abs(Math.cos(runPair.angleRad))
            }
          } : {})
        })
      }
    })

    return {
      resource: {
        ...createCanonicalResource({
          axes: {
            tws: rowData.map(row => row.tws),
            twa: twaAxis
          },
          values: { boatSpeedMatrix },
          ...(derivedRows.length ? { derived: { rows: derivedRows } } : {})
        }),
        ...(sailnumber ? { sailnumber } : {})
      }
    }
  }
}

module.exports = ExpeditionImporter