# Polar Performance — Signal K Plugin

Polar Performance reads your boat's true wind speed, true wind angle, and boat speed from Signal K, looks up the corresponding target values from your polar diagram, and publishes performance metrics — beat angle, run angle, VMG, polar speed ratio, and others — back to the Signal K bus in real time. An integrated webapp lets you inspect the live values, manage polars, and configure the plugin while it is running.

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
2. Go to the **Polars** tab and either import a polar from the ORC database or upload your own CSV file.
3. Go to the **Settings** tab and select the polar you just added as the active polar.
4. The **Overview** tab now shows live performance numbers and a polar diagram.
5. Enable the outputs you want in the **Outputs** tab.

---

## The webapp

The webapp is the primary interface for the plugin. Open it from the Signal K dashboard.

### Overview

A polar diagram on the left and live performance numbers on the right. The diagram shows a live TWS curve interpolated for the current wind speed, and two dots — the polar target speed (what the polar says you should be doing) and your actual boat speed — both at the current TWA. The targets section shows the beat and run angle and VMG interpolated from the polar for the current wind speed. Any data quality warnings appear at the bottom.

### Inputs

Shows the raw instrument values as they arrive from Signal K (before smoothing) and the smoothed values actually used for computation, side by side. Useful for spotting stale sensors or checking whether the smoother settings make sense for your data. Any missing inputs are listed as warnings.

### Outputs

Shows the current value of each output path and lets you enable or disable each group with a toggle. Only enabled outputs are published to the Signal K bus. 

### Settings

Lets you alter the settings of the plugin. Polar selection, performance adjustment, smoother type and parameter, and speed source. The polar diagram of the selected polar is shown.

### Polars

Manage stored polar files, import polars from the ORC database, and upload your own CSV. 
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

### Smoothed inputs

| Path | Description |
|------|-------------|
| `environment.wind.angleTrueWaterDamped` | Smoothed TWA as used internally by the plugin. |
| `performance.boatSpeedDamped` | Smoothed boat speed as used internally by the plugin. |

Useful when you want downstream instruments to use the same smoothed values that drive the performance calculation.

---

## Managing polars

### Importing from ORC

