# Retain State Topics — Design

**Date:** 2026-06-29
**Status:** Draft
**Branch:** TBD

## Context

The VRM MQTT add-on bridges Victron VRM installations into the Home Assistant Mosquitto broker. While the bridge is connected to VRM, value topics (e.g. `vrm/{idSite}/Dc/Battery/Voltage`) flow through the throttle (`src/vrm/RollingMessageThrottle.ts`, `src/vrm/MessageThrottle.ts`) and reach Home Assistant in real time.

When the VRM broker connection drops and then reconnects, values go back to flowing — **but the bridge does not republish the last value for each topic.** Home Assistant therefore shows the affected entities as `unavailable` / `null` / `0` for as long as it takes VRM to emit the next value for that topic (a few seconds for high-rate metrics, several minutes for slow ones like `Dc/Pv/Power` mid-day). The user reports this as visible entity flapping in Home Assistant.

The same symptom occurs after Home Assistant or its broker restarts: HA re-subscribes but the broker has nothing retained for the state topics, so each entity shows `unknown` until the next VRM publish lands.

The bridge already retains discovery payloads (`homeassistant/device/{id}/config`) and the availability payload (`vrm/{idSite}/availability`), and republishes them on `homeassistant/status=online`. It does **not** retain per-entity state values. Adding retain to those topics is the simplest way to fix both flaps.

## Goal

After this change, every `vrm/{idSite}/...` value topic published by the bridge is retained on the local broker, so:

- Home Assistant restart (broker retains state) → entities restore to last known value on resubscribe.
- VRM-side reconnect → entities keep their last value instead of going `unknown` / `0`.
- Installation removal → retained state for that installation is cleared so old values do not linger under stale entity IDs.

## Non-goals

- Routing discovery, availability, command-set (`/set`) publishes through this change. Their retain semantics are already correct.
- Bridging a single in-memory "last value" cache back to the broker on reconnect — the broker's native retain flag suffices.
- Per-topic filter logic (e.g. retain only "slow-changing" topics). All bridged state topics retain.
- Changing the throttle's coalescing cadence, the VRM-side session config (`clean: true`), or the keepalive behavior.

## Design

### 1. Flip `HaBrokerClient.publish` default to `retained`

`src/ha/HaBrokerClient.ts:85`:

```ts
publish(topic: string, payload: string, retained = false): void { … }
```

becomes

```ts
publish(topic: string, payload: string, retained = true): void { … }
```

The internal `client.publish(..., { retain: retained, qos: 0 }, ...)` call is unchanged. Audit of callers:

| Caller | File:Line | Current `retained` | After |
|---|---|---|---|
| `throttle.flush` via `ha.publish(topic, payload)` (single-install) | `MqttBridgeConnection.ts:53` | `false` (default) | `true` ✓ |
| `RollingMessageThrottle` callback | `InstallationManager.ts:40` (passed into `RollingMessageThrottle` constructor) | `false` (default) | `true` ✓ |
| `publishInstallation` | `DiscoveryPublisher.ts:39` | explicit `true` | unchanged |
| `publishAvailability` | `DiscoveryPublisher.ts:49` | explicit `true` | unchanged |
| `removeInstallation` retained-clear | `DiscoveryPublisher.ts:56,68,127` | explicit `true` | unchanged |
| `purgeLegacyDiscovery` retained-clear | `DiscoveryPublisher.ts:127` | explicit `true` | unchanged |
| `InstallationManager.offline` retained-clear | `InstallationManager.ts:159` | explicit `true` | unchanged |

Every existing explicit `true` stays explicit (more defensible than depending on the default). The only call sites whose behavior actually flips are the throttle callbacks — which is exactly the intended change.

### 2. Track published state topics per installation

