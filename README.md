# Polar Performance — Signal K Plugin

Polar Performance reads your boat's true wind speed, true wind angle, and boat speed from Signal K, looks up the corresponding target values from your polar diagram, and publishes performance metrics — beat angle, run angle, VMG, polar speed ratio, and others — back to the Signal K bus in real time. An integrated webapp lets you inspect the live values, manage polars, and configure the plugin while it is running.

Current runtime behaviour is also more explicit: when a polar lookup cannot be completed or a required input has no usable value, the plugin writes `null` for the affected output paths and the `/live` and `/status` endpoints expose that state clearly. Idle input recovery is enabled for all live subscriptions, so temporary silence is handled without leaving the plugin in a stale state.

---

## Installation

Install from the Signal K App Store, or manually:

```sh
cd ~/.signalk
npm install signalk-polar-performance-plugin
```

Then restart Signal K and enable the plugin in **Server → Plugin Config → Polar Performance**.

---

## Quick start

1. Open the webapp from **Webapps → Polar Performance**.
2. Go to the **Polars** tab and either import a polar from the ORC database or import a text polar.
3. Go to the **Settings** tab and select the polar you just added as the active polar.
4. The **Overview** tab now shows live performance numbers and a polar diagram.
5. Enable the outputs you want in the **Outputs** tab.

---

## The webapp

The webapp is the primary interface for the plugin. Open it from the Signal K dashboard.

### Overview

A polar diagram on the left and live performance numbers on the right. The diagram shows a live TWS curve interpolated for the current wind speed, and two dots — the polar target speed (what the polar says you should be doing) and your actual boat speed — both at the current TWA. The targets section shows the beat and run angle and VMG interpolated from the polar for the current wind speed. Any data quality warnings appear at the bottom.

The webapp also includes a dedicated Navigation page for VMC-related sailing decisions. It displays the live heading-to-VMC curve for the current polar and wind conditions, the current/target/opposite-tack VMC values, and the corresponding target headings. The full-screen plotter provides a Graph mode toggle so you can switch between Performance and Navigation overlays.

For external clients such as KIP or SKIP race steer widgets, the plugin also exposes live curve endpoints that return curve points only, driven by the plugin's current Signal K state:

- `GET /plugins/signalk-polar-performance-plugin/live/curve`
- `GET /plugins/signalk-polar-performance-plugin/live/vmc-curve`

The first returns the current polar curve with beat/run optima. The second returns the current VMC curve with port/starboard optima.

### Inputs

Shows the raw instrument values as they arrive from Signal K (before smoothing) and the smoothed values actually used for computation, side by side. Useful for spotting stale sensors or checking whether the smoother settings make sense for your data. Any missing inputs are listed as warnings.

### Outputs

Shows the current value of each output path and lets you enable or disable each group with a toggle. Only enabled outputs are published to the Signal K bus. 

### Settings

Lets you alter the settings of the plugin. Polar selection, performance adjustment, smoother type and parameter, and speed source. The polar diagram of the selected polar is shown.

### Polars

Manage stored polars, import polars from the ORC database, and import text polars in supported formats.
---

## Configuration

All configuration is done through the webapp. The settings available are:

### Active polar

Select the polar to use for calculations. The polar diagram in the Settings tab updates when you change this. If no polar is selected the plugin runs but publishes nothing; any previously published values are nullified immediately.

### Performance adjustment

A multiplier applied to all polar speeds before they are used. `1.0` means use the polar as-is. `0.90` means the plugin assumes your boat achieves 90 % of the polar values — useful when your polar is optimistic or you are sailing conservatively. The polar diagram in the Settings tab reflects this adjustment. Step size is 0.05.

### Smoother

Input smoothing prevents noisy instrument data from producing erratic outputs. The available smoothers are:

