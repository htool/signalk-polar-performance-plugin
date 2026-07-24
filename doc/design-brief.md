# Polar Performance Plugin — Design Brief

## Overview

`signalk-polar-performance-plugin` (npm v0.0.60) is a Signal K server plugin that computes sailing performance metrics by comparing the vessel's actual speed against theoretical targets derived from a boat-specific **polar diagram**. The polar is supplied by the user as a semicolon-delimited CSV (ORC sailboat data format).

A bundled **webapp** (`/signalk-polar-performance-plugin/`) visualises the polar curves and plots the real-time boat speed and polar target speed as live dots on the chart.

---

## Repository Layout

```
plugin/index.js        — single-file plugin (no build step)
public/index.html      — single-file webapp (Chart.js 2.x + jQuery, no build step)
public/Chart.min.js    — bundled Chart.js 2.x (offline-safe)
public/jquery-3.7.1-min.js
doc/                   — screenshots / this brief
README.md
package.json
```

---

## Plugin Backend (`plugin/index.js`)

### Signal K paths consumed

| Path | Condition |
|------|-----------|
| `navigation.speedThroughWater` | always (unless `useSOG`) |
| `navigation.speedOverGround` | when `useSOG = true` |
| `environment.wind.speedTrue` | always |
| `environment.wind.angleTrueWater` | always |
| `navigation.headingTrue` | when `tackTrue = true` |

Source filtering is available for TWS (`useTWSsource`) and SOG (`useSOGsource`) via name.id strings.

### Signal K paths produced

| Path | Units | Notes |
|------|-------|-------|
| `performance.boatSpeedDamped` | m/s | STW or SOG after damping |
| `environment.wind.angleTrueWaterDamped` | rad | TWA after damping, negative to port |
| `performance.polarSpeed` | m/s | Interpolated polar target speed for current TWS+TWA |
| `performance.polarSpeedRatio` | ratio | BSP / polarSpeed |
| `performance.velocityMadeGood` | m/s | Actual VMG |
| `performance.polarVelocityMadeGood` | m/s | Polar VMG at current TWS+TWA |
| `performance.polarVelocityMadeGoodRatio` | ratio | VMG / polarVMG |
| `performance.beatAngle` | rad | Optimal upwind angle for TWS, negative to port |
| `performance.gybeAngle` | rad | Optimal downwind angle for TWS, negative to port |
| `performance.beatAngleVelocityMadeGood` | m/s | VMG at beat angle |
| `performance.gybeAngleVelocityMadeGoodRatio` | m/s | VMG at gybe/run angle |
| `performance.targetAngle` | rad | Auto-switching beat or run angle |
| `performance.targetVelocityMadeGood` | m/s | VMG at target angle |
| `performance.targetSpeed` | m/s | Target boat speed at targetAngle |
| `performance.optimumWindAngle` | rad | Diff between TWA and beat/run angle |
| `performance.maxSpeed` | m/s | Fastest point on polar for TWS |
| `performance.maxSpeedAngle` | rad | Angle for max speed, negative to port |
| `performance.tackTrue` | rad | Opposite-tack heading relative to True North |

Most paths are gated behind config flags (see Configuration section).  
Metadata (`units`, `description`) is emitted once on first update.

### HTTP endpoints (via `registerWithRouter`)

| Endpoint | Returns |
|----------|---------|
| `GET /plugins/signalk-polar-performance-plugin/polar` | Raw parsed polar object (JSON) |
| `GET /plugins/signalk-polar-performance-plugin/chartData` | Chart.js-ready dataset for the polar curves |

`/chartData` returns HTTP 500 with a structured error if polar CSV is empty or invalid.

---

## Polar Data Processing

### Input format

Semicolon-delimited CSV, first column = TWA (degrees), first row = `twa/tws` header with TWS values (knots).

Beat/run rows are identified by having **more than one `0`** in the data columns; these define the optimal beat and run angles plus their VMG directly from the ORC data.

### Processing pipeline (`csvToPolarObject`)

1. Parse CSV into array-of-arrays.
2. Build internal structure: `polar[]` keyed by TWS index, each entry has `tws` (m/s), `twa[]` ({twa, tbs, vmg} in SI units), plus `Beat angle`, `Beat VMG`, `Run angle`, `Run VMG`, `Max speed`, `Max speed angle`.
3. If beat/run angles are **not** in the CSV, derive them by finding max-VMG point in the upwind/downwind halves of `twa[]`.
4. **Prepend zero wind speed row** (tws=0.0001) to allow interpolation at very low speeds.
5. **Pad head of each TWS curve** from 0° to the lowest recorded angle using a cosine-tapering formula.
6. **Pad tail** from the highest recorded angle to 180° with inverse-square decay.
7. Sort `twa[]` by angle.
8. Apply `perfAdjust` ratio to all boat speeds at parse time.

