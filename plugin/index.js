'use strict'

const { PolarTable } = require('./PolarTable')
const PolarFileStore = require('./PolarFileStore')
const { ImportService, ImportError, createTimestampedId } = require('./import/ImportService')
const canonical = require('./import/canonical')
const { parseMatrixPolarText } = require('./import/matrixText')
const {
  createSmoothedPolar,
  createSmoothedHandler,
  SmoothedAngle,
  BaseSmoother,
  ExponentialSmoother,
  MovingAverageSmoother,
  KalmanSmoother
} = require('signalkutilities')

const CURRENT_SETTINGS_VERSION = 1

const STALE_RESUBSCRIBE_PERIOD = 60000 // ms — idle period before live input subscriptions are re-established

const DEFAULT_SETTINGS = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  activePolar: '',
  perfAdjust: 1,
  showAllTwsLines: true,
  smootherType: 'Exponential',
  smootherParamExponential: 1,
  smootherParamMovingAverage: 10,
  smootherParamKalman: 0.1,
  beatAngle: false,
  beatVMG: false,
  targetTWA: false,
  optimumWindAngle: false,
  VMG: false,
  maxSpeed: false,
  polarSpeed: false,
  useSOG: false,
  tackTrue: false,
  smoothedInputs: false
}

module.exports = (app) => {
  // Module-level state — survives across start/stop cycles when the server
  // hot-reloads config. Handlers are re-created on every start().
  let settings = {}
  let changedOptions = {}     // staged but not yet applied
  let hasPendingChanges = false
  let isRunning = false
  let polarTable = null
  let store = null
  let importService = null
  let windSmoother = null
  let bspSmoother = null
  let hdgSmoother = null
  let metaSentPaths = new Set()  // tracks paths that have had metadata emitted

  // Last-computed output values, updated by computeAndSend on every cycle.
  // Keys match the settings keys; values are SI numbers or null.
  const lastOutputs = {}

  // Maps each settings toggle key to the SK paths it controls.
  // Used both to nullify paths when a toggle is turned off and to build /status outputs.
  const OUTPUT_PATHS = {
    beatAngle:        ['performance.beatAngle', 'performance.gybeAngle'],
    beatVMG:         ['performance.beatAngleVelocityMadeGood', 'performance.gybeAngleVelocityMadeGood'],
    targetTWA:       ['performance.targetAngle', 'performance.targetVelocityMadeGood'],
    optimumWindAngle:['performance.optimumWindAngle'],
    VMG:             ['performance.velocityMadeGood', 'performance.polarVelocityMadeGood', 'performance.polarVelocityMadeGoodRatio'],
    polarSpeed:      ['performance.polarSpeed', 'performance.targetSpeed', 'performance.polarSpeedRatio'],
    maxSpeed:        ['performance.maxSpeed', 'performance.maxSpeedAngle'],
    tackTrue:        ['performance.tackTrue'],
    smoothedInputs:  ['environment.wind.angleTrueWaterDamped', 'performance.boatSpeedDamped'],
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function _wireHandlerWatchdog(handler) {
    return {
      idlePeriod: STALE_RESUBSCRIBE_PERIOD,
      onIdle: () => {
        if (!isRunning) return
        app.debug(`resubscribing to ${handler.path} because data got stale or did not arrive at all`)
        handler.unsubscribe()
        handler.subscribe()
      }
    }
  }

  function getSmootherClass(type) {
    switch (type) {
      case 'None':          return BaseSmoother
      case 'MovingAverage': return MovingAverageSmoother
      case 'Kalman':        return KalmanSmoother
      default:              return ExponentialSmoother
    }
  }

  function getSmootherOptions(type, s) {
    switch (type) {
      case 'None':          return {}
      case 'MovingAverage': return { timeSpan: s.smootherParamMovingAverage ?? 10 }
      case 'Kalman':        return { steadyState: s.smootherParamKalman ?? 0.1 }
      default:              return { tau: s.smootherParamExponential ?? 1 }
    }
  }

  /** Migrate legacy settings in-place, returning the updated object. */
  function migrateSettings(s) {
    const version = s.settingsVersion ?? 0

    if (version < 1) {
      // v0 → v1: replace three separate damping fields with type-specific smoother params
      const tau = Math.max(s.dampingTWA ?? 1, s.dampingTWS ?? 1, s.dampingBSP ?? 1)
      s.smootherType = 'Exponential'
      s.smootherParamExponential = tau
      delete s.dampingTWA
      delete s.dampingTWS
      delete s.dampingBSP
      delete s.useTWSsource
      delete s.useSOGsource
      delete s.trueWindSpeedPath

      // Migrate embedded CSV polar to a canonical polar file.
      // Only advance settingsVersion if the CSV is successfully written —
      // if it fails, keep csvTable so the migration retries on next start.
      if (s.csvTable && s.csvTable.trim()) {
        try {
          const { resource } = parseMatrixPolarText(s.csvTable)
          store.saveCanonical('migrated-polar', resource)
          s.activePolar = 'migrated-polar'
          delete s.csvTable
          app.debug('Legacy csvTable migrated to migrated-polar.json')
        } catch (e) {
          app.setPluginError('Migration failed — could not save legacy CSV: ' + e.message)
          app.debug('CSV migration error: %s', e.message)
          return s  // abort; csvTable kept so next start retries
        }
      } else {
        delete s.csvTable
      }

      s.settingsVersion = 1
      app.debug('Settings migrated from v0 to v1')
    }

    // Persist if any migration ran, so migrations don't repeat on next start
    if ((s.settingsVersion ?? 0) > version) {
      app.savePluginOptions(s)
      app.debug('Migrated settings saved (v%d → v%d)', version, s.settingsVersion)
    }

    return s
  }

  // ---------------------------------------------------------------------------
  // Hot-apply runtime option changes
  // ---------------------------------------------------------------------------

  function applyOptionChanges() {
    const keys = Object.keys(changedOptions)
    if (keys.length === 0) return

    // Merge all changes into settings first so every branch below sees the
    // updated state when it reads from settings.
    Object.assign(settings, changedOptions)
    changedOptions = {}
    hasPendingChanges = false

    // Active polar — load new table
    if ('activePolar' in settings || 'perfAdjust' in settings) {
      if (keys.includes('activePolar') && settings.activePolar) {
        try {
          polarTable = store.load(settings.activePolar)
          polarTable.setPerformanceAdjustment(settings.perfAdjust || 1)
          app.setPluginStatus(`Polar '${settings.activePolar}' loaded`)
        } catch (e) {
          app.setPluginError(`Cannot load polar '${settings.activePolar}': ${e.message}`)
        }
      } else if (keys.includes('activePolar') && !settings.activePolar) {
        polarTable = null
        nullifyOutputs()
        app.setPluginStatus('No polar configured — set activePolar or upload a CSV file')
      } else if (keys.includes('perfAdjust') && polarTable) {
        polarTable.setPerformanceAdjustment(settings.perfAdjust)
      }
    }

    // Smoother type or parameter changes — update all running smoothers in-place
    const SMOOTHER_KEYS = ['smootherType', 'smootherParamExponential', 'smootherParamMovingAverage', 'smootherParamKalman']
    if (keys.some(k => SMOOTHER_KEYS.includes(k))) {
      const SC = getSmootherClass(settings.smootherType)
      const so = getSmootherOptions(settings.smootherType, settings)
      if (windSmoother) { windSmoother.setSmootherClass(SC); windSmoother.setSmootherOptions(so) }
      if (bspSmoother)  { bspSmoother.setSmootherClass(SC);  bspSmoother.setSmootherOptions(so)  }
      if (hdgSmoother)  { hdgSmoother.setSmootherClass(SC);  hdgSmoother.setSmootherOptions(so)  }
    }

    // Speed source change — re-point the BSP handler with an explicit unsubscribe/subscribe cycle.
    if (keys.includes('useSOG') && bspSmoother) {
      bspSmoother.unsubscribe()
      bspSmoother.handler.path = settings.useSOG
        ? 'navigation.speedOverGround'
        : 'navigation.speedThroughWater'
      bspSmoother.subscribe()
    }

    // Tack heading toggle
    if (keys.includes('tackTrue')) {
      if (settings.tackTrue && !hdgSmoother) {
        const SC = getSmootherClass(settings.smootherType)
        const so = getSmootherOptions(settings.smootherType, settings)
        hdgSmoother = new SmoothedAngle(app, plugin.id, 'hdg', 'navigation.headingTrue', {
          angleRange: '0to2pi',
          SmootherClass: SC,
          smootherOptions: so,
          ..._wireHandlerWatchdog({
            get path() { return hdgSmoother?.handler?.path ?? 'navigation.headingTrue' },
            unsubscribe: () => hdgSmoother?.unsubscribe(),
            subscribe: () => hdgSmoother?.subscribe(false, true),
          })
        })
      } else if (!settings.tackTrue && hdgSmoother) {
        hdgSmoother.terminate()
        hdgSmoother = null
      }
    }

    app.savePluginOptions(settings, (err) => {
      if (err) app.error('Failed to save settings: ' + err.message)
    })

    // Nullify SK paths for any output toggle that was just switched off
    const disabledPaths = keys
      .filter(k => OUTPUT_PATHS[k] && !settings[k])
      .flatMap(k => OUTPUT_PATHS[k])
    if (disabledPaths.length) {
      app.handleMessage(plugin.id, {
        updates: [{ values: disabledPaths.map(path => ({ path, value: null })) }]
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Nullify all polar-derived SK paths — called when polar is deselected so
  // consumers see null rather than stale values from the previous polar.
  // ---------------------------------------------------------------------------

  function nullifyOutputs() {
    const allPaths = Object.values(OUTPUT_PATHS).flat()
    app.handleMessage(plugin.id, {
      updates: [{ values: allPaths.map(path => ({ path, value: null })) }]
    })
  }

  // ---------------------------------------------------------------------------
  // Performance computation — called on every smoothed wind update
  // ---------------------------------------------------------------------------

  function computeAndSend() {
    if (hasPendingChanges) applyOptionChanges()
    if (!polarTable) return

    const wind = windSmoother.polarValue
    const TWS = wind.magnitude
    const TWAsigned = wind.angle
    if (!Number.isFinite(TWS) || !Number.isFinite(TWAsigned)) return

    // TWA is always positive for polar lookups; sign is tracked via `port`
    const TWA = Math.abs(TWAsigned)
    const port = TWAsigned < 0 ? -1 : 1
    const BSP = bspSmoother ? bspSmoother.value : null
    const HDG = hdgSmoother ? hdgSmoother.value : null

    const values = []
    const metas = []

    function add(skPath, value, unit, description) {
      if (!Number.isFinite(value)) return
      values.push({ path: skPath, value })
      if (!metaSentPaths.has(skPath)) {
        metas.push({ path: skPath, value: { units: unit, description } })
        metaSentPaths.add(skPath)
      }
    }

    // Always emit smoothed inputs
    if (settings.smoothedInputs) {
      add('environment.wind.angleTrueWaterDamped', TWAsigned, 'rad',
        'True Wind Angle after smoothing, negative to port.')
      if (Number.isFinite(BSP)) {
        add('performance.boatSpeedDamped', BSP, 'm/s', 'Boat speed after smoothing.')
      }
    }

    // Polar lookups
    const isUpwind = TWA < Math.PI / 2
    const beatAngle = polarTable.getBeatAngle(TWS)
    const runAngle  = polarTable.getRunAngle(TWS)
    const beatVMG   = polarTable.getBeatVMG(TWS)
    const runVMG    = polarTable.getRunVMG(TWS)
    const targetAngle = isUpwind ? beatAngle : runAngle
    const targetVMG   = isUpwind ? beatVMG   : runVMG

    if (Number.isFinite(beatAngle)) {
      if (settings.beatAngle) {
        add('performance.beatAngle', beatAngle * port, 'rad',
          'Optimal beat angle for current TWS, negative to port.')
      }
      if (settings.targetTWA && isUpwind) {
        add('performance.targetAngle', beatAngle * port, 'rad',
          'Target TWA — auto-switches between beat and run, negative to port.')
      }
    }

    if (Number.isFinite(runAngle)) {
      if (settings.beatAngle) {
        add('performance.gybeAngle', runAngle * port, 'rad',
          'Optimal run/gybe angle for current TWS, negative to port.')
      }
      if (settings.targetTWA && !isUpwind) {
        add('performance.targetAngle', runAngle * port, 'rad',
          'Target TWA — auto-switches between beat and run, negative to port.')
      }
    }

    if (Number.isFinite(beatVMG)) {
      if (settings.beatVMG) {
        add('performance.beatAngleVelocityMadeGood', beatVMG, 'm/s',
          'Optimal beat VMG for current TWS.')
      }
      if (settings.targetTWA && isUpwind) {
        add('performance.targetVelocityMadeGood', beatVMG, 'm/s',
          'Target VMG — auto-switches between beat and run.')
      }
    }

    if (Number.isFinite(runVMG)) {
      if (settings.beatVMG) {
        add('performance.gybeAngleVelocityMadeGood', runVMG, 'm/s',
          'Optimal run VMG for current TWS.')
      }
      if (settings.targetTWA && !isUpwind) {
        add('performance.targetVelocityMadeGood', runVMG, 'm/s',
          'Target VMG — auto-switches between beat and run.')
      }
    }

    // Optimum wind angle: angular difference between current TWA and optimal angle
    if (settings.optimumWindAngle) {
      if (isUpwind && Number.isFinite(beatAngle)) {
        add('performance.optimumWindAngle', (TWA - beatAngle) * port, 'rad',
          'Difference between TWA and beat angle, negative to port.')
      } else if (!isUpwind && Number.isFinite(runAngle)) {
        add('performance.optimumWindAngle', (runAngle - TWA) * port * -1, 'rad',
          'Difference between TWA and run angle, negative to port.')
      }
    }

    // Polar speed and performance ratios
    const polarSpeed = polarTable.getBoatSpeed(TWS, TWA)
    if (Number.isFinite(polarSpeed) && polarSpeed > 0) {
      if (settings.polarSpeed) {
        add('performance.polarSpeed', polarSpeed, 'm/s',
          'Polar chart boat speed for current TWS and TWA.')

        // Target speed: only meaningful when sailing within the polar range
        if (Number.isFinite(targetAngle) && Number.isFinite(targetVMG)) {
          const cosTarget = Math.abs(Math.cos(targetAngle))
          if (cosTarget > 0.01) {
            add('performance.targetSpeed', targetVMG / cosTarget, 'm/s',
              'Boat speed needed to achieve target VMG at the optimal angle.')
          }
        }

        if (Number.isFinite(BSP)) {
          add('performance.polarSpeedRatio', BSP / polarSpeed, 'ratio',
            'Actual boat speed divided by polar speed.')
        }
      }

      if (Number.isFinite(BSP)) {
        if (settings.VMG && Number.isFinite(targetVMG) && targetVMG > 0) {
          const vmg = BSP * Math.cos(TWA)
          add('performance.velocityMadeGood', vmg, 'm/s',
            'Actual VMG based on current boat speed and TWA.')
          add('performance.polarVelocityMadeGood', targetVMG, 'm/s',
            'Polar VMG for current TWS.')
          if (Number.isFinite(vmg)) {
            add('performance.polarVelocityMadeGoodRatio', Math.abs(vmg) / targetVMG, 'ratio',
              'Actual VMG divided by polar VMG.')
          }
        }
      }
    } else {
      // Clear these paths so no stale non-zero value remains on the SK bus
      if (settings.polarSpeed) {
        values.push({ path: 'performance.polarSpeed', value: null })
        values.push({ path: 'performance.polarSpeedRatio', value: null })
        values.push({ path: 'performance.targetSpeed', value: null })
      }
    }

    // Max speed for current TWS
    if (settings.maxSpeed) {
      const maxSpeed = polarTable.getMaxSpeed(TWS)
      const maxSpeedAngle = polarTable.getMaxSpeedAngle(TWS)
      if (Number.isFinite(maxSpeed)) {
        add('performance.maxSpeed', maxSpeed, 'm/s',
          'Maximum polar boat speed for current TWS.')
        add('performance.maxSpeedAngle', maxSpeedAngle * port, 'rad',
          'TWA at which maximum speed is achieved, negative to port.')
      }
    }

    // Opposite tack heading
    if (settings.tackTrue && Number.isFinite(HDG) && Number.isFinite(targetAngle)) {
      let tack = port < 0 ? HDG - targetAngle : HDG + targetAngle
      tack = ((tack % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      add('performance.tackTrue', tack, 'rad',
        'Opposite tack heading relative to true north.')
    }

    if (values.length === 0) return

    if (metas.length > 0) {
      app.handleMessage(plugin.id, { updates: [{ meta: metas }] })
    }

    app.handleMessage(plugin.id, { updates: [{ values }] })

    // Snapshot enabled outputs for /status endpoint
    // Each output key maps to an array of { path, value } computed this cycle
    const outputSnapshot = {}
    values.forEach(({ path, value }) => { outputSnapshot[path] = value })
    Object.assign(lastOutputs, outputSnapshot)
  }

  // ---------------------------------------------------------------------------
  // Plugin object
  // ---------------------------------------------------------------------------

  const plugin = {
    id: 'signalk-polar-performance-plugin',
    name: 'Polar Performance Plugin',
    description: 'Calculates sailing performance metrics from a polar diagram.',

    schema: () => ({
      type: "object",
      description: "The plugin is configured through its webapp. Open it from the Signal K app list (Webapps → Advanced Wind) to set sources, enable corrections and adjust parameters.",
      properties: {}
}),

    uiSchema: () => ({}),

    getOpenApi: () => require('../openApi.json'),

    // registerWithRouter is defined outside start() — runs once at plugin load
    registerWithRouter(router) {
      app.debug('registerWithRouter')

      function getStore() {
        if (!store) {
          store = new PolarFileStore(app.getDataDirPath())
        }
        return store
      }

      function loadStoredPolar(id) {
        return getStore().load(id)
      }

      // Size-1 cache: avoids reloading from disk when consecutive query requests
      // target the same polar ID (e.g. the N parallel curve fetches on startup).
      // perfAdjust is applied fresh on every use so it is never part of the key.
      let cachedPolar = null  // { id, table } | null

      function loadPolarCached(id) {
        if (!cachedPolar || cachedPolar.id !== id) {
          cachedPolar = { id, table: loadStoredPolar(id) }
        }
        cachedPolar.table.setPerformanceAdjustment(settings.perfAdjust || 1)
        return cachedPolar.table
      }

      function invalidatePolarCache(id) {
        if (cachedPolar && cachedPolar.id === id) cachedPolar = null
      }

      function getImportService() {
        if (!importService) {
          importService = new ImportService(getStore())
        }
        return importService
      }

      // Lightweight internet connectivity probe.
      // Attempts a HEAD request to Cloudflare's public DNS (1.1.1.1) with a
      // 3-second timeout.  Returns true if any HTTP response is received,
      // false on network error or timeout.
      async function checkInternet() {
        const TIMEOUT_MS = 3000
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
          const response = await fetch('https://1.1.1.1', { method: 'HEAD', signal: controller.signal })
            .finally(() => clearTimeout(timer))
          return response.status < 600
        } catch (_) {
          return false
        }
      }

      function errorStatus(error) {
        return /Polar not found/i.test(error.message) ? 404 : 500
      }

      function toFixedNumber(value, digits) {
        return Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : null
      }

      function getPolarTwsValues(table) {
        return table.table
          .filter(entry => entry.tws > 0.001)
          .map(entry => parseFloat(entry.tws.toFixed(4)))
      }

      function buildCurveResult(table, tws, stepRad) {
        const points = []
        for (let twa = 0; twa <= Math.PI + 1e-9; twa += stepRad) {
          const tbs = table.getBoatSpeed(tws, twa)
          if (Number.isFinite(tbs) && tbs > 0) {
            points.push({
              twa: toFixedNumber(twa, 5),
              tbs: toFixedNumber(tbs, 4)
            })
          }
        }

        const beatAngle = table.getBeatAngle(tws)
        const beatVMG = table.getBeatVMG(tws)
        const runAngle = table.getRunAngle(tws)
        const runVMG = table.getRunVMG(tws)
        const beatTbs = Number.isFinite(beatAngle) ? table.getBoatSpeed(tws, beatAngle) : null
        const runTbs = Number.isFinite(runAngle) ? table.getBoatSpeed(tws, runAngle) : null

        return {
          tws,
          points,
          beat: (Number.isFinite(beatAngle) && Number.isFinite(beatTbs)) ? {
            twa: toFixedNumber(beatAngle, 5),
            tbs: toFixedNumber(beatTbs, 4),
            vmg: toFixedNumber(beatVMG, 4)
          } : null,
          run: (Number.isFinite(runAngle) && Number.isFinite(runTbs)) ? {
            twa: toFixedNumber(runAngle, 5),
            tbs: toFixedNumber(runTbs, 4),
            vmg: toFixedNumber(runVMG, 4)
          } : null
        }
      }

      function buildSpeedResult(table, tws, twa) {
        const tbs = table.getBoatSpeed(tws, twa)
        return {
          tws,
          twa,
          tbs: toFixedNumber(tbs, 4),
          state: table.getInterpolationState(tws, twa)
        }
      }

      function buildTargetsResult(table, tws) {
        const beatAngle = table.getBeatAngle(tws)
        const runAngle = table.getRunAngle(tws)
        const beatVMG = table.getBeatVMG(tws)
        const runVMG = table.getRunVMG(tws)
        const beatTbs = Number.isFinite(beatAngle) ? table.getBoatSpeed(tws, beatAngle) : null
        const runTbs = Number.isFinite(runAngle) ? table.getBoatSpeed(tws, runAngle) : null

        return {
          tws,
          beat: (Number.isFinite(beatAngle) && Number.isFinite(beatTbs)) ? {
            twa: toFixedNumber(beatAngle, 5),
            tbs: toFixedNumber(beatTbs, 4),
            vmg: toFixedNumber(beatVMG, 4)
          } : null,
          run: (Number.isFinite(runAngle) && Number.isFinite(runTbs)) ? {
            twa: toFixedNumber(runAngle, 5),
            tbs: toFixedNumber(runTbs, 4),
            vmg: toFixedNumber(runVMG, 4)
          } : null
        }
      }

      function buildPerformanceMetric(polarValue, actualValue) {
        if (!Number.isFinite(polarValue) || polarValue <= 0 || !Number.isFinite(actualValue)) {
          return null
        }
        return {
          polar: toFixedNumber(polarValue, 4),
          actual: toFixedNumber(actualValue, 4),
          ratio: toFixedNumber(actualValue / polarValue, 5)
        }
      }

      function buildPerformanceResult(table, tws, twa, bsp) {
        const polarSpeed = table.getBoatSpeed(tws, twa)
        const upwindLimit = Math.PI / 3
        const downwindLimit = 2 * Math.PI / 3

        let direction = 'reaching'
        let polarVmg = null
        let actualVmg = null
        if (twa < upwindLimit) {
          direction = 'upwind'
          polarVmg = table.getBeatVMG(tws)
          actualVmg = bsp * Math.cos(twa)
        } else if (twa > downwindLimit) {
          direction = 'downwind'
          polarVmg = table.getRunVMG(tws)
          actualVmg = Math.abs(bsp * Math.cos(twa))
        }

        return {
          tws,
          twa,
          bsp,
          direction,
          speed: buildPerformanceMetric(polarSpeed, bsp),
          vmg: direction === 'reaching' ? null : buildPerformanceMetric(polarVmg, actualVmg)
        }
      }

      function validatePolarResourceBody(resource) {
        return canonical.validateCanonicalPolarResourceBody(resource)
      }

      function generateCanonicalPolarId(resource) {
        return createTimestampedId(
          resource?.sailnumber || resource?.name || 'polar',
          'polar',
          (candidate) => getStore().exists(candidate),
          Date.now
        )
      }

      router.use((req, res, next) => {
        res.set('Origin-Agent-Cluster', '?1')
        next()
      })

      router.get('/polars/active', (req, res) => {
        if (!settings.activePolar) {
          return res.status(404).json({ error: 'No polar is currently active' })
        }
        res.json({ id: settings.activePolar })
      })

      router.put('/polars/active', (req, res) => {
        const id = req.body?.id
        if (typeof id !== 'string') {
          return res.status(400).json({ error: "Expected JSON body with string 'id'" })
        }

        if (!id) {
          polarTable = null
          settings.activePolar = ''
          app.savePluginOptions(settings, (err) => {
            if (err) app.error('Failed to save settings: ' + err.message)
          })
          nullifyOutputs()
          app.setPluginStatus('No polar configured — set activePolar or upload a CSV file')
          return res.json({ id: '' })
        }

        try {
          polarTable = loadStoredPolar(id)
          polarTable.setPerformanceAdjustment(settings.perfAdjust || 1)
          settings.activePolar = id
          app.savePluginOptions(settings, (err) => {
            if (err) app.error('Failed to save settings: ' + err.message)
          })
          app.setPluginStatus(`Polar '${id}' loaded`)
          res.json({ id })
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.delete('/polars/active', (_req, res) => {
        polarTable = null
        settings.activePolar = ''
        app.savePluginOptions(settings, (err) => {
          if (err) app.error('Failed to save settings: ' + err.message)
        })
        nullifyOutputs()
        app.setPluginStatus('No polar configured — set activePolar or upload a CSV file')
        res.json({ id: '' })
      })

      router.get('/imports/formats', (_req, res) => {
        res.json(getImportService().listFormats())
      })

      router.get('/internet', async (_req, res) => {
        res.json({ online: await checkInternet() })
      })

      router.get('/imports/sources', (_req, res) => {
        res.json(getImportService().listSources())
      })

      router.post('/polars', (req, res) => {
        const validationError = validatePolarResourceBody(req.body)
        if (validationError) {
          return res.status(400).json({ error: validationError })
        }

        try {
          const id = generateCanonicalPolarId(req.body)
          getStore().saveCanonical(id, {
            ...req.body,
            name: req.body.name || id
          })
          res.status(201).json({ id })
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      router.post('/imports/text/:format', (req, res) => {
        try {
          const result = getImportService().importText(req.params.format, req.body)
          res.status(201).json({ id: result.id })
        } catch (error) {
          if (error instanceof ImportError) {
            return res.status(error.status).json({ error: error.message })
          }
          res.status(500).json({ error: error.message })
        }
      })

      router.get('/imports/sources/:source/search', async (req, res) => {
        if (!await checkInternet()) {
          return res.status(503).json({ error: 'No internet connection — external source imports are unavailable' })
        }
        try {
          const results = await getImportService().searchSource(req.params.source, req.query?.q)
          res.json(results)
        } catch (error) {
          if (error instanceof ImportError) {
            return res.status(error.status).json({ error: error.message })
          }
          res.status(500).json({ error: error.message })
        }
      })

      router.post('/imports/sources/:source/items/:externalId', async (req, res) => {
        if (!await checkInternet()) {
          return res.status(503).json({ error: 'No internet connection — external source imports are unavailable' })
        }
        try {
          const result = await getImportService().importSource(req.params.source, req.params.externalId, req.body)
          res.status(201).json({ id: result.id })
        } catch (error) {
          if (error instanceof ImportError) {
            return res.status(error.status).json({ error: error.message })
          }
          res.status(500).json({ error: error.message })
        }
      })

      router.get('/polars/:id/axes/tws', (req, res) => {
        try {
          const table = loadStoredPolar(req.params.id)
          res.json(getPolarTwsValues(table))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.get('/polars/:id/queries/curve', (req, res) => {
        try {
          const table = loadPolarCached(req.params.id)
          const tws = parseFloat(req.query.tws)
          if (!Number.isFinite(tws) || tws < 0) {
            return res.status(400).json({ error: "'tws' query parameter required (m/s)" })
          }
          const stepRad = parseFloat(req.query.step) || (2 * Math.PI / 180)
          if (!Number.isFinite(stepRad) || stepRad <= 0 || stepRad > Math.PI / 2) {
            return res.status(400).json({ error: "'step' must be between 0 and π/2 radians" })
          }
          res.json(buildCurveResult(table, tws, stepRad))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.get('/polars/:id/queries/speed', (req, res) => {
        try {
          const table = loadPolarCached(req.params.id)
          const tws = parseFloat(req.query.tws)
          const twa = parseFloat(req.query.twa)
          if (!Number.isFinite(tws) || tws < 0 || !Number.isFinite(twa) || twa < 0) {
            return res.status(400).json({ error: "'tws' and 'twa' query parameters are required" })
          }
          res.json(buildSpeedResult(table, tws, twa))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.get('/polars/:id/queries/targets', (req, res) => {
        try {
          const table = loadPolarCached(req.params.id)
          const tws = parseFloat(req.query.tws)
          if (!Number.isFinite(tws) || tws < 0) {
            return res.status(400).json({ error: "'tws' query parameter required (m/s)" })
          }
          res.json(buildTargetsResult(table, tws))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.get('/polars/:id/queries/performance', (req, res) => {
        try {
          const table = loadPolarCached(req.params.id)
          const tws = parseFloat(req.query.tws)
          const twa = parseFloat(req.query.twa)
          const bsp = parseFloat(req.query.bsp)
          if (!Number.isFinite(tws) || tws < 0 || !Number.isFinite(twa) || twa < 0 || !Number.isFinite(bsp) || bsp < 0) {
            return res.status(400).json({ error: "'tws', 'twa', and 'bsp' query parameters are required" })
          }
          res.json(buildPerformanceResult(table, tws, twa, bsp))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      router.get('/polars/:id/meta', (req, res) => {
        try {
          const polarStore = getStore()
          const table = polarStore.load(req.params.id)
          const meta = polarStore.readMeta(req.params.id)
          const twsValues = getPolarTwsValues(table)
          res.json({
            id: req.params.id,
            name: meta.boatName || req.params.id,
            sailnumber: meta.sailnumber,
            boatType: meta.boatType,
            year: meta.year,
            source: meta.source,
            notes: meta.notes,
            twsMin: twsValues.length ? twsValues[0] : null,
            twsMax: twsValues.length ? twsValues[twsValues.length - 1] : null
          })
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      // Current smoothed live values from the plugin's own smoothers. All SI units.
      // tws/bsp/polarSpeed in m/s; twa in rad (positive = starboard, negative = port).
      // Returns null for any field not yet available (plugin not running,
      // no BSP source, polar not loaded, or boat in irons).
      router.get('/live', (req, res) => {
        const wind = windSmoother?.ready ? windSmoother.polarValue : null
        const TWS       = wind ? wind.magnitude : null
        const TWAsigned = wind ? wind.angle : null
        const TWA       = Number.isFinite(TWAsigned) ? Math.abs(TWAsigned) : null
        const BSP       = bspSmoother ? bspSmoother.value : null

        const polarSpeed = (polarTable && Number.isFinite(TWS) && Number.isFinite(TWA))
          ? polarTable.getBoatSpeed(TWS, TWA)
          : null

        const performance = (Number.isFinite(BSP) && Number.isFinite(polarSpeed) && polarSpeed > 0)
          ? BSP / polarSpeed
          : null

        const si = v => Number.isFinite(v) ? parseFloat(v.toFixed(5)) : null

        const polarState = (polarTable && Number.isFinite(TWS) && Number.isFinite(TWA))
          ? polarTable.getInterpolationState(TWS, TWA)
          : null

        res.json({
          tws:         si(TWS),
          twa:         si(TWAsigned),
          bsp:         si(BSP),
          polarSpeed:  si(polarSpeed),
          performance: Number.isFinite(performance) ? parseFloat(performance.toFixed(5)) : null,
          polarState
        })
      })

      // Comprehensive snapshot of everything the plugin knows about its current state.
      // All values are SI units (m/s, rad). Use /meta for display unit conversion.
      //
      // inputs.raw.*  — last value delivered by the instrument (from smoother handler)
      // inputs.smoothed.* — value the plugin actually used for computation
      // outputs.*     — only present for enabled settings; null if polar not ready
      // polarState    — same as /live
      router.get('/status', (req, res) => {
        const si = v => (Number.isFinite(v) ? parseFloat(v.toFixed(5)) : null)

        // Raw inputs: read directly from the smoother handlers
        const rawTws = si(windSmoother?.polar?.magnitudeHandler?.value ?? null)
        const rawTwa = si(windSmoother?.polar?.angleHandler?.value ?? null)
        const rawBsp = si(bspSmoother?.handler?.value ?? null)
        const rawHdg = si(hdgSmoother?.handler?.value ?? null)

        const wind = windSmoother?.ready ? windSmoother.polarValue : null
        const TWS       = wind ? wind.magnitude : null
        const TWAsigned = wind ? wind.angle     : null
        const BSP       = bspSmoother ? bspSmoother.value : null
        const HDG       = hdgSmoother ? hdgSmoother.value  : null

        const bspPath = settings.useSOG ? 'navigation.speedOverGround' : 'navigation.speedThroughWater'

        const polarState = (polarTable && Number.isFinite(TWS) && Number.isFinite(TWAsigned))
          ? polarTable.getInterpolationState(TWS, Math.abs(TWAsigned))
          : null

        // Build outputs object: only include paths that are enabled and were
        // computed in the last cycle (present in lastOutputs).
        const outputs = {}
        Object.entries(OUTPUT_PATHS).forEach(([key, paths]) => {
          if (!settings[key]) return
          paths.forEach(path => {
            const v = lastOutputs[path]
            outputs[path] = Number.isFinite(v) ? si(v) : null
          })
        })

        res.json({
          inputs: {
            raw: {
              tws: rawTws,
              twa: rawTwa,
              bsp: rawBsp,
              ...(settings.tackTrue ? { hdg: rawHdg } : {})
            },
            smoothed: {
              tws: si(TWS),
              twa: si(TWAsigned),
              bsp: si(BSP),
              ...(settings.tackTrue && HDG != null ? { hdg: si(HDG) } : {})
            },
            paths: {
              tws: 'environment.wind.speedTrue',
              twa: 'environment.wind.angleTrueWater',
              bsp: bspPath,
              ...(settings.tackTrue ? { hdg: 'navigation.headingTrue' } : {})
            }
          },
          outputs,
          polarState
        })
      })

      // Metadata describing the units and display preferences for each field
      // returned by /live and the canonical curve query endpoints. displayUnits are fetched from the
      // SK server's path metadata so user unit preferences (kn vs m/s etc.) are
      // respected. Falls back to safe defaults when SK metadata is unavailable.
      router.get('/meta', (req, res) => {
        const speed = { formula: 'value * 1.943844', symbol: 'kn', displayFormat: '0.0' }
        const angle = { formula: 'value * 57.29577951308231', symbol: '\u00b0', displayFormat: '0.0' }
        const ratio = { formula: 'value * 100', symbol: '%', displayFormat: '0.1' }

        res.json({
          tws:         { units: 'm/s', displayUnits: speed },
          twa:         { units: 'rad', displayUnits: angle },
          bsp:         { units: 'm/s', displayUnits: speed },
          polarSpeed:  { units: 'm/s', displayUnits: speed },
          performance: { units: 'ratio', displayUnits: ratio },
          'curve.tbs': { units: 'm/s', displayUnits: speed },
          'curve.vmg': { units: 'm/s', displayUnits: speed },
          'curve.twa': { units: 'rad', displayUnits: angle }
        })
      })

      // ---- Runtime settings ------------------------------------------------

      router.get('/settings', (req, res) => {
        // Merge pending staged changes so the client always sees the latest
        // intended state even before the next wind update drains them.
        res.json({ ...settings, ...changedOptions, _defaults: DEFAULT_SETTINGS })
      })

      router.put('/settings', (req, res) => {
        if (!req.body || typeof req.body !== 'object') {
          return res.status(400).json({ error: 'Expected a JSON object' })
        }
        // Stage changes; they are applied in applyOptionChanges() on the next
        // wind update (or immediately below if the plugin is already running).
        Object.assign(changedOptions, req.body)
        hasPendingChanges = true
        // Drain immediately so source/polar changes take effect even when the
        // wind data stream is idle.
        if (isRunning) applyOptionChanges()
        res.json({ ...settings, ...changedOptions, _defaults: DEFAULT_SETTINGS })
      })

      // ---- Polar file operations -------------------------------------------

      router.get('/polars', (req, res) => {
        try {
          const polarStore = getStore()
          const polars = polarStore.list().map((id) => {
            const meta = polarStore.readMeta(id)
            return {
              id,
              name: meta.boatName || id,
              sailnumber: meta.sailnumber,
              boatType: meta.boatType,
              year: meta.year,
              source: meta.source
            }
          })
          res.json(polars)
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      router.get('/polars/:id', (req, res) => {
        try {
          const stored = getStore().readObject(req.params.id)
          res.json({ ...stored, id: req.params.id })
        } catch (e) {
          res.status(404).json({ error: e.message })
        }
      })

      router.put('/polars/:id', (req, res) => {
        const validationError = validatePolarResourceBody(req.body)
        if (validationError) {
          return res.status(400).json({ error: validationError })
        }

        try {
          getStore().saveCanonical(req.params.id, {
            ...req.body,
            name: req.body.name || req.params.id
          })
          invalidatePolarCache(req.params.id)
          if (settings.activePolar === req.params.id) {
            polarTable = loadStoredPolar(req.params.id)
            polarTable.setPerformanceAdjustment(settings.perfAdjust || 1)
          }
          res.json({ id: req.params.id })
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      router.delete('/polars/:id', (req, res) => {
        try {
          getStore().delete(req.params.id)
          invalidatePolarCache(req.params.id)
          if (settings.activePolar === req.params.id) {
            settings.activePolar = ''
            polarTable = null
            nullifyOutputs()
            app.savePluginOptions(settings, (err) => {
              if (err) app.error('Failed to save settings: ' + err.message)
            })
          }
          res.json({ id: req.params.id })
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })
    },

    start(options) {
      metaSentPaths = new Set()  // reset so metadata is re-emitted after restart

      store = new PolarFileStore(app.getDataDirPath())
      importService = new ImportService(store)

      settings = migrateSettings({ ...DEFAULT_SETTINGS, ...options, settingsVersion: options.settingsVersion ?? 0 })

      const SmootherClass = getSmootherClass(settings.smootherType)
      const smootherOptions = getSmootherOptions(settings.smootherType, settings)

      // Load the active polar table
      if (settings.activePolar) {
        try {
          polarTable = store.load(settings.activePolar)
          polarTable.setPerformanceAdjustment(settings.perfAdjust || 1)
          app.setPluginStatus(`Polar '${settings.activePolar}' loaded`)
        } catch (e) {
          // File missing or corrupt — run without a polar rather than crashing.
          // Keep settings.activePolar so the user can see which file is broken
          // and re-upload it without reconfiguring. Nullify any stale SK values.
          polarTable = null
          nullifyOutputs()
          app.setPluginError(`Polar '${settings.activePolar}' could not be loaded: ${e.message}`)
          app.debug('Polar load error: %s', e.message)
        }
      } else {
        app.setPluginStatus('No polar configured — set activePolar or upload a CSV file')
      }

      // Wind vector smoother (TWS + TWA combined as a Cartesian vector —
      // avoids ±π wraparound discontinuity during smoothing)
      windSmoother = createSmoothedPolar({
        id: 'wind',
        pathMagnitude: 'environment.wind.speedTrue',
        pathAngle: 'environment.wind.angleTrueWater',
        subscribe: true,
        app,
        pluginId: plugin.id,
        SmootherClass,
        smootherOptions,
        onDelta: computeAndSend,
        idlePeriod: STALE_RESUBSCRIBE_PERIOD,
        onIdle: () => {
          if (!isRunning) return
          app.debug('resubscribing to wind inputs because data got stale or did not arrive at all')
          windSmoother.unsubscribe()
          windSmoother.subscribe(true, true)
        }
      })

      // Boat speed (STW or SOG depending on settings)
      bspSmoother = createSmoothedHandler({
        id: 'bsp',
        path: settings.useSOG
          ? 'navigation.speedOverGround'
          : 'navigation.speedThroughWater',
        subscribe: true,
        app,
        pluginId: plugin.id,
        SmootherClass,
        smootherOptions,
        ..._wireHandlerWatchdog({
          get path() { return bspSmoother?.handler?.path ?? (settings.useSOG ? 'navigation.speedOverGround' : 'navigation.speedThroughWater') },
          unsubscribe: () => bspSmoother?.unsubscribe(),
          subscribe: () => bspSmoother?.subscribe(),
        })
      })

      // Optional heading handler for opposite-tack computation.
      // Uses SmoothedAngle (vector-based) to avoid the 0/2π wraparound
      // discontinuity that scalar smoothing would produce near north.
      if (settings.tackTrue) {
        hdgSmoother = new SmoothedAngle(app, plugin.id, 'hdg', 'navigation.headingTrue', {
          angleRange: '0to2pi',
          SmootherClass,
          smootherOptions,
          ..._wireHandlerWatchdog({
            get path() { return hdgSmoother?.handler?.path ?? 'navigation.headingTrue' },
            unsubscribe: () => hdgSmoother?.unsubscribe(),
            subscribe: () => hdgSmoother?.subscribe(false, true),
          })
        })
      }

      isRunning = true
      app.debug('Plugin started')
    },

    stop() {
      isRunning = false
      importService = null
      nullifyOutputs()
      if (windSmoother) { windSmoother.terminate(); windSmoother = null }
      if (bspSmoother)  { bspSmoother.terminate();  bspSmoother = null  }
      if (hdgSmoother)  { hdgSmoother.terminate();  hdgSmoother = null  }
      app.debug('Plugin stopped')
    }
  }

  return plugin
}
