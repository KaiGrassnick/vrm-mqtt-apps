# Spec — Mark installations offline after configurable staleness timeout

**Date:** 2026-06-30
**Branch:** `feature/expire`
**Status:** Approved

## Problem

`MqttBridgeConnection` (`vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`) marks
an installation `online` via `publisher.publishAvailability(idSite, true)` in
`handleConnect` (line 204) and `offline` in `handleOffline` (line 321). Both
events come from the underlying mqtt client's connection state to the VRM
broker.

The gap: a Victron installation can complete the MQTT CONNECT handshake at
the broker and then deliver zero telemetry messages — e.g. the Cerbo/Gateway
is powered off, has no internet, or the bus is down. The mqtt connection
stays `connected`, `handleOffline` never fires, and HA continues to display
the installation as `online` indefinitely. Meanwhile the VRM REST API still
returns the installation in the user's list (the list is decoupled from the
gateway's runtime state), so `InstallationManager.reconcile` keeps the
connection alive.

We need a per-installation staleness watchdog: if a connection does not
produce any HA publish within a configurable timeout, mark the installation
offline on the HA availability topic.

## Goals

- Per-installation timer; independent arm/reset/fire across installations.
- Configurable timeout via env var + Add-on option; default 5 minutes;
  `0` disables the feature.
- Touch (reset) only on messages that produce a HA publish (forward paths +
  custom aggregates). Unobserved paths do not reset.
- Lifecycle-correct: timer arms on `handleConnect`, clears on `handleOffline`
  and `stop()`, restarts on reconnect.
- Manager suspension (HA broker offline) clears every timer via the existing
  `conn.stop()` call.

## Non-goals

- Detecting broker-side connectivity loss (already handled by `handleOffline`).
- Per-installation override (single global setting).
- Retrying / re-arming after the timer fires — once an installation is marked
  offline, it stays offline until either `handleConnect` (reconnect) or the
  VRM poll cycle replaces it.
- Surfacing a separate "stale" state — we reuse the existing
  `vrm/{idSite}/availability` `offline` payload. HA already maps it to
  `unavailable`.

## Design

### Update definition

"Received an update" = any branch of `handleMessage` that pushes a topic into
`this.publishedStateTopics` (currently the forward path on line 269 and the
aggregate output on line 261). Messages on subscribed-but-not-forwarded paths
do not reset the timer.

Rationale: matches the user-visible signal. An installation reporting only
unobserved metrics would otherwise be marked offline even when alive — but
that signal is invisible to HA, so treating it as liveness would create
false positives.

### Components

#### 1. `MqttBridgeConnection` — new private `staleTimer`

New private field:

```ts
private staleTimer: ReturnType<typeof setTimeout> | null = null;
```

New helper:

```ts
private touch(): void {
  if (this.offlineTimeoutMs <= 0) return;
  if (this.staleTimer !== null) clearTimeout(this.staleTimer);
  this.staleTimer = setTimeout(() => {
    this.staleTimer = null;
    console.log(`[MQTT] ${this.installation.name} (${this.installation.identifier}) stale — no updates for ${this.offlineTimeoutMs}ms`);
    this.publisher.publishAvailability(this.installation.idSite, false);
  }, this.offlineTimeoutMs);
}
```

New constructor option:

```ts
export interface MqttBridgeConnectionOptions {
  // ... existing ...
  /** Staleness timeout in ms. 0 = disable. Default 300_000. */
  offlineTimeoutMs?: number;
}
```

Wire-up sites:

| Site | Action |
|---|---|
| `handleConnect` (line 190) | After `publishAvailability(idSite, true)`, call `this.touch()`. This is the only place the timer is armed in the lifecycle. |
| `handleMessage` (line 251) | After the `publishedStateTopics.add(...)` calls in both branches (aggregate line 261 and forward line 269), call `this.touch()`. One call covers both — placed after the for-loop block, just before the closing brace of `handleMessage`. |
| `handleOffline` (line 314) | After clearing `keepaliveTimer`, add `if (this.staleTimer !== null) { clearTimeout(this.staleTimer); this.staleTimer = null; }`. |
| `stop()` (line 151) | Add the same `clearTimeout` block before the existing `keepaliveTimer` clear. |

When `offlineTimeoutMs <= 0`, `touch()` is a no-op and the timer is never
armed. `stop()` and `handleOffline` must still defensively call
`clearTimeout(null)` — guard with `if (this.staleTimer !== null)`.

#### 2. `config.ts` — new field

Add to `AppConfig.vrm`:

```ts
/** Per-installation staleness timeout in ms. 0 = disable. Default 300_000. */
offlineTimeoutMs: number;
```

Parse in `loadConfig`:

```ts
offlineTimeoutMs: optionalEnvInt('VRM_OFFLINE_TIMEOUT_MS', 300_000),
```

#### 3. `index.ts` — wire to manager

Add `offlineTimeoutMs: config.vrm.offlineTimeoutMs` to the
`InstallationManager` constructor options.

#### 4. `InstallationManager` — propagate

Add `offlineTimeoutMs` to `InstallationManagerOptions`, default `300_000`,
and forward it into every `new MqttBridgeConnection({...})` call inside
`reconcile` (line 89).

#### 5. Add-on option — `vrm-mqtt/config.yaml`

Add to the `options:` list:

```yaml
offline_timeout:
  name: Offline timeout (ms)
  description: >-
    If an installation does not produce any Home Assistant publish for this
    many milliseconds, it is marked offline. Set to 0 to disable.
  default: 300000
  type: int
  min: 0
```

Add-on option name maps to env var via the existing schema mapping pattern
in `vrm-mqtt/DOCS.md` and the supervisor schema; final wiring happens in the
implementation plan.

#### 6. `.env.example` — documentation only

