const halfPi = Math.PI / 2
var sourceAddress

module.exports = function (app) {
  var plugin = {}
  var unsubscribes = []
  var timers = []
  var damping = {}

  plugin.id = 'signalk-polar-performance-plugin'
  plugin.name = 'Polar performance plugin'
  plugin.description = 'A plugin that calculates performance information based on a (CSV) polar diagram.'

  plugin.uiSchema = {
    csvTable: { "ui:widget": "textarea" }
  }

  var schema = {
    // The plugin schema
    properties: {
      beatAngle: {
        type: 'boolean',
        title: 'Enable calculation/sending of beat/upwind and run/gybe/downwind angle'
      },
      beatVMG: {
        type: 'boolean',
        title: 'Enable calculation/sending of beat/upwind and run/gybe/downwind VMG'
      },
      targetTWA: {
        type: 'boolean',
        title: 'Enable sending Target TWA (performance.targetAngle)'
      },
      tackTrue: {
        type: 'boolean',
        title: 'Enable calculating Opposite Tack True (performance.tackTrue)'
      },
      optimumWindAngle: {
        type: 'boolean',
        title: 'Enable calculation of Optimum Wind Angle (difference between TWA and beat/run angle (depends on beat/run angle)'
      },
      VMG: {
        type: 'boolean',
        title: 'Enable calculation of VMG, polarVMG and polar VMG ratio'
      },
      useSOG: {
        type: 'boolean',
        title: 'Use speed over ground (SOG) as boat speed.'
      },
      maxSpeed: {
        type: 'boolean',
        title: 'Enable writing of maximum speed angle and boat speed for a given TWS'
      },
      perfAdjust: {
        type: 'number',
        description: 'This ratio allows you to lower the polar boat speeds in case you are not expecting to meet 100% due to e.g. weight. 1 = 100%, 0.8 = 80% etc',
        title: 'Performance adjustment ratio',
        default: 1
      },
      dampingTWA: {
        type: 'number',
        description: 'If data appears erratic or too sensitive, damping may be applied to amke information appear more stable. With damping set to 0, the data is presented in raw form wih no damping applied.',
        title: 'True Wind Angle damping seconds',
        default: 1
      },
      dampingTWS: {
        type: 'number',
        title: 'True Wind Speed damping seconds',
        default: 1
      },
      dampingBSP: {
        type: 'number',
        title: 'Boat speed damping damping',
        default: 1
      },
      csvTable: {
        type: "string",
        title: "Copy/paste the csv content of the polar in http://jieter.github.io/orc-data/site/ style."
      }
    }
  }

  plugin.schema = function() {
    // updateSchema()
    return schema
  }


  plugin.start = function (options, restartPlugin) {
    // Here we put our plugin logic
    app.debug('Plugin started');
    var unsubscribes = [];
    app.debug('Options: %s', JSON.stringify(options))

    // Load polar table
    var polar = csvToPolarObject(options.csvTable)
    app.debug('polar: %s', JSON.stringify(polar))

    plugin.registerWithRouter = function(router) {
      // Will appear here; plugins/signalk-polar-performance-plugin/
      app.debug("registerWithRouter")
      router.get("/polar", (req, res) => {
        res.contentType("application/json")
        res.send(JSON.stringify(polar))
      })
      router.get("/chartData", (req, res) => {
        res.contentType("application/json")
        res.send(JSON.stringify(getChartData()))
      })
    }

   
    // Global variables
    var BSP, STW, TWA, targetTWA, TWS, HDG, port // Angles in rad, speed in m/s

    // Subscribe to paths
    let localSubscription = {
      context: '*',
      subscribe: [
        {
          path: 'navigation.speedThroughWater',
          policy: 'instant'
        },
        {
          path: 'environment.wind.speedTrue',
          policy: 'instant'
        },
        {
          path: 'environment.wind.angleTrueWater',
          policy: 'instant'
        }
      ]
    }

    // Additional subscribes based on options
    if (options.useSOG == true) {
      localSubscription.subscribe.push({
        path: 'navigation.speedOverGround',
        policy: 'instant'
      })
    }
    if (options.tackTrue == true) {
      localSubscription.subscribe.push({
          path: 'navigation.headingTrue',
          policy: 'instant'
      })
    }

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          // app.debug(u.values)
          handleDelta(u.values)
        })
      }
    )

    // Handle delta
    function handleDelta (deltas) {
      deltas.forEach(delta => {
	      // app.debug('handleData: %s', JSON.stringify(delta))
	      if (delta.path == 'navigation.speedThroughWater') {
	        STW = applyDamping (delta.value, 'BSP', options.dampingBSP || 0)
          BSP = STW
	        // app.debug('speedThroughWater (STW): %d', STW)
	      } else if (delta.path == 'navigation.speedOverGround') {
	        SOG = applyDamping (delta.value, 'BSP', options.dampingBSP || 0)
          BSP = SOG
	        // app.debug('speedThroughWater (STW): %d', STW)
	      } else if (delta.path == 'navigation.headingTrue') {
	        HDG = delta.value
	        // app.debug('heading (HDG): %d', HDG)
	      } else if (delta.path == 'environment.wind.speedTrue') {
          // applyDamping (Xn, unit, a, n)
	        TWS = applyDamping (delta.value, 'TWS', options.dampingTWS || 0)
	        // app.debug('environment.wind.speedTrue (TWS): %d applyDamping: %d', delta.value, TWS)
	        // app.debug('TWS: %d TWA: %d BSP: %d', msToKts(TWS), radToDeg(TWA)*port, msToKts(BSP))
          sendUpdates(getPerformanceData(TWS, TWA, BSP))
	      } else if (delta.path == 'environment.wind.angleTrueWater') {
          if (delta.value < 0) {
            port = -1
          } else {
            port = 1
          }
	        TWA = Math.abs(applyDamping (delta.value, 'TWA', options.dampingTWA || 0))
	        app.debug('environment.wind.angleTrueWater (TWA): %s applyDamping: %s', radToDeg(delta.value).toFixed(0), radToDeg(TWA).toFixed(0))
	      }
      })
    }

    function sendUpdates (perfObj) {
      let values = []
      let metas = []
      if (typeof perfObj.beatAngle != 'undefined') {
        if (options.beatAngle == true) {
          values.push({path: 'performance.beatAngle', value: roundDec(perfObj.beatAngle)})
        }
        if (options.targetTWA == true) {
          values.push({path: 'performance.targetAngle', value: roundDec(perfObj.beatAngle)})
        }
      }
      if (typeof perfObj.beatVMG != 'undefined') {
        values.push({path: 'performance.beatAngleVelocityMadeGood', value: roundDec(perfObj.beatVMG)})
        if (options.targetTWA == true) {
          values.push({path: 'performance.targetVelocityMadeGood', value: roundDec(perfObj.beatVMG)})
          metas.push({path: 'performance.targetVelocityMadeGood', value: {"units": "rad"}})
        }
      }
      if (typeof perfObj.runAngle != 'undefined') {
        if (options.beatAngle == true) {
          values.push({path: 'performance.gybeAngle', value: roundDec(perfObj.runAngle)})
        }
        if (options.targetTWA == true) {
          values.push({path: 'performance.targetAngle', value: roundDec(perfObj.runAngle)})
        }
      }
      if (typeof perfObj.runVMG != 'undefined') {
        values.push({path: 'performance.gybeAngleVelocityMadeGood', value: roundDec(perfObj.runVMG)})
        if (options.targetTWA == true) {
          values.push({path: 'performance.targetVelocityMadeGood', value: roundDec(perfObj.runVMG)})
          metas.push({path: 'performance.targetVelocityMadeGood', value: {"units": "rad"}})
        }
      }
      if (typeof perfObj.optimumWindAngle != 'undefined') {
        values.push({path: 'performance.optimumWindAngle', value: roundDec(perfObj.optimumWindAngle)})
        metas.push({path: 'performance.optimumWindAngle', value: {"units": "rad"}})
      }
      if (typeof perfObj.targetSpeed != 'undefined') {
        values.push({path: 'performance.targetSpeed', value: roundDec(perfObj.targetSpeed)})
      }
      if (typeof perfObj.polarSpeed != 'undefined') {
        values.push({path: 'performance.polarSpeed', value: roundDec(perfObj.polarSpeed)})
        values.push({path: 'performance.polarSpeedRatio', value: roundDec(perfObj.polarSpeedRatio)})
        if (typeof perfObj.velocityMadeGood != 'undefined') {
          values.push({path: 'performance.velocityMadeGood', value: roundDec(perfObj.velocityMadeGood)})
          values.push({path: 'performance.polarVelocityMadeGood', value: roundDec(perfObj.polarVelocityMadeGood)})
          metas.push({path: 'performance.polarVelocityMadeGood', value: {"units": "m/s"}})
          values.push({path: 'performance.polarVelocityMadeGoodRatio', value: roundDec(perfObj.polarVelocityMadeGoodRatio)})
          metas.push({path: 'performance.polarVelocityMadeGoodRatio', value: {"units": "ratio"}})
        }
      }
      if (typeof perfObj.maxSpeed != 'undefined') {
        values.push({path: 'performance.maxSpeed', value: roundDec(perfObj.maxSpeed)})
        metas.push({path: 'performance.maxSpeed', value: {"units": "m/s"}})
        values.push({path: 'performance.maxSpeedAngle', value: roundDec(perfObj.maxSpeedAngle)})
        metas.push({path: 'performance.maxSpeedAngle', value: {"units": "rad"}})
      }
      if (options.tackTrue == true) {
        if (typeof perfObj.tackTrue != 'undefined') {
          values.push({path: 'performance.tackTrue', value: roundDec(perfObj.tackTrue)})
        }
      }

      app.debug('sendUpdates: %s', JSON.stringify(values))
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values,
            meta: metas
          }
        ]
      })
    }

    function getPerformanceData (TWS, TWA, BSP) {
      var performance = {}
      // Use windspeed to find nearest speeds
      for (let indexTWS = 0 ; indexTWS < polar.length-1; indexTWS++) {
        let lower = polar[indexTWS].tws
        let upper = polar[indexTWS+1].tws
        if (TWS >= lower && TWS <= upper) {
          //app.debug('TWS between %d and %d', lower, upper)
          // Calculate gap ratio
          let gap = upper - lower
          let twsGapRatio = (1 / gap) * (TWS - lower)
          //app.debug('twsGapRatio: %d', twsGapRatio)
	        // Calculate beat/run angle
	        if (TWA < halfPi) {
            // app.debug('Upwind')
	          // Take beat angle
            if (typeof polar[indexTWS]['Beat angle'] != 'undefined') {
	            let beatLower = polar[indexTWS]['Beat angle']
	            let beatUpper = polar[indexTWS+1]['Beat angle']
	            performance.beatAngle = beatLower + ((beatUpper - beatLower) * twsGapRatio)
              targetTWA = performance.beatAngle
            }
	          // Calculate optimum wind angle (B&G thing)
	          if (options.optimumWindAngle == true) {
              if (typeof performance.beatAngle != 'undefined') {
                performance.optimumWindAngle = (TWA - performance.beatAngle) * port
              }
	          }
	          // Calculate beat VMG
            if (typeof polar[indexTWS]['Beat VMG'] != 'undefined') {
	            let VMGLower = polar[indexTWS]['Beat VMG']
	            let VMGUpper = polar[indexTWS+1]['Beat VMG']
	            performance.beatVMG = VMGLower + ((VMGUpper - VMGLower) * twsGapRatio)
	            performance.targetVMG = performance.beatVMG
            }
	        } else {
            // app.debug('Downwind')
            if (typeof polar[indexTWS]['Run angle'] != 'undefined') {
	            // Calculate run angle
	            let runLower = polar[indexTWS]['Run angle']
	            let runUpper = polar[indexTWS+1]['Run angle']
	            //app.debug('runLower: %s runUpper: %s', runLower, runUpper)
	            performance.runAngle = runLower + ((runUpper - runLower) * twsGapRatio)
              targetTWA = performance.runAngle
            }
	          if (options.optimumWindAngle == true) {
              if (typeof performance.runAngle != 'undefined') {
	              // Calculate optimum wind angle
	              performance.optimumWindAngle = (performance.runAngle - TWA) * port * -1
              }
	          }
	          // Calculate run VMG
            if (typeof polar[indexTWS]['Run VMG'] != 'undefined') {
	            let VMGLower = polar[indexTWS]['Run VMG']
	            let VMGUpper = polar[indexTWS+1]['Run VMG']
	          //app.debug('VMGLower: %s VMGUpper: %s', VMGLower, VMGUpper)
	            performance.runVMG = VMGLower + ((VMGUpper - VMGLower) * twsGapRatio)
	            performance.targetVMG = performance.runVMG
            }
          }
          // Calculate opposite Tack True
          // app.debug('tackTrue: port: %d HDG: %d targetTWA: %d', port, radToDeg(HDG), radToDeg(targetTWA))
          if (port) {
            let tackTrue = HDG - targetTWA
            if (tackTrue < 0) {
              tackTrue = tackTrue + (2*Math.PI)
            }
            performance.tackTrue = tackTrue
          } else {
            let tackTrue = HDG + targetTWA
            if (tackTrue > (2*Math.PI)) {
              tackTrue = tackTrue - (2*Math.PI)
            }
            performance.tackTrue = tackTrue
          }
          // Calculate polar target boat speed

          // Interpolate Define the 4 near data points
          let lowerTWA = polar[indexTWS].twa
          let upperTWA = polar[indexTWS+1].twa
          // app.debug('TWAlower: %s', JSON.stringify(TWAlower))
          // First find lowerTWA
          for (let indexTWA = 0 ; indexTWA < lowerTWA.length-1; indexTWA++) {
            let lowerTWAlower = lowerTWA[indexTWA]
            let lowerTWAupper = lowerTWA[indexTWA+1]
	          // app.debug('lowerTWAlower: %s lowerTWAupper: %s', lowerTWAlower, lowerTWAupper)
            if (TWA >= lowerTWAlower.twa && TWA <= lowerTWAupper.twa) {
              // Now find upperTWA
              for (let indexTWA = 0 ; indexTWA < upperTWA.length-1; indexTWA++) {
                let upperTWAlower = upperTWA[indexTWA]
                let upperTWAupper = upperTWA[indexTWA+1]
                if (TWA >= upperTWAlower.twa && TWA <= upperTWAupper.twa) {
                  // Found the 4 points
			            // app.debug('lowerTWAlower: %d TWA: %d lowerTWAupper: %d', lowerTWAlower.twa, TWA, lowerTWAupper.twa)
		              // Calculate gap ratio
		              let gap = lowerTWAupper.twa - lowerTWAlower.twa
		              let twaGapRatio = (1 / gap) * (TWA - lowerTWAlower.twa)
			            // app.debug('twaGapRatio: %d', twaGapRatio)
		              // Calculate lower tws boat speed
			            let lowerTBS = lowerTWAlower.tbs + ((lowerTWAupper.tbs - lowerTWAlower.tbs) * twaGapRatio)
		              // Calculate upper tws boat speed
			            let upperTBS = upperTWAlower.tbs + ((upperTWAupper.tbs - upperTWAlower.tbs) * twaGapRatio)
		              // Calculate polar boat speed
		              performance.polarSpeed = lowerTBS + ((upperTBS - lowerTBS) * twsGapRatio)
			            // app.debug('lowerTBS: %d TBS: %d upperTBS: %d', lowerTBS, performance.polarSpeed, upperTBS)
                  break
                }
              }
              break
            } 
          }
          if (typeof performance.polarSpeed == 'undefined') {
            if (TWA < performance.beatAngle) {
              // In case TWA < lowest polar angle
              app.debug('Low angle %d not present in table', radToDeg(TWA))
              // performance.polarSpeed = 
            } else if (TWA > performance.runAngle) {
              // In case TWA > highest polar angle
              app.debug('High angle %d not present in table', radToDeg(TWA))
              // performance.polarSpeed =
            }
          }

          if (options.maxSpeed == true) {
            let lowerMax = polar[indexTWS]['Max speed']
            let upperMax = polar[indexTWS+1]['Max speed']
            let maxSpeed = lowerMax + ((upperMax - lowerMax) * twsGapRatio)
            performance.maxSpeed = maxSpeed
            let lowerMaxAngle = polar[indexTWS]['Max speed angle']
            let upperMaxAngle = polar[indexTWS+1]['Max speed angle']
            let maxSpeedAngle = lowerMaxAngle + ((upperMaxAngle - lowerMaxAngle) * twsGapRatio)
            performance.maxSpeedAngle = maxSpeedAngle
          }
        } else if (indexTWS == 0 && TWS < lower) {
          app.debug('No data for low wind speed (%d kts)', msToKts(TWS))
        } else if (indexTWS == polar.length-1 && TWS > upper) {
          app.debug('No data for high wind speed (%d kts)', msToKts(TWS))
        }
      }
      // Calculate polar performance ratio
      if (typeof performance.polarSpeed != 'undefined') {
        performance.polarSpeedRatio = BSP / performance.polarSpeed
        if (options.VMG == true) {
          performance.velocityMadeGood = Math.abs(BSP * Math.cos(TWA))
          performance.polarVelocityMadeGood = performance.targetVMG
          performance.polarVelocityMadeGoodRatio = performance.velocityMadeGood / performance.polarVelocityMadeGood
        }
      } else {
        // No value would create stale values
        performance.polarSpeed = 0
        performance.polarSpeedRatio = 0
        if (options.VMG == true) {
          performance.velocityMadeGood = 0
          performance.polarVelocityMadeGood = 0
          performance.polarRatioVelocityMadeGood = 0
        }
      }
      return performance
    }

		function csvToPolarObject (csv) {
      var csvArray = []
      var polar = {}
      var beat = false

      // Create array of arrays from csv
      csv.split('\n').forEach(row => {
        csvArray.push(row.split(';'))
      })
      // app.debug('csvArray: %s', JSON.stringify(csvArray))

      // Populate the polar object from CSV rows
      csvArray.forEach(row => {
        if (row[0] == 'twa/tws') {
          // The row with TWS columns
          // Create empty TWS objects in polar object
          app.debug('First row with TWS columns')
          polar = []
          for (let index = 1; index < row.length; index++) {
            
            let twsObj = {'tws': ktsToMs(row[index])} // CSV kts to internal m/s
            polar.push(twsObj)
          }
          app.debug('polar: %s', JSON.stringify(polar))
        } else if (row.filter(i => i === '0').length > 1) {
          app.debug('beat and run angles are included')
          // Beat / Run angle
          let angle = degToRad(Number(row[0]))
          let angleName
          let VMGName
          app.debug('angle < halfPi   %d < %d', angle, halfPi)
          if (angle < halfPi) {
            angleName = 'Beat angle'
            VMGName = 'Beat VMG'
            app.debug('cvsToPolar: row includes Beat angle: %s', row.join(';'))
          } else {
            angleName = 'Run angle'
            VMGName = 'Run VMG'
            app.debug('cvsToPolar: row includes Run angle: %s', row.join(';'))
          }

          for (let index = 0; index < row.length-1; index++) {
            if (row[index+1] != 0) {
              polar[index][angleName] = angle
              let tbs = ktsToMs(Number(row[index+1])) * (options.perfAdjust || 1)
              let vmg = tbs * Math.abs(Math.cos(angle))
              polar[index][VMGName] = roundDec(vmg)
              if (typeof polar[index]['twa'] == 'undefined') {
                polar[index]['twa'] = []
              }
              let Obj = {"twa": angle, "tbs": tbs, "vmg": vmg}
              polar[index]['twa'] = polar[index]['twa'].concat(Obj)
              if (typeof polar[index]['Max speed'] == 'undefined' || tbs > polar[index]['Max speed']) {
                polar[index]['Max speed'] = tbs
                polar[index]['Max speed angle'] = angle
              }
            }
          }
        } else {
          // Normal line
          let angle = degToRad(Number(row[0]))  // CSV deg to internal rad
          for (let index = 0; index < row.length-1; index++) {
            if (typeof polar[index].twa == 'undefined') {
              polar[index].twa = []
            }
            let tbs = ktsToMs(Number(row[index+1])) * (options.perfAdjust || 1)
            let vmg = tbs * Math.abs(Math.cos(angle))
            let Obj = {"twa": angle, "tbs": tbs, "vmg": vmg}
            // app.debug('Adding Obj: %s', JSON.stringify(Obj))
            polar[index]['twa'] = polar[index]['twa'].concat(Obj)
            // See if we need to set/overwrite beat/run angle


            // See if this a new Max speed
            if (typeof polar[index]['Max speed'] == 'undefined' || tbs > polar[index]['Max speed']) {
              polar[index]['Max speed'] = tbs
              polar[index]['Max speed angle'] = angle
            }
          }
        }
      })

      // Sort the twa arrays by angle
      polar.forEach(tws => {
        let twaArray = tws.twa
        twaArray = twaArray.sort((a, b) => a.twa - b.twa)
        // app.debug('twaArray sorted: %s', JSON.stringify(twaArray))
        tws.twa = twaArray
      })

      // Find the beat/run angle if not set yet.
      for (let index = 0; index < polar.length; index++) {
        let tws = polar[index].tws
        app.debug('Beat angle for TWS %s is %s', msToKts(tws).toFixed(0), polar[index]['Beat angle'])
        // app.debug(polar[index]['Beat angle'])
        if (typeof polar[index]['Beat angle'] == 'undefined') {
          app.debug('Finding beat angle for TWS %s')
          let beatVMG = 0
          let beatElement = 0
          let runVMG = 0
          let runElement = 0

          let twaArray = polar[index].twa
          for (let element = 0; element < twaArray.length; element++) {
            let Obj = twaArray[element]
            if (Obj.twa < halfPi) {
              // Beat
              if (Obj.vmg > beatVMG) {
                beatElement = element
              }
            } else {
              // Run
              if (Obj.vmg > runVMG) {
                runElement = element
              }
            }
          }
          app.debug('beatVMG for %s is %s (angle %s)', msToKts(tws).toFixed(0), msToKts(twaArray[beatElement].vmg).toFixed(2), radToDeg(twaArray[beatElement].twa).toFixed(1))
          app.debug('runVMG for %s is %s (angle %s)', msToKts(tws).toFixed(0), msToKts(twaArray[runElement].vmg).toFixed(2), radToDeg(twaArray[runElement].twa).toFixed(1))
          polar[index]['Beat angle'] = twaArray[beatElement].twa
          polar[index]['Beat VMG'] = twaArray[beatElement].vmg
          polar[index]['Run angle'] = twaArray[runElement].twa
          polar[index]['Run VMG'] = twaArray[runElement].vmg
        }
        
      }

      // And now fill in some missing ends to avoid doing expensive calculations in the main loop
      if (polar[0].tws > 0) {
        // Add a 0 line to allow interpolation at very low wind speeds
        app.debug('Add a 0 line to allow interpolation at very low wind speeds')
        let Obj = {
           tws: 0.0001,
          'Beat angle': polar[0]['Beat angle'],
          'Beat VMG': polar[0]['Beat VMG'],
          'Run angle': polar[0]['Run angle'],
          'Run VMG': polar[0]['Run VMG'],
          twa: []
        }
        Object.keys(polar[0].twa).forEach(twaObj => {
          Obj.twa.push({twa: twaObj.twa, tbs: 0})
        })
        polar.unshift(Obj)
      }

      for (let index = 0; index < polar.length; index++) {
        // Sorted on angle, so first is lowest
        let tws = polar[index].tws
        let twaArray = polar[index].twa
        let lowTBS = twaArray[0].tbs
        let lowTWA = twaArray[0].twa

        // app.debug('Padding polar for %s from 0 to first given angle (%d deg, %d kts)', msToKts(tws).toFixed(0), radToDeg(lowTWA), msToKts(lowTBS))
        
        // Now put some extra values at the beginning
        var topArray = []
        for (let angle = 0; angle < lowTWA; angle = angle + degToRad(5)) {
          app.debug('Padding for angle %d (< lowTWA)', radToDeg(angle).toFixed(1), radToDeg(lowTWA).toFixed(1))
          let tbs = (angle / lowTWA) * Math.pow(Math.cos((-1*lowTWA + angle)*2),2) * lowTBS
          if (tbs < 0 ) { tbs = 0 }
          let Obj = {'twa': angle, 'tbs': tbs}
          topArray.push(Obj)
        }
        // app.debug('Adding values: %s', JSON.stringify(topArray))
        polar[index].twa = topArray.concat(twaArray)
      }

      for (let index = 0; index < polar.length; index++) {
        let tws = polar[index].tws
        let twaArray = polar[index].twa
        let highTBS = twaArray[twaArray.length-1].tbs
        let highTWA = twaArray[twaArray.length-1].twa

        app.debug('Padding polar for %s from highTWA to last given angle (%d, %d kts)', msToKts(tws).toFixed(0), highTWA, msToKts(highTBS))

        // Now put some extra values at the beginning
        var tailArray = []
        for (let angle = Math.PI; angle > highTWA; angle = angle - degToRad(5)) {
          let tbs = Math.pow(highTWA/angle, 2) * highTBS
          let Obj = {'twa': angle, 'tbs': tbs}
          tailArray.unshift(Obj)
        }
        // app.debug('Adding values: %s', JSON.stringify(tailArray))
        polar[index].twa = twaArray.concat(tailArray)
      }

      // app.debug(JSON.stringify(polar))
		  return (polar)
		}

    function getChartData () {
      var backgroundColor = []
      var borderColor = []
      for (let c = 0; c < 20; c++) {
        let r = 0 + (c*10)
        let g = 130 + (c*20 % 100)
        let b = 80 + (c*30 % 120)
        let color =  r + ', ' + g + ', ' + b
        backgroundColor.push('rgba(' + color + ', 1)')
        borderColor.push('rgba(' + color + ', 0.8)')
      }
      app.debug(backgroundColor)
      app.debug(borderColor)


      var data = {
        labels: [],
        datasets: []
      }
      for (let angle = 0; angle <= 180; angle += 5) {
        data.labels.push(angle)
      }
      for (let index = 0; index < polar.length; index++) {
        // Add x axis label TWS
        let tws = msToKts(polar[index].tws).toFixed(0)
        let twaArray = polar[index].twa
        data.datasets[index] = {
          data: [],
          pointRadius: [],
          backgroundColor: backgroundColor[index],
          borderColor: borderColor[index],
          fill: false,
          label: tws + ' kts'
        }
        for (let twaIndex = 0; twaIndex <= twaArray.length-1; twaIndex++) {
          let twaObj = twaArray[twaIndex]
          let radius = 2
          if (twaObj.twa == polar[index]['Beat angle'] || twaObj.twa == polar[index]['Run angle']) {
            radius = 5
          }
          data.datasets[index].data.push({x: Number(radToDeg(twaObj.twa).toFixed(1)), y: Number(msToKts(twaObj.tbs).toFixed(2))})
          data.datasets[index].pointRadius.push(radius)
        }
      }
      // Remove 0 kts line
      data.datasets.shift()
      return data
    }

		function applyDamping (Xn, unit, RC) {
      if (RC == 0) {
        return Xn
      } else {
			  if (typeof damping[unit] == 'undefined') {
			    // Doesn't exist yet, make obj for unit
			    damping[unit] = {Yn: Xn, dt: Date.now()}
			  }
        // Edge case when hovering around -pi and +pi
        if (Xn > Math.PI && damping[unit].Yn < (0-Math.PI)) {
          Xn = Xn - (2*Math.PI)
        } else if (Xn < (0-Math.PI) && damping[unit].Yn > Math.PI) {
          Xn = Xn + (2*Math.PI)
        }
	      // Calculate a
	      let dt = (Date.now() - damping[unit].dt)/1000
	      damping[unit].dt = Date.now()
	      let a = dt / (RC + dt)
			  // Yn = (1-a) * Yn-1 + a * Xn
			  let Yn = (1-a) * (damping[unit].Yn || Xn) + a * Xn

        // Fix is we go outside -pi to pi
        if (Yn > Math.PI) {
          Yn = Yn - Math.PI
        } else if (Yn < (0-Math.PI)) {
          Yn = Yn + Math.PI
        }

			  // Remember Yn
			  damping[unit].Yn = Yn
			  // app.debug('Unit: %s  dt: %d  a: %d  obj: %s', unit, dt, a, JSON.stringify(damping[unit]))
			  return Yn
			}
	  }
  }

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops
    app.debug('Plugin stopped');
    plugin.stop = function () {
      unsubscribes.forEach(f => f());
      unsubscribes = [];
      timers.forEach(timer => {
        clearInterval(timer)
      }) 
    };

  };

  return plugin;
};


function radToDeg(radians) {
  return radians * 180 / Math.PI
}

function degToRad(degrees) {
  return degrees * (Math.PI/180.0)
}

function ktsToMs(knots) {
  return knots / 1.94384
}

function msToKts(ms) {
  return ms * 1.94384
}

function roundDec (value) {
  if (typeof value == 'undefined') {
    return undefined
  } else {
    value = Number(value.toFixed(3))
    return value
  }
}

