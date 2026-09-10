# Polar Performance Developer Reference

This document covers the REST API this plugin still exposes. It no longer stores, imports,
or manages polar files — that is handled by a separate 'polars' resource-provider plugin
(e.g. [signalk-polar-management](https://github.com/Asw1n/signalk-polar-management)). For the
canonical `polarTable` format and its management API, see that plugin's documentation and the
[polar-format](https://github.com/Asw1n/polar-format) / [polar-math](https://github.com/Asw1n/polar-math)
packages it depends on.

For installation, day-to-day use, and webapp workflow, start with [../README.md](../README.md).

## How the active polar is resolved

This plugin subscribes to two Signal K paths published by the 'polars' resource provider:

- `polars.activePolar` — `{ href: '/resources/polars/<id>' }`, or absent if no polar is active.
- `polars.performanceFactor` — a number applied as a multiplier to all polar speeds.

On a change to `polars.activePolar`, the plugin resolves `<id>` via the in-process
`app.resourcesApi.getResource('polars', id)` call and builds a `polar-math` `Polar` instance
from the returned canonical document. If the resource provider or the active polar becomes
unavailable, the last successfully loaded polar is kept until a valid update arrives.

## REST API

The plugin exposes a REST API under `/plugins/signalk-polar-performance-plugin/`. Authentication
follows Signal K server rules; the same session cookie used by the webapp works for direct API calls.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/live` | Current smoothed TWS, TWA, BSP, polar speed, and polar state. |
| `GET` | `/status` | Full snapshot: raw inputs, smoothed inputs, and all enabled output values. |
| `GET` | `/meta` | Display unit metadata for all fields, plus a read-only summary of the active polar (name, boatType, sailnumber, year, source) and performance factor. |
| `GET` | `/settings` | Current plugin settings (smoother, output toggles, speed source — no polar selection). |
| `PUT` | `/settings` | Update settings. Body: JSON object with changed keys only. |
| `GET` | `/polar/axes/tws` | TWS axis of the currently active polar. 404 if none is active. |
| `GET` | `/polar/queries/curve?tws=&step=` | Interpolated curve for the active polar at the given TWS, with beat/run markers, performance factor already applied. |

The authoritative machine-readable schema for the two `/polar/*` endpoints is in
[../openApi.json](../openApi.json).
