# Rolling Message Throttle — Design

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `feature/rolling-updates`

## Context

The VRM MQTT add-on bridges every Victron VRM installation the user has access to into the Home Assistant Mosquitto broker. With 100+ installations the user is seeing load spikes on Home Assistant.

### Where the load comes from

In `src/vrm/MqttBridgeConnection.ts:117-136`, each `MqttBridgeConnection.handleConnect` subscribes to 7 fixed VRM topics for its installation. Incoming VRM messages are routed to the local broker via `routeFromVrm` (`src/ha/MessageRouter.ts:43-49`) and then handed to a shared `GlobalMessageThrottle` (`src/vrm/GlobalMessageThrottle.ts`).

The shared throttle's contract is to coalesce messages by topic and flush them all at once every `intervalMs` (default 500ms). The current flush loop is:

```ts
private doFlush(): void {
  if (this.buffer.size === 0) return;
  for (const [topic, payload] of this.buffer) {
    this.publish(topic, payload);
  }
  this.buffer.clear();
}
```

Topics produced by `routeFromVrm` are scoped per installation (`vrm/{portalId}/{service}/{instance}/{path}`), so the "global" buffer never actually coalesces across installations — two installations publishing the same conceptual value (e.g. battery SOC) use different topics. The shared throttle is, in practice, a shared 500ms batch timer.

With ~100 installations × 7 topics, every 500ms a synchronous loop of ~700 publishes hits the local broker. The load is bursty and grows linearly with fleet size. The user expects the fleet to keep growing.

The 500ms startup stagger in `InstallationManager.reconcile` (`src/vrm/InstallationManager.ts:93-116`) is **not** the problem — that path already runs sequentially. The problem is the steady-state flush.

## Goal

Spread the per-cycle publish load evenly across the throttle interval so the broker/HA sees a continuous stream rather than a single 700-publish burst every 500ms. The behavior must scale automatically with the number of installations and require no new add-on options.

## Non-goals

- Changing the per-topic coalescing semantics ("latest value wins" per topic).
- Routing discovery, availability, or keepalive publishes through the throttle (those are not in scope — see `DiscoveryPublisher.ts:42-89` for the existing HA-birth batching).
- Changing the per-installation connection-startup stagger in `InstallationManager.reconcile` (it is already sequential, ~50s for 100 installations is acceptable; the user pointed at the throttle specifically).
- Breaking the existing `GlobalMessageThrottle` public API.

## Design

### Replace `GlobalMessageThrottle` with `RollingMessageThrottle`

`src/vrm/GlobalMessageThrottle.ts` is deleted. A new `src/vrm/RollingMessageThrottle.ts` is introduced with the **same public API** (`enqueue`, `start`, `flush`, `stop`) and the same constructor signature. The `MqttBridgeConnection` and `InstallationManager` call sites do not change beyond a one-token import swap at `src/vrm/InstallationManager.ts:48`.

The internal state is a sharded buffer keyed by `portalId`:

```ts
private shards = new Map<string, Map<string, string>>();  // portalId → topic → payload
private cursor = 0;        // round-robin position across shards
private timer: NodeJS.Timeout | null = null;
```

### Topic → portalId parsing

`enqueue` extracts the `portalId` from the topic prefix. All topics entering the throttle come from `routeFromVrm` and follow the shape `vrm/{portalId}/…`:

```ts
const PORTAL_RE = /^vrm\/([^/]+)\//;
private portalIdOf(topic: string): string {
  const m = PORTAL_RE.exec(topic);
  return m ? m[1] : '_unknown';
}
```

A topic that doesn't match (defensive: should not happen, but the throttle must not throw) goes into a single `_unknown` shard and is flushed with the rest.

### Tick schedule

A `setTimeout` chain (one outstanding timer at a time) drives the flushes. On each tick the throttle:

1. Picks the shard at `shards.keys()[cursor % shards.size]`.
2. Increments `cursor`.
3. Publishes every `(topic, payload)` in that shard, then clears it.
4. Reschedules the next tick at `max(1, ⌊intervalMs / shards.size⌋)` ms.

When `shards.size === 0` (no data buffered) the tick interval is `intervalMs` and the tick is a no-op.

### Shard lifecycle

- **Created lazily** on first `enqueue` for a `portalId`.
- **Never removed.** An installation that disappears leaves an empty shard. The shard still occupies a slot in the round-robin, but the tick on that slot is a no-op. Memory cost is one `Map` entry per `portalId` ever seen — negligible at the fleet sizes in question.
- This keeps the design simple. No need to track "active vs empty" shards or evict them.

### Why this scales

| N (installations with buffered data) | tickMs | Total cycle | Per-installation flush latency |
|---|---|---|---|
| 1 | 500 | 500ms | up to 500ms |
| 100 | 5 | 500ms | up to 500ms |
| 500 | 1 (floor) | 500ms | up to 500ms |
| 1000 | 1 (floor) | 1000ms | up to 1000ms |
| 5000 | 1 (floor) | 5000ms | up to 5s |