The plugin can search the [ORC sailboat data](https://jieter.github.io/orc-data/site/) database directly. Go to **Polars → Import from ORC**, type part of the boat name, type, or sail number and click Search. When you find your boat, click Import. The polar is saved and immediately available for selection.

An internet connection is required for the initial search. After import the polar is stored locally and no further internet access is needed.

### Uploading a CSV

If you have a polar in Jieter/ORC CSV format (as exported from the ORC site or many routing tools), you can upload it directly. Go to **Polars → Upload CSV**, fill in the file name and optionally the boat name, type, and sail number for display purposes, then browse to the file and click Upload.

The CSV format uses semicolons as separators. The first row is a header with `twa/tws` in the first column followed by wind speeds in knots. Each subsequent row is a TWA in degrees followed by boat speeds in knots. Beat and run angles appear as separate rows with one non-zero speed per row (the VMG for that wind speed column).

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

This is a dark-themed, full-screen canvas display suitable for a chartplotter or secondary monitor. It shows all library curves, the live TWS curve, and the performance dots, and updates in real time.

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

## Canonical polar format

The plugin stores polars as canonical JSON `polarTable` resources. This is the only supported management format for the webapp and the REST API.

Required structure:

- `kind` must be `polarTable`.
- `schemaVersion` is a version string for the canonical resource format.
- `units` currently must be SI only: `tws = m/s`, `twa = rad`, `boatSpeed = m/s`.
- `symmetry.portStarboardSymmetric` currently must be `true`.
- `axes.tws` is a non-empty sorted array of true wind speeds in m/s.
- `axes.twa` is a non-empty sorted array of true wind angles in radians over the range `0..pi`.
- `values.boatSpeedMatrix` is a 2D array of boat speeds in m/s, indexed as `[twsRow][twaColumn]`.
- The number of matrix rows must match `axes.tws.length`.
- Each matrix row length must match `axes.twa.length`.

Optional metadata:

- `name`
- `sailnumber`
- `boatType`
- `year`
- `source`
- `notes`

Optional derived data:

- `derived.rows` can provide precomputed beat/run/max-speed targets for each TWS row.
- Each derived row uses the same TWS unit conventions as the main table.
- `beat` and `run` entries contain `twa`, `tbs`, and `vmg`, all in SI units.

Example:

```json
{
	"kind": "polarTable",
	"schemaVersion": "1.0.0",
	"name": "Example Boat",
	"sailnumber": "EX-1",
	"boatType": "Example 36",
	"year": 2025,
	"source": "custom",
	"notes": "Minimal canonical example",
	"units": {
		"tws": "m/s",
		"twa": "rad",
		"boatSpeed": "m/s"
	},
	"symmetry": {
		"portStarboardSymmetric": true
	},
	"axes": {
		"tws": [3.0864, 5.144],
		"twa": [0.75398, 1.5708, 2.65465]
	},
	"values": {
		"boatSpeedMatrix": [
			[2.5051, 2.65465, 2.23368],
			[3.16888, 3.34861, 2.74799]
		]
	},
	"derived": {
		"rows": [
			{
				"tws": 3.0864,
				"beat": { "twa": 0.75398, "tbs": 2.5051, "vmg": 1.82652 },
				"run": { "twa": 2.65465, "tbs": 2.23368, "vmg": 1.97371 },
				"maxSpeed": 2.65465,
				"maxSpeedAngle": 1.5708
			}
		]
	}
}
```

Notes:

- The resource `id` is not part of the `PUT /polars/:id` body; it comes from the URL path.
- If `derived` is omitted, the plugin can still load and query the polar from the axis and matrix data alone.
- The authoritative machine-readable schema is in `openApi.json` under `PolarResource` and `PolarResourceBody`.

---

## API endpoints

The plugin exposes a REST API under `/plugins/signalk-polar-performance-plugin/`. Authentication follows Signal K server rules — the same session cookie used by the webapp works for direct API calls.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/live` | Current smoothed TWS, TWA, BSP, polar speed, and polar state. |
| `GET` | `/status` | Full snapshot: raw inputs, smoothed inputs, and all enabled output values. |
| `GET` | `/meta` | Display unit metadata for all fields. |
| `GET` | `/settings` | Current plugin settings. |
| `PUT` | `/settings` | Update settings. Body: JSON object with changed keys only. |
| `GET` | `/polars` | List stored canonical polar resources with metadata. |
| `GET` | `/polars/active` | Get the active polar id. |
| `PUT` | `/polars/active` | Set the active polar. Body: JSON `{ id }`. |
| `DELETE` | `/polars/active` | Clear the active polar. |
| `GET` | `/polars/:id` | Get a stored canonical `polarTable` resource. |
| `PUT` | `/polars/:id` | Create or replace a canonical `polarTable` resource. |
| `DELETE` | `/polars/:id` | Delete a stored polar. |
| `GET` | `/polars/:id/meta` | Read stored metadata and TWS range for a polar. |
| `GET` | `/polars/:id/axes/tws` | Array of TWS values (m/s) in a stored polar. |
| `GET` | `/polars/:id/queries/curve?tws=<m/s>&step=<rad>` | Interpolated polar curve for a given TWS, with beat and run markers. |
| `GET` | `/polars/:id/queries/speed?tws=<m/s>&twa=<rad>` | Interpolated boat speed and interpolation state for a single TWS/TWA point. |
| `GET` | `/polars/:id/queries/targets?tws=<m/s>` | Optimal beat and run targets for a given TWS. |
| `GET` | `/polars/:id/queries/performance?tws=<m/s>&twa=<rad>&bsp=<m/s>` | Speed and VMG performance ratios against the polar. |

---

## Known limitations

- Heel angle is not taken into account in the polar lookup. Most ORC polars are upright polars.
- Polar storage is canonical-only. The management API and webapp accept canonical `polarTable` JSON resources, not CSV or ORC imports.


 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Laylines_Target_TWA_to_Active.png)

 - SailSteer screen -> Long press tile to add 'Performance -> Target TWA -> decollapse, choose SignalK'

 ![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Target_TWA_to_SignalK.png)

Now the Target TWA is coming from SignalK and the laylines will be drawn based on it's value.

![](https://raw.githubusercontent.com/htool/signalk-polar-performance-plugin/main/doc/BandG_Sailsteer_with_laylines.png)

### Raymarine
If you have a Raymarine MFD and can tell more about this, please add to the README or tell me.
