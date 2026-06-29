# Forwarding Whitelist + Custom Aggregates

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
no documented extension path. The current `aggregateFrom` is bolted onto the
general `SensorEntityDef` type, mixed in with regular entities, and the
discrimination lives in the body of the loop in `DiscoveryConfigBuilder`.

## Goal

1. Per-phase L{n} values stay subscribed on the VRM broker (they are needed as
   aggregate inputs) but are **not** forwarded to Home Assistant.
2. Each entity definition has an explicit **forward** flag that controls both
   HA discovery emission and HA-side publish. Default is `false` so new
   entities do not silently appear in HA.
3. **Aggregates are a first-class, separate concept** with their own
   registry and required `aggregateFrom` field. They are not mixed into the
   normal entity arrays.
4. The VRM subscribe list and the `INSTALLATION_PATHS` discovery hint list
   are both derived from the entity defs and custom-aggregate defs — no
   parallel hardcoded lists.
5. Operators can add a new aggregate that combines an arbitrary mix of
   template (`L{n}/Power`) and literal (`Dc/Pv/Power`) sources without
   touching any code outside `entityDefs.ts`.

## Design

### 1. Entity defs — `vrm-mqtt/app/src/ha/entityDefs.ts`

#### 1a. `forward` flag on the base interface

Add `forward?: boolean` to `EntityDefBase`. Default `false`. Every existing
entity type (`sensor`, `binary_sensor`, `switch`, `select`, `number`)
inherits it.

#### 1b. New `CustomAggregateEntityDef` type

A first-class type for aggregate-only sensors. Distinct from
`SensorEntityDef` so `aggregateFrom` cannot appear on a normal sensor by
accident.

```ts
export interface CustomAggregateEntityDef {
  /** VRM dbus path the aggregate is published on, e.g. 'Z/Aggregate/Ac/Grid/Power'. */
  path: string;
  /** Human-readable name shown in Home Assistant. */
  name: string;
  /** Required. The VRM paths whose sum becomes this entity's value.
   *  Templates containing `{n}` are expanded to indices 1, 2, 3.
   *  Literal paths (e.g. 'Dc/Pv/Power') are kept as-is. */
  aggregateFrom: string[];
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  stateClass?: HaStateClass;
  precision?: number;
  /** Default false. When true, emit HA discovery and publish the value. */
  forward?: boolean;
}
```

`SensorEntityDef` loses its `aggregateFrom` field — aggregates no longer
ride along with normal sensors.

#### 1c. New `CUSTOM_AGGREGATES` array + `CUSTOM_AGGREGATE_DEFS` registry

Move every existing aggregate out of `SYSTEM_ENTITIES` into a dedicated
array. The path convention `Z/Aggregate/<category>/<sub>/<metric>` keeps
all derived metrics grouped under one root and sorts them last in discovery
payloads and device panels.

```ts
const CUSTOM_AGGREGATES: CustomAggregateEntityDef[] = [
  // AC aggregates (per-source)
  { path: 'Z/Aggregate/Ac/Consumption/Power', name: 'AC Consumption Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Consumption/L{n}/Power'], forward: true },
  { path: 'Z/Aggregate/Ac/Grid/Power', name: 'Grid Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Grid/L{n}/Power'], forward: true },
  { path: 'Z/Aggregate/Ac/Genset/Power', name: 'Generator Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Genset/L{n}/Power'], forward: true },

  // Combined PV total — DC + both AC PV sources. Supersedes the old
  // Ac/PvOnOutput/AggPower and Ac/PvOnGrid/AggPower, which are dropped.
  { path: 'Z/Aggregate/Pv/Power', name: 'PV Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Dc/Pv/Power', 'Ac/PvOnOutput/L{n}/Power', 'Ac/PvOnGrid/L{n}/Power'],
    forward: true },
];

export const CUSTOM_AGGREGATE_DEFS: Partial<Record<VrmServiceName,
  readonly CustomAggregateEntityDef[]>> = {
  system: CUSTOM_AGGREGATES,
};
```

The two old `Ac/PvOnOutput/AggPower` and `Ac/PvOnGrid/AggPower` aggregates
are removed entirely — their sources feed into the combined
`Z/Aggregate/Pv/Power`, so per-source breakdown is no longer surfaced in
HA. The underlying VRM subscriptions stay so the combined aggregate has all
its inputs.

