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
        title: 'Enable calculation of beat/upwind and run/gybe/downwind angle'
      },
      beatVMG: {
        type: 'boolean',
        title: 'Enable calculation of beat/upwind and run/gybe/downwind VMG'
      },
      optimalWindAngle: {
        type: 'boolean',
        title: 'Enable calculation of Optimal Wind Angle (difference between TWA and beat/run angle (depends on beat/run angle)'
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
    var BSP, STW, TWA, TWS, port // Angles in rad, speed in m/s
    var Pi = Math.PI
    var halfPi = Pi / 2

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
	      } else if (delta.path == 'environment.wind.speedTrue') {
	        TWS = delta.value
	        // app.debug('environment.wind.speedTrue (TWS): %d', TWS)
	        app.debug('TWS: %d TWA: %d BSP: %d', TWS, TWA, BSP)
          sendUpdates(getPerformanceData(TWS, TWA, BSP))
	      } else if (delta.path == 'environment.wind.angleTrueWater') {
          if (delta.value < 0) {
            port = -1
          } else {
            port = 1
          }
	        TWA = Math.abs(delta.value)
	        // app.debug('environment.wind.angleTrueWater (TWA): %d', TWA)
	      }
      })
    }

    function sendUpdates (perfObj) {
      let values = []
      let metas = []
      if (typeof perfObj.beatAngle != 'undefined') {
        values.push({path: 'performance.beatAngle', value: roundDec(perfObj.beatAngle)})
        values.push({path: 'performance.targetAngle', value: roundDec(perfObj.beatAngle)})
      }
      if (typeof perfObj.beatVMG != 'undefined') {
        values.push({path: 'performance.beatAngleVelocityMadeGood', value: roundDec(perfObj.beatVMG)})
      }
      if (typeof perfObj.runAngle != 'undefined') {
        values.push({path: 'performance.gybeAngle', value: roundDec(perfObj.runAngle)})
        values.push({path: 'performance.targetAngle', value: roundDec(perfObj.runAngle)})
      }
      if (typeof perfObj.runVMG != 'undefined') {
        values.push({path: 'performance.gybeAngleVelocityMadeGood', value: roundDec(perfObj.runVMG)})
      }
      if (typeof perfObj.optimalWindAngle != 'undefined') {
        values.push({path: 'performance.optimalWindAngle', value: roundDec(perfObj.optimalWindAngle)})
        metas.push({path: 'performance.optimalWindAngle', value: {"units": "rad"}})
      }
      if (typeof perfObj.targetSpeed != 'undefined') {
        values.push({path: 'performance.targetSpeed', value: roundDec(perfObj.targetSpeed)})
      }
      if (typeof perfObj.polarSpeed != 'undefined') {
        values.push({path: 'performance.polarSpeed', value: roundDec(perfObj.polarSpeed)})
        values.push({path: 'performance.polarSpeedRatio', value: roundDec(perfObj.polarSpeedRatio)})
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
            if (options.beatAngle == true) {
	            // Calculate beat angle
	            let beatLower = polar[indexTWS]['Beat angle']
	            let beatUpper = polar[indexTWS+1]['Beat angle']
	            performance.beatAngle = beatLower + ((beatUpper - beatLower) * twsGapRatio)
            }
	          // Calculate optimal wind angle
	          if (options.optimalWindAngle == true) {
	            performance.optimalWindAngle = performance.beatAngle - TWA * port
	          }
	          // Calculate beat VMG
	          if (options.beatVMG == true) {
	            let VMGLower = polar[indexTWS]['Beat VMG']
	            let VMGUpper = polar[indexTWS+1]['Beat VMG']
	            performance.beatVMG = VMGLower + ((VMGUpper - VMGLower) * twsGapRatio)
            }
	        } else {
            // app.debug('Downwind')
            if (options.beatAngle == true) {
	            // Calculate run angle
	            let runLower = polar[indexTWS]['Run angle']
	            let runUpper = polar[indexTWS+1]['Run angle']
	            //app.debug('runLower: %s runUpper: %s', runLower, runUpper)
	            performance.runAngle = runLower + ((runUpper - runLower) * twsGapRatio)
            }
	          if (options.optimalWindAngle == true) {
	            // Calculate optimal wind angle
	            performance.optimalWindAngle = performance.runAngle - TWA * port
	          }
	          if (options.beatVMG == true) {
	            // Calculate run VMG
	            let VMGLower = polar[indexTWS]['Run VMG']
	            let VMGUpper = polar[indexTWS+1]['Run VMG']
	            //app.debug('VMGLower: %s VMGUpper: %s', VMGLower, VMGUpper)
	            performance.runVMG = VMGLower + ((VMGUpper - VMGLower) * twsGapRatio)
            }
          }
          // Calculate polar target boat speed

          // Define the 4 near data points
          let lowerTWA = polar[indexTWS].twa
          let upperTWA = polar[indexTWS+1].twa
          // app.debug('TWAlower: %s', JSON.stringify(TWAlower))
          for (let indexTWA = 0 ; indexTWA < lowerTWA.length-1; indexTWA++) {
            let lowerTWAlower = lowerTWA[indexTWA]
            let lowerTWAupper = lowerTWA[indexTWA+1]
            let upperTWAlower = upperTWA[indexTWA]
            let upperTWAupper = upperTWA[indexTWA+1]

	          // app.debug('lowerTWAlower: %s lowerTWAupper: %s', lowerTWAlower, lowerTWAupper)
            if (TWA >= lowerTWAlower.twa && TWA <= lowerTWAupper.twa) {
	            // app.debug('lowerTWAlower: %d TWA: %d lowerTWAupper: %d', lowerTWAlower.twa, TWA, lowerTWAupper.twa)
              // Calculate gap ratio
              let gap = lowerTWAupper.twa - lowerTWAlower.twa
              let twaGapRatio = (1 / gap) * (TWA - lowerTWAlower.twa)
	            // app.debug('twaGapRatio: %d', twaGapRatio)
              // Calculate lower tws boat speed
	            let lowerTBS = lowerTWAlower.tbs + ((lowerTWAupper.tbs - lowerTWAlower.tbs) * twaGapRatio)
              // Calculate upper tws boat speed
	            let upperTBS = upperTWAlower.tbs + ((upperTWAupper.tbs - upperTWAlower.tbs) * twaGapRatio)

              // Calculate target boat speed
              performance.polarSpeed = lowerTBS + ((upperTBS - lowerTBS) * twsGapRatio)
	            // app.debug('lowerTBS: %d TBS: %d upperTBS: %d', lowerTBS, performance.polarSpeed, upperTBS)

              // Calculate polar performance
              performance.polarSpeedRatio = (1 / performance.polarSpeed) * BSP

            } 
          }

          // Calculate polar performance ratio
        } else {
          // app.debug('%d not >= %d && <= %d', TWS, lower, upper)
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
          let angle = Number(row[0])
          let angleName
          let VMGName
          if (angle < 90) {
            angleName = 'Beat angle'
            VMGName = 'Beat VMG'
          } else {
            angleName = 'Run angle'
            VMGName = 'Run VMG'
          }
          for (let index = 1; index < row.length; index++) {
            if (row[index] != 0) {
              polar[index-1][angleName] = degToRad(angle)
              polar[index-1][VMGName] = roundDec(Number((row[index]) * Math.abs(Math.cos(angle))))
              app.debug('polar[index-1]: %s', polar[index-1])
              if (typeof polar[index-1]['twa'] == 'undefined') {
                polar[index-1]['twa'] = []
              }
              app.debug('polar[index-1]: %s', polar[index-1])
              app.debug('Adding TargetBoatSpeed')
              let Obj = {"twa": degToRad(angle), "tbs": ktsToMs(Number(row[index]))}
              app.debug('Obj: %s', JSON.stringify(Obj))
              polar[index-1]['twa'] = polar[index-1]['twa'].concat(Obj)
              app.debug('polar[index-1]["twa"]: %s', polar[index-1]['twa'])
              app.debug('polar: %s', JSON.stringify(polar))
            }
          }
        } else {
          // Normal line
          let angle = degToRad(Number(row[0]))  // CSV deg to internal rad
          for (let index = 1; index < row.length; index++) {
            if (typeof polar[index-1].twa == 'undefined') {
              polar[index-1].twa = []
            }
            let Obj = {"twa": angle, "tbs": ktsToMs(Number(row[index]))}
            polar[index-1]['twa'] = polar[index-1]['twa'].concat(Obj)
            app.debug('polar: %s', JSON.stringify(polar))
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

function MsToKts(ms) {
  return ms * 1.94384
}

function roundDec (value) {
  value = Number(value.toFixed(3))
  return value
}
