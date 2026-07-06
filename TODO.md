# TODO

## Feature: file-based polar table management — DONE

- [x] `plugin/PolarTable.js` — copied from signalKutilities; project now owns it
- [x] `plugin/PolarFileStore.js` — list, load, save, copy, delete, importFromORC, fetchOrcIndex (static async)
- [x] Schema: `csvTable` removed, `activePolar` added
- [x] Startup: `PolarFileStore(app.getDataDirPath())`, `store.load(activePolar)`, graceful fallback
- [x] `GET /polars`, `GET /polars/:name`, `POST /polars/:name`, `DELETE /polars/:name`
- [x] `PUT /polars/active/:name` — hot-swaps polar without restart
- [x] `GET /polars/import/search?q=` — fetches & caches ORC index, returns filtered list
- [x] `POST /polars/import/:sailnumber` — imports ORC vpp → Jieter CSV

## Refactor: adopt PolarTable class — DONE

- [x] `csvToPolarObject()` replaced with `new PolarTable().loadFromJieter()`
- [x] Bilinear interpolation replaced with `PolarTable` getters
- [x] `perfAdjust` applied at query time (not parse time)
- [x] Above-range TWS: clamps to last entry
- [x] `getChartData()` kept in `index.js`

## Refactor: adopt signalkutilities — DONE

- [x] `signalkutilities` in `package.json` dependencies
- [x] `createSmoothedPolar` for TWS+TWA wind vector (no ±π wraparound)
- [x] `createSmoothedHandler` for BSP/STW and SOG
- [x] `SmoothedAngle` for HDG (conditional on `tackTrue`)
- [x] Single smoother config: `smootherType` + per-type param; same class/options for all handlers
- [x] Legacy `dampingTWA/TWS/BSP` migrated to `smootherParamExponential` (v0→v1 migration)
- [x] `excludeSelf: true` default via signalkutilities — no feedback loops
- [x] `stop()` uses `.terminate()` on each handler

## Feature: runtime configuration — DONE

- [x] `GET /settings` — returns live settings merged with pending staged changes
- [x] `PUT /settings` — stages and immediately applies changes (smoother params, activePolar, useSOG, tackTrue)

## Bugs / Code quality

- [x] `registerWithRouter` defined outside `start()` — runs once at plugin load
- [x] `type: 'object'` wrapper present on root schema
- [x] `timers` dead code removed; `stop()` uses `.terminate()`
- [x] `excludeSelf: true` via signalkutilities
- [ ] Remove duplicate `showError()` in `public/index.html` (line 225 and line 406 — lower definition replaces the chart container)

## Refactoring / Standards compliance

- [x] `engines.node: ">=20"` in `package.json`
- [x] `prepublishOnly: "npm test"` in `package.json`
- [x] `useTWSsource` and `useSOGsource` removed from schema and cleaned up by v0→v1 migration
- [ ] Upgrade or replace Chart.js 2.x (EOL) — relies on internal `_model` property for label placement
- [ ] Set minimum Signal K server version in `package.json` / README (`signalk.requires`)
- [ ] Add `.github/workflows/signalk-ci.yml` CI workflow
- [ ] Add `.github/dependabot.yml`

## Webapp

### Entry points and use cases

Two separate entry points serve different use cases:

| URL | File | Use case |
|---|---|---|
| `/{pluginId}/` | `index.html` + `app.js` | **Configuration and inspection** — full-featured desktop UI for configuring the plugin, inspecting live data, managing polars. Intended for use on a laptop/computer. |
| `/{pluginId}/plotter.html` | `plotter.html` | **Plotter display** — minimal, distraction-free 360° polar canvas. No sidebar, no controls. Intended for embedding in an MFD/chartplotter or kiosk display. Keep as-is. |

`polar-canvas.js` is shared by both entry points.

### index.html design

Five-page single-page app. All pages share one `app.js` module; no build step.

### Page: Polar
- Single card, matches advancedwind layout: canvas left (~60%), live numbers right (~40%)
- 360° canvas polar diagram (reuse `PolarCanvas` from `polar-canvas.js`)
- Live performance numbers on the right: TWS, TWA, BSP, target speed, performance %
- Beat and run targets (TWA + VMG)

### Page: Inputs
- Live SK source values: TWS, TWA, BSP/STW (or SOG), HDG — update every second
- Stale row styling (`tr.stale`) when data has not updated
- Warnings list (text-danger) for paths not subscribed / path not found / waiting for first data

### Page: Outputs
- Toggle switches for each output path the plugin emits (beatAngle, beatVMG, targetTWA, VMG, optimumWindAngle, maxSpeed, tackTrue)
- Changes call `PUT /settings` immediately

### Page: Settings
- Smoother type selector (None / Exponential / MovingAverage / Kalman) + parameter field
- Performance adjust slider/input
- Active polar selector (dropdown of loaded polars)
- useSOG toggle
- All changes call `PUT /settings`; persisted via `app.savePluginOptions(settings)` so they survive restart

### Page: Polars
- List of stored polar files with active indicator
- Upload CSV button
- ORC search box → result list → import button per result
- Delete button per polar

### Cross-cutting
- [ ] `PUT /settings` already exists; wire `app.savePluginOptions(settings)` inside it
- [ ] `perfAdjust` applied at query time — no reload needed
- [ ] `useSOG`, `tackTrue` changes need to re-subscribe (restart the relevant SmoothedHandler)

## Feature: settings versioning and migration

- [ ] Add a `settingsVersion` integer field to `plugin.schema` (default `1`, hidden from the user via `uiSchema`)
- [ ] On `start()`, after loading settings, call a `migrateSettings(settings)` helper that:
  - Checks `settings.settingsVersion` (treat `undefined` as version `0`)
  - Applies each migration step in sequence until the current version is reached
  - Returns the upgraded settings object (mutates in place is fine)
  - Saves the result back via `app.savePluginOptions()` so the migration only runs once
- [ ] Implement migration step `0 → 1`: rename legacy `dampingTWA` / `dampingTWS` / `dampingBSP` fields to the new single-smoother schema; remove `useTWSsource` / `useSOGsource`; set `settingsVersion: 1`
- [ ] Write a unit test for `migrateSettings` covering each version step

## Testing

- [ ] Replace stub `npm test` with a real test suite (node:test)
- [ ] Add lifecycle test: `start() → stop() → start()` with empty config

## Features (from README to-do)

- [ ] Improved interpolation (currently simple bilinear)
- [ ] Make calculation trigger smarter / configurable (currently fires on every TWS update)
- [ ] API endpoint to inspect parsed polar as JSON *(already exists as `/polar` — validate or document it)*
- [ ] Live polar creation from recorded data
  - [ ] Save new record speed per angle to file
  - [ ] Determine if vessel is on a steady course before recording
  - [ ] Configurable polar resolution
- [ ] Support multiple polar diagrams (e.g. per sail plan)
- [ ] Capture heel angle in polar diagram

## Nice to have

- [ ] **Rich polar (ORC Speed Guide import)** — ORC Speed Guide HTML files contain a full per-(TWS,TWA) table with heel angle, reef factor, and flatten factor in addition to BSP/VMG. A `RichPolarTable` class could load this data (parsed once from the boat's `speed guide.html`) and interpolate target values at the live (TWS, TWA). New SK paths: `performance/targetHeel` (°), `performance/sailTrim/reef` (0–1), `performance/sailTrim/flat` (0–1). Design: separate optional file alongside the BSP polar (Option A — keep `PolarTable` unchanged); new `activeRichPolar` setting (empty = disabled). Import tool needed to convert the HTML to a JSON grid.
