'use strict'

const { Polar } = require('polar-math')
const {
  MessageHandler,
  createSmoothedPolar,
  createSmoothedHandler,
  SmoothedAngle,
  BaseSmoother,
  ExponentialSmoother,
  MovingAverageSmoother,
  KalmanSmoother
} = require('signalkutilities')

const CURRENT_SETTINGS_VERSION = 2

const STALE_RESUBSCRIBE_PERIOD = 60000 // ms — idle period before live input subscriptions are re-established

const DEFAULT_SETTINGS = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
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

  // Active polar — sourced from the `polars.activePolar` / `polars.performanceFactor`
  // SK paths (published by a 'polars' resource-provider plugin, e.g. signalk-polar-management).
  // This plugin no longer stores or manages polar files itself.
  let polar = null                 // polar-math Polar instance, or null when unavailable
  let activePolarId = null
  let activePolarDoc = null        // raw canonical resource, for descriptive metadata
  let performanceFactor = 1
  let activePolarHandler = null
  let performanceFactorHandler = null

  let windSmoother = null
  let bspSmoother = null
  let hdgSmoother = null
  let metaSentPaths = new Set()  // tracks paths that have had metadata emitted
  let lifecycleWarningMap = new Map()
  let lifecycleWarnings = []

  // Last-computed output values, updated by computeAndSend on every cycle.
  // Keys match the settings keys; values are SI numbers or null.
  const lastOutputs = {}

  // GET handlers mirrored onto /signalk/v1/api/<plugin.id>/ (SK 2.x readonly).
  // Writes stay on /plugins/ (admin). registerWithRouter fills this list.
  const publicGetRoutes = []

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

  function _setLifecycleWarning(id, status, path) {
    const safePath = path || 'unknown path'
    const message = status === 'idle'
      ? `Input ${id} is idle on ${safePath}; resubscribing`
      : `Input ${id} is stale on ${safePath}`
    lifecycleWarningMap.set(id, {
      id,
      status,
      path: safePath,
      message,
      updatedAt: Date.now()
    })
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function _clearLifecycleWarning(id) {
    if (!lifecycleWarningMap.has(id)) return
    lifecycleWarningMap.delete(id)
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function _wireHandlerWatchdog({ id, getPath, unsubscribe, subscribe }) {
    return {
      idlePeriod: STALE_RESUBSCRIBE_PERIOD,
      onDelta: () => {
        _clearLifecycleWarning(id)
      },
      onStale: () => {
        if (!isRunning) return
        const path = getPath()
        app.debug(`[${plugin.id}] stale input ${id} on ${path}`)
        _setLifecycleWarning(id, 'stale', path)
      },
      onIdle: () => {
        if (!isRunning) return
        const path = getPath()
        app.debug(`[${plugin.id}] idle input ${id} on ${path}; resubscribing`)
        _setLifecycleWarning(id, 'idle', path)
        unsubscribe()
        subscribe()
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
      delete s.csvTable
      s.settingsVersion = 1
      app.debug('Settings migrated from v0 to v1')
    }

    if (s.settingsVersion < 2) {
      // v1 → v2: polar selection and performance adjustment moved to the
      // `polars.activePolar` / `polars.performanceFactor` SK paths, published
      // by a 'polars' resource-provider plugin (e.g. signalk-polar-management).
      delete s.activePolar
      delete s.perfAdjust
      s.settingsVersion = 2
      app.debug('Settings migrated from v1 to v2')
    }

    // Persist if any migration ran, so migrations don't repeat on next start.
    // Signal K requires a callback; omitting it throws TypeError and aborts start().
    if ((s.settingsVersion ?? 0) > version) {
      app.savePluginOptions(s, (err) => {
        if (err) {
          app.error('Failed to save migrated settings: ' + err.message)
        } else {
          app.debug('Migrated settings saved (v%d → v%d)', version, s.settingsVersion)
        }
      })
    }

    return s
  }

  // ---------------------------------------------------------------------------
  // Active polar — sourced from SK paths published by a 'polars' resource provider
  // ---------------------------------------------------------------------------

  // Extracts the resource id from an `href` of the shape `/resources/polars/<id>`.
  function hrefToId(href) {
    if (typeof href !== 'string') return null
    const match = href.match(/\/resources\/polars\/([^/]+)$/)
    return match ? match[1] : null
  }

  async function checkPolarProvider() {
    if (!app.resourcesApi || typeof app.resourcesApi.listResources !== 'function') return false
    try {
      await app.resourcesApi.listResources('polars', {})
      return true
    } catch (_e) {
      return false
    }
  }

  function handleActivePolarDelta() {
    const value = activePolarHandler.value
    const href = value?.href
    if (!href) {
      polar = null
      activePolarId = null
      activePolarDoc = null
      nullifyOutputs()
      app.setPluginStatus('No active polar selected — select one in the polar management webapp')
      return
    }

    const id = hrefToId(href)
    if (!id) {
      app.setPluginError(`Cannot parse active polar href: ${href}`)
      return
    }

    app.resourcesApi.getResource('polars', id).then((doc) => {
      try {
        polar = Polar.fromTable(doc)
        activePolarId = id
        activePolarDoc = doc
        app.setPluginStatus(`Polar '${doc.name || id}' loaded`)
      } catch (e) {
        // Keep the last valid polar (if any) rather than dropping outputs on a bad update.
        app.setPluginError(`Invalid active polar '${id}': ${e.message}`)
        if (!polar) nullifyOutputs()
      }
    }).catch((e) => {
      app.setPluginError(`Cannot load active polar '${id}': ${e.message}`)
      if (!polar) nullifyOutputs()
    })
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
    if (!polar) return

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
    const { value: targets } = polar.targetsAt({ tws: TWS, performanceFactor })
    const beatAngle = targets?.beat?.twa ?? null
    const runAngle  = targets?.run?.twa ?? null
    const beatVMG   = targets?.beat?.vmg ?? null
    const runVMG    = targets?.run?.vmg ?? null
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
    const { value: polarSpeed } = polar.speedAt({ tws: TWS, twa: TWA, performanceFactor })
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
      const maxSpeed = targets?.maxSpeed?.speed ?? null
      const maxSpeedAngle = targets?.maxSpeed?.twa ?? null
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
      description: "The plugin is configured through its webapp. Open it from the Signal K app list (Webapps → Polar Performance) to set sources, enable corrections and adjust parameters. Select the active polar and performance factor in the Polar Management webapp.",
      properties: {}
}),

    uiSchema: () => ({}),

    getOpenApi: () => require('../openApi.json'),

    // registerWithRouter is defined outside start() — runs once at plugin load
    registerWithRouter(router) {
      app.debug('registerWithRouter')
      publicGetRoutes.length = 0
      function publicGet(path, handler) {
        router.get(path, handler)
        publicGetRoutes.push([path, handler])
      }

      function errorStatus(error) {
        return /No active polar/i.test(error.message) ? 404 : 500
      }

      function toFixedNumber(value, digits) {
        return Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : null
      }

      function getPolarTwsValues() {
        return polar.entries
          .filter(entry => entry.tws > 0.001)
          .map(entry => parseFloat(entry.tws.toFixed(4)))
      }

      function buildCurveResult(tws, stepRad) {
        const points = []
        for (let twa = 0; twa <= Math.PI + 1e-9; twa += stepRad) {
          const { value: tbs } = polar.speedAt({ tws, twa, performanceFactor })
          if (Number.isFinite(tbs) && tbs > 0) {
            points.push({
              twa: toFixedNumber(twa, 5),
              tbs: toFixedNumber(tbs, 4)
            })
          }
        }

        const { value: targets } = polar.targetsAt({ tws, performanceFactor })
        return {
          tws,
          points,
          beat: targets?.beat ? {
            twa: toFixedNumber(targets.beat.twa, 5),
            tbs: toFixedNumber(targets.beat.speed, 4),
            vmg: toFixedNumber(targets.beat.vmg, 4)
          } : null,
          run: targets?.run ? {
            twa: toFixedNumber(targets.run.twa, 5),
            tbs: toFixedNumber(targets.run.speed, 4),
            vmg: toFixedNumber(targets.run.vmg, 4)
          } : null
        }
      }

      router.use((req, res, next) => {
        res.set('Origin-Agent-Cluster', '?1')
        next()
      })

      // ---- Active polar curve queries (read-only — for the webapp's polar canvas) --

      publicGet('/polar/axes/tws', (req, res) => {
        if (!polar) return res.status(404).json({ error: 'No active polar selected' })
        res.json(getPolarTwsValues())
      })

      publicGet('/polar/queries/curve', (req, res) => {
        if (!polar) return res.status(404).json({ error: 'No active polar selected' })
        try {
          const tws = parseFloat(req.query.tws)
          if (!Number.isFinite(tws) || tws < 0) {
            return res.status(400).json({ error: "'tws' query parameter required (m/s)" })
          }
          const stepRad = parseFloat(req.query.step) || (2 * Math.PI / 180)
          if (!Number.isFinite(stepRad) || stepRad <= 0 || stepRad > Math.PI / 2) {
            return res.status(400).json({ error: "'step' must be between 0 and π/2 radians" })
          }
          res.json(buildCurveResult(tws, stepRad))
        } catch (e) {
          res.status(errorStatus(e)).json({ error: e.message })
        }
      })

      // Current smoothed live values from the plugin's own smoothers. All SI units.
      // tws/bsp/polarSpeed in m/s; twa in rad (positive = starboard, negative = port).
      // Returns null for any field not yet available (plugin not running,
      // no BSP source, polar not loaded, or boat in irons).
      publicGet('/live', (req, res) => {
        const wind = windSmoother?.ready ? windSmoother.polarValue : null
        const TWS       = wind ? wind.magnitude : null
        const TWAsigned = wind ? wind.angle : null
        const TWA       = Number.isFinite(TWAsigned) ? Math.abs(TWAsigned) : null
        const BSP       = bspSmoother ? bspSmoother.value : null

        const polarResult = (polar && Number.isFinite(TWS) && Number.isFinite(TWA))
          ? polar.speedAt({ tws: TWS, twa: TWA, performanceFactor })
          : null
        const polarSpeed = polarResult ? polarResult.value : null

        const performance = (Number.isFinite(BSP) && Number.isFinite(polarSpeed) && polarSpeed > 0)
          ? BSP / polarSpeed
          : null

        const si = v => Number.isFinite(v) ? parseFloat(v.toFixed(5)) : null

        res.json({
          tws:         si(TWS),
          twa:         si(TWAsigned),
          bsp:         si(BSP),
          polarSpeed:  si(polarSpeed),
          performance: Number.isFinite(performance) ? parseFloat(performance.toFixed(5)) : null,
          polarState:  polarResult ? polarResult.state : null
        })
      })

      // Comprehensive snapshot of everything the plugin knows about its current state.
      // All values are SI units (m/s, rad). Use /meta for display unit conversion.
      //
      // inputs.raw.*  — last value delivered by the instrument (from smoother handler)
      // inputs.smoothed.* — value the plugin actually used for computation
      // outputs.*     — only present for enabled settings; null if polar not ready
      // polarState    — same as /live
      publicGet('/status', (req, res) => {
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

        const polarState = (polar && Number.isFinite(TWS) && Number.isFinite(TWAsigned))
          ? polar.speedAt({ tws: TWS, twa: Math.abs(TWAsigned), performanceFactor }).state
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
          polarState,
          lifecycleWarnings
        })
      })

      // Metadata describing the units and display preferences for each field
      // returned by /live and the canonical curve query endpoints, plus a
      // read-only summary of the active polar and performance factor
      // (both sourced from the `polars.*` SK paths — not editable here).
      publicGet('/meta', (req, res) => {
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
          'curve.twa': { units: 'rad', displayUnits: angle },
          activePolar: activePolarDoc ? {
            id: activePolarId,
            name: activePolarDoc.name || activePolarId,
            boatType: activePolarDoc.boatType ?? null,
            sailnumber: activePolarDoc.sailnumber ?? null,
            year: activePolarDoc.year ?? null,
            source: activePolarDoc.source ?? null,
            notes: activePolarDoc.notes ?? null
          } : null,
          performanceFactor
        })
      })

      // ---- Runtime settings ------------------------------------------------

      publicGet('/settings', (req, res) => {
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
        // Drain immediately so source changes take effect even when the
        // wind data stream is idle.
        if (isRunning) applyOptionChanges()
        res.json({ ...settings, ...changedOptions, _defaults: DEFAULT_SETTINGS })
      })
    },

    // SK 2.x mounts this at /signalk/v1/api (readonly). Writes stay on /plugins/.
    signalKApiRoutes(router) {
      const prefix = '/signalk-polar-performance-plugin'
      publicGetRoutes.forEach(([path, handler]) => {
        router.get(prefix + path, handler)
      })
      return router
    },

    start(options) {
      app.debug('Starting')
      metaSentPaths = new Set()  // reset so metadata is re-emitted after restart
      lifecycleWarningMap = new Map()
      lifecycleWarnings = []
      polar = null
      activePolarId = null
      activePolarDoc = null
      performanceFactor = 1

      settings = migrateSettings({ ...DEFAULT_SETTINGS, ...options, settingsVersion: options.settingsVersion ?? 0 })

      checkPolarProvider().then((available) => {
        app.debug(`checkPolarProvider: ${available ? 'polars resource provider found' : 'no polars resource provider'}`)
        if (!available) {
          app.setPluginStatus("No 'polars' resource provider registered — install signalk-polar-management (or another plugin providing the 'polars' resource type) to select an active polar.")
        }
      })

      // Active polar / performance factor — read-only, published by a 'polars' resource provider.
      // These are event-driven (change only on user action), so the idle-watchdog
      // unsubscribe/resubscribe used for sensor handlers below does not apply here: absence
      // of deltas is the normal state, not a sign of a broken subscription, and periodically
      // forcing a resubscribe would just be churn (and possible side effects) for no reason.
      activePolarHandler = new MessageHandler(app, plugin.id, 'activePolar')
      activePolarHandler.path = 'polars.activePolar'
      activePolarHandler.onDelta = () => handleActivePolarDelta()
      activePolarHandler.subscribe()

      performanceFactorHandler = new MessageHandler(app, plugin.id, 'performanceFactor')
      performanceFactorHandler.path = 'polars.performanceFactor'
      performanceFactorHandler.onDelta = () => {
        const value = performanceFactorHandler.value
        performanceFactor = Number.isFinite(value) ? value : 1
      }
      performanceFactorHandler.subscribe()

      const SmootherClass = getSmootherClass(settings.smootherType)
      const smootherOptions = getSmootherOptions(settings.smootherType, settings)

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
        ..._wireHandlerWatchdog({
          id: 'wind.smoothed',
          getPath: () => `${windSmoother?.polar?.pathMagnitude ?? 'environment.wind.speedTrue'}, ${windSmoother?.polar?.pathAngle ?? 'environment.wind.angleTrueWater'}`,
          unsubscribe: () => windSmoother?.unsubscribe(),
          subscribe: () => windSmoother?.subscribe(true, true),
        }),
        onDelta: () => {
          _clearLifecycleWarning('wind.smoothed')
          computeAndSend()
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
          id: 'bsp.smoothed',
          getPath: () => bspSmoother?.handler?.path ?? (settings.useSOG ? 'navigation.speedOverGround' : 'navigation.speedThroughWater'),
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
            id: 'hdg.smoothed',
            getPath: () => hdgSmoother?.handler?.path ?? 'navigation.headingTrue',
            unsubscribe: () => hdgSmoother?.unsubscribe(),
            subscribe: () => hdgSmoother?.subscribe(false, true),
          })
        })
      }

      isRunning = true
      app.debug('Plugin started')
    },

    stop() {
      app.debug('Stopping')
      isRunning = false
      nullifyOutputs()
      if (windSmoother) { windSmoother.terminate(); windSmoother = null }
      if (bspSmoother)  { bspSmoother.terminate();  bspSmoother = null  }
      if (hdgSmoother)  { hdgSmoother.terminate();  hdgSmoother = null  }
      if (activePolarHandler) { activePolarHandler.unsubscribe(); activePolarHandler = null }
      if (performanceFactorHandler) { performanceFactorHandler.unsubscribe(); performanceFactorHandler = null }
      polar = null
      activePolarId = null
      activePolarDoc = null
      lifecycleWarningMap = new Map()
      lifecycleWarnings = []
      app.debug('Plugin stopped')
    }
  }

  return plugin
}