| Type | Parameter | Best for |
|------|-----------|----------|
| **Exponential (EMA)** | Time constant τ (seconds) | General use. Smooth but responsive. |
| **Moving average** | Window size (seconds) | Uniform weighting over a fixed time window. |
| **Kalman filter** | Steady-state gain (0–1) | Automatically balances noise and responsiveness. |
| **None** | — | When your instruments already filter their output. |

All three input channels — true wind speed, true wind angle, and boat speed — use the same smoother type and parameter. 

### Speed source

Choose between **speed through water** (`navigation.speedThroughWater`) and **speed over ground** (`navigation.speedOverGround`). Use SOG when a working paddlewheel is not available, but be aware that SOG includes current — this makes boat speed appear higher or lower depending on the tidal state.

### Navigation / VMC outputs

Enable the `vmcNavigation` output group to publish VMC-related navigation values. These calculations use the active polar together with the current course and current estimate from Signal K, and they are suppressed when no usable course bearing is available. The Navigation page and the plotter's Navigation mode use these outputs directly.

---

## Outputs

Enable each group in the **Outputs** tab. 

### Beat and run angles

| Path | Description |
|------|-------------|
| `performance.beatAngle` | Optimal upwind TWA for the current TWS. Negative = port tack. |
| `performance.gybeAngle` | Optimal downwind TWA for the current TWS. Negative = port tack. |

These are the angles at which VMG is maximised, read directly from the polar. Use these as target wind angles for optimal upwind and downwind sailing.

### Beat and run VMG

| Path | Description |
|------|-------------|
| `performance.beatAngleVelocityMadeGood` | Best achievable VMG upwind for the current TWS. |
| `performance.gybeAngleVelocityMadeGood` | Best achievable VMG downwind for the current TWS. |

### Target TWA and VMG

Automatically selects between beat and run depending on whether you are sailing upwind or downwind (TWA < 90° = upwind).

| Path | Description |
|------|-------------|
| `performance.targetAngle` | Target TWA for the current point of sail. Negative = port. |
| `performance.targetVelocityMadeGood` | Target VMG for the current point of sail. |

### Optimum wind angle

| Path | Description |
|------|-------------|
| `performance.optimumWindAngle` | Difference between your current TWA and the optimal angle. Negative = bear away, positive = head up. Zero means you are sailing at the optimal angle. |

### VMG and polar VMG ratio

| Path | Description |
|------|-------------|
| `performance.velocityMadeGood` | Your actual VMG: `boatSpeed × cos(TWA)`. |
| `performance.polarVelocityMadeGood` | Polar target VMG for the current TWS. |
| `performance.polarVelocityMadeGoodRatio` | Actual VMG divided by polar VMG. `1.0` = perfect; `0.85` = 85 % of theoretical optimum. |

### Polar speed and speed ratio

| Path | Description |
|------|-------------|
| `performance.polarSpeed` | The polar target boat speed for the current TWS and TWA. |
| `performance.targetSpeed` | The boat speed you would need at the optimal angle to achieve target VMG. |
| `performance.polarSpeedRatio` | Actual boat speed divided by polar speed. `1.0` = on target; `<1.0` = below target. |

### Maximum speed

| Path | Description |
|------|-------------|
| `performance.maxSpeed` | Maximum polar boat speed achievable at the current TWS. |
| `performance.maxSpeedAngle` | The TWA at which maximum speed is achieved. |

### Opposite tack heading

| Path | Description |
|------|-------------|
| `performance.tackTrue` | True heading on the opposite tack, calculated from the beat angle and current heading. Useful for tactical displays and layline charts. |

Requires `navigation.headingTrue` to be available.

### VMC navigation outputs

| Path | Description |
|------|-------------|
| `performance.velocityMadeGoodOnCourse` | Actual velocity made good on course over ground. |
| `performance.targetVelocityMadeGoodOnCourse` | Best achievable VMC on the current tack. |
| `performance.oppositeTackVelocityMadeGoodOnCourse` | Best achievable VMC on the opposite tack. |
| `performance.velocityMadeGoodOnCourseRatio` | Actual VMC divided by target VMC on the current tack. |
| `performance.targetHeadingTrue` | Target true heading for maximum VMC on the current tack. |
| `performance.oppositeTackHeadingTrue` | Target true heading for maximum VMC on the opposite tack. |

