# Spec — Prune stale retained topics under `vrm/{idSite}/#`

**Date:** 2026-06-30
**Branch:** `feature/adjust-entities`
**Status:** Approved (sections 1–3)

## Problem

The bridge retains every state value it forwards to Home Assistant via
`HaBrokerClient.publish()` (which defaults to `retain: true`, see
`vrm-mqtt/app/src/ha/HaBrokerClient.ts:85`). Each value lives at
`vrm/{idSite}/{service}/{instance}/{path}` on the broker.

The `forward` flag in `SERVICE_ENTITY_DEFS` (`vrm-mqtt/app/src/ha/entityDefs.ts`)
controls whether an entity is published to HA. Changing a definition from
`forward: true` to `forward: false` causes the bridge to stop publishing that
path, but the broker still holds the last-published retained value at
`vrm/{idSite}/system/0/{path}` indefinitely.

`homeassistant/device/vrm_{idSite}/config` is regenerated and republished on
fresh process start (via `DiscoveryPublisher.publishInstallation` →
`buildInstallationDiscovery`), so HA's device registry will eventually drop the
orphaned entity — but only after the bridge restarts. Worse: if the entity is
*renamed* (path changed) rather than removed, the old retained topic lingers
even though nothing references it.

We need a one-shot reconciliation that clears every retained topic under
`vrm/{idSite}/#` that the bridge no longer publishes.

## Goals

- A single bridge startup clears stale retained topics for every installation.
- Idempotent: subsequent calls are no-ops.
- Best-effort: failures are logged, never raised.
- Tightly scoped: the only thing we touch is retained messages under
  `vrm/{idSite}/#`. Discovery configs, availability topics, write topics, and
  any other integration's topics are not affected.

## Non-goals

- Discovering third-party publishers under the `vrm/` prefix. The prefix is
  treated as the bridge's namespace; if another publisher exists under it, its
  retained messages will be cleared too. This is an accepted trade-off.
- Renaming the bridge's namespace.
- Cleanup on a schedule (timer-driven) — only fires on connect.

## Design

### Trigger

`MqttBridgeConnection.handleConnect` (`vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:190`),
immediately after `publisher.publishAvailability(this.installation.idSite, true)`
on line 204. Fire-and-forget — wrap in `.catch(err => console.error(...))`.

Runs on every `handleConnect` (initial connect AND reconnects). Idempotent:
after the first successful scan the broker returns zero stale topics and the
method becomes a no-op round-trip.

### Components

#### 1. `getCurrentlyForwardedTopics(idSite)` — new helper in `observedPaths.ts`

Returns the `Set<string>` of every full HA-side topic the bridge currently
publishes under `vrm/{idSite}/#`. Composition:

1. `vrm/{idSite}/availability` — always present.
2. For every `forward: true` entity in `SERVICE_ENTITY_DEFS.system`, add
   `vrm/{idSite}/system/0/{path}` with `{n}` expanded to `1, 2, 3` via the
   existing `expandTemplate` helper in `observedPaths.ts`.
3. For every `forward: true` aggregate in `CUSTOM_ENTITY_DEFS.aggregate`, add
   `vrm/{idSite}/custom/aggregate/{path}`. Aggregate `path` fields are literal
   (no `{n}`) — matches the wiring in
   `MqttBridgeConnection.buildAggregator` (`vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:280`).

Normal-entity topic construction reuses `makeStateTopic` from
`DiscoveryConfigBuilder.ts` so the topic shape `vrm/{idSite}/{service}/{instance}/{path}`
is defined in exactly one place. **Implementation note:** `makeStateTopic` is
currently a private function in `DiscoveryConfigBuilder.ts`; this spec requires
it to be exported (small, mechanical change).

#### 2. `DiscoveryPublisher.pruneRetainedTopics(idSite)` — new method

