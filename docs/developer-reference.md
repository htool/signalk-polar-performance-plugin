# Polar Performance Developer Reference

This document is for the second kind of user of the plugin: integrators and developers who want to automate polar management, consume the plugin through its REST API, or provide canonical `polarTable` resources directly.

For installation, day-to-day use, and webapp workflow, start with [../README.md](../README.md).

## Canonical polar format

The plugin stores polars as canonical JSON `polarTable` resources. This is the only supported storage and management format for the REST API.

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
- Text imports and ORC imports are converted into this canonical structure before being stored.
- The authoritative machine-readable schema is in [../openApi.json](../openApi.json) under `PolarResource` and `PolarResourceBody`.

## REST API

The plugin exposes a REST API under `/plugins/signalk-polar-performance-plugin/`. Authentication follows Signal K server rules; the same session cookie used by the webapp works for direct API calls.

### Operational endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/live` | Current smoothed TWS, TWA, BSP, polar speed, and polar state. |
| `GET` | `/status` | Full snapshot: raw inputs, smoothed inputs, and all enabled output values. |
| `GET` | `/meta` | Display unit metadata for all fields. |
| `GET` | `/settings` | Current plugin settings. |
| `PUT` | `/settings` | Update settings. Body: JSON object with changed keys only. |

### Polar manager endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/polars` | List stored canonical polar resources with metadata. |
| `GET` | `/polars/active` | Get the active polar id. |
| `PUT` | `/polars/active` | Set the active polar. Body: JSON `{ id }`. |
| `DELETE` | `/polars/active` | Clear the active polar. |
| `GET` | `/polars/:id` | Get a stored canonical `polarTable` resource. |
| `PUT` | `/polars/:id` | Create or replace a canonical `polarTable` resource. |
| `DELETE` | `/polars/:id` | Delete a stored polar. |
| `GET` | `/polars/:id/meta` | Read stored metadata and TWS range for a polar. |

### Query endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/polars/:id/axes/tws` | Array of TWS values (m/s) in a stored polar. |
| `GET` | `/polars/:id/queries/curve?tws=<m/s>&step=<rad>` | Interpolated polar curve for a given TWS, with beat and run markers. |
| `GET` | `/polars/:id/queries/speed?tws=<m/s>&twa=<rad>` | Interpolated boat speed and interpolation state for a single TWS/TWA point. |
| `GET` | `/polars/:id/queries/targets?tws=<m/s>` | Optimal beat and run targets for a given TWS. |
| `GET` | `/polars/:id/queries/performance?tws=<m/s>&twa=<rad>&bsp=<m/s>` | Speed and VMG performance ratios against the polar. |

### Import endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/imports/formats` | List supported text import formats. |
| `POST` | `/imports/text/:format` | Import a text polar and store it as a canonical resource. |
| `GET` | `/imports/sources` | List supported external sources and their current availability. |
| `GET` | `/imports/sources/:source/search?q=<text>` | Search an external source for import candidates. |
| `POST` | `/imports/sources/:source/items/:externalId` | Import a source item and store it as a canonical resource. |

## External source availability

External sources are optional. Signal K may run in an isolated environment, so lack of internet access is not treated as a plugin error.

- `GET /imports/sources` reports source availability through `available` and `availabilityMessage`.
- The ORC source is shown as unavailable when the plugin cannot reach the official ORC index within a short timeout.
- ORC imports do not accept manual metadata overrides; imported metadata is owned by the source data.
- Certificate search results may be served from a cached ORC active-certificate index.

## Source of truth

- Use [../openApi.json](../openApi.json) as the authoritative machine-readable API contract.
- Use this document for a human-readable overview of the canonical format and endpoint categories.