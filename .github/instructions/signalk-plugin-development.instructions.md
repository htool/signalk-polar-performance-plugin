---
applyTo: "*.js,package.json"
---

# Signal K Plugin Development – Agent Instructions

---

## 1. Architecture Principles

Signal K v2 is moving toward modular, operation-based REST APIs. Before writing a plugin, determine which category it falls into:

- **Resource data** (routes, waypoints, charts) → implement a Resource Provider Plugin
- **Course operations** → integrate with the Course API
- **Autopilot control** → implement an Autopilot Provider Plugin
- **General data processing, integration, or custom output** → standard plugin with delta handling

Do not create a plain plugin that duplicates functionality covered by an existing v2 API.

**Offline-first:** Never depend on Internet connectivity for core functionality. Bundle all required assets.

---

## 2. Project Structure

```
my-plugin/
  index.js          # plugin entry point
  public/           # optional webapp (auto-mounted at /{pluginId}/)
    index.html
    app.js
    main.css
  test/
    plugin.test.js
  openApi.json      # if plugin exposes an API
  CHANGELOG.md
  README.md
  package.json
```

---

## 3. `package.json` Key Rules

- `plugin.id` must match the npm package name — both are frozen once published
- `engines.node` must be `">=22.0.0"` and `engines.signalk-server` must be `">=2.28.0"`
- `main` or `exports` must point to the actual entry file
- Use `prepublishOnly` for build steps — **never** `postinstall`
- `signalk-node-server-plugin` keyword is required for AppStore visibility
- Use `signalk.requires` for companion plugin dependencies, not `peerDependencies`

For a full template, keyword list, CI workflow files, and publish verification, see the `plugin-package` skill.

---

## 4. Plugin Interface

```javascript
module.exports = (app) => {
  let timers = []

  const plugin = {
    id: 'my-signalk-plugin',   // must match npm package name
    name: 'My Great Plugin',

    start: (settings, restartPlugin) => {
      // settings = config saved by user. Validate before use.
    },

    stop: () => {
      // MUST free all resources: terminate handlers, clearInterval, close connections.
      timers.forEach(clearInterval)
      timers = []
      // Return a Promise if any teardown is async.
    },

    schema: () => ({ type: 'object', properties: {} })
  }

  return plugin
}
```

### Optional interface methods

| Method | Purpose |
|---|---|
| `uiSchema()` | Returns a uiSchema to customise the config form |
| `registerWithRouter(router)` | Register Express routes under `/plugins/{pluginId}/`. Implement `getOpenApi()` when using this. |
| `getOpenApi()` | Returns OpenAPI JSON; makes docs available in Admin UI |

### Route registration pattern

```javascript
plugin.registerWithRouter = (router) => {
  router.get('/results', (req, res) => {
    res.status(200).json({ data: getResults() })
  })
}

plugin.getOpenApi = () => require('./openApi.json')
```

**Never** use `app.get()` directly — always use `registerWithRouter`. Plugin routes are already protected by the server's security layer.

---

## 5. Server API Usage

### Status reporting

```javascript
app.setPluginStatus('Running, collecting data')
app.setPluginError('Failed to connect: ' + err.message)
// NOT the deprecated: app.setProviderStatus / app.setProviderError
```

### Subscribing to SK paths

**Always use `signalKutilities` classes** (`MessageHandler`, `MessageSmoother`, `Polar`, `PolarSmoother`) for subscriptions — never use `app.subscriptionmanager` or `app.streambundle` directly. See the `signalkutilities-api` skill.

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

```shell
DEBUG=my-signalk-plugin signalk-server
```

---

## 6. Configuration Schema

These plugins use an **empty schema**: `schema: () => ({ type: 'object', properties: {} })`. Settings are managed at runtime by the plugin — do not add properties to the schema.

Guard all `settings.*` reads with `Number.isFinite` or equivalent at the point of use in `start()`.