```ts
async pruneRetainedTopics(idSite: number): Promise<void> {
  const keep = getCurrentlyForwardedTopics(idSite);
  const prefix = `vrm/${idSite}/`;
  const retained = await this.ha.collectRetained(`${prefix}#`, 300);

  let cleared = 0;
  for (const { topic } of retained) {
    // Defensive: broker may have surfaced siblings + live /set writes.
    if (!topic.startsWith(prefix)) continue;
    if (topic.endsWith('/set')) continue;
    if (keep.has(topic)) continue;
    this.ha.publish(topic, '', true);
    cleared++;
  }
  console.log(`[HA] Pruned ${cleared} stale retained topic(s) under vrm/${idSite}/`);
}
```

Reuses the existing `HaBrokerClient.collectRetained` primitive
(`vrm-mqtt/app/src/ha/HaBrokerClient.ts:99`) — same one already used by
`DiscoveryPublisher.removeInstallation` for the no-in-memory fallback.

Three guards:

| Guard | Reason |
|---|---|
| `!topic.startsWith(prefix)` | Defensive against the broker surfacing topics from sibling `idSite`s during the wildcard subscribe. Mirrors the existing `removeInstallation` guard at `DiscoveryPublisher.ts:66`. |
| `topic.endsWith('/set')` | The HA broker client subscribes to `vrm/#` and routes `/set` writes through `onCommand`. A live `/set` flowing through during the 300ms collect window would otherwise be cleared mid-flight. |
| `keep.has(topic)` | The actual source-of-truth check. |

The empty-payload publish with retain is the same clearing primitive already
used in `MqttBridgeConnection.stop()` (line 161) and
`DiscoveryPublisher.removeInstallation()` (lines 55, 67).

#### 3. Wire-up site — `MqttBridgeConnection.handleConnect`

```ts
this.publisher.publishAvailability(this.installation.idSite, true);
// Fire-and-forget — not on the critical path. Failures are logged, not raised.
this.publisher.pruneRetainedTopics(this.installation.idSite).catch((err) => {
  console.error(`[HA] Prune failed for idSite=${this.installation.idSite}:`, err);
});
this.sendKeepalive();
```

### Discovery config

Handled by the existing `DiscoveryPublisher.publishInstallation` path — on
fresh process start (or any name change) it regenerates and republishes
`homeassistant/device/vrm_{idSite}/config` from the current entity defs. HA
re-reads the device registry against the retained config and drops entities
whose `components` entries are gone.

This spec adds no discovery-config changes.

### Error handling

Best-effort throughout. Failures logged, never raised.

| Failure | Behavior |
|---|---|
| `collectRetained` subscribe fails (logs `[HA] collectRetained subscribe failed` and returns `[]`) | Scan returns `[]`, zero clears, no error surfaces to caller. |
| Single `ha.publish('', true)` NACKs | Existing callback in `HaBrokerClient.publish` logs `[HA] Publish error on {topic}`. Prune continues to the next topic. |
| Whole prune rejects (uncaught) | Caught by `.catch()` at the wire-up site, logged as `[HA] Prune failed for idSite=…`. |

No retry. Next `handleConnect` retries naturally. Between failure and retry,
retained stale topics are inert — HA's discovery config already doesn't
reference them.

## Tests

### `observedPaths.test.ts` — `describe('getCurrentlyForwardedTopics')`

- Forward entity → `vrm/{idSite}/system/0/{path}` (literal + `{n}`-expanded
  to all three indices).
- Forward aggregate → `vrm/{idSite}/custom/aggregate/{path}`.
- Non-forward entity def absent from the set.
- `availability` always present regardless of defs.
- Two different `idSite`s produce disjoint sets.

### `DiscoveryPublisher.test.ts` — `describe('pruneRetainedTopics')`

- Mixed-input seed: one kept topic, one stale topic, one sibling-installation
  topic (`vrm/999/...`), one `…/set` topic, one `availability` topic — only
  the stale one triggers `ha.publish(topic, '', true)`.
- `collectRetained` returns `[]` → zero `publish` calls.
- `availability` retained topic is NOT cleared.
- Already-empty retained topic is NOT cleared (re-asserted by `keep.has`
  matching its topic regardless of payload).
- With 3 stales and 2 keeps, log message ends with `Pruned 3 stale retained
  topic(s) under vrm/{idSite}/`.

### `MqttBridgeConnection.test.ts` — one new test

- After `conn.start()` triggers `connect`, `publisher.pruneRetainedTopics` is
  called with `conn.idSite`.
- Rejecting prune does not block `sendKeepalive` or subsequent message
  forwarding.

## Migration / rollout

- No config changes. No new public API surface apart from the
  `DiscoveryPublisher` method.
- Operational effect on first start after upgrade: any retained topic under
  `vrm/{idSite}/#` that isn't in the current forward set is cleared once.
  After that, every subsequent start is a no-op.
- No effect on users who haven't changed any entity defs.

## Open questions

None. Decisions captured: trigger (on `handleConnect`), scope
(`vrm/{idSite}/#`), component (new method on `DiscoveryPublisher`), execution
(fire-and-forget, on every handleConnect, idempotent).
