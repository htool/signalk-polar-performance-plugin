# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.60] - 2026-06-30

### Added
- Added GitHub Actions CI workflow for automated testing across multiple platforms and Node.js versions.

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

[0.0.60]: https://github.com/htool/signalk-polar-performance-plugin/compare/3593e2b...HEAD
[0.0.59]: https://github.com/htool/signalk-polar-performance-plugin/compare/c0a8958...3593e2b
[0.0.58]: https://github.com/htool/signalk-polar-performance-plugin/compare/ad9c8b5...c0a8958
[0.0.57]: https://github.com/htool/signalk-polar-performance-plugin/compare/ed1217d...ad9c8b5
[0.0.45]: https://github.com/htool/signalk-polar-performance-plugin/compare/a1d99ec...ed1217d
[0.0.44]: https://github.com/htool/signalk-polar-performance-plugin/compare/51ba34f...a1d99ec
[0.0.40]: https://github.com/htool/signalk-polar-performance-plugin/compare/858cd66...51ba34f
[0.0.35]: https://github.com/htool/signalk-polar-performance-plugin/compare/21de4ab...858cd66
[0.0.9]: https://github.com/htool/signalk-polar-performance-plugin/compare/0d1eb6a...21de4ab
[0.0.7]: https://github.com/htool/signalk-polar-performance-plugin/compare/cd2e367...0d1eb6a
