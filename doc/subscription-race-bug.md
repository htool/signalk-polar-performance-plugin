# Subscription Race Condition — Investigation Notes

**Filed against:** [signalk-polar-performance-plugin #22](https://github.com/htool/signalk-polar-performance-plugin/issues/22)  
**Possibly affects:** any Signal K plugin that subscribes to a path published by another plugin  
**Status:** hypothesis, unconfirmed — root cause not yet proven by runtime observation or test

---

## Observed Symptom

After a server restart, the polar-performance plugin UI reports:

> `environment.wind.speedTrue — no data from instruments`

persistently — for 20+ minutes, or until the plugin is manually disabled and re-enabled. Meanwhile, querying the REST API (`/signalk/v1/api/vessels/self/environment/wind/speedTrue`) shows the path IS live: fresh timestamps, `$source: AdvancedWind`, values updating on every request.

**Key observations:**
- The data IS in the SK delta cache and model — the subscription is the problem, not the source.
- Manually toggling the plugin (disable → enable) clears the warning immediately on re-enable.
- The failure is restart-specific and non-deterministic: it does not always occur, but recurs reliably across restarts on Docker / Raspberry Pi deployments.
- A similar pattern has been observed between `speedandcurrent` and `advancedWind` (the former publishing corrected STW, the latter not receiving it).

---

## What the Two signalKutilities Bugs Explain (and Don't Explain)

Two bugs were found and fixed in signalKutilities (commit `35f180d`):

1. **`MessageHandler._resetIdleTimer()` one-cycle stale lag** — when `stalenessDetection = true` is explicitly set before any data arrives, the stale flag is set with no timer, and the first delivery does not clear it. Only the second delivery clears it.

2. **`createSmoothedPolar()` bootstrap data loss** — `polar.onChange` was wired after `polar.subscribe()`, so bootstrap-snapshot data fired into a null handler.

These explain a **transient one- or two-cycle startup lag** (~1–2 seconds at 1 Hz sensor rates). They do not explain a failure that persists for 20+ minutes or until the plugin is restarted. Something else is preventing the subscription from ever delivering data.

---

## The Remaining Hypothesis (Bug 3)

### Background: how cross-plugin subscriptions work

When polar-performance subscribes to `environment.wind.speedTrue` and that path does not yet exist in the SK server's live buses (advancedWind hasn't published yet), the subscription manager falls back to a `keys.onValue` listener:

```
subscriptionmanager.subscribe(command, ...):
  // Step A — subscribe to all currently known buses
  handleSubscribeRows(this.app, command.subscribe, unsubscribes, buses, ...)

  // Step B — register for all future new paths
  unsubscribes.push(
    this.streambundle.keys.onValue((newPath) => {
      handleSubscribeRows(this.app, command.subscribe, unsubscribes, { [newPath]: getBus(newPath) }, ...)
    })
  )
```

`this.streambundle.keys` is a BaconJS `Bus<string>`. When a path is published for the first time, `StreamBundle.getUnfilteredBus(path)` creates the per-path bus and immediately calls `keys.push(path)`. The full call sequence in `pushUnfilteredDelta` is:

```ts
// For each path-value in a delta:
this.getUnfilteredBus(pathValue.path).push(normalizedDelta)
//  └── getUnfilteredBus(path):
//        if (!unfilteredBuses[path]):
//          unfilteredBuses[path] = new Bacon.Bus()
//          if (!buses[path]):
//            keys.push(path)           ← (A) announces new path
//        return unfilteredBuses[path]
//  └── .push(normalizedDelta)          ← (B) delivers data to subscribers
```

The intent is that (A) fires all `keys.onValue` callbacks synchronously, wiring subscriptions onto the new bus before (B) pushes the first value into it.

### The hypothesis: nested BaconJS push deferral

The `pushUnfilteredDelta` loop is itself called from within the `unfilteredDelta` event handler, which is triggered by `signalk.emit('unfilteredDelta', ...)` inside `dispatchDelta`. That emission is itself driven by another event or synchronous call chain.

When `keys.push(path)` is called at step (A), there may already be an active BaconJS dispatch in progress for another bus (e.g. `unfilteredAllPathsBus.push(normalizedDelta)` runs just before the per-path push, for every value in every delta). In BaconJS 3.x the dispatcher uses a "pending event queue" to handle nested pushes — if a `Bus.push()` call happens while another dispatch is already on the call stack, the inner push may be enqueued rather than dispatched immediately.

If `keys.push(path)` is deferred in this way:

1. `getUnfilteredBus(path)` returns the freshly created (subscriber-less) bus.
2. `.push(normalizedDelta)` is called on the bus — **no subscribers yet**, delta is dropped.
3. The outer dispatch completes.
4. The deferred `keys.push(path)` fires — `keys.onValue` callbacks run — polar-performance's subscription is wired onto the bus.
5. But the bus has already delivered its first (and possibly only) value. No future value comes until the wind changes.

