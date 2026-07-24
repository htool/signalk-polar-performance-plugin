# Copilot Instructions for signalk-polar-performance-plugin

## Fix Strategy

**Prefer upstream fixes over downstream fixes.**

When a problem is caused by missing or incorrect data at the source (e.g. no SK paths configured on a polar, missing metadata in the library, incorrect ID in the backend), fix it at the source rather than working around it on the client. Only apply a client-side fix if the root cause genuinely cannot be addressed upstream.

Examples:
- Intermediate polars had no SK paths → fix: configure paths in `index.js` (upstream), not add fallback `rawUnits` in `insight.js` (downstream).
- `PolarSmoother` did not expose flat `sources` → fix: add `sources` getter in the library, not special-case it in the webapp.
