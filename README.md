# Polar performance plugin
Generate performance information based on a polar diagram.

## Data correctness
It's assumed data is already corrected when it's read by this plugin. This can be sometimes be done by the sensor, sometimes upon entry into SignalK using the [calibration plugin](https://www.npmjs.com/package/@signalk/calibration).

## Data sources
The following paths are read
 - navigation.speedThroughWater
 - environment.wind.speedTrue
 - environment.wind.angleTrueWater
 - navigation.speedOverGround (optional)

## Plugin configuration
### Polar diagram
The polar diagram can be configured through CSV notation as used on [ORC sailboat data](https://jieter.github.io/orc-data/site/).

The resulting polar after processing can be seen here in the WebApp, looking something like:
![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_polar.png)


### Plugin options
In the plugin configuration you can toggle the following options:
 - Enable calculation/sending of beat/upwind and run/gybe/downwind angle
 - Enable calculation/sending of beat/upwind and run/gybe/downwind VMG
 - Enable sending Target TWA
 - Enable calculation of Optimum Wind Angle (difference between TWA and beat/run angle (depends on beat/run angle)
 - Enable sending of maximum speed angle and boat speed for a given TWS
 - Enable calculation of Optimum Wind Angle (difference between TWA and beat/run angle (depends on beat/run angle)

## Calculated performance data
### Currently supported
 - Upwind / beat angle (performance.beatAngle) 
 - Downwind / run / gybe angle (performance.gybeAngle) 
 - Upwind / beat VMG (performance.beatAngleVelocityMadeGood) 
 - Downwind / run / gybe VMG (performance.gybeAngleVelocityMadeGood) 
 - Target TWA (performance.targetAngle) (equals upwind or downwind angle)
 - Optimal Wind Angle (diff between TWA and environment.wind.directionTrue)
 - Polar Boat Speed (performance.polarSpeed)
 - Polar Speed Ratio (performance.polarSpeedRatio)
 - Plugin option to use SOG as boat speed
 - Wind angle for maximum speed at this wind speed
 - Fill up the ends of the polar diagram
 - Visualisation of the polar diagram

### To-do list
 - Improved interpolation
 - Make moment to do calculation smarter/configurable
 - API to see JSON of polar
 - Extrapolation of polar data
 - Create polar from live data
 -- Save polar info to file
 -- Save new record speed for angle in polar
 -- Determine if we're on a steady course to avoid fake records
 -- Dampening algoritms
 -- Configure the resolution of the polar diagram
 - Support multiple polar diagrams
 - Capture heel in polar diagram

## MFD configuration

### B&G
To get the values calculated by this plugin from SignalK to your B&G MFD/Triton2, you need to install the [B&G performance plugin](https://www.npmjs.com/package/signalk-bandg-performance-plugin) and select at least the following values:
 - Polar Speed (Polar Speed - POL SPD)
 - Polar Speed Ratio (Polar Performance - POL PERF))
 - Target TWA (TARG TWA)

To see lay lines you need to set:
 - Settings -> Chart -> Laylines -> Targets... -> True wind angle to 'Actual'

 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Laylines_Target_TWA_to_Active.png)

 - SailSteer screen -> Long press tile to add 'Performance -> Target TWA -> decollapse, choose SignalK'

 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Target_TWA_to_SignalK.png)

Now the Target TWA is coming from SignalK and the laylines will be drawn based on it's value.

![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Sailsteer_with_laylines.png)

### Raymarine
If you have a Raymarine MFD and can tell more about this, please add to the README or tell me.