For N ≤ 500 the `intervalMs` is preserved exactly. Beyond that, Node's `setTimeout` 1ms granularity floors the tick and the cycle lengthens. Users with very large fleets can raise `vrm_throttle_interval_ms` proportionally if they need a tighter cycle. A future "K shards per tick" mode could break the 1ms ceiling — out of scope here.

## Edge cases

| Case | Behavior |
|---|---|
| `intervalMs === 0` (bypass) | `enqueue` publishes synchronously. `start` and `flush` are no-ops. Preserves `GlobalMessageThrottle.test.ts:17-21`. |
| `shards.size === 0` (no data yet) | Tick at `intervalMs`, no publish. Preserves `GlobalMessageThrottle.test.ts:74-78`. |
| `shards.size === 1` | Tick at `intervalMs`. **Identical to current behavior** — small fleets see no regression. |
| `shards.size > 1` | Tick at `max(1, ⌊intervalMs / N⌋)` ms. One shard per tick, round-robin. |
| Shard empty when its slot comes up | Cursor advances, no publish. |
| Installation added mid-cycle | New shard created on next `enqueue`; the new shard gets a slot on the next round-robin cycle. |
| Installation removed (no further `enqueue`) | Shard stays, no eviction. |
| `flush()` called (e.g. on HA offline) | Drain **all** shards immediately. The pending timer is **not** cleared — preserves the `GlobalMessageThrottle` contract from `GlobalMessageThrottle.test.ts:51-61`. |
| `stop()` called (shutdown) | Drain all shards, clear the timer. Subsequent `enqueue` calls do not publish. Preserves `GlobalMessageThrottle.test.ts:63-72`. |
| `start()` called twice | Idempotent. Preserves `GlobalMessageThrottle.test.ts:43-49`. |
| Multiple `enqueue` for the same topic | Latest payload wins (per-shard `Map.set` semantics). Preserves `GlobalMessageThrottle.test.ts:23-31`. |

## Component changes

| File | Change |
|---|---|
| `vrm-mqtt/app/src/vrm/RollingMessageThrottle.ts` | **New.** Replaces `GlobalMessageThrottle`. |
| `vrm-mqtt/app/src/vrm/GlobalMessageThrottle.ts` | **Deleted.** |
| `vrm-mqtt/app/src/vrm/InstallationManager.ts:48` | One-line change: `new GlobalMessageThrottle(...)` → `new RollingMessageThrottle(...)`. |
| `vrm-mqtt/app/src/vrm/__tests__/RollingMessageThrottle.test.ts` | **New.** Replaces the old test file. |
| `vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts` | **Deleted.** |
| `vrm-mqtt/CHANGELOG.md` | Add `0.1.5` entry. |
| `vrm-mqtt/DOCS.md` | One paragraph in the Configuration table: existing `vrm_throttle_interval_ms` description gains a sentence on rolling behavior. |
| `vrm-mqtt/config.yaml` | Bump `version: "0.1.4"` → `"0.1.5"`. No schema/option changes. |

`MqttBridgeConnection`, `DiscoveryPublisher`, `HaBrokerClient`, `VrmBrokerPool`, `VrmApiClient`, `index.ts`, and `config.ts` are **not touched**.

## Testing strategy

### Preserved (renamed to `RollingMessageThrottle.test.ts`)

All 7 cases from `vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts`:

1. Bypass mode (`intervalMs === 0`) publishes synchronously.
2. Coalesces messages with the same topic (latest wins).
3. Publishes distinct topics across the interval (preserved because with N topics the cycle covers all N).
4. `start()` is idempotent.
5. `flush()` drains immediately and leaves the timer running.
6. `stop()` drains and clears the timer.
7. Empty flush is a no-op.

### New

- With 3 simulated installations, advancing 1 × `intervalMs` produces publishes from all 3.
- With 3 simulated installations, publishes from installation 1 land in the first third of the interval, installation 2 in the second third, installation 3 in the final third (verifies the "evenly distributed" claim).
- Adding a 4th installation mid-cycle causes subsequent ticks to include it.
- A shard that receives a new enqueue after its slot has already flushed keeps the data into the next cycle (no data loss across cycle boundaries).
- A removed installation (no further `enqueue`) leaves an empty shard that is visited by the cursor but produces no publish.

Tests use `jest.useFakeTimers()` to control time, consistent with the existing throttle test file.

## Migration & rollout

- No add-on option changes. No schema changes. No `repository.yaml` changes.
- The change is internal: the `GlobalMessageThrottle` class is renamed and its internals rewritten; the public surface is preserved.
- Small fleets (N ≤ 1 with buffered data) see byte-identical behavior.
- Large fleets see a smoother, lower-peak publish stream to the local broker.
- Version bump: `0.1.4` → `0.1.5`.

## Open questions

None. The user's two clarification answers selected the per-installation offset model and the always-on / scales-with-N rollout.