**Result:** the subscription is set up correctly, but it missed its only delivery opportunity. If the wind speed is steady at anchor — or if the server is in a calm, static environment — advancedWind continues publishing identical values at 1 Hz, but the bus sees them as fresh pushes and _should_ deliver them. Unless BaconJS also deduplicates unchanged values on `Bus.push`, in which case no further delivery ever happens.

Alternatively: if the delta pipeline skips publishing when the value is unchanged (delta suppression at the source or at `dispatchDelta`), then the one dropped value is the last one pushed and polar-performance stays dark indefinitely.

### BaconJS 3.x dispatcher behaviour (key unknown)

The above rests on whether BaconJS 3.x actually defers nested `Bus.push()` calls. This needs to be confirmed by:

- Reading `node_modules/baconjs/dist/Bacon.js` (or the TypeScript source) in the Signal K server install and finding the `Bus.push` → dispatch path.
- Checking whether there is a `dispatcherState` / `isDispatching` guard and what happens when `push` is called while `isDispatching === true`.
- Writing a minimal BaconJS reproduction:

  ```js
  const Bacon = require('baconjs')
  const keys = new Bacon.Bus()
  const dataBus = new Bacon.Bus()
  let received = 0

  // Simulate: subscribe before first push
  keys.onValue(path => {
    // wire subscription on new bus
    dataBus.onValue(v => { received++ })
  })

  // Simulate: first push announces key AND delivers data in same tick
  Bacon.combineAsArray(keys).subscribe(() => {})  // keep keys alive
  keys.push('myPath')    // ← does this defer?
  dataBus.push(42)       // ← does subscriber see this?

  console.log('received:', received)  // expect 1; if 0, bug confirmed
  ```

  Or, more faithfully, simulate the nested-push scenario:

  ```js
  const outer = new Bacon.Bus()
  const keys  = new Bacon.Bus()
  const inner = new Bacon.Bus()

  keys.onValue(() => {
    inner.onValue(v => { console.log('inner delivery:', v) })
  })

  outer.onValue(() => {
    keys.push('myPath')   // nested push inside outer handler
    inner.push(99)        // does inner subscriber exist yet?
  })

  outer.push('trigger')
  ```

---

## How the Disable → Re-enable Workaround Fixes It

When the user disables the plugin, `stop()` calls `windSmoother.terminate()` which unsubscribes everything. When the plugin is re-enabled, `start()` re-runs. By this time `environment.wind.speedTrue` IS in `unfilteredBuses` (advancedWind has been publishing for a while). `handleSubscribeRows` (Step A) finds the path in the existing buses and wires the subscription directly — no `keys.onValue` path is needed. The bootstrap snapshot then delivers the most-recent cached value immediately. This is why re-enable fixes it instantly.

---

## Suggested Investigation Steps

1. **Confirm the BaconJS nested-push behaviour** (see reproduction script above). This is the fastest path to either confirming or ruling out Bug 3.

2. **Enable verbose debug logging** in polar-performance and advancedWind (`app.debug` output), then capture a failing restart. Check whether polar-performance's `MessageHandler` callback is ever invoked for `environment.wind.speedTrue`. If the callback fires but downstream processing is blocked, the bug is in signalKutilities (potentially a residual from the now-fixed bugs). If the callback is never invoked, the subscription never received the delta and Bug 3 is confirmed.

3. **Add a one-shot `app.getSelfPath` check** on plugin startup (after 5 seconds) that reads the cached value of `environment.wind.speedTrue` directly and, if present, calls the handler callback manually to bootstrap the smoother. This would be a defensive workaround independent of the root cause.

4. **Raise with the SK server team**: share this document and the BaconJS nested-push hypothesis. The `streambundle.ts` / `subscriptionmanager.ts` interaction is the relevant surface. The fix would be to ensure that the `keys.push` + bus `.push` sequence in `getUnfilteredBus` is atomic with respect to BaconJS dispatch — either by using `Bacon.update` / `Bacon.combineAsArray`, or by separating the key announcement from the data push in a way that guarantees subscribers are wired before the push fires.

---

## Relevant Source Files

| File | Location |
|---|---|
| `StreamBundle` — `getUnfilteredBus`, `pushUnfilteredDelta` | `signalk-server` — `src/streambundle.ts` |
| `SubscriptionManager` — `subscribe`, `handleSubscribeRows` | `signalk-server` — `src/subscriptionmanager.ts` |
| `plugins.ts` — `mergeExcludeSelf`, plugin wrapper | `signalk-server` — `src/interfaces/plugins.ts` |
| `index.ts` — `dispatchDelta`, `handleMessage` | `signalk-server` — `src/index.ts` |
| `MessageHandler._subscribeViaManager` | `signalKutilities` — `src/signalk/MessageHandler.js` |
| `createSmoothedPolar` | `signalKutilities` — `src/signalk/Polar.js` |
| Plugin start, windSmoother setup | `signalk-polar-performance-plugin` — `plugin/index.js` lines 1095–1131 |
