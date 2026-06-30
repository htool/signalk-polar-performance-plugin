---
applyTo: "**"
---

# Signal K Plugin Development – Agent Instructions

Comprehensive standards and best practices for developing, testing, versioning, publishing, and documenting Signal K server plugins. Follow these guidelines when creating or modifying any Signal K plugin.

---

## 1. Architecture Principles

### Align with Signal K v2 direction
Signal K server v2 is moving from a generic full-data-model approach toward modular, operation-based REST APIs (OpenAPI-defined, under `/signalk/v2/api`). Before writing a plugin, determine which category it falls into:

- **Resource data** (routes, waypoints, charts, POIs) → implement a [Resource Provider Plugin](#resource-provider-plugins) against the Resources API
- **Course operations** (set course, advance waypoint) → integrate with the Course API
- **Autopilot control** → implement an Autopilot Provider Plugin
- **General data processing, integration, or custom output** → standard plugin with delta handling

Do not create a plain plugin that duplicates functionality covered by an existing v2 API.

### Offline-first
Never depend on Internet connectivity for core functionality. Bundle all required assets (fonts, stylesheets, images). Plugins/webapps that optionally use Internet services must be resilient to connectivity loss and must display connection status clearly.

---

## 2. Project Structure

```
my-plugin/
  plugin/           # compiled/entry JS code
    index.js
  public/           # optional webapp (auto-mounted at /{pluginId}/)
    index.html
    app.js
    main.css
  src/              # TypeScript source (if applicable)
    index.ts
  test/
    plugin.test.js
  openApi.json      # if plugin exposes an API
  CHANGELOG.md
  README.md
  package.json
  .github/
    workflows/
      signalk-ci.yml
      release.yml
    dependabot.yml
```

---

## 3. `package.json` Requirements

```json
{
  "name": "my-signalk-plugin",
  "version": "1.0.0",
  "description": "Human-readable description",
  "keywords": [
    "signalk-node-server-plugin",
    "signalk-category-utility"
  ],
  "main": "plugin/index.js",
  "author": "Your Name <you@example.com>",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20"
  },
  "signalk-plugin-enabled-by-default": false,
  "signalk": {
    "displayName": "My Plugin",
    "appIcon": "./assets/icon-128.png",
    "screenshots": ["./docs/screenshots/main.png"]
  },
  "scripts": {
    "test": "node --test test/",
    "prepublishOnly": "npm run build"
  }
}
```

**Required `keywords`** for AppStore visibility:
- `signalk-node-server-plugin` — required for the plugin to appear in the AppStore
- One or more category keywords: `signalk-category-ais`, `signalk-category-instruments`, `signalk-category-nmea-2000`, `signalk-category-nmea-0183`, `signalk-category-hardware`, `signalk-category-notifications`, `signalk-category-digital-switching`, `signalk-category-utility`, `signalk-category-cloud`, `signalk-category-weather`, `signalk-category-database`, `signalk-category-chart-plotters`

**Key rules**:
- `plugin.id` should match the npm package name. Both values are effectively frozen once users have the plugin installed: `plugin.id` is used as the config file name, data directory name, and delta `$source` label; the package name is used for AppStore installs and `npm link`. Changing either is a breaking change for existing users and requires a data migration.
- `author` must be set; without it, OIDC-published packages show a bot name in the AppStore
- `engines.node` must be declared; required if using `node:sqlite` or other version-gated builtins (needs `>=22.5.0`)
- `main` or `exports` must point to the actual entry file
- Use `prepublishOnly` for build steps — **never** `postinstall` (the AppStore installs with `--ignore-scripts`)
- Verify published assets with `npm pack --dry-run | grep -E '(screenshots|icon)'`
- Use `signalk.requires` / `signalk.recommends` for cross-plugin dependencies, **not** `peerDependencies`

---

## 4. Plugin Interface

A plugin is a factory function exported from `index.js` (or `index.ts`):

### JavaScript

```javascript
module.exports = (app) => {
  let unsubscribes = []
  let timers = []

  const plugin = {
    id: 'my-signalk-plugin',   // must be unique; use the npm package name
    name: 'My Great Plugin',

    start: (settings, restartPlugin) => {
      // Called on enable or server start (when enabled).
      // settings = validated config from Plugin Config screen.
    },

    stop: () => {
      // Called on disable or before config changes are applied.
      // MUST free all resources: unsubscribe, clearInterval, close connections.
      unsubscribes.forEach((f) => f())
      unsubscribes = []
      timers.forEach(clearInterval)
      timers = []
      // Return a Promise if any teardown is async.
    },

    schema: () => ({
      type: 'object',
      properties: {
        someValue: {
          type: 'number',
          title: 'Some value',
          default: 60
        }
      }
    })
  }

  return plugin
}
```

### TypeScript

```typescript
import { Plugin, ServerAPI } from '@signalk/server-api'

module.exports = (app: ServerAPI): Plugin => {
  const plugin: Plugin = {
    id: 'my-signalk-plugin',
    name: 'My Plugin',
    start: (settings, restartPlugin) => { /* … */ },
    stop: () => { /* … */ },
    schema: () => ({ type: 'object', properties: {} })
  }
  return plugin
}
```

### Optional interface methods

| Method | Purpose |
|---|---|
| `uiSchema()` | Returns a [uiSchema](https://rjsf-team.github.io/react-jsonschema-form/docs/) to customise the config form |
| `registerWithRouter(router)` | Register Express routes under `/plugins/{pluginId}/`. Implement `getOpenApi()` when using this. |
| `getOpenApi()` | Returns OpenAPI JSON object; makes docs available in Admin UI under _Documentation → OpenAPI_ |

### Route registration pattern

```javascript
plugin.registerWithRouter = (router) => {
  router.get('/results', (req, res) => {
    res.status(200).json({ data: getResults() })
  })
}

plugin.getOpenApi = () => require('./openApi.json')
```

**Never** use `app.get()` directly — always use `registerWithRouter`. Plugin routes are already protected by the server's security layer; do not access `app.securityStrategy` or call `isDummy()`.

---

## 5. Server API Usage

### Status reporting

```javascript
app.setPluginStatus('Running, collecting data')
app.setPluginError('Failed to connect: ' + err.message)
// NOT the deprecated: app.setProviderStatus / app.setProviderError
```

### Subscribing to deltas

```javascript
let unsubscribes = []

plugin.start = (options) => {
  const subscription = {
    context: 'vessels.self',
    subscribe: [{ path: 'navigation.speedThroughWater', period: 1000 }]
  }

  app.subscriptionmanager.subscribe(
    subscription,
    unsubscribes,
    (err) => app.error('Subscription error: ' + err),
    (delta) => {
      delta.updates.forEach((u) => {
        u.values?.forEach(({ path, value }) => {
          if (Number.isFinite(value)) processValue(path, value)
        })
      })
    }
  )
}

plugin.stop = () => {
  unsubscribes.forEach((f) => f())
  unsubscribes = []
}
```

Use `subscriptionmanager.subscribe()` — **not** `app.streambundle.getBus()` (deprecated, cannot use `sourcePolicy`).

Use `excludeSelf: true` on subscriptions for paths your own plugin also writes, to avoid feedback loops.

### Emitting deltas

```javascript
app.handleMessage(plugin.id, {
  updates: [{
    values: [{ path: 'navigation.speedThroughWater', value: 3.5 }]
  }]
})
```

### File storage

```javascript
// Store files in the plugin's data directory, not __dirname or process.cwd()
const dataDir = app.getDataDirPath()
const filePath = path.join(dataDir, 'mydata.json')
```

### Debugging

```javascript
app.debug('Processing value: %o', value)  // enabled via DEBUG env var
```

Start server with:
```shell
DEBUG=my-signalk-plugin signalk-server
# or for loading issues:
DEBUG=signalk:interfaces:plugins signalk-server
```

---

## 6. Configuration Schema

Use JSON Schema. Keep settings backward-compatible: never rename or remove existing setting keys; add new settings at the end of `uiSchema['ui:order']` and the `properties` block.

```javascript
plugin.schema = {
  type: 'object',
  required: ['updateInterval'],
  properties: {
    updateInterval: {
      type: 'number',
      title: 'Update interval (ms)',
      default: 1000
    },
    enableLearning: {
      type: 'boolean',
      title: 'Enable learning mode',
      default: false
    }
  }
}
```

Validate user inputs at the boundary:

```javascript
plugin.start = (settings) => {
  const interval = Number.isFinite(settings.updateInterval)
    ? settings.updateInterval
    : 1000
}
```

---

## 7. Error Handling Conventions

- **Hot paths** (e.g. per-sample callbacks, delta handlers): silently return on invalid/non-finite inputs — never throw. Throwing inside a hot loop floods Signal K logs.
- **Configuration / startup**: log a descriptive error and set plugin error status; do not crash the process.
- **Async teardown**: return a `Promise` from `stop()` so the server waits before calling `start()` again.

```javascript
// Hot path pattern
function processValue(speed, heel) {
  if (!Number.isFinite(speed) || !Number.isFinite(heel)) return
  // … proceed
}
```

---

## 8. Performance Guidelines

- The STW (or equivalent hot) callback must remain **synchronous** — no async/await, no blocking I/O.
- Batch metric computations inside the existing handler rather than adding separate timers where possible.
- Avoid large allocations per sample; pre-allocate buffers or reuse objects.
- Throttle persistence writes (e.g. save state every 5 s, not on every sample).

---

## 9. WebApp (bundled UI in `public/`)

- Mounted automatically at `http://{server}/{pluginId}/`
- **No build step by default** — use plain ES modules with `<script type="module">`
- Bundle all dependencies (fonts, CSS, images); do not load from CDN
- Poll JSON endpoints at a reasonable rate (≤1 Hz for display data)
- Handle backpressure: check `delta.$backpressure` and show a non-blocking warning if present
- Discover server features via `GET /signalk/v2/features` before conditionally enabling UI sections

For `package.json` webapp keywords:
- `signalk-webapp` — standalone (full-page) webapp
- `signalk-embeddable-webapp` — embedded inside server Admin UI
- `signalk-plugin-configurator` — replaces the generic plugin config form

---

## 10. Testing

### Unit tests

Use Node.js built-in test runner (`node:test`) or Jest. Place tests in `test/`.

```javascript
// test/plugin.test.js
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

describe('processValue', () => {
  it('returns undefined for non-finite input', () => {
    assert.strictEqual(processValue(NaN, 0), undefined)
  })
})
```

### Lifecycle tests (mandatory)

The CI validates `start() → stop() → start()` with empty config. Your `stop()` must cleanly release all resources so the second `start()` succeeds.

### Integration tests (optional, recommended)

Set `enable-signalk-integration: true` in CI to run against a real SK server with sample NMEA data. Use `SIGNALK_URL` environment variable for the server URL.

### What the CI checks even without a test suite

- `signalk-node-server-plugin` keyword present
- `main`/`exports` resolves after build
- `schema()` returns a JSON-serializable object
- No deprecated API calls (`setProviderStatus`, `setProviderError`)
- No internal server property access (`app.server`, `app.deltaCache`, `app.pluginsMap`)
- No direct `app.get()` route registration
- No file writes to `__dirname` or `process.cwd()`
- npm pack includes all files referenced by `main`/`exports`
- Installs cleanly with `--ignore-scripts`

---

## 11. Continuous Integration (GitHub Actions)

Create `.github/workflows/signalk-ci.yml`:

```yaml
name: SignalK Plugin CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  test:
    uses: SignalK/signalk-server/.github/workflows/plugin-ci.yml@master
    with:
      test-command: 'npm test'
      build-command: 'npm run build --if-present'
      enable-signalk-integration: false
```

The reusable workflow tests across: Linux x64, Linux arm64, macOS arm64, Windows x64 (Node 22 & 24), and armv7/Cerbo GX (Node 20).

Pass `signalk-server-versions: '["2.23.0", "latest"]'` with integration tests enabled to catch cross-version regressions.

CI test results appear in the AppStore Indicators tab for published packages.

---

## 12. Releases and Versioning

Follow [Semantic Versioning](https://semver.org/):
- **patch** — bug fixes, no API changes
- **minor** — new features, backward-compatible
- **major** — breaking changes

### Release workflow

Create `.github/workflows/release.yml` (triggered on version tags):

```yaml
name: Release

on:
  push:
    tags:
      - '[0-9]+.[0-9]+.[0-9]+*'
      - 'v[0-9]+.[0-9]+.[0-9]+*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          prerelease: ${{ contains(github.ref_name, 'beta') }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  publish:
    needs: release
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - name: Publish to npm
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          if [[ "$tag" == *beta* ]]; then
            npm publish --provenance --access public --tag beta
          else
            npm publish --provenance --access public
          fi
```

### Cutting a release

```shell
npm version patch    # or minor / major
git push && git push --tags
```

### `CHANGELOG.md`

Maintain a `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) with `## x.y.z` version headers. The AppStore Changelog tab reads this file.

### Commit hygiene

Write PR titles and commit messages that make sense out of context, e.g.:
- `fix: AIS fallback when GPS source is missing`
- `feat: add configurable averaging window`

These become the auto-generated release notes.

---

## 13. Dependabot

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: '/'
    schedule:
      interval: weekly
    groups:
      minor-and-patch:
        update-types: [minor, patch]

  - package-ecosystem: github-actions
    directory: '/'
    schedule:
      interval: weekly
    groups:
      actions:
        update-types: [minor, patch]
```

---

## 14. Documentation

### `README.md` (required)

Must include:
- What the plugin does (1–2 sentences)
- Prerequisites / compatible Signal K server versions
- Installation instructions (AppStore + manual `npm link`)
- Configuration reference (all settings with types, defaults, descriptions)
- Description of any HTTP endpoints exposed
- Known limitations

Keep it scannable — most users read it before installing. Use relative image paths (`![caption](./docs/foo.png)`) — they render inline on the AppStore detail page.

### OpenAPI definition (required when exposing HTTP endpoints)

Create `openApi.json` and return it from `plugin.getOpenApi()`. Include a `servers` property if the API is not rooted at the plugin mount path:

```json
{
  "openapi": "3.0.0",
  "info": { "title": "My Plugin API", "version": "1.0.0" },
  "servers": [{ "url": "/plugins/my-signalk-plugin" }],
  "paths": { ... }
}
```

### Code comments

- Comment **why**, not **what**
- Document non-obvious math, Kalman parameters, or physical model assumptions
- Do not add comments that just restate the code

---

## 15. Security

- **Do not** access `app.securityStrategy` or call `isDummy()` — plugin routes registered via `registerWithRouter` are already protected
- **Do not** write user-controlled data directly to file paths without sanitisation
- **Do not** embed credentials in code; read from settings or environment variables
- **Do not** expose internal server state via plugin API endpoints
- Validate all inputs from HTTP requests at the route handler boundary

---

## 16. Deprecation and End-of-Life

- Add keyword `signalk-deprecated` or set `signalk.deprecated: true` in `package.json` when a plugin is superseded or unmaintained
- Deprecated plugins are hidden from general AppStore browsing but remain visible to users who have them installed

---

## 17. Local Development Workflow

```shell
# 1. Create and build your plugin
cd my-plugin
npm install

# 2. Link to Signal K server config directory
npm link
cd ~/.signalk
npm link my-signalk-plugin

# 3. Start server with debug output
DEBUG=my-signalk-plugin signalk-server --sample-n2k-data

# 4. Enable the plugin via Admin UI → Plugin Config
```

Re-link after any AppStore install/update as it removes the symlink.

---

## 18. Anti-patterns to Avoid

| Anti-pattern | Correct approach |
|---|---|
| `plugin.id` differs from npm package name (new plugins) | Use the npm package name as `plugin.id` from the start |
| Changing `plugin.id` or package name on a published plugin | Treat as a breaking change; migrate config/data dirs in `start()` and document in CHANGELOG |
| `app.setProviderStatus()` | `app.setPluginStatus()` |
| `app.setProviderError()` | `app.setPluginError()` |
| `app.get('/myroute', ...)` | `plugin.registerWithRouter(router)` |
| Writing to `__dirname` or `process.cwd()` | `app.getDataDirPath()` |
| `app.streambundle.getBus()` for new code | `app.subscriptionmanager.subscribe()` |
| `peerDependencies` for companion plugins | `signalk.requires` in `package.json` |
| `postinstall` build scripts | `prepublishOnly` |
| Throwing inside hot delta callbacks | Guard with `Number.isFinite`, return silently |
| Feedback loop: subscribing to a path you write | Use `excludeSelf: true` |
| Force-pushing or amending published tags | Cut a new patch version |

---

## References

- [Signal K Plugin Development Docs](https://signalk.org/signalk-server/master/docs/develop/plugins/)
- [Signal K Server API TypeDocs](https://signalk.org/signalk-server/master/api/)
- [Reusable CI Workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
- [Keep a Changelog](https://keepachangelog.com/)
- [Semantic Versioning](https://semver.org/)
- [npm Provenance](https://docs.npmjs.com/generating-provenance-statements)
- [React JSON Schema Form (RJSF)](https://rjsf-team.github.io/react-jsonschema-form/docs/)