### Runtime interpolation (`getPerformanceData`)

Bilinear interpolation: find the TWS bracket, compute `twsGapRatio`, then find the TWA bracket within each TWS level and interpolate `tbs`. Beat/run angles and VMG are linearly interpolated between TWS levels.

---

## Configuration Schema

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `useTWSsource` | string | `''` | Filter TWS updates to this source name.id |
| `useSOG` | boolean | — | Use SOG instead of STW |
| `useSOGsource` | string | `''` | Filter SOG updates to this source name.id |
| `beatAngle` | boolean | — | Emit beat/gybe angles |
| `beatVMG` | boolean | — | Emit beat/gybe VMG |
| `targetTWA` | boolean | — | Emit `performance.targetAngle` / `targetVMG` |
| `tackTrue` | boolean | — | Emit opposite-tack heading |
| `optimumWindAngle` | boolean | — | Emit optimum wind angle |
| `VMG` | boolean | — | Emit actual + polar VMG and ratio |
| `maxSpeed` | boolean | — | Emit max speed and angle |
| `perfAdjust` | number | `1` | Scales all polar boat speeds (e.g. 0.9 = 90%) |
| `dampingTWA` | number | `1` | RC time constant (seconds) for TWA |
| `dampingTWS` | number | `1` | RC time constant (seconds) for TWS |
| `dampingBSP` | number | `1` | RC time constant (seconds) for boat speed |
| `csvTable` | string | — | Full polar CSV (textarea in Admin UI) |

### Damping

An RC low-pass filter: `Yn = (1-a)·Yn-1 + a·Xn` where `a = dt / (RC + dt)`. Handles the `±π` wraparound for TWA. Set `dampingXxx = 0` for raw pass-through.

---

## Webapp (`public/index.html`)

### Stack

- **Chart.js 2.x** (scatter chart, bundled)
- **jQuery 3.7.1** (bundled)
- Plain ES5 — no module bundler, no TypeScript, no framework

### Data flow

1. On load: `$.getJSON('/plugins/.../chartData')` → static polar curves drawn once.
2. WebSocket to `/signalk/v1/stream` subscribes to:
   - `environment.wind.angleTrueWaterDamped`
   - `performance.polarSpeed`
   - `performance.boatSpeedDamped`
   - `environment.wind.speedTrue`
3. `setInterval(updateChart, 300ms)` — redraws chart at ~3 Hz.
4. Two foreground dots (dataset[0] = Polar Speed, dataset[1] = Boat Speed) are prepended to the chart data and updated in real time.
5. `interpolateColors(TWS)` highlights the curve(s) nearest to current TWS by blending toward white (influence range ±2.5 kts).
6. A custom Chart.js plugin draws TWS-keyed speed labels at a user-configurable TWA position (default 135°, persisted in `localStorage`).
7. 20-second timeout detects and displays missing data paths.
8. Reconnect logic on WebSocket close/error (500 ms retry).

### Error handling

Two error display functions exist (inconsistency — one replaces the entire container, the other uses a banner div). Both show a "Reload" button.

---

## Known Gaps / To-Do (from README + code inspection)

- No test suite (`npm test` is a stub).
- `plugin.registerWithRouter` is defined **inside** `plugin.start()` — non-standard and may cause issues if `start` is called multiple times.
- No `schema.type = 'object'` wrapper — schema missing the root `type` field.
- `timers` array is populated in config but never actually used (`setInterval` result is never pushed).
- Two `showError` functions in the webapp (one at top of `<script>`, one at bottom) — the lower one overrides the first, replacing the entire `.chart-container` content.
- Chart.js 2.x is EOL; uses legacy `_model` internal property for label positioning.
- No `excludeSelf: true` on subscriptions (plugin writes several paths it also reads — potential feedback loop risk for damped paths).
- README to-do list: improved interpolation, smarter calculation triggers, live polar creation from recorded data, multiple polar support, heel capture in polar.
- `package.json` missing `engines.node`, no `prepublishOnly`, no CI workflow.

---

## Data Flow Diagram

```
Instruments → SK server
                │
    ┌───────────▼───────────────┐
    │  subscriptionmanager      │
    │  STW / SOG / TWS / TWA    │
    │  HDG (optional)           │
    └───────────┬───────────────┘
                │  applyDamping()
                ▼
         getPerformanceData()
          (bilinear interpolation
           on csvToPolarObject output)
                │
    ┌───────────▼────────────────────────┐
    │  app.handleMessage()               │
    │  performance.* paths + metadata    │
    └───────────┬────────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
   MFD / B&G      Webapp (WebSocket)
   (via B&G         polar chart +
    perf plugin)    live dots
```
