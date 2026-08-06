# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `/live` and `/status` endpoints now return `null` for `tws`/`twa` (and downstream fields) when the wind smoother has no data or is stale, instead of `0`. The guard was checking for the presence of the smoother object rather than its `ready` state.
- `computeAndSend`: when the polar table lookup fails (boat outside polar range — in irons or above max TWS), the `performance.polarSpeed`, `performance.polarSpeedRatio`, and `performance.targetSpeed` SK paths are now written with `null` instead of `0`. Writing `0` was misleading because it is a valid-looking value rather than an explicit "no data" signal.
- Live input subscriptions are now re-established after prolonged silence for all subscribed inputs, not just true wind. Boat speed and optional true heading use the same recovery path, and the plugin now reports their lifecycle state through the webapp/status endpoints.

### Changed
- Idle input recovery is now always enabled; the temporary `detectStaleData` setting has been removed from the runtime settings UI.

## [1.2.1] - 2026-07-25

### Fixed
- `openApi.json` was missing from the npm tarball (`files` field in `package.json` did not list it), causing the plugin to crash on install with `Cannot find module '../openApi.json'` (#20).

## [1.2.0] - 2026-07-25

## [1.1.0] - 2026-07-21

### Added
- Plotter webapp (plotter.html) now has a settings panel accessible via a gear button: active polar selector, performance percentage stepper (±5%, range 50–200%), and a toggle to show or hide all TWS library curves.
- `PolarCanvas.setShowAllTwsLines()` method to toggle library curve visibility at runtime; when off, only the live (current-TWS) curve is drawn.

### Fixed
- `perfAdjust` was not applied to the `/polars/:id/queries/curve` (and `/speed`, `/targets`, `/performance`) endpoints because each request loaded a fresh `PolarTable` from disk without calling `setPerformanceAdjustment()`. Polar curves in the webapp now correctly scale when performance is changed.
- App Store icon was missing (monogram fallback shown): added `icon.png` at the package root so the App Store CDN can fetch it from the npm tarball via unpkg.com. The runtime `signalk.appIcon: ./icon.png` path is unchanged - the server still serves it from `public/icon.png` via the webapp mount.

### Changed
- Polar query endpoints (`/queries/curve`, `/speed`, `/targets`, `/performance`) now use a size-1 in-memory cache keyed by polar ID, avoiding repeated disk reads when consecutive requests target the same polar (e.g. the parallel curve fetches on startup). The cache is invalidated on `PUT` or `DELETE` for that polar ID.

## [1.0.1] - 2026-07-20

### Fixed
- `plotter.html` updated to use the current `/polars/:id/axes/tws` and `/polars/:id/queries/curve` API routes; the TWS line was no longer rendered after the polar management API redesign in 1.0.0.

## [1.0.0] - 2026-07-20

### Added
- Full polar file management: store, activate, copy, delete, and hot-swap polar files without restarting the plugin.
- Import polars from the ORC (Offshore Racing Congress) database by sail number, boat name, or boat type.
- Redesigned webapp polar management UI for canonical polar files and ORC imports.
- OpenAPI spec covering polar-manager, polar-query, and legacy polar-data endpoints.
- Custom plugin icon assets.

### Fixed
- Legacy `csvTable` in v0 settings is now converted to a canonical polar file during the v0→v1 migration; if conversion fails the migration retries on next start rather than silently discarding the data.
- ORC availability check now short-circuits immediately when the certificate cache is already fresh, avoiding a redundant network round-trip; status check timeout raised from 2 s to 15 s.
- Sidebar toggler was unreachable on mobile viewports.

### Changed
- `trueWindSpeedPath` legacy field is now removed during v0→v1 migration.
- README and developer reference updated for canonical polar management and import flow.
- Developer reference split into a separate file from the user guide.
- Version bumped to 1.0.0 to reflect the stable, production-ready polar management API.

## [0.0.60] - 2026-07-06

### Added
- Added runtime configuration of the plugin via the webapp.
- Added support for managing multiple polar  files —  switch between polars directly from the webapp.
- Added runtime inspection of the plugin via the webapp.
- Added ability to import polars from the ORC (Offshore Racing Congress) database by searching on sail number, boat name or boat type.
- Added extrapolation of the polar beyond the boundaries of the polar file.
- Added comprehensive warnings in the webapp.
- Added a full-screen polar diagram plotter page for a clean, chart-plotter-style view of your polar.
- Added new smoother types for sensor input smoothing: Moving Average and Kalman filter, in addition to the existing Exponential smoother.
- Added GitHub Actions CI workflow for automated testing across multiple platforms and Node.js versions.
- Added support for display units. Polar data and polar diagrams now use the preferred units.

### Changed
- Polar diagram changed to a rader style diagram.
- The separate damping settings for True Wind Speed, True Wind Angle, and Boat Speed have been replaced by a single smoother type with one tuning parameter. Existing settings are migrated automatically on first start.
- source selection replaced by source priorities.

## [0.0.59] - 2026-06-03

### Added
- Added informative error messages in the plugin log when polar or wind data is missing or unavailable.

### Fixed
- Fixed incorrect tack/gybe true wind angle calculation.
- Improved reliability of CSV polar file loading with strengthened parsing.

## [0.0.58] - 2026-01-21

### Added
- Added Signal K metadata (units and descriptions) for all plugin output paths, making values easier to read in compatible displays.

## [0.0.57] - 2026-01-03

### Added
- Added ability to select which True Wind Speed source ID to use for calculations.
- Added option to specify which GPS/SOG source to use for boat speed calculations.
- Added an example CSV polar file to help with initial setup.

### Changed
- Performance data is now only sent when values actually change, reducing network traffic.

### Fixed
- Fixed incorrect units for target velocity made good (VMG).
- Updated dashboard webapp jQuery dependency for compatibility.

## [0.0.45] - 2024-06-22

### Changed
- Signal K metadata is now sent only once at startup rather than with every update, reducing bandwidth usage.

## [0.0.44] - 2024-06-22

### Added
- Added target boat speed output based on the current polar and wind conditions.
- The performance dashboard now automatically reconnects when the server connection is lost.

### Changed
- Beat angle, gybe angle, and target true wind angle are now shown as signed values (positive/negative depending on tack).
- True wind angle in the dashboard is now displayed as an absolute value for clarity.

## [0.0.40] - 2023-05-30

### Added
- Added Signal K logo to the performance dashboard webapp.
- Added visual dots on the polar diagram showing current boat speed and polar target speed.

### Changed
- When sailing beyond the fastest polar heading, the plugin now uses the highest available polar speed.
- Polar diagram speed values are rounded for a cleaner display.

### Fixed
- Fixed plugin not restarting correctly after configuration changes are applied.
- Fixed plugin not stopping cleanly when disabled.
- Fixed erratic Speed over Ground and Boat Speed readings caused by damping misconfiguration.

## [0.0.35] - 2023-05-21

### Added
- Added interactive polar diagram visualization in the performance dashboard webapp.
- Added Velocity Made Good (VMG), polar VMG, and VMG ratio as Signal K output paths.
- Added configurable damping (smoothing) for True Wind Speed, True Wind Angle, and Boat Speed, using time constants for consistent behaviour.
- Added configurable polar adjustment ratio for fine-tuning performance targets to your specific boat.
- Added tack true wind angle and beat/run angle calculations, including automatic estimation when not present in the polar file.
- Added polar speed extrapolation towards zero wind speed.

### Changed
- Polar VMG is now calculated using the optimal true wind angle for improved accuracy.
- Polar diagram now displays all wind speeds in distinct colours.
- Polar diagram has a dark theme.

### Fixed
- Fixed beat and run angle errors when the polar file does not include them.
- Fixed polar diagram generation bug at the zero-wind baseline.
- Fixed CSV polar file loading and chart display precision.
- Fixed heading damping instability near ±180°.

## [0.0.9] - 2023-04-30

### Fixed
- Fixed optimum wind angle calculation producing incorrect results.

## [0.0.7] - 2023-04-29

### Added
- Added option to use Speed over Ground (SOG) instead of Speed through Water (STW) for performance calculations.
- Added polar maximum speed and the wind angle at which it occurs as output paths.

### Changed
- Renamed Signal K paths from 'optimal' to 'optimum' to align with B&G instrument terminology.

---

[0.0.60]: https://github.com/htool/signalk-polar-performance-plugin/compare/3593e2b...d051c34
[0.0.59]: https://github.com/htool/signalk-polar-performance-plugin/compare/c0a8958...3593e2b
[0.0.58]: https://github.com/htool/signalk-polar-performance-plugin/compare/ad9c8b5...c0a8958
[0.0.57]: https://github.com/htool/signalk-polar-performance-plugin/compare/ed1217d...ad9c8b5
[0.0.45]: https://github.com/htool/signalk-polar-performance-plugin/compare/a1d99ec...ed1217d
[0.0.44]: https://github.com/htool/signalk-polar-performance-plugin/compare/51ba34f...a1d99ec
[0.0.40]: https://github.com/htool/signalk-polar-performance-plugin/compare/858cd66...51ba34f
[0.0.35]: https://github.com/htool/signalk-polar-performance-plugin/compare/21de4ab...858cd66
[0.0.9]: https://github.com/htool/signalk-polar-performance-plugin/compare/0d1eb6a...21de4ab
[0.0.7]: https://github.com/htool/signalk-polar-performance-plugin/compare/cd2e367...0d1eb6a