---

## 7. Error Handling

- **Hot paths** (per-sample callbacks): silently return on invalid/non-finite inputs — never throw. Throwing inside a hot loop floods SK logs.
- **Startup**: log a descriptive error and call `app.setPluginError()`; do not crash the process.
- **Async teardown**: return a `Promise` from `stop()`.

```javascript
function processValue(speed, heel) {
  if (!Number.isFinite(speed) || !Number.isFinite(heel)) return
  // … proceed
}
```

---

## 8. Performance

- Hot callbacks must remain **synchronous** — no async/await, no blocking I/O.
- Batch metric computations inside the existing handler rather than adding separate timers.
- Throttle persistence writes (e.g. every 5 s, not on every sample).

---

## 9. WebApp (`public/`)

- Mounted automatically at `http://{server}/{pluginId}/`
- No build step — use plain ES modules with `<script type="module">`
- Bundle all dependencies; do not load from CDN
- Poll JSON endpoints at ≤1 Hz for display data

---

## 10. Testing

Use Node.js built-in test runner (`node:test`). Place tests in `test/`.

```javascript
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

describe('processValue', () => {
  it('returns undefined for non-finite input', () => {
    assert.strictEqual(processValue(NaN, 0), undefined)
  })
})
```

**Lifecycle test (mandatory):** `start() → stop() → start()` with empty config must succeed. `stop()` must cleanly release all resources.

---

## 11. Releases and Versioning

Follow Semantic Versioning: patch = bug fixes, minor = new features, major = breaking changes.

```shell
# Cut a release:
git add -A && git commit -m "chore: release x.y.z"
git tag x.y.z && git push && git push --tags
```

Maintain `CHANGELOG.md` with `## x.y.z - YYYY-MM-DD` headers. The AppStore Changelog tab reads this file.

Use the `/release-prep` prompt to automate version bumping and CHANGELOG drafting.

---

## 12. Documentation

**`README.md`** must include: what the plugin does, compatible SK server versions, installation instructions, configuration reference, HTTP endpoints exposed, known limitations.

**`openApi.json`:** Required when exposing HTTP endpoints. Return from `plugin.getOpenApi()`.

**Code comments:** Comment *why*, not *what*. Document non-obvious math, Kalman parameters, physical model assumptions.

---

## 13. Security

- Do not access `app.securityStrategy` — plugin routes via `registerWithRouter` are already protected
- Do not write user-controlled data directly to file paths without sanitisation
- Do not embed credentials in code; read from settings or environment variables
- Validate all inputs from HTTP requests at the route handler boundary

---

## 14. Local Development

```shell
npm link
cd ~/.signalk && npm link my-signalk-plugin
DEBUG=my-signalk-plugin signalk-server --sample-n2k-data
```

Re-link after any AppStore install/update (it removes the symlink).

---

## 15. Anti-patterns

| Anti-pattern | Correct approach |
|---|---|
| `plugin.id` differs from npm package name | Use npm package name as `plugin.id` from the start |
| Changing `plugin.id` or package name on a published plugin | Treat as breaking change; migrate in `start()` and document in CHANGELOG |
| `app.setProviderStatus()` | `app.setPluginStatus()` |
| `app.setProviderError()` | `app.setPluginError()` |
| `app.get('/myroute', ...)` | `plugin.registerWithRouter(router)` |
| Writing to `__dirname` or `process.cwd()` | `app.getDataDirPath()` |
| `app.subscriptionmanager.subscribe()` directly | Use `signalKutilities` handlers |
| `app.streambundle.getBus()` | Use `signalKutilities` handlers |
| `peerDependencies` for companion plugins | `signalk.requires` in `package.json` |
| `postinstall` build scripts | `prepublishOnly` |
| Throwing inside hot delta callbacks | Guard with `Number.isFinite`, return silently |
| Force-pushing or amending published tags | Cut a new patch version |
