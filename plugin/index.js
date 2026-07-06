'use strict'

const { PolarTable } = require('./PolarTable')
const PolarFileStore = require('./PolarFileStore')
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

const DEFAULT_SETTINGS = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  activePolar: '',
  perfAdjust: 1,
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
  let orcIndex = null     // cached in-memory for the session after first fetch
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

      // Migrate embedded CSV polar to a file in the data directory.
      // Only advance settingsVersion if the CSV is successfully written —
      // if it fails, keep csvTable in settings so the migration retries on next start.
      if (s.csvTable && s.csvTable.trim()) {
        try {
          store.save('default_v06', s.csvTable)
          s.activePolar = 'default_v06'
          delete s.csvTable
          app.debug('Legacy csvTable migrated to default_v06.csv')
        } catch (e) {
          app.setPluginError('Migration failed — could not save legacy CSV: ' + e.message)
          app.debug('CSV migration error: %s', e.message)
          return s  // abort migration; csvTable kept so next start retries
        }
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

    // Speed source change — re-point the BSP handler; it auto-resubscribes
    if (keys.includes('useSOG') && bspSmoother) {
      bspSmoother.handler.path = settings.useSOG
        ? 'navigation.speedOverGround'
        : 'navigation.speedThroughWater'
    }

    // Tack heading toggle
    if (keys.includes('tackTrue')) {
      if (settings.tackTrue && !hdgSmoother) {
        const SC = getSmootherClass(settings.smootherType)
        const so = getSmootherOptions(settings.smootherType, settings)
        hdgSmoother = new SmoothedAngle(app, plugin.id, 'hdg', 'navigation.headingTrue', {
          angleRange: '0to2pi',
          SmootherClass: SC,
          smootherOptions: so
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
      // Zero out to prevent stale values accumulating in the data model
      if (settings.polarSpeed) {
        add('performance.polarSpeed', 0, 'm/s',
          'Polar chart boat speed for current TWS and TWA.')
        add('performance.polarSpeedRatio', 0, 'ratio',
          'Actual boat speed divided by polar speed.')
        add('performance.targetSpeed', 0, 'm/s',
          'Boat speed needed to achieve target VMG at the optimal angle.')
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
  // Chart data — builds the Chart.js dataset from the loaded polar table
  // ---------------------------------------------------------------------------

  function getChartData() {
    if (!polarTable || !polarTable.table || polarTable.table.length === 0) return null

    const polar = polarTable.table
    const backgroundColor = []
    const borderColor = []
    for (let c = 0; c < 20; c++) {
      const color = `${c * 10}, ${130 + (c * 20) % 100}, ${80 + (c * 30) % 120}`
      backgroundColor.push(`rgba(${color}, 1)`)
      borderColor.push(`rgba(${color}, 0.8)`)
    }

    const data = { labels: [], datasets: [] }
    for (let a = 0; a <= 180; a += 5) data.labels.push(a)

    for (let i = 0; i < polar.length; i++) {
      const tws = (polar[i].tws * 1.94384).toFixed(0)
      const twaArray = polar[i].twa
      data.datasets[i] = {
        data: [],
        pointRadius: [],
        backgroundColor: backgroundColor[i],
        borderColor: borderColor[i],
        fill: false,
        label: `${tws} kts`
      }
      for (const pt of twaArray) {
        const isOptimal = pt.twa === polar[i]['Beat angle'] || pt.twa === polar[i]['Run angle']
        data.datasets[i].data.push({
          x: Number((pt.twa * 180 / Math.PI).toFixed(1)),
          y: Number((pt.tbs * 1.94384).toFixed(2))
        })
        data.datasets[i].pointRadius.push(isOptimal ? 5 : 2)
      }
    }
    data.datasets.shift() // remove the 0-kts padding row
    return data
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

      router.use((req, res, next) => {
        res.set('Origin-Agent-Cluster', '?1')
        next()
      })

      // Legacy endpoint — returns the raw polar table structure
      router.get('/polar', (req, res) => {
        res.json(polarTable ? polarTable.table : [])
      })

      // List of TWS values in the loaded polar, in m/s (excludes zero-padding entry).
      // Useful for iterating all available library curves.
      router.get('/polar/tws', (req, res) => {
        if (!polarTable || !polarTable.table || polarTable.table.length === 0) {
          return res.status(503).json({ error: 'No polar loaded' })
        }
        const tws = polarTable.table
          .filter(entry => entry.tws > 0.001)
          .map(entry => parseFloat(entry.tws.toFixed(4)))
        res.json(tws)
      })

      // Interpolated polar curve for a given TWS.
      // Query params:
      //   tws  (required) – true wind speed in m/s
      //   step (optional) – angular sampling step in radians, default 0.035 (~2°)
      // Returns points from 0–π using getBoatSpeed() — same interpolation as
      // the live performance computation — plus beat/run markers. All values in SI.
      router.get('/polar/curve', (req, res) => {
        if (!polarTable || !polarTable.table || polarTable.table.length === 0) {
          return res.status(503).json({ error: 'No polar loaded' })
        }
        const tws = parseFloat(req.query.tws)
        if (!Number.isFinite(tws) || tws < 0) {
          return res.status(400).json({ error: "'tws' query parameter required (m/s)" })
        }
        const stepRad = parseFloat(req.query.step) || (2 * Math.PI / 180)
        if (!Number.isFinite(stepRad) || stepRad <= 0 || stepRad > Math.PI / 2) {
          return res.status(400).json({ error: "'step' must be between 0 and π/2 radians" })
        }

        const points = []
        for (let twa = 0; twa <= Math.PI + 1e-9; twa += stepRad) {
          const tbs = polarTable.getBoatSpeed(tws, twa)
          if (Number.isFinite(tbs) && tbs > 0) {
            points.push({
              twa: parseFloat(twa.toFixed(5)),
              tbs: parseFloat(tbs.toFixed(4))
            })
          }
        }

        const beatAngle = polarTable.getBeatAngle(tws)
        const beatVMG   = polarTable.getBeatVMG(tws)
        const runAngle  = polarTable.getRunAngle(tws)
        const runVMG    = polarTable.getRunVMG(tws)

        const beatTbs = Number.isFinite(beatAngle) ? polarTable.getBoatSpeed(tws, beatAngle) : null
        const runTbs  = Number.isFinite(runAngle)  ? polarTable.getBoatSpeed(tws, runAngle)  : null

        res.json({
          tws,
          points,
          beat: (Number.isFinite(beatAngle) && Number.isFinite(beatTbs)) ? {
            twa: parseFloat(beatAngle.toFixed(5)),
            tbs: parseFloat(beatTbs.toFixed(4)),
            vmg: Number.isFinite(beatVMG) ? parseFloat(beatVMG.toFixed(4)) : null
          } : null,
          run: (Number.isFinite(runAngle) && Number.isFinite(runTbs)) ? {
            twa: parseFloat(runAngle.toFixed(5)),
            tbs: parseFloat(runTbs.toFixed(4)),
            vmg: Number.isFinite(runVMG) ? parseFloat(runVMG.toFixed(4)) : null
          } : null
        })
      })

      // Current smoothed live values from the plugin's own smoothers. All SI units.
      // tws/bsp/polarSpeed in m/s; twa in rad (positive = starboard, negative = port).
      // Returns null for any field not yet available (plugin not running,
      // no BSP source, polar not loaded, or boat in irons).
      router.get('/live', (req, res) => {
        const wind = windSmoother ? windSmoother.polarValue : null
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

        const wind = windSmoother ? windSmoother.polarValue : null
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
      // returned by /live and /polar/curve. displayUnits are fetched from the
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

      // Chart data for the webapp
      router.get('/chartData', (req, res) => {
        const chart = getChartData()
        if (!chart) {
          return res.status(503).json({
            error: 'No polar loaded',
            reason: 'Configure activePolar in plugin settings or upload a CSV via /polars/:name'
          })
        }
        res.json(chart)
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
          res.json(store ? store.listWithMeta() : [])
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      // NOTE: specific routes must come before the parameterised :name routes
      router.get('/polars/import/search', async (req, res) => {
        const q = (req.query.q || '').toLowerCase()
        try {
          if (!orcIndex) orcIndex = await PolarFileStore.fetchOrcIndex()
          const lq = q
          const results = orcIndex
            .filter(b => !lq ||
              String(b.name     || '').toLowerCase().includes(lq) ||
              String(b.sailnumber || '').toLowerCase().includes(lq) ||
              String(b.type || '').toLowerCase().includes(lq))
            .map(b => ({
              name: b.name,
              sailnumber: b.sailnumber,
              type: b.type,
              // sort priority: name match first, sailnumber second, type last
              _p: String(b.name || '').toLowerCase().includes(lq) ? 0
                : String(b.sailnumber || '').toLowerCase().includes(lq) ? 1 : 2
            }))
            .sort((a, b) => a._p - b._p)
            .map(({ _p, ...rest }) => rest)
          res.json(results)
        } catch (e) {
          orcIndex = null // allow retry after failure
          res.status(502).json({ error: `Failed to fetch ORC data: ${e.message}` })
        }
      })

      router.post('/polars/import/:sailnumber', async (req, res) => {
        const sn = req.params.sailnumber
        try {
          // Fetch the full boat entry (VPP + metadata) directly from the ORC site.
          // The compact orcIndex only has {sailnumber, name, type}; the full entry
          // is always fetched on import so we don’t need to load the entire index first.
          const boat = await PolarFileStore.fetchBoat(sn)
          if (!boat || !boat.vpp) {
            return res.status(404).json({ error: `No VPP data found for sail number '${sn}'` })
          }
          const name = store.importFromORC(boat.vpp, sn, {
            boatName: boat.name,
            boatType: boat.boat?.type,
            sailnumber: sn
          })
          res.json({ ok: true, name })
        } catch (e) {
          res.status(e.message?.includes('fetch failed') ? 404 : 500)
            .json({ error: e.message })
        }
      })

      router.put('/polars/active/:name', (req, res) => {
        try {
          polarTable = store.load(req.params.name)
          polarTable.setPerformanceAdjustment(settings.perfAdjust || 1)
          settings.activePolar = req.params.name
          app.setPluginStatus(`Polar '${req.params.name}' loaded`)
          res.json({ ok: true, activePolar: req.params.name })
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      router.get('/polars/:name', (req, res) => {
        try {
          const content = store.read(req.params.name)
          res.type(store.isJson(req.params.name) ? 'application/json' : 'text/plain').send(content)
        } catch (e) {
          res.status(404).json({ error: e.message })
        }
      })

      router.post('/polars/:name', (req, res) => {
        try {
          // Accept JSON { csv, boatName, boatType, sailnumber } or plain text CSV
          let csv, meta = null
          if (req.body && typeof req.body === 'object' && req.body.csv) {
            csv = req.body.csv
            const { boatName, boatType, sailnumber } = req.body
            if (boatName || boatType || sailnumber) meta = { boatName, boatType, sailnumber }
          } else if (typeof req.body === 'string') {
            csv = req.body
          } else {
            return res.status(400).json({ error: 'Expected JSON { csv } or text/plain' })
          }
          store.save(req.params.name, csv, meta)
          res.json({ ok: true })
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })

      router.delete('/polars/:name', (req, res) => {
        try {
          store.delete(req.params.name)
          res.json({ ok: true })
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })
    },

    start(options) {
      metaSentPaths = new Set()  // reset so metadata is re-emitted after restart

      // Store must be initialised before migrateSettings so the CSV migration
      // can write the legacy polar to a file during the v0 → v1 upgrade.
      store = new PolarFileStore(app.getDataDirPath())

      // Treat missing settingsVersion as v0 — must override after spreading DEFAULT_SETTINGS
      // (which has settingsVersion: 1) so migration triggers correctly for legacy installs.
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
        smootherOptions
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
        smootherOptions
      })

      // Optional heading handler for opposite-tack computation.
      // Uses SmoothedAngle (vector-based) to avoid the 0/2π wraparound
      // discontinuity that scalar smoothing would produce near north.
      if (settings.tackTrue) {
        hdgSmoother = new SmoothedAngle(app, plugin.id, 'hdg', 'navigation.headingTrue', {
          angleRange: '0to2pi',
          SmootherClass,
          smootherOptions
        })
      }

      // Trigger performance computation whenever a new smoothed wind value is ready
      windSmoother.onChange = computeAndSend

      isRunning = true
      app.debug('Plugin started')
    },

    stop() {
      isRunning = false
      nullifyOutputs()
      if (windSmoother) { windSmoother.terminate(); windSmoother = null }
      if (bspSmoother)  { bspSmoother.terminate();  bspSmoother = null  }
      if (hdgSmoother)  { hdgSmoother.terminate();  hdgSmoother = null  }
      app.debug('Plugin stopped')
    }
  }

  return plugin
}
