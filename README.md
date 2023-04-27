# Polar performance plugin
Generate performance information based on a polar diagram.

## Data correctness
It's assumed data is already corrected when it's read by this plugin. This can be sometimes be done by the sensor, sometimes upon entry into SignalK using the (calibration plugin)[https://www.npmjs.com/package/@signalk/calibration].

## Data sources
The following paths are read
 - navigation.speedThroughWater
 - environment.wind.speedTrue
 - environment.wind.angleTrueWater

## Polar diagram
For starters, use the plugin config to set one polar diagram.
Simple interpolation will be used to get the corresponding values from the polar diagram info.
For polar diagrams you can check (ORC sailboat data)[https://jieter.github.io/orc-data/site/].

## Calculated performance data
The following data is calculated
 - Upwind / beat angle (performance.beatAngle) 
 - Downwind / run / gybe angle (performance.gybeAngle) 
 - Optimal Wind Angle (diff between TWA and environment.wind.directionTrue)
 - Upwind / beat VMG (performance.beatAngleVelocityMadeGood) 
 - Downwind / run / gybe VMG (performance.gybeAngleVelocityMadeGood) 

## To-do list
 - Polar Boat Speed (performance.targetSpeed)
 - Polar Performance (ratio polar boat speed and boat speed)
 - Target TWA (performance.targetAngle)
 - Fill up the ends of the polar diagram
 - A switch to use SOG as boat speed
 - Wind angle for maximum speed at this wind speed
 - Improved interpolation
 - Make moment to do calculation smarter/configurable
 - Create polar from live data
 -- Save polar info to file
 -- Save new record speed for angle in polar
 -- Determine if we're on a steady course to avoid fake records
 -- Dampening algoritms
 -- Configure the resolution of the polar diagram
 - Capture heel in polar diagram
 - Visualisation of the polar diagram