`MqttBridgeConnection` (single source of truth for one installation's lifecycle and its `idSite`) gains:

```ts
private readonly publishedStateTopics = new Set<string>();
```

In `MqttBridgeConnection.handleMessage` (`src/vrm/MqttBridgeConnection.ts:176`), after `routeFromVrm` returns the routed messages and **before** `enqueue`:

```ts
for (const msg of routeFromVrm(topic, str, this.getIdSite)) {
  this.publishedStateTopics.add(msg.topic);
  this.throttle.enqueue(msg.topic, msg.payload);
}
```

Why here, not in the throttle: the throttle is shared across installations (`RollingMessageThrottle` is global; keying by `portalId`), but cleanup is keyed by `idSite`. Keeping the set on the connection localizes tracking to the lifecycle unit that already owns `idSite` and is the unit being torn down on removal.

### 3. Clear retained on `MqttBridgeConnection.stop()`

`src/vrm/MqttBridgeConnection.ts:82` adds retained-clear before the existing unsubscribe/teardown:

```ts
async stop(): Promise<void> {
  if (this.keepaliveTimer !== null) { … }
  this.throttle.flush();

  // Clear retained state values so HA doesn't keep showing the old installation
  // long after it's gone.
  for (const topic of this.publishedStateTopics) {
    this.ha.publish(topic, '', true);
  }
  this.publishedStateTopics.clear();

  if (!this.client) return;
  this.client.off(…);
  …
}
```

`InstallationManager.removeInstallation` (`src/vrm/InstallationManager.ts:66,159`) already triggers `conn.stop()`, so cleanup is wired into the existing removal path with no new orchestration. The same `stop()` runs on graceful shutdown, which matches the existing semantics.

### Why the retain flag, not an in-memory replay

We considered caching the last value per topic in memory and republishing on VRM- and HA-reconnect events. That avoids the broker write of retain, but:

- It loses its value on bridge restart.
- It does not survive an HA-side broker restart — the broker still has nothing for `homeassistant/device/.../state`-style subscribers to pick up on resubscribe.
- It does not survive the most common practical disruption (a transient VRM broker hiccup with no bridge restart).

Retaining on the broker is the smallest mechanism that solves all three flaps and matches the convention Home Assistant already expects from retained state topics.

### What this does *not* touch

- Discovery, availability, command-set topics (already retained or don't need to be).
- The throttler's coalescing cadence, partitioning, or `MessageThrottle` fallback.
- The `clean: true` session flag on `HaBrokerClient` — it is about persistent sessions for subscriptions, unrelated to retained publishes.
- The VRM-side session (`clean`, reconnect period) — set on the pool/client owned by `VrmBrokerPool`.
- `MessageRouter` or the entity-allow-list in `DiscoveryConfigBuilder`.

## Edge cases

| Case | Behavior |
|---|---|
| Bridge starts, no VRM messages have arrived yet for an installation | `publishedStateTopics` is empty; `stop()` is a no-op for retention. ✓ |
| Same topic routed repeatedly (e.g. SOC updates every 5s) | `Set.add` is idempotent. Only the latest broker-stored retained value matters. ✓ |
| Connection runs through multiple VRM disconnects in one bridge lifetime | Set grows monotonically across reconnects (we only `clear()` on `stop()`). Stays correct. ✓ |
| Installation kept alive across bridge restart | Set starts empty on restart. First VRM message repopulates; broker retained value will be overwritten naturally. No migration step needed for stale non-retained history. |
| Bridge publishes a state value, then disconnects from VRM before the value changes again | The broker has already stored the retained value; HA subscribers see the last value until VRM reconnects and produces a fresher one. The retain flag stores at *publish* time, independent of the VRM-side session. ✓ |
| Installation removed with non-empty throttle shard | `throttle.flush()` (existing) drains any pending messages via `ha.publish` (retained) first, then `stop()` clears the published-state-topics set. Order matters: flush must run before the clear. ✓ |
| `intervalMs === 0` (bypass mode, tests) | Throttle publishes synchronously → topic is added to the set on the same tick → capture works in tests. ✓ |
| Long idle installations (no VRM messages ever received) | `publishedStateTopics` is empty → `stop()` clears nothing. ✓ |

## Component changes

| File | Change |
|---|---|
| `vrm-mqtt/app/src/ha/HaBrokerClient.ts` | Line 85: default `retained = false` → `retained = true`. |
| `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` | New field `publishedStateTopics: Set<string>`. New tracking line in `handleMessage`. New retained-clear loop in `stop()`. |
| `vrm-mqtt/app/src/ha/__tests__/HaBrokerClient.test.ts` | New tests: default publish goes through with `retain: true`; explicit `false` still works. |
| `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` | New tests: state topics are tracked across `handleMessage` calls; `stop()` publishes empty-retained for each tracked topic. |
| `vrm-mqtt/CHANGELOG.md` | Add entry under the next patch bump. |
| `vrm-mqtt/config.yaml` | Bump `version`. |

`DiscoveryPublisher`, `InstallationManager`, `MessageRouter`, `RollingMessageThrottle`, `MessageThrottle`, `VrmBrokerPool`, `VrmApiClient`, `index.ts`, `config.ts`, `HaBrokerClient.collectRetained`, `HaBrokerClient.start`, and `HaBrokerClient.stop` are **not touched**.

## Testing strategy

### `HaBrokerClient.test.ts`

- After `client.publish` callback completes, an unpublished state payload from the throttle now has `retain: true` (default).
- Existing tests that pass `true` explicitly keep working (sanity, no regression).
- `collectRetained` and `stop` behavior unchanged.

### `MqttBridgeConnection.test.ts`

- After `handleMessage` produces a routed topic, the connection's `publishedStateTopics` contains that topic.
- After a reconnect cycle (simulating VRM offline → connect), topics seen during that cycle are still in the set when `stop()` runs.
- On `stop()`, for each tracked topic, `ha.publish(topic, '', true)` is called exactly once with empty payload and retained. (Use the existing `mockHa = { publish: jest.fn() }` fixture; see `MqttBridgeConnection.test.ts:24`.)
- `stop()` on a connection that never received messages is a no-op for retention (no retained-clear publishes).
- Order: `stop()` calls `throttle.flush()` before the retained-clear loop (the existing `flush` already drains pending messages).

### Manual smoke (post-implementation)

- Upgrade the add-on. Confirm in `mqtt-explorer` (or via `mosquitto_sub -t 'vrm/#' -v`) that the next state message has the `retained: true` flag.
- Restart Home Assistant; confirm entities retain their last value (not `unknown`).
- Disconnect and reconnect the VRM-side connection (or wait for a transient blip); confirm entities keep their value while VRM is offline.

## Migration & rollout

- No add-on option changes. No schema changes. No `repository.yaml` changes.
- Existing installations' retained state is empty for the vrm/{idSite}/... tree until the first VRM poll after upgrade. Home Assistant entities briefly show `unknown` for that window (one poll cycle, typically a few seconds) and then resolve to retain-correct values.
- Version bump: next patch release after `0.1.5` (which `config.yaml` currently advertises; check `git status` before bumping — pending 0.1.6 changes may exist on this branch).

## Open questions

None.