#### 1d. `SYSTEM_ENTITIES` changes

`SYSTEM_ENTITIES` (vrm-mqtt/app/src/ha/entityDefs.ts:166) loses the five
existing aggregate entries — they now live in `CUSTOM_AGGREGATES`. Every
remaining entry keeps its current shape except:

- **Mark `forward: true`** on exactly these three entries:
  - `Dc/Battery/Soc`
  - `Dc/Battery/Voltage`
  - `Dc/Battery/State`
- `Dc/Pv/Power` is **not** marked forward — its sole purpose is feeding the
  new combined PV aggregate. It is still subscribed as an aggregate source
  but produces no HA entity and no HA publish.

All other existing system entities (per-phase L{n} readings, the rest of the
battery metrics, ESS controls, system state, timers, IO, etc.) keep the
default `forward: false` and therefore do not appear in HA after the change.

### 2. Shared path-expansion helper — `vrm-mqtt/app/src/ha/observedPaths.ts` (new)

A single helper produces the set of "paths the bridge ever sees on the bus"
from the entity defs **and** the custom-aggregate defs. Both the VRM-side
subscription and the HA-side `INSTALLATION_PATHS` consume it.

```ts
/**
 * Expand every {n} placeholder in entity `path` and `aggregateFrom` entries
 * to the standard L-phase indices (1, 2, 3). Literal paths are kept as-is.
 * The result is the union of:
 *   - all aggregate source paths from CUSTOM_AGGREGATE_DEFS (literal +
 *     template-expanded), regardless of the aggregate's forward flag —
 *     sources must be subscribed even if the aggregate itself isn't published
 *   - all paths from entities with forward: true in SERVICE_ENTITY_DEFS
 *     (literal + template-expanded)
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

- `Dc/Pv/Power` — aggregate source for `Z/Aggregate/Pv/Power`
- `Dc/Battery/Soc` — forward (normal entity)
- `Dc/Battery/Voltage` — forward (normal entity)
- `Dc/Battery/State` — forward (normal entity)
- `Ac/Grid/+/Power` — aggregate source for `Z/Aggregate/Ac/Grid/Power`
- `Ac/Consumption/+/Power` — aggregate source for `Z/Aggregate/Ac/Consumption/Power`
- `Ac/Genset/+/Power` — aggregate source for `Z/Aggregate/Ac/Genset/Power`
- `Ac/PvOnGrid/+/Power` — aggregate source for `Z/Aggregate/Pv/Power`
- `Ac/PvOnOutput/+/Power` — aggregate source for `Z/Aggregate/Pv/Power`

If someone later adds a new forward: true entity or a new custom aggregate
with a literal source path, the subscription list updates automatically.

`expandAggregateSourcePaths` (the local helper in
`MqttBridgeConnection.ts:27`) is removed — the shared helper covers its
job.

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
// = paths from entities in SERVICE_ENTITY_DEFS['system'] with forward:true
//   ∪ paths from CUSTOM_AGGREGATE_DEFS['system'] with forward:true
// (Both sets, expanded for {n}, deduplicated.)
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

`buildAggregator` is updated to iterate over
`CUSTOM_AGGREGATE_DEFS['system'] ?? []`, filtering by `def.forward`. Only
forward: true aggregates ever produce messages, so no separate forward-check
is needed for the aggregate branch.

### 5. Discovery — `DiscoveryConfigBuilder.ts` and `InstallationDevice.ts`

**`DiscoveryConfigBuilder.buildDiscoveryConfigs`** (vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts:29):
the loop body becomes `if (def.forward) { ... }` for normal entities, and
the aggregate branch is removed from this loop entirely. The aggregate
emission now lives in a separate post-pass that consumes
`CUSTOM_AGGREGATE_DEFS[service] ?? []`.

The function signature gains an optional `customAggregates` parameter
(defaults to `[]`) so the existing call sites stay unchanged in shape:

```ts
export function buildDiscoveryConfigs(
  idSite: number,
  service: VrmServiceName,
  instance: string | number,
  meta: DeviceMeta,
  observedPaths: string[],
  customAggregates: readonly CustomAggregateEntityDef[] = [],
): HaDiscoveryConfig[];
```

For each forward: true custom aggregate, emit a sensor config if at least
one expanded source appears in `observedPaths` (same gating the old code
applied). Re-uses the existing `expandAggregateSourcePaths` helper.

**`InstallationDevice.ts`** replaces the hardcoded `INSTALLATION_PATHS`
constant with a call into the shared helper, and passes the custom
aggregates:

```ts
import { getObservedPaths } from './observedPaths';
import { CUSTOM_AGGREGATE_DEFS } from './entityDefs';
// ...
const configs = buildDiscoveryConfigs(
  idSite, 'system', 0, meta,
  getObservedPaths(),
  CUSTOM_AGGREGATE_DEFS.system ?? [],
);
```

This removes the parallel list of 19 paths that has to be kept in sync with
the entity defs by hand.

### 6. Behavioural impact

**HA device panel after the change** contains 7 system/0 entities (was 19):

- 3 battery sensors (`Dc/Battery/Soc`, `Dc/Battery/Voltage`, `Dc/Battery/State`)
- 3 AC aggregates (`Z/Aggregate/Ac/Consumption/Power`,
  `Z/Aggregate/Ac/Grid/Power`, `Z/Aggregate/Ac/Genset/Power`)
- 1 new combined PV aggregate (`Z/Aggregate/Pv/Power`)

The previous `Dc/Pv/Power` entity and the two `Ac/PvOn*/AggPower`
aggregates are no longer present in HA — their sole purpose now is feeding
the new combined aggregate.

**VRM broker subscription** is the same 9 wildcarded topics as today.
Bandwidth and CPU on the VRM side are unaffected.

**Aggregate correctness:**
- `Z/Aggregate/Pv/Power` sums observed sources. Single-phase installs
  report `Dc/Pv/Power + (one AC PV phase)`. Three-phase installs report
  the full sum. This matches the existing observed-sources semantics used
  by every other `aggregateFrom` rule — no special-casing required.
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
  aggregate-emission tests still pass because every existing aggregate has
  `forward: true`. Update the setup so it passes the new
  `customAggregates` parameter, and add coverage for:
  - forward:false normal entity not emitted
  - forward:true normal entity emitted
  - forward:true custom aggregate emitted when at least one source observed
  - forward:false custom aggregate not emitted
- `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` aggregate
  section (lines 621+) — add a test that verifies a literal source
  (`Dc/Pv/Power`) feeds `Z/Aggregate/Pv/Power` and that the aggregate sums DC + AC
  contributions.

**New tests:**

- `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts` — covers
  `getObservedPaths()`:
  - Expands `{n}` to `1`, `2`, `3` for both normal-entity paths and
    custom-aggregate `aggregateFrom` entries.
  - Keeps literal paths unchanged.
  - Includes aggregate sources regardless of the aggregate's `forward` flag.
  - Dedupes overlapping sources.
  - Returns sorted output.
- Update `MqttBridgeConnection.test.ts` retained-clear section to verify that
  forwarded-only topics are cleared and not subscribed-only ones.

### 8. Documentation

- `vrm-mqtt/DOCS.md:57` — the discovery example mentions `pv_power`. Update
  the example to `z_aggregate_pv_power` (the slug for `Z/Aggregate/Pv/Power`)
  and add a one-line note that operators can add new entries to
  `SYSTEM_ENTITIES` (forward: true) or `CUSTOM_AGGREGATES` to extend the
  bridge.
- No change needed to the per-topic mapping reference (it still covers the
  full VRM topic tree; the bridge just forwards fewer of them).

## Open scope (out of this spec)

- Migrating `VEBUS_ENTITIES` / `PLATFORM_ENTITIES` to the forward flag.
  Today those services are not bridged for this installation type (no
  `MqttBridgeConnection` subscription covers `vebus` or `platform`); the
  flag defaults to `false` everywhere, which is consistent. Explicit
  opt-in for those services is a follow-up if needed.
- Custom aggregates for non-system services. The `CUSTOM_AGGREGATE_DEFS`
  registry is keyed by `VrmServiceName`, so the structure supports
  `vebus`/`platform` aggregates later without further design changes.
- HA-side dashboards in `docs/homeassistant/`. Out of scope; operators
  regenerate their own dashboards when entity IDs change.