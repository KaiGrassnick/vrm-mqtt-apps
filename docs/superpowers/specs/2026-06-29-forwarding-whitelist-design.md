# Forwarding Whitelist + Flexible Aggregation

**Date:** 2026-06-29
**Status:** Design — awaiting review

## Problem

Today the bridge subscribes to a fixed list of VRM topics per installation and
forwards every received message verbatim to the Home Assistant MQTT broker.
Per-phase readings (e.g. `Ac/Grid/L1/Power`, `Ac/Grid/L2/Power`,
`Ac/Grid/L3/Power`) are exposed as individual HA entities alongside their
`Ac/Grid/AggPower` aggregate. Home Assistant users only need the aggregate;
the per-phase entities add noise to the device panel without operational value.

Additionally, the bridge hardcodes which VRM topics it aggregates. Operators
who want a different grouping — for example a single PV entity that combines
the DC PV (`Dc/Pv/Power`) with both AC PV sources (`Ac/PvOnOutput/L{n}/Power`
and `Ac/PvOnGrid/L{n}/Power`) — must edit `entityDefs.ts` and recompile, with
no documented extension path.

## Goal

1. Per-phase L{n} values stay subscribed on the VRM broker (they are needed as
   aggregate inputs) but are **not** forwarded to Home Assistant.
2. Each entity definition has an explicit **forward** flag that controls both
   HA discovery emission and HA-side publish. Default is `false` so new
   entities do not silently appear in HA.
3. The VRM subscribe list and the `INSTALLATION_PATHS` discovery hint list
   are both derived from the entity defs — no parallel hardcoded lists.
4. Operators can add a new aggregate that combines an arbitrary mix of
   template (`L{n}/Power`) and literal (`Dc/Pv/Power`) sources without
   touching any code outside `entityDefs.ts`.

## Design

### 1. Entity defs — `vrm-mqtt/app/src/ha/entityDefs.ts`

Add `forward?: boolean` to `EntityDefBase`. Default `false`. Every existing
entity type (`sensor`, `binary_sensor`, `switch`, `select`, `number`)
inherits it.

**Forward the following existing entities** by setting `forward: true`:

- `Dc/Battery/Soc`
- `Dc/Battery/Voltage`
- `Dc/Battery/State`
- `Ac/Consumption/AggPower`
- `Ac/Grid/AggPower`
- `Ac/Genset/AggPower`
- `Ac/PvOnOutput/AggPower`
- `Ac/PvOnGrid/AggPower`

All other existing entities keep the default `forward: false`. In particular
`Dc/Pv/Power` is **not** forwarded — its sole purpose is to feed the new
combined PV aggregate below.

**Add the new combined PV aggregate entity:**

```ts
{
  path: 'ZPv/AggPower',
  component: 'sensor',
  name: 'PV Aggregate Power',
  unit: 'W',
  deviceClass: 'power',
  stateClass: 'measurement',
  precision: 1,
  aggregateFrom: [
    'Dc/Pv/Power',
    'Ac/PvOnOutput/L{n}/Power',
    'Ac/PvOnGrid/L{n}/Power',
  ],
  forward: true,
},
```

The `Z` prefix sorts this entity last in discovery payloads and device panels,
matching the convention used for derived/total metrics.

The existing `Dc/Pv/Power` sensor def stays in place (it is still subscribed
as an aggregate source) but gets no `forward` flag, so it produces no HA
discovery config and is not published to HA.

### 2. Shared path-expansion helper — `vrm-mqtt/app/src/ha/observedPaths.ts` (new)

A single helper produces the set of "paths the bridge ever sees on the bus"
from the entity defs. Both the VRM-side subscription and the HA-side
`INSTALLATION_PATHS` consume it.

```ts
/**
 * Expand every {n} placeholder in entity `path` and `aggregateFrom` entries
 * to the standard L-phase indices (1, 2, 3). Literal paths are kept as-is.
 * The result is the union of:
 *   - all aggregate source paths (literal + template-expanded)
 *   - all paths from entities with forward: true (literal + template-expanded)
 * Returned sorted, deduplicated.
 */
export function getObservedPaths(): string[];
```

`{n}` only expands to `1`, `2`, `3` — matching the existing
`POSSIBLE_PHASE_INDICES` constant in `MqttBridgeConnection.ts`. No other
index is used by system/0 entities, so this is sufficient.

### 3. Subscription — `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`

`buildSubscribeTopics()` no longer hardcodes 9 topics. It builds them as
`N/{brokerPortalId}/{service}/{instance}/{path}` for every path in
`getObservedPaths()` where `service === 'system'` and `instance === '0'`.

After this change the resulting topic set is unchanged in cardinality (9
topics) but is derived rather than hardcoded:

- `Dc/Pv/Power` — aggregate source for `ZPv/AggPower`
- `Dc/Battery/Soc` — forward
- `Dc/Battery/Voltage` — forward
- `Dc/Battery/State` — forward
- `Ac/Grid/+/Power` — aggregate sources for `Ac/Grid/AggPower`
- `Ac/Consumption/+/Power` — aggregate sources for `Ac/Consumption/AggPower`
- `Ac/Genset/+/Power` — aggregate sources for `Ac/Genset/AggPower`
- `Ac/PvOnGrid/+/Power` — aggregate sources for both `Ac/PvOnGrid/AggPower`
  and `ZPv/AggPower`
- `Ac/PvOnOutput/+/Power` — aggregate sources for both
  `Ac/PvOnOutput/AggPower` and `ZPv/AggPower`