These outputs are published when the VMC navigation output group is enabled. They depend on a valid course bearing and a usable current/ground-speed estimate, and they are used by the Navigation page and Navigation mode in the plotter.

### Smoothed inputs

| Path | Description |
|------|-------------|
| `environment.wind.angleTrueWaterDamped` | Smoothed TWA as used internally by the plugin. |
| `performance.boatSpeedDamped` | Smoothed boat speed as used internally by the plugin. |

Useful when you want downstream instruments to use the same smoothed values that drive the performance calculation.

---

## Managing polars

### Importing from ORC

The plugin can search the official ORC active certificate source directly. Go to **Polars → Import ORC Certificate**, type part of the certificate RefNo, boat name, class, or sail number and click Search. When you find your boat, click Import. The polar is saved locally and immediately available for selection.

Internet access is required only while searching or importing from ORC. In an isolated Signal K installation the ORC source is simply shown as unavailable; that is not treated as a plugin error. After import the polar is stored locally and no further internet access is needed.

### Importing text polars

If you have a polar in a supported text format, you can import it directly from the **Polars** tab. The plugin currently supports Jieter-style semicolon CSV and Expedition-style delimited text. Optional metadata such as display name, sail number, boat type, year, source label, and notes can be added during text import.

The Jieter CSV format uses semicolons as separators. The first row is a header with `twa/tws` in the first column followed by wind speeds in knots. Each subsequent row is a TWA in degrees followed by boat speeds in knots. Beat and run angles appear as separate rows with one non-zero speed per row (the VMG for that wind speed column).

**Example:**
```
twa/tws;6;8;10;12;14;16;20
52;4.57;5.59;6.33;6.87;7.23;7.45;7.65
60;4.93;5.93;6.66;7.15;7.47;7.68;7.94
75;5.17;6.18;6.91;7.37;7.68;7.92;8.31
90;5.29;6.43;7.23;7.71;8.03;8.29;8.57
110;5.38;6.56;7.36;7.84;8.22;8.6;9.31
120;5.2;6.38;7.23;7.76;8.16;8.55;9.36
135;4.65;5.84;6.78;7.43;7.87;8.25;9.03
150;3.92;5.05;5.97;6.7;7.2;7.58;8.17
46.9;4.23;0;0;0;0;0;0
44.8;0;5.09;0;0;0;0;0
144.2;4.19;0;0;0;0;0;0
146.4;0;5.25;0;0;0;0;0
```

### Extrapolation

The polar table covers a finite range of TWA values. The plugin extrapolates outside this range in two ways:

- **Close to the wind (beat zone):** A quadratic curve fitted to ensure continuity with the first measured point. The boat speed reaches zero at 25° (the assumed hard pinching angle).
- **Deep downwind (run zone):** A cosine-VMG model extending 30 % of the angular gap between the run angle and dead downwind. Beyond this limit the plugin returns no value rather than extrapolate further.

Values derived from extrapolated regions are indicated in the webapp warnings.

### Performance adjustment

The performance adjustment multiplier scales all polar speeds proportionally. Use it to calibrate the polar to your boat's actual performance. A value of `0.95` tells the plugin your boat achieves 95 % of the published polar — the polar diagram in Settings reflects this visually.

---

## Connecting to plotters and instruments

### B&G / Navico

