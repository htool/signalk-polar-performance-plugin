var sourceAddress

module.exports = function (app) {
  var plugin = {}
  var unsubscribes = []
  var timers = []

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
      useSOG: {
        type: 'boolean',
        title: 'Use speed over ground (SOG) as boat speed.'
      },
      maxSpeed: {
        type: 'boolean',
        title: 'Enable writing of maximum speed angle and boat speed for a given TWS'
      },
      csvTable: {
        type: "string",
        title: "Enter csv with polar in http://jieter.github.io/orc-data/site/ style."
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
   
    // Global variables
    var BSP, STW, TWA, TargetTWA, TWS, HDG, port // Angles in rad, speed in m/s
    var halfPi = Math.PI / 2

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
        {
          path: 'navigation.headingTrue',
          policy: 'instant'
        }
      }
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
	        STW = delta.value
          BSP = STW
	        // app.debug('speedThroughWater (STW): %d', STW)
	      } else if (delta.path == 'navigation.speedOverGround') {
	        SOG = delta.value
          BSP = SOG
	        // app.debug('speedThroughWater (STW): %d', STW)
	      } else if (delta.path == 'navigation.headingTrue') {
	        HDG = delta.value
	        // app.debug('heading (HDG): %d', HDG)
	      } else if (delta.path == 'environment.wind.speedTrue') {
	        TWS = delta.value
	        // app.debug('environment.wind.speedTrue (TWS): %d', TWS)
	        app.debug('TWS: %d TWA: %d BSP: %d', msToKts(TWS), radToDeg(TWA)*port, msToKts(BSP))
          sendUpdates(getPerformanceData(TWS, TWA, BSP))
	      } else if (delta.path == 'environment.wind.angleTrueWater') {
          if (delta.value < 0) {
            port = -1
          } else {
            port = 1
          }
	        TWA = Math.abs(delta.value)
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
      }
      if (typeof perfObj.maxSpeed != 'undefined') {
        values.push({path: 'performance.maxSpeed', value: roundDec(perfObj.maxSpeed)})
        metas.push({path: 'performance.maxSpeed', value: {"units": "m/s"}})
        values.push({path: 'performance.maxSpeedAngle', value: roundDec(perfObj.maxSpeedAngle)})
        metas.push({path: 'performance.maxSpeedAngle', value: {"units": "rad"}})
      }
      if (options.tackTrue == true) {
        values.push({path: 'performance.tackTrue', value: roundDec(perfObj.tackTrue)})
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
            }
	        } else {
            // app.debug('Downwind')
            if (typeof polar[indexTWS]['Run angle'] != 'undefined') {
	            // Calculate run angle
	            let runLower = polar[indexTWS]['Run angle']
	            let runUpper = polar[indexTWS+1]['Run angle']
	            //app.debug('runLower: %s runUpper: %s', runLower, runUpper)
	            performance.runAngle = runLower + ((runUpper - runLower) * twsGapRatio)
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
            }
          }
          // Calculate opposite Tack True
          if (port) {
            let tackTrue = HDG - TargetTWA
            if (tackTrue < 0) {
              tackTrue = tackTrue + (2*Math.PI)
            }
            performance.tackTrue = tackTrue
          } else {
            let tackTrue = HDG + TargetTWA
            if (tackTrue > (2*Math.PI) {
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
        performance.polarSpeedRatio = (1 / performance.polarSpeed) * BSP
      } else {
        // No value would create stale values
        performance.polarSpeed = 0
        performance.polarSpeedRatio = 0
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
          polar = []
          for (let index = 1; index < row.length; index++) {
            
            let twsObj = {'tws': ktsToMs(row[index])} // CSV kts to internal m/s
            polar.push(twsObj)
          }
          app.debug('polar: %s', JSON.stringify(polar))
        } else if (row[0] == '0') {
          app.debug('beat and run angles are included')
        } else if (row.includes('0')) {
          // Beat / Run angle
          let angle = degToRad(Number(row[0]))
          let angleName
          let VMGName
          if (angle < halfPi) {
            angleName = 'Beat angle'
            VMGName = 'Beat VMG'
          } else {
            angleName = 'Run angle'
            VMGName = 'Run VMG'
          }
          for (let index = 0; index < row.length-1; index++) {
            if (row[index+1] != 0) {
              polar[index][angleName] = angle
              let tbs = ktsToMs(Number(row[index+1]))
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
            let tbs = ktsToMs(Number(row[index+1]))
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
      if (typeof polar[0].beatAngle == 'undefined') {
        for (let index = 0; index < polar.length-1; index++) {
          let tws = polar[index].tws
          let beatVMG = 0
          let beatVMGelement = 0
          let runVMG = 0
          let runVMGelement = 0

          let twaArray = polar[index].twa
          for (let element = 0; element < twaArray.length-1; element++) {
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
          app.debug('beatVMG for %d is %d (angel %d)', tws, twaArray[beatVMGelement].vmg, twaArray[beatVMGelement].twa)
          app.debug(' runVMG for %d is %d (angel %d)', tws, twaArray[runVMGelement].vmg, twaArray[runVMGelement].twa)
          polar[index]['Beat angle'] = twaArray[beatVMGelement].twa
          polar[index]['Beat VMG'] = twaArray[beatVMGelement].vmg
          polar[index]['Run angle'] = twaArray[runVMGelement].twa
          polar[index]['Run VMG'] = twaArray[runVMGelement].vmg
        }
        
      }

      // And now fill in some missing ends to avoid doing expensive calculations in the main loop
      for (let index = 0; index < polar.length-1; index++) {
        // Sorted on angle, so first is lowest
        let tws = polar[index].tws
        let twaArray = polar[index].twa
        let lowTBS = twaArray[0].tbs
        let lowTWA = twaArray[0].twa

        app.debug('Padding polar for %s from 0 to first given angle (%d deg, %d kts)', msToKts(tws).toFixed(0), radToDeg(lowTWA), msToKts(lowTBS))
        
        // Now put some extra values at the beginning
        var topArray = []
        for (let angle = 0; angle < lowTWA; angle = angle + degToRad(5)) {
          let tbs = (angle / lowTWA) * Math.pow(Math.cos((-1*lowTWA + angle)*3),3) * lowTBS
          let Obj = {'twa': angle, 'tbs': tbs}
          topArray.push(Obj)
        }
        // app.debug('Adding values: %s', JSON.stringify(topArray))
        polar[index].twa = topArray.concat(twaArray)
      }

      for (let index = 0; index < polar.length-1; index++) {
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
  value = Number(value.toFixed(3))
  return value
}