Add:

```
# Per-installation staleness timeout in ms. 0 = disable. Default: 300000 (5 min).
VRM_OFFLINE_TIMEOUT_MS=300000
```

### Behavior table

| State transition                          | Timer action                            | Availability published       |
|-------------------------------------------|-----------------------------------------|------------------------------|
| `start()` (no prior connect)              | unarmed                                 | —                            |
| `handleConnect` (mqtt connect or first)   | `setTimeout(fire, timeoutMs)`           | `online` (existing)          |
| `handleMessage` → forward or aggregate    | `clearTimeout` + `setTimeout(fire, …)`  | —                            |
| `handleMessage` → observed-only path      | unchanged                               | —                            |
| `handleOffline` (mqtt offline event)      | `clearTimeout`                          | `offline` (existing)         |
| `stop()`                                  | `clearTimeout`                          | `offline` via shutdown       |
| Timer fires                               | —                                       | `offline` (new path)         |
| `manager.suspend()` → `conn.stop()`       | timer cleared (via stop)                | `offline` via shutdown       |
| `manager.resume()` → `conn.start()`       | unarmed until next `handleConnect`      | `online` on connect          |

### Edge cases

- **Timeout = 0:** `touch()` short-circuits; timer never arms. Existing
  behavior (availability set on connect/offline events only) is preserved.
- **Multiple reconnects:** `handleConnect` re-arms the timer fresh via
  `touch()`. The previous timer is cleared by `handleOffline` before the new
  `handleConnect` runs, so no leaked timers.
- **Suspend while stale timer pending:** `manager.suspend()` calls
  `conn.stop()` → timer cleared. No offline publish races against the
  shutdown availability publish (both publish `offline`; the second is a
  no-op retained write).
- **Timer fires concurrently with `stop()`:** Both call
  `publishAvailability(idSite, false)`. The retained write is idempotent.
- **No HA publish ever happens** (forward set empty): timer arms, fires
  after `offlineTimeoutMs`, marks offline. The installation is registered
  but never publishes — matches the documented "still registered but
  silent" intent.

## Tests

All tests use the existing fake-timer pattern (`jest.useFakeTimers()` in
`MqttBridgeConnection.test.ts:72`). A small `makeMockPublisher` extension
that records `publishAvailability` calls in order is reused.

### `MqttBridgeConnection.test.ts` — new `describe('staleness watchdog')`

1. **Forwards keep the timer alive.**
   - `offlineTimeoutMs = 1000`. `start()` → simulate `connect` → simulate a
     forwarded message on `N/{portal}/system/0/Ac/Consumption/L1/Power` →
     advance 999 ms → assert `publishAvailability(_, false)` not called →
     simulate another forwarded message → advance 999 ms → still not called.
2. **Timer fires after the configured silence.**
   - Same setup, no forwarded message. Advance 1001 ms → assert
     `publishAvailability(idSite, false)` called exactly once.
3. **Unobserved path does not reset the timer.**
   - Simulate connect. Publish a message on a path NOT in
     `forwardPaths` (e.g. `N/{portal}/system/0/Some/Unobserved/Path`) that
     parses but doesn't match any forward or aggregate. Advance 1001 ms →
     assert `publishAvailability(_, false)` called once. Then simulate a
     forwarded message → advance 999 ms → assert no further offline
     publish.
4. **Aggregate output resets the timer.**
   - Forward an aggregate source payload → `publishedStateTopics` gains an
     aggregate topic → timer resets → advance 999 ms → still online.
5. **`handleOffline` clears the timer.**
   - Connect, advance 500 ms, simulate `offline` event, advance 2000 ms →
     assert `publishAvailability(_, false)` called exactly once (the
     `handleOffline` publish, not a stale timer fire).
6. **`stop()` clears the timer.**
   - Connect, advance 500 ms, `await stop()`, advance 2000 ms → assert no
     `publishAvailability` call beyond the shutdown one (mock shutdown
     emits no extra call in this test; we verify by counting calls).
7. **`offlineTimeoutMs = 0` disables the feature.**
   - Connect, advance 10 minutes → assert no `publishAvailability(_, false)`
     call.
8. **Reconnect re-arms the timer.**
   - Connect, simulate `offline`, simulate `connect` again, advance 1001 ms →
     assert `publishAvailability(_, false)` called once (the post-reconnect
     stale fire, not a leftover timer from before).

### `InstallationManager.test.ts` — extension

Verify the option is propagated. Existing tests construct `MqttBridgeConnection`
via a captured `connections` array; add a single test that constructs the
manager with `offlineTimeoutMs: 12345`, runs a `reconcile` with one
installation, and asserts the captured connection has `offlineTimeoutMs ===
12345`.

### No new `DiscoveryPublisher` tests

Behavior reuses `publishAvailability`, which already has full coverage in the
pruning test file (`MqttBridgeConnection.test.ts`) and the existing device
config tests. The pruning spec added tests at that level; this spec adds
tests at the timer level.

## Migration / rollout

- New env var `VRM_OFFLINE_TIMEOUT_MS` defaults to 300000 — existing
  installations flip from "permanently online" to "offline after 5 minutes
  of silence" on first start. Expected operational impact: low. Victron
  installations report telemetry every ~1 s; 5 minutes of silence is a
  strong signal of a real outage.
- New Add-on option `offline_timeout` defaults to 300000; same behavior.
- Setting the option/env to `0` restores the prior behavior exactly.
- No new public API surface apart from the constructor option on
  `MqttBridgeConnectionOptions` and `InstallationManagerOptions`.
- HA's existing availability wiring (`vrm/{idSite}/availability`) handles
  the rest. Entities will flip to `unavailable` when the retained topic
  reads `offline`.

## Open questions

None.