If someone later adds a new forward: true entity or a new aggregate with a
literal source path, the subscription list updates automatically.

`expandAggregateSourcePaths` (the local helper in
`MqttBridgeConnection.ts:27`) is replaced by calls into the shared helper.

### 4. Routing — `MqttBridgeConnection.handleMessage`

`handleMessage` (vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:219) is split
into two independent decisions per message:

1. **Aggregate feed** — unchanged. `this.aggregator.feedPayload(parsed.path, str)`
   runs unconditionally for every parsed topic; the aggregator internally
   no-ops on untracked paths.
2. **HA forward** — only when `parsed.path` is in the forward set.

Build the forward set at constructor time:

```ts
private readonly forwardPaths: ReadonlySet<string>;
// = getObservedPaths().filter(p => /* entity def for p has forward: true */)
```

In `handleMessage`:

```ts
if (this.forwardPaths.has(parsed.path)) {
  this.publishedStateTopics.add(msg.topic);
  this.throttle.enqueue(msg.topic, msg.payload);
}
```

`publishedStateTopics` only contains forwarded topics. `stop()` continues to
clear retained state for each tracked topic — the same defensive cleanup,
but now correctly limited to topics HA actually saw.

**Aggregate outputs are inherently safe.** `buildAggregator` is updated to
filter on `def.forward`. Only forward: true aggregates ever produce messages,
so no separate forward-check is needed for the aggregate branch.

### 5. Discovery — `DiscoveryConfigBuilder.ts` and `InstallationDevice.ts`

**`DiscoveryConfigBuilder.buildDiscoveryConfigs`** (vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts:29):
wrap the existing loop body in `if (def.forward)`. The template, aggregate,
and observed-path branches all become opt-in. Aggregate emission still
requires at least one expanded source path (existing behaviour).

**`InstallationDevice.ts`** replaces the hardcoded `INSTALLATION_PATHS`
constant with a call into the shared helper:

```ts
import { getObservedPaths } from './observedPaths';
// ...
const configs = buildDiscoveryConfigs(idSite, 'system', 0, meta, getObservedPaths());
```

This removes the parallel list of 19 paths that has to be kept in sync with
the entity defs by hand.

### 6. Behavioural impact

**HA device panel after the change** contains 9 system/0 entities (was 19):

- 3 battery sensors (`Dc/Battery/Soc`, `Dc/Battery/Voltage`, `Dc/Battery/State`)
- 5 existing power aggregates (`Ac/Consumption/AggPower`, `Ac/Grid/AggPower`,
  `Ac/Genset/AggPower`, `Ac/PvOnOutput/AggPower`, `Ac/PvOnGrid/AggPower`)
- 1 new combined PV aggregate (`ZPv/AggPower`)

The previous `Dc/Pv/Power` entity is no longer present in HA — its sole
purpose now is feeding the new combined aggregate.

**VRM broker subscription** is the same 9 wildcarded topics as today.
Bandwidth and CPU on the VRM side are unaffected.

**Aggregate correctness:**
- `ZPv/AggPower` sums observed sources. Single-phase installs report
  `Dc/Pv/Power + (one AC PV phase)`. Three-phase installs report the full sum.
  This matches the existing observed-sources semantics used by every other
  `aggregateFrom` rule — no special-casing required.
- Negative contributions are passed through unchanged. If a future VRM
  firmware reports `Ac/PvOnGrid/L{n}/Power` as negative for export, the
  aggregate reflects it.

### 7. Tests

**Updates to existing tests:**

- `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts:748` — the test
  "forwards the raw L-phase message AND the aggregate to HA" asserts the
  current behaviour. With the change, the L-phase topic must NOT be
  published. Update to:
  - assert the L-phase path is NOT published to HA
  - assert the aggregate IS published
- `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts:146` — the test
  "subscribes to exactly 9 topics" still holds; the count is unchanged.
- `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts:200-278` —
  aggregate-emission tests still pass because every existing aggregate gets
  `forward: true`. Add coverage for forward:false entities not being emitted.
- `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` aggregate
  section (lines 621+) — add a test that verifies a literal source
  (`Dc/Pv/Power`) feeds `ZPv/AggPower` and that the aggregate sums DC + AC
  contributions.

**New tests:**

- `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts` — covers
  `getObservedPaths()`:
  - Expands `{n}` to `1`, `2`, `3`.
  - Keeps literal paths unchanged.
  - Unions aggregate sources and forward paths.
  - Dedupes overlapping sources.
  - Returns sorted output.
- Update `MqttBridgeConnection.test.ts` retained-clear section to verify that
  forwarded-only topics are cleared and not subscribed-only ones.

### 8. Documentation

- `vrm-mqtt/DOCS.md:57` — the discovery example mentions `pv_power`. Update
  the example to `pv_aggregate_power` (or whatever slug `ZPv/AggPower`
  produces) and add a one-line note that operators can edit
  `entityDefs.ts` to add new forward entities or aggregates.
- No change needed to the per-topic mapping reference (it still covers the
  full VRM topic tree; the bridge just forwards fewer of them).

## Open scope (out of this spec)

- Migrating `VEBUS_ENTITIES` / `PLATFORM_ENTITIES` to the forward flag.
  Today those services are not bridged for this installation type (no
  `MqttBridgeConnection` subscription covers `vebus` or `platform`); the
  flag defaults to `false` everywhere, which is consistent. Explicit
  opt-in for those services is a follow-up if needed.
- HA-side dashboards in `docs/homeassistant/`. Out of scope; operators
  regenerate their own dashboards when entity IDs change.