# TODO

## Feature: file-based polar table management — DONE

- [x] `plugin/PolarTable.js` — copied from signalKutilities; project now owns it
- [x] `plugin/PolarFileStore.js` — list, load, save, copy, delete, importFromORC, fetchOrcIndex (static async)
- [x] Schema: `csvTable` removed, `activePolar` added
- [x] Startup: `PolarFileStore(app.getDataDirPath())`, `store.load(activePolar)`, graceful fallback
- [x] `GET /polars`, `GET /polars/:name`, `POST /polars/:name`, `DELETE /polars/:name`
- [x] `PUT /polars/active/:name` — hot-swaps polar without restart
- [x] `GET /polars/import/search?q=` — fetches & caches ORC index, returns filtered list
- [x] `POST /polars/import/:sailnumber` — imports ORC vpp → JSON file

## Refactor: adopt PolarTable class — DONE

- [x] `csvToPolarObject()` replaced with `new PolarTable().loadFromJieter()`
- [x] Bilinear interpolation replaced with `PolarTable` getters
- [x] `perfAdjust` applied at query time (not parse time)
- [x] Above-range TWS: clamps to last entry
- [x] `getChartData()` and `/chartData` endpoint removed (legacy Chart.js, replaced by polar-canvas.js)

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

## Feature: ORC JSON storage format — DONE

- [x] `PolarTable.loadFromOrcVpp(vpp)` — direct loader, no CSV roundtrip
- [x] `PolarFileStore.importFromORC()` — stores `{sailnumber, name, boat, vpp}` as `.json` (no CSV conversion)
- [x] `PolarFileStore.load()` — tries `.json` (loadFromOrcVpp) first, falls back to `.csv` (loadFromJieter)
- [x] `PolarFileStore.list()` — returns both `.json` and `.csv` polars
- [x] `PolarFileStore.readMeta()` — reads metadata from JSON object or CSV `# polar:` comment
- [x] `PolarFileStore.delete()` / `copy()` — dual-format aware
- [x] `GET /polars/:name` — serves `application/json` for JSON polars, `text/plain` for CSV

## Feature: global ORC search via dakk fork — DONE

- [x] `ORC_PROVIDER = 'dakk'` constant — change to `'jieter'` to revert to AUS-only index
- [x] `fetchOrcIndex()` — fetches compact `index.json` (global, `[[sailnumber, name, type]]` format)
- [x] `fetchBoat(sailnumber)` — fetches full VPP from `data/<sailnumber>.json`
- [x] Search route uses flat `b.type` (no longer `b.boat?.type` from full ORC objects)
- [x] Import route calls `fetchBoat()` directly — no longer needs full VPP in index
- [x] Results sorted: name matches first, then sailnumber, then type

## Feature: polar extrapolation — DONE

- [x] Beat zone: quadratic ramp from 25° (pinch angle, zero speed) to beat angle (C1 continuous)
- [x] Run zone: cosine-VMG model past run angle, limited to 30% of gap to 180°
- [x] `getInterpolationState()` returns `'extrapolated'` for deep-downwind region
- [x] Webapp shows warning when sailing beyond run angle

## Feature: /status endpoint — DONE

- [x] Returns raw inputs, smoothed inputs, all enabled output paths, and polar state
- [x] Webapp uses `/status` instead of SK REST API calls — consistent data source
- [x] Stale SK paths nullified when polar deselected, output toggled off, or plugin stopped

## Bugs / Code quality

- [x] `registerWithRouter` defined outside `start()` — runs once at plugin load
- [x] Schema and uiSchema emptied — all configuration via webapp
- [x] Legacy files removed: `Chart.min.js`, `jquery-3.7.1-min.js`, `polar-analysis.html`
- [x] ORC import VMG→BSP bug fixed (`importFromORC` was storing VMG as BSP)
- [x] Raw input values in `/status` fixed (`magnitudeHandler.value` not `handlerMagnitude._value`)
- [x] Output key mismatch fixed (dot-notation keys converted to slash-notation for webapp)
- [ ] `getBoatSpeed` at 180° (dead downwind) — pre-existing test failure, not yet fixed

## Refactoring / Standards compliance

- [x] `engines.node: ">=20"` in `package.json`
- [x] `prepublishOnly: "npm test"` in `package.json`
- [x] `useTWSsource` and `useSOGsource` removed from schema and cleaned up by v0→v1 migration
- [x] Minimum Signal K server version set: `engines["signalk-server"]: ">=2.28.0"`
- [x] `.github/workflows/signalk-ci.yml` CI workflow present
- [ ] Add `.github/dependabot.yml`
- [ ] Long-term: ORC database integration via `https://orc.org/sailors/active-certificates-database`

## Webapp — DONE

### Pages (current)

| Page | Key | Content |
|---|---|---|
| Overview | `overview` | 360° polar canvas + live performance numbers + beat/run targets |
| Inputs | `inputs` | Smoother settings, raw + smoothed TWS/TWA/BSP/HDG, warnings |
| Polar | `settings` | Active polar selector, perf adjust, boat metadata, polar canvas |
| Outputs | `outputs` | Per-output toggles with live values |
| Polar management | `polars` | Stored polars list, CSV paste upload, ORC search + direct import |

### Entry points

| URL | File | Use case |
|---|---|---|
| `/{pluginId}/` | `index.html` + `app.js` | Configuration and inspection |
| `/{pluginId}/plotter.html` | `plotter.html` | Minimal 360° polar display for MFD/kiosk |


### Cross-cutting
- [x] `PUT /settings` already exists; wire `app.savePluginOptions(settings)` inside it
- [x] `perfAdjust` applied at query time — no reload needed
- [x] `useSOG`, `tackTrue` changes need to re-subscribe (restart the relevant SmoothedHandler)

## Feature: settings versioning and migration — DONE

- [x] `settingsVersion` integer field in `DEFAULT_SETTINGS` (default `1`); schema is empty, versioning handled in code
- [x] `migrateSettings(settings)` helper called in `start()` — detects version 0, applies upgrade, saves result
- [x] Migration step `0 → 1` — renames `dampingTWA/TWS/BSP` → `smootherParamExponential`, removes `useTWSsource`/`useSOGsource`, migrates embedded `csvTable` to a file
- [x] Unit tests for `migrateSettings` in `test/migration.test.js` — 7 tests, all passing

## Testing — DONE

- [x] Real test suite using `node:test` — `PolarTable.test.js`, `PolarFileStore.test.js`, `migration.test.js`, `lifecycle.test.js`
- [x] Lifecycle covered: `start() → stop() → start()` with empty config — 7 tests in `lifecycle.test.js`, all passing

## Features (from README to-do)

- [ ] Improved interpolation (currently simple bilinear)

## Nice to have

- [ ] **Rich polar (ORC Speed Guide import)** — ORC Speed Guide HTML files contain a full per-(TWS,TWA) table with heel angle, reef factor, and flatten factor in addition to BSP/VMG. A `RichPolarTable` class could load this data (parsed once from the boat's `speed guide.html`) and interpolate target values at the live (TWS, TWA). New SK paths: `performance/targetHeel` (°), `performance/sailTrim/reef` (0–1), `performance/sailTrim/flat` (0–1). Design: separate optional file alongside the BSP polar (Option A — keep `PolarTable` unchanged); new `activeRichPolar` setting (empty = disabled). Import tool needed to convert the HTML to a JSON grid.
- [ ] **Polar creation based on observations**
Create your own polar based on real world observations. 
- [ ] **Import polar data directly from ORC** Importing data from jieter adds a dependency. It would be better to import directly from the source, being the ORC website or its database.
