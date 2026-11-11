# Polar Performance Developer Reference

This document covers the REST API this plugin still exposes. It no longer stores, imports,
or manages polar files — that is handled by
[signalk-polar-management](https://github.com/Asw1n/signalk-polar-management), which also
provides the in-process polar calculation service this plugin uses. For the canonical
`polarTable` / `polarSet` formats and the management API, see that plugin's documentation
and the [polar-format](https://github.com/Asw1n/polar-format) package; the underlying
calculation engine, [polar-math](https://github.com/Asw1n/polar-math), is a dependency of
the management plugin, not of this one.

For installation, day-to-day use, and webapp workflow, start with [../README.md](../README.md).

## How the active polar is resolved

All polar calculations and all active-polar metadata go through the in-process
calculation service announced by signalk-polar-management via the `polarManagement`
PropertyValue. At startup this plugin subscribes with
`app.onPropertyValues('polarManagement', …)` and acquires an **active-polar handle**
(`service.activePolar()`). Every calculation call on that handle automatically follows
the shared active polar, the shared sailplan selection (for v2 polar sets), the shared
performance factor, and the shared wave-correction toggle — this plugin applies none of
them itself. When the management plugin is missing or stopped, calculations are
unavailable and the plugin reports this in its status; results then carry
`state.available: false` with a reason such as `no_active_polar`.

Descriptive metadata comes from the same handle: `handle.describe()` returns the active
document's name, boat details, selected sailplan, the applied performance factor, and the
selected table's TWS axis. The plugin refreshes this snapshot on `handle.onChange`
notifications and serves it through `/meta` and `/polar/axes/tws`. It does not subscribe
to the `polars.*` Signal K paths and performs no resource lookups; those paths remain
published by signalk-polar-management for other consumers.

### Sea state / wave correction

v2 polar sets can carry a wave-correction table, and active handles accept per-call
`seaState` input. This plugin does not supply `seaState`, because the Signal K
specification currently defines no paths for the required inputs (significant wave height,
wave period, wave direction). Wave correction therefore has no effect on this plugin's
outputs. If the specification gains such paths, sea state can be wired into the existing
handle calls without restructuring.

## REST API

The plugin exposes a REST API under `/plugins/signalk-polar-performance-plugin/`. Authentication
follows Signal K server rules; the same session cookie used by the webapp works for direct API calls.
The endpoints marked **Read-only** are available to users with Signal K read-only permission.
Anonymous access is controlled only by the server's `allow_readonly` setting and is not enabled by
the plugin. Curve queries are capped at 181 sample angles per request (minimum step 1°).
`/meta` includes the active polar's boat type, sail number, source, and free-text notes, so those
fields are also available to read-only users.

| Method | Path | Description | Access |
|--------|------|-------------|--------|
| `GET` | `/live` | Current smoothed TWS, TWA, BSP, polar speed, and polar state. | Read-only |
| `GET` | `/status` | Full snapshot: raw inputs, smoothed inputs, and all enabled output values. | Read-only |
| `GET` | `/meta` | Display unit metadata for all fields, plus a read-only summary of the active polar (name, boatType, sailnumber, year, source, notes, selected sailplan) and the applied performance factor. | Read-only |
| `GET` | `/settings` | Current plugin settings (smoother, output toggles, speed source — no polar selection). | Administrator |
| `PUT` | `/settings` | Update settings. Body: JSON object with changed keys only. | Administrator |
| `GET` | `/polar/axes/tws` | TWS axis of the currently active polar. 404 if none is active. | Read-only |
| `GET` | `/polar/queries/curve?tws=&step=` | Interpolated curve for the active polar at the given TWS, with beat/run markers, performance factor already applied. `step` must be at least 1° and at most π/2 radians. | Read-only |

The authoritative machine-readable schema for the two `/polar/*` endpoints is in
[../openApi.json](../openApi.json).