Install the [B&G Performance Plugin](https://www.npmjs.com/package/signalk-bandg-performance-plugin). Map at minimum:

| Signal K path | B&G label |
|---------------|-----------|
| `performance.polarSpeed` | Polar Speed (POL SPD) |
| `performance.polarSpeedRatio` | Polar Performance (POL PERF) |
| `performance.targetAngle` | Target TWA (TARG TWA) |
| `performance.beatAngle` | Beat Angle |
| `performance.gybeAngle` | Gybe Angle |

For laylines on charts: **Settings → Chart → Laylines → Targets → True wind angle → Actual**.

### Garmin / Raymarine / other NMEA 2000

Use a Signal K → NMEA 2000 gateway plugin (such as `canboat` or `signalk-to-n2k`) to forward paths to the PGN fields your plotter expects for performance data. Consult your plotter's documentation for the relevant PGNs — most support Polar Speed, Target TWA, and VMG.

### OpenCPN / KIP / other Signal K displays

Subscribe directly to the paths listed in the Outputs section above. 

### Full-screen polar plotter

The plugin includes a separate full-screen polar plotter page at:

```
http://<your-server>:<port>/signalk-polar-performance-plugin/plotter.html
```

This is a dark-themed, full-screen canvas display suitable for a chartplotter or secondary monitor. It shows all library curves, the live TWS curve, and the performance dots, and updates in real time. The plotter now also has a Graph mode toggle so you can switch between Performance and Navigation views with navigation-aware overlays.

---

## Data quality and warnings

The webapp shows warnings whenever something prevents accurate calculation:

| Warning | Cause |
|---------|-------|
| *True wind speed — no data* | `environment.wind.speedTrue` is not arriving from Signal K.  |
| *True wind angle — no data* | `environment.wind.angleTrueWater` is not arriving.  |
| *Boat speed — no data* | `navigation.speedThroughWater` (or SOG) is not arriving.  |
| *No polar loaded* | No active polar is configured. Select a polar from the settings tab. Or go to the Polars tab and store a canonical polar resource first. |
| *Sailing in irons* | TWA is below the minimum angle in the polar. No output is produced. |
| *Pinching* | TWA is between the minimum polar angle and the beat angle. Values come from the extrapolated beat zone. |
| *Extrapolated beyond run angle* | TWA is deeper than the run angle. Values come from the cosine-VMG extrapolation model. |
| *Wind speed below/above polar range* | TWS is outside the range covered by the polar. Values are extrapolated from the nearest TWS entry. |

---

## Input data quality

Performance calculations are only as good as the inputs. A few things are worth checking before relying on the output:

- **True wind** must already be correctly calculated. If your setup uses a basic instrument or the Signal K Derived Data plugin, check that the calculation is using the right boat speed source and that heading is calibrated. The [Advanced Wind plugin](https://github.com/htool/advancedWind) provides additional corrections for sensor mounting angle, heel, mast movement, and upwash if your true wind data quality is poor.
- **Boat speed calibration** has a direct effect on polar ratio calculations. A 3 % paddlewheel error produces a 3 % offset in `performance.polarSpeedRatio`. The [Speed and Current plugin](https://github.com/htool/speedandcurrent) can automate paddlewheel calibration.
- **Data consistency:** the plugin uses its own internal smoother for all inputs. 

---

## For integrators and API users

If you want to automate polar management or consume the plugin as a canonical polar provider, use the developer reference:

- [Developer reference](docs/developer-reference.md) for the canonical `polarTable` structure and the plugin REST API.
- The live curve endpoints above return curve data only; the Signal K bus remains the source of truth for the live deltas.
- [openApi.json](openApi.json) for the authoritative machine-readable contract.

---

## Known limitations

- Heel angle is not taken into account in the polar lookup. Most ORC polars are upright polars.
- Polar storage is canonical-only. Text and ORC imports are conversion inputs; they are stored internally as canonical `polarTable` resources.


 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Laylines_Target_TWA_to_Active.png)

 - SailSteer screen -> Long press tile to add 'Performance -> Target TWA -> decollapse, choose SignalK'

 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Target_TWA_to_SignalK.png)

Now the Target TWA is coming from SignalK and the laylines will be drawn based on it's value.

![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Sailsteer_with_laylines.png)

### Raymarine
If you have a Raymarine MFD and can tell more about this, please add to the README or tell me.
