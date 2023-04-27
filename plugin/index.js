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
    var STW, TWA, TWS, port // Angles in rad, speed in m/s
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
	        STW = delta.value * 1.94384
	        // app.debug('speedThroughWater (STW): %d', STW)
	      } else if (delta.path == 'environment.wind.speedTrue') {
	        TWS = delta.value * 1.94384
	        // app.debug('environment.wind.speedTrue (TWS): %d', TWS)
          sendUpdates(getPerformanceData(TWS, TWA))
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
      app.debug('sendUpdates: %s', JSON.stringify(perfObj))
      if (typeof perfObj.beatAngle != 'undefined') {
        values.push({path: 'performance.beatAngle', value: Number(perfObj.beatAngle.toFixed(4))})
      }
      if (typeof perfObj.beatVMG != 'undefined') {
        values.push({path: 'performance.beatAngleVelocityMadeGood', value: Number(perfObj.beatVMG.toFixed(4))})
      }
      if (typeof perfObj.runAngle != 'undefined') {
        values.push({path: 'performance.gybeAngle', value: Number(perfObj.runAngle.toFixed(4))})
      }
      if (typeof perfObj.runVMG != 'undefined') {
        values.push({path: 'performance.gybeAngleVelocityMadeGood', value: Number(perfObj.runVMG.toFixed(4))})
      }
      if (typeof perfObj.optimalWindAngle != 'undefined') {
        values.push({path: 'performance.optimalWindAngle', value: Number(perfObj.optimalWindAngle.toFixed(4))})
        metas.push({path: 'performance.optimalWindAngle', value: {"units": "rad"}})
      }

      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values,
            meta: metas
          }
        ]
      })
    }

    function getPerformanceData (TWS, TWA) {
      var performance = {}
      // Use windspeed to find nearest speeds
      for (let index = 0 ; index < Object.keys(polar.tws).length; index++) {
        let lower = Number(Object.keys(polar.tws)[index])
        let upper = Number(Object.keys(polar.tws)[index+1])
        if (TWS >= lower && TWS <= upper) {
          // app.debug('TWS between %d and %d', lower, upper)
          // Calculate gap ratio
          let gap = upper - lower
          let gapRatio = (1 / gap) * (TWS - lower)
          // app.debug('gapRatio: %d', gapRatio)
          // Calculate beat/run angle
          if (TWA < halfPi) {
            // Calculate beat angle
            let beatLower = Object.values(polar.tws)[index]['Beat angle']
            let beatUpper = Object.values(polar.tws)[index+1]['Beat angle']
            performance.beatAngle = beatLower + ((beatUpper - beatLower) * gapRatio)
            // Calculate optimal wind angle
            performance.optimalWindAngle = performance.beatAngle - TWA * port
            // Calculate beat VMG
            let VMGLower = Object.values(polar.tws)[index]['Beat VMG']
            let VMGUpper = Object.values(polar.tws)[index+1]['Beat VMG']
            performance.beatVMG = VMGLower + ((VMGUpper - VMGLower) * gapRatio)
          } else {
            // Calculate run angle
            let runLower = Object.values(polar.tws)[index]['Run angle']
            let runUpper = Object.values(polar.tws)[index+1]['Run angle']
            // app.debug('runLower: %s runUpper: %s', runLower, runUpper)
            performance.runAngle = runLower + ((runUpper - runLower) * gapRatio)
            // Calculate optimal wind angle
            performance.optimalWindAngle = performance.runAngle - TWA * port
            // Calculate run VMG
            let VMGLower = Object.values(polar.tws)[index]['Run VMG']
            let VMGUpper = Object.values(polar.tws)[index+1]['Run VMG']
            performance.runVMG = VMGLower + ((VMGUpper - VMGLower) * gapRatio)
          }
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

      csvArray.forEach(row => {
        if (row[0] == 'twa/tws') {
          // The row with TWS columns
          // Create empty TWS objects in polar object
          polar = {'tws': {}}
          for (let index = 1; index < row.length; index++) {
            polar.tws[row[index]] = {}
          }
        } else if (row[0] == '0') {
          app.debug('beat and run angles are included')
          polar.beat = true
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
              polar.tws[Object.keys(polar.tws)[index-1]][angleName] = degToRad(angle)
              polar.tws[Object.keys(polar.tws)[index-1]][VMGName] = Number(Number((row[index]) * Math.abs(Math.cos(angle))).toFixed(2))
              if (typeof polar.tws[Object.keys(polar.tws)[index-1]].twa == 'undefined') {
                polar.tws[Object.keys(polar.tws)[index-1]].twa = {}
              }
              polar.tws[Object.keys(polar.tws)[index-1]].twa[degToRad(angle)] = Number(row[index])
            }
          }
        } else {
          // Normal line
          let angle = degToRad(Number(row[0]))
          for (let index = 1; index < row.length; index++) {
            if (typeof polar.tws[Object.keys(polar.tws)[index-1]].twa == 'undefined') {
              polar.tws[Object.keys(polar.tws)[index-1]].twa = {}
            }
            polar.tws[Object.keys(polar.tws)[index-1]].twa[degToRad(angle)] = Number(row[index])
          }
        }
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
  return knots * 1.94384
}

function MsToKts(ms) {
  return ms / 1.94384
}
