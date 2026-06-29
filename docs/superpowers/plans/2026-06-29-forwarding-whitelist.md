# Forwarding Whitelist + Custom Aggregates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop forwarding per-phase VRM readings to Home Assistant. Forward only an explicit opt-in set of normal entities plus a new class of `CustomAggregateEntityDef` aggregates. Derive the VRM subscribe list and discovery hint list from the entity definitions instead of hardcoding them.

**Architecture:** A `forward?: boolean` flag (default `false`) on every entity definition controls HA-side publish. A new `CustomAggregateEntityDef` type with required `aggregateFrom` field replaces the old in-place `aggregateFrom` on `SensorEntityDef`, moving aggregates into a separate `CUSTOM_AGGREGATES` registry. A new `getObservedPaths()` helper in `src/ha/observedPaths.ts` produces the union of forward paths + aggregate sources — consumed by both `MqttBridgeConnection.buildSubscribeTopics()` and `InstallationDevice.buildInstallationDiscovery()` so neither has to maintain a parallel hardcoded list.

**Tech Stack:** TypeScript, Jest, ts-jest, mqtt.js (no new deps).

## Global Constraints

- Node.js `>=24.0.0` (from `vrm-mqtt/app/package.json`).
- TypeScript `^5.9.3` (from `vrm-mqtt/app/package.json`).
- All commands run from `vrm-mqtt/app/` (the directory with `package.json`).
- Test command: `npm test` from `vrm-mqtt/app/`. Lint: `npm run lint`. Typecheck: `npm run typecheck`.
- Spec: `docs/superpowers/specs/2026-06-29-forwarding-whitelist-design.md`.
- Aggregate path convention: `Z/Aggregate/<category>/<sub>/<metric>`.
- `{n}` placeholder expands only to indices `1`, `2`, `3` (POSSIBLE_PHASE_INDICES).

## File Structure

**New files:**
- `vrm-mqtt/app/src/ha/observedPaths.ts` — `getObservedPaths()` helper (single source of truth for subscribe + observed paths)
- `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts` — unit tests for the helper

**Modified files:**
- `vrm-mqtt/app/src/ha/entityDefs.ts` — add `forward` to base, `CustomAggregateEntityDef` type, `CUSTOM_AGGREGATES` array, `CUSTOM_AGGREGATE_DEFS` registry; remove `aggregateFrom` from `SensorEntityDef`; move aggregates out of `SYSTEM_ENTITIES`; mark forward on battery sensors + new aggregates
- `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts` — accept `customAggregates` parameter, gate normal entities by `forward: true`, post-pass for custom aggregates
- `vrm-mqtt/app/src/ha/InstallationDevice.ts` — drop `INSTALLATION_PATHS` constant, call `getObservedPaths()`, pass `CUSTOM_AGGREGATE_DEFS.system`
- `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` — derive subscribe topics, build aggregator from `CUSTOM_AGGREGATE_DEFS`, gate `handleMessage` forward by forwardPaths Set
- `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts` — update existing aggregate tests for new paths, add forward-flag tests
- `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` — flip L-phase forward assertion, add Z/Aggregate/Pv/Power test
- `vrm-mqtt/DOCS.md` — update discovery example, add extension note

---

## Task 1: Update entityDefs.ts — data model + new aggregates registry

**Files:**
- Modify: `vrm-mqtt/app/src/ha/entityDefs.ts:6-22` (EntityDefBase), `:24-46` (SensorEntityDef), `:166-233` (SYSTEM_ENTITIES), `:320-323` (SERVICE_ENTITY_DEFS)
- Test: `vrm-mqtt/app/src/ha/__tests__/entityDefs.test.ts` (new — basic shape assertions)

**Interfaces:**
- Consumes: nothing (foundational)
- Produces:
  - `EntityDefBase.forward?: boolean` (default false)
  - `interface CustomAggregateEntityDef { path, name, aggregateFrom: string[], unit?, deviceClass?, stateClass?, precision?, forward?: boolean }`
  - `export const CUSTOM_AGGREGATE_DEFS: Partial<Record<VrmServiceName, readonly CustomAggregateEntityDef[]>>` (keyed by service; `system` populated)

- [ ] **Step 1: Write the failing test**

Create `vrm-mqtt/app/src/ha/__tests__/entityDefs.test.ts`:

```typescript
import { SERVICE_ENTITY_DEFS, CUSTOM_AGGREGATE_DEFS } from '../entityDefs';
import type { SensorEntityDef, CustomAggregateEntityDef } from '../entityDefs';

describe('entityDefs', () => {
  describe('forward flag defaults', () => {
    it('SYSTEM_ENTITIES entities default to no forward flag (treated as false)', () => {
      const batterySoc = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Dc/Battery/Soc',
      );
      expect(batterySoc).toBeDefined();
      // Battery SOC must explicitly opt in via forward: true.
      expect((batterySoc as SensorEntityDef).forward).toBe(true);
    });

    it('per-phase L{n}/Power entities default to no forward flag', () => {
      const gridL1 = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Ac/Grid/L{n}/Power',
      );
      expect(gridL1).toBeDefined();
      expect((gridL1 as SensorEntityDef).forward).toBeUndefined();
    });

    it('Dc/Pv/Power entity has no forward flag (aggregate source only)', () => {
      const dcPv = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Dc/Pv/Power',
      );
      expect(dcPv).toBeDefined();
      expect((dcPv as SensorEntityDef).forward).toBeUndefined();
    });
  });

  describe('CUSTOM_AGGREGATE_DEFS', () => {
    it('contains the four expected system aggregates', () => {
      const aggs = CUSTOM_AGGREGATE_DEFS.system ?? [];
      const paths = aggs.map((a) => a.path).sort();
      expect(paths).toEqual([
        'Z/Aggregate/Ac/Consumption/Power',
        'Z/Aggregate/Ac/Genset/Power',
        'Z/Aggregate/Ac/Grid/Power',
        'Z/Aggregate/Pv/Power',
      ]);
    });

    it('all system aggregates have aggregateFrom and forward: true', () => {
      for (const agg of CUSTOM_AGGREGATE_DEFS.system ?? []) {
        expect(agg.aggregateFrom.length).toBeGreaterThan(0);
        expect((agg as CustomAggregateEntityDef).forward).toBe(true);
      }
    });

    it('Z/Aggregate/Pv/Power combines DC PV and both AC PV sources', () => {
      const pv = (CUSTOM_AGGREGATE_DEFS.system ?? []).find(
        (a) => a.path === 'Z/Aggregate/Pv/Power',
      );
      expect(pv).toBeDefined();
      expect(pv!.aggregateFrom).toEqual([
        'Dc/Pv/Power',
        'Ac/PvOnOutput/L{n}/Power',
        'Ac/PvOnGrid/L{n}/Power',
      ]);
    });

    it('no longer has Ac/PvOnOutput/AggPower or Ac/PvOnGrid/AggPower', () => {
      const aggs = CUSTOM_AGGREGATE_DEFS.system ?? [];
      expect(aggs.find((a) => a.path === 'Ac/PvOnOutput/AggPower')).toBeUndefined();
      expect(aggs.find((a) => a.path === 'Ac/PvOnGrid/AggPower')).toBeUndefined();
    });

    it('SYSTEM_ENTITIES no longer contains any aggregate entries', () => {
      for (const def of SERVICE_ENTITY_DEFS.system ?? []) {
        expect('aggregateFrom' in def).toBe(false);
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `vrm-mqtt/app/`:
```bash
npm test -- --testPathPattern entityDefs.test
```

Expected: FAIL (no `forward` on `Dc/Battery/Soc`, no `CUSTOM_AGGREGATE_DEFS`, aggregates still in `SYSTEM_ENTITIES`).

- [ ] **Step 3: Update `EntityDefBase` and `SensorEntityDef` in `entityDefs.ts`**

Edit `vrm-mqtt/app/src/ha/entityDefs.ts`:

```typescript
interface EntityDefBase {
  /**
   * VRM dbus path relative to the service/instance prefix.
   * Use `{n}` as a placeholder for any dynamic numeric index, e.g.:
   *   `Dc/{n}/Voltage`   → matches Dc/0/Voltage, Dc/1/Voltage, Dc/2/Voltage …
   *   `Ac/L{n}/Power`    → matches Ac/L1/Power, Ac/L2/Power, Ac/L3/Power …
   *   `Relay/{n}/State`  → matches Relay/0/State, Relay/1/State …
   * Paths without `{n}` are static and produce exactly one entity.
   */
  path: string;
  /**
   * Human-readable name template shown in Home Assistant.
   * Use `{n}` at the same position as in `path` to carry the discovered index
   * through to the entity name, e.g. `AC L{n} Power` → "AC L2 Power".
   */
  name: string;
  /**
   * When true, the bridge subscribes to the VRM topic (when needed), emits an
   * HA discovery config, and publishes the value to HA. When false or omitted,
   * the entity may still be subscribed as an aggregate source but never
   * appears in HA.
   *
   * Default: false. New entities must explicitly opt in.
   */
  forward?: boolean;
}

export interface SensorEntityDef extends EntityDefBase {
  component: 'sensor';
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  stateClass?: HaStateClass;
  precision?: number;
  /** Populated when deviceClass is 'enum' — used to build the value_template. */
  enumValues?: Array<{ value: number; label: string }>;
}

/**
 * A derived sensor whose value is the sum of one or more source paths on the
 * VRM bus. Aggregate entities live in `CUSTOM_AGGREGATE_DEFS` (not in the
 * normal `SERVICE_ENTITY_DEFS` array) and have their own type so `aggregateFrom`
 * cannot be attached to a regular sensor by accident.
 *
 * Source paths may use `{n}` (expanded to indices 1, 2, 3) or be literal paths
 * (e.g. `Dc/Pv/Power`). The aggregate is the sum of source values that have
 * been observed at least once — a single-phase installation publishes a
 * one-phase sum, a three-phase installation publishes a three-phase sum.
 *
 * Aggregate entities MUST be subscribed for their sources to be observed,
 * regardless of their own `forward` flag.
 */
export interface CustomAggregateEntityDef {
  /** VRM dbus path the aggregate is published on, e.g. 'Z/Aggregate/Ac/Grid/Power'. */
  path: string;
  /** Human-readable name shown in Home Assistant. */
  name: string;
  /** Required. Source paths to sum. Templates use `{n}` → 1, 2, 3. */
  aggregateFrom: string[];
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  stateClass?: HaStateClass;
  precision?: number;
  /** Default false. When true, emit HA discovery and publish the value. */
  forward?: boolean;
}
```

- [ ] **Step 4: Move aggregates out of `SYSTEM_ENTITIES`, mark forward on battery sensors**

Edit `vrm-mqtt/app/src/ha/entityDefs.ts` `SYSTEM_ENTITIES`:

Replace the five aggregate entries (lines that look like `{ path: 'Ac/Consumption/AggPower', ... aggregateFrom: ['Ac/Consumption/L{n}/Power'] }` and the four similar ones) so they are removed from `SYSTEM_ENTITIES`. Specifically delete these entries:

```typescript
{ path: 'Ac/Consumption/AggPower', ... aggregateFrom: ['Ac/Consumption/L{n}/Power'] },
{ path: 'Ac/Grid/AggPower', ... aggregateFrom: ['Ac/Grid/L{n}/Power'] },
{ path: 'Ac/Genset/AggPower', ... aggregateFrom: ['Ac/Genset/L{n}/Power'] },
{ path: 'Ac/PvOnOutput/AggPower', ... aggregateFrom: ['Ac/PvOnOutput/L{n}/Power'] },
{ path: 'Ac/PvOnGrid/AggPower', ... aggregateFrom: ['Ac/PvOnGrid/L{n}/Power'] },
```

Update the three battery sensor entries so they carry `forward: true`:

```typescript
{ path: 'Dc/Battery/Soc', component: 'sensor', name: 'Battery SOC', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1, forward: true },
{ path: 'Dc/Battery/Voltage', component: 'sensor', name: 'Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3, forward: true },
{ path: 'Dc/Battery/State', component: 'sensor', name: 'Battery State', deviceClass: 'enum', enumValues: BATTERY_STATE_ENUM, forward: true },
```

`Dc/Pv/Power` and all other entries stay unchanged (no forward flag → defaults to false).

- [ ] **Step 5: Add `CUSTOM_AGGREGATES` array and `CUSTOM_AGGREGATE_DEFS` registry**

After the `PLATFORM_ENTITIES` constant, before `SERVICE_ENTITY_DEFS`, insert:

```typescript
// ── Custom aggregates registry ────────────────────────────────────────────────

const CUSTOM_AGGREGATES: CustomAggregateEntityDef[] = [
  { path: 'Z/Aggregate/Ac/Consumption/Power', name: 'AC Consumption Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Consumption/L{n}/Power'], forward: true },
  { path: 'Z/Aggregate/Ac/Grid/Power', name: 'Grid Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Grid/L{n}/Power'], forward: true },
  { path: 'Z/Aggregate/Ac/Genset/Power', name: 'Generator Aggregate Power',
    unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1,
    aggregateFrom: ['Ac/Genset/L{n}/Power'], forward: true },
  // Combined PV total — DC + both AC PV sources.
  // Supersedes the dropped Ac/PvOnOutput/AggPower and Ac/PvOnGrid/AggPower.
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

- [ ] **Step 6: Run the test to verify it passes**

Run from `vrm-mqtt/app/`:
```bash
npm test -- --testPathPattern entityDefs.test
```

Expected: PASS for all 8 assertions.

- [ ] **Step 7: Run typecheck to confirm no compile errors**

```bash
npm run typecheck
```

Expected: no errors. (Other modules still reference `def.aggregateFrom`; typecheck passes because `forward?: boolean` is the only new field and removing `aggregateFrom` from `SensorEntityDef` is the next task's fallout — but consumers should already be updated by Step 4 since SYSTEM_ENTITIES no longer has any `aggregateFrom`. If typecheck reports errors in `MqttBridgeConnection.ts` or `DiscoveryConfigBuilder.ts`, those are fixed in later tasks; ignore for now if they're the only failures.)

If typecheck reports errors in unrelated files (e.g. `MqttBridgeConnection.ts` reading `def.aggregateFrom`), stop here and continue to Task 2 — those are addressed by the next tasks. Note the specific errors but don't fix them yet.

- [ ] **Step 8: Commit**

```bash
cd vrm-mqtt/app
git add src/ha/entityDefs.ts src/ha/__tests__/entityDefs.test.ts
git commit -m "feat(entityDefs): add forward flag + CustomAggregateEntityDef registry"
```

---

## Task 2: Create observedPaths.ts helper

**Files:**
- Create: `vrm-mqtt/app/src/ha/observedPaths.ts`
- Test: `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`

**Interfaces:**
- Consumes: `SERVICE_ENTITY_DEFS` (from `./entityDefs`), `CUSTOM_AGGREGATE_DEFS` (from `./entityDefs`)
- Produces: `export function getObservedPaths(): string[]` — sorted, deduplicated, `{n}`-expanded union of forward paths + aggregate sources

- [ ] **Step 1: Write the failing test**

Create `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`:

```typescript
import { getObservedPaths } from '../observedPaths';

describe('getObservedPaths', () => {
  it('returns a sorted array', () => {
    const result = getObservedPaths();
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it('contains no duplicates', () => {
    const result = getObservedPaths();
    expect(new Set(result).size).toBe(result.length);
  });

  it('expands {n} to 1, 2, 3 for normal-entity path templates', () => {
    const result = getObservedPaths();
    // Ac/Grid/L{n}/Power is the template for the per-phase power entity.
    // As an aggregate source for Z/Aggregate/Ac/Grid/Power it must be in the set.
    expect(result).toContain('Ac/Grid/L1/Power');
    expect(result).toContain('Ac/Grid/L2/Power');
    expect(result).toContain('Ac/Grid/L3/Power');
  });

  it('includes forward: true normal entities as literal paths', () => {
    const result = getObservedPaths();
    // After Task 1, Dc/Battery/Soc, Voltage, State all have forward: true.
    expect(result).toContain('Dc/Battery/Soc');
    expect(result).toContain('Dc/Battery/Voltage');
    expect(result).toContain('Dc/Battery/State');
  });

  it('includes literal aggregate sources regardless of the aggregate forward flag', () => {
    const result = getObservedPaths();
    // Dc/Pv/Power is a literal source for Z/Aggregate/Pv/Power.
    expect(result).toContain('Dc/Pv/Power');
  });

  it('does NOT include paths for normal entities without forward: true', () => {
    const result = getObservedPaths();
    // Ac/Grid/L{n}/Current is defined but NOT forward: true and not an aggregate source.
    expect(result).not.toContain('Ac/Grid/L1/Current');
    expect(result).not.toContain('Ac/Grid/L2/Current');
    expect(result).not.toContain('Ac/Grid/L3/Current');
  });

  it('includes aggregate targets (forward: true custom aggregates themselves)', () => {
    const result = getObservedPaths();
    // The aggregate targets are NOT observed paths on the bus — they are HA-published topics.
    // getObservedPaths returns bus-side paths only.
    expect(result).not.toContain('Z/Aggregate/Ac/Grid/Power');
    expect(result).not.toContain('Z/Aggregate/Pv/Power');
  });

  it('does not include non-system-service entities', () => {
    const result = getObservedPaths();
    // vebus / platform entities are not system/0 — they must not leak in.
    // Ac/Out/L{n}/P is a vebus entity, not a system entity.
    expect(result).not.toContain('Ac/Out/L1/P');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern observedPaths.test
```

Expected: FAIL — `getObservedPaths` does not exist.

- [ ] **Step 3: Implement `getObservedPaths`**

Create `vrm-mqtt/app/src/ha/observedPaths.ts`:

```typescript
import { SERVICE_ENTITY_DEFS, CUSTOM_AGGREGATE_DEFS } from './entityDefs';

/**
 * L-phase indices that `{n}` expands to when computing VRM-side topic paths.
 * Matches the existing convention in MqttBridgeConnection.
 */
const POSSIBLE_PHASE_INDICES = ['1', '2', '3'] as const;

/**
 * Expand a single template path. Templates containing `{n}` are expanded to
 * the three standard L-phase indices. Literal templates are returned as-is.
 */
function expandTemplate(template: string): string[] {
  if (!template.includes('{n}')) return [template];
  return POSSIBLE_PHASE_INDICES.map((n) => template.replace('{n}', n));
}

/**
 * Expand a list of templates, returning the deduplicated sorted union.
 */
function expandAll(templates: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const t of templates) {
    for (const p of expandTemplate(t)) {
      expanded.add(p);
    }
  }
  return [...expanded].sort();
}

/**
 * Return the union of every VRM-side path the bridge ever sees on the bus,
 * sorted and deduplicated. Used as:
 *   - the source list for the VRM MQTT subscription
 *   - the observed-paths list for HA discovery template expansion
 *
 * Sources:
 *   1. Every `path` field from forward: true entities in SERVICE_ENTITY_DEFS
 *      (template-expanded).
 *   2. Every `aggregateFrom` entry from CUSTOM_AGGREGATE_DEFS (template-expanded).
 *      Aggregate sources are included regardless of the aggregate's own
 *      `forward` flag — the sources must be subscribed even when the
 *      aggregate is not published.
 *
 * Currently only the `system` service is bridged, so this helper returns only
 * system paths. The registry structure supports extending to other services
 * without API changes.
 */
export function getObservedPaths(): string[] {
  const systemEntities = SERVICE_ENTITY_DEFS.system ?? [];
  const customAggregates = CUSTOM_AGGREGATE_DEFS.system ?? [];

  const forwardPaths = new Set<string>();
  for (const def of systemEntities) {
    if (!def.forward) continue;
    for (const p of expandTemplate(def.path)) {
      forwardPaths.add(p);
    }
  }

  const aggregateSources = new Set<string>();
  for (const agg of customAggregates) {
    for (const p of expandAll(agg.aggregateFrom)) {
      aggregateSources.add(p);
    }
  }

  const union = new Set<string>([...forwardPaths, ...aggregateSources]);
  return [...union].sort();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern observedPaths.test
```

Expected: PASS for all 8 assertions.

- [ ] **Step 5: Commit**

```bash
cd vrm-mqtt/app
git add src/ha/observedPaths.ts src/ha/__tests__/observedPaths.test.ts
git commit -m "feat(observedPaths): add getObservedPaths helper"
```

---

## Task 3: Update DiscoveryConfigBuilder — apply forward filter, accept customAggregates

**Files:**
- Modify: `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts:15-48` (buildDiscoveryConfigs body), `:50-69` (expandAggregateSourcePaths — extend with literal-only mode if needed)
- Test: `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts` (extend existing)

**Interfaces:**
- Consumes: `getObservedPaths()` from `./observedPaths`, `CUSTOM_AGGREGATE_DEFS` from `./entityDefs`, existing `matchTemplateIndices`
- Produces: `buildDiscoveryConfigs(idSite, service, instance, meta, observedPaths, customAggregates?)` — new `customAggregates` parameter (defaults to `[]`); only forward: true entities emit configs; custom aggregates get their own post-pass

- [ ] **Step 1: Update existing aggregate tests to use new paths**

Edit `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts`. Inside the `describe('aggregate sensors', ...)` block (line 200), update assertions to the new path names:

```typescript
describe('aggregate sensors', () => {
  describe('Z/Aggregate/Ac/Grid/Power', () => {
    it('emits a sensor when at least one L-phase grid power path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Grid/L1/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_grid_power'));
      expect(agg).toBeDefined();
    });

    it('points state_topic at the aggregate path', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Grid/L1/Power',
        'Ac/Grid/L2/Power',
        'Ac/Grid/L3/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_grid_power'));
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Z/Aggregate/Ac/Grid/Power`);
    });

    it('inherits the source unit, device_class, and state_class', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Grid/L1/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_grid_power')) as HaSensorConfig;
      expect(agg?.unit_of_measurement).toBe('W');
      expect(agg?.device_class).toBe('power');
      expect(agg?.state_class).toBe('measurement');
    });

    it('omits the aggregate when no L-phase grid power path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Dc/Pv/Power',
        'Dc/Battery/Soc',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_grid_power'));
      expect(agg).toBeUndefined();
    });

    it('uses the standard numeric value_template (bridge publishes the sum)', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Grid/L1/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_grid_power'));
      expect(agg?.value_template).toBe(
        "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
      );
    });
  });

  describe('Z/Aggregate/Ac/Consumption/Power', () => {
    it('emits a sensor when at least one L-phase consumption path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Consumption/L1/Power',
        'Ac/Consumption/L2/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_consumption_power'));
      expect(agg).toBeDefined();
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Z/Aggregate/Ac/Consumption/Power`);
    });
  });

  describe('Z/Aggregate/Ac/Genset/Power', () => {
    it('emits a sensor when at least one L-phase genset path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
        'Ac/Genset/L3/Power',
      ]);
      const agg = configs.find(c => c.unique_id === v('system_0_z_aggregate_ac_genset_power'));
      expect(agg).toBeDefined();
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Z/Aggregate/Ac/Genset/Power`);
    });
  });

  it('non-aggregate entity defs (no aggregateFrom) are unaffected by the aggregate branch', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Battery/Soc']);
    const soc = configs.find(c => c.unique_id === v('system_0_dc_battery_soc'));
    expect(soc).toBeDefined();
    expect(soc?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });
});
```

These tests reference `buildDiscoveryConfigs(idSite, service, instance, meta, observedPaths)` — the new signature adds a 6th optional `customAggregates` parameter. The existing call sites stay valid. The aggregates must now come from the `customAggregates` argument, which the existing tests don't pass — so they will fail until the next step wires it up.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern DiscoveryConfigBuilder.test
```

Expected: FAIL — aggregate emissions rely on `customAggregates` parameter being passed.

- [ ] **Step 3: Update the `entityDefs` import to also import the new registry**

Edit `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts:3`:

```typescript
import { SERVICE_ENTITY_DEFS, CUSTOM_AGGREGATE_DEFS } from './entityDefs';
```

- [ ] **Step 4: Update `buildDiscoveryConfigs` signature and body**

Replace the function (DiscoveryConfigBuilder.ts:15-48) with:

```typescript
export function buildDiscoveryConfigs(
  idSite: number,
  service: VrmServiceName,
  instance: string | number,
  meta: DeviceMeta,
  observedPaths: string[],
  customAggregates: readonly CustomAggregateEntityDef[] = [],
): HaDiscoveryConfig[] {
  const defs = SERVICE_ENTITY_DEFS[service];
  if (!defs) return [];

  const device = buildDevice(idSite, service, instance, meta);
  const configs: HaDiscoveryConfig[] = [];
  const pathSet = new Set(observedPaths);

  // Normal entities — only those with forward: true are surfaced to HA.
  for (const def of defs) {
    if (!def.forward) continue;
    if (def.path.includes('{n}')) {
      for (const n of matchTemplateIndices(def.path, observedPaths)) {
        configs.push(entityToConfig(idSite, service, instance, device, def, n));
      }
    } else if (pathSet.has(def.path)) {
      configs.push(entityToConfig(idSite, service, instance, device, def));
    }
  }

  // Custom aggregates — same gating as the old aggregate branch.
  // Only forward: true aggregates with at least one observed source emit configs.
  for (const agg of customAggregates) {
    if (!agg.forward) continue;
    if (expandAggregateSourcePaths(agg.aggregateFrom, observedPaths).length > 0) {
      configs.push(entityToConfig(idSite, service, instance, device, agg));
    }
  }

  return configs;
}
```

- [ ] **Step 5: Update existing tests' call sites to pass `customAggregates`**

Update the four aggregate tests (lines 202-247, 251-258, 263-269) to pass the new aggregate list. Replace each call like:

```typescript
buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Ac/Grid/L1/Power'])
```

with:

```typescript
buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Ac/Grid/L1/Power'], CUSTOM_AGGREGATE_DEFS.system ?? [])
```

Add the import at the top of the test file:

```typescript
import { CUSTOM_AGGREGATE_DEFS } from '../entityDefs';
```

There are 5 call sites that need this — search for `buildDiscoveryConfigs(ID_SITE, 'system', 0, META` and add the trailing `, CUSTOM_AGGREGATE_DEFS.system ?? []` to each.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern DiscoveryConfigBuilder.test
```

Expected: PASS for all 30+ assertions.

- [ ] **Step 7: Add new tests for forward-flag and custom-aggregate behavior**

Append to `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts`:

```typescript
// ── forward flag ─────────────────────────────────────────────────────────────

describe('forward flag', () => {
  it('emits forward: true normal entities when their path is observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Battery/Soc'], CUSTOM_AGGREGATE_DEFS.system ?? []);
    const soc = configs.find(c => c.unique_id === v('system_0_dc_battery_soc'));
    expect(soc).toBeDefined();
  });

  it('omits normal entities without forward: true even when observed', () => {
    // Dc/Pv/Power is no longer forward: true.
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Pv/Power'], CUSTOM_AGGREGATE_DEFS.system ?? []);
    const dcPv = configs.find(c => c.unique_id === v('system_0_dc_pv_power'));
    expect(dcPv).toBeUndefined();
  });

  it('omits per-phase L{n} entities (no forward: true) even when observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
      'Ac/Grid/L1/Power',
      'Ac/Grid/L2/Power',
      'Ac/Grid/L3/Power',
    ], CUSTOM_AGGREGATE_DEFS.system ?? []);
    // No individual L{n}/Power configs — only the aggregate.
    const lphase = configs.find(c => c.unique_id === v('system_0_ac_grid_l1_power'));
    expect(lphase).toBeUndefined();
    const lphase2 = configs.find(c => c.unique_id === v('system_0_ac_grid_l2_power'));
    expect(lphase2).toBeUndefined();
    const lphase3 = configs.find(c => c.unique_id === v('system_0_ac_grid_l3_power'));
    expect(lphase3).toBeUndefined();
  });

  it('emits Z/Aggregate/Pv/Power when both DC and AC PV sources are observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
      'Dc/Pv/Power',
      'Ac/PvOnOutput/L1/Power',
      'Ac/PvOnGrid/L1/Power',
    ], CUSTOM_AGGREGATE_DEFS.system ?? []);
    const pv = configs.find(c => c.unique_id === v('system_0_z_aggregate_pv_power'));
    expect(pv).toBeDefined();
    expect(pv?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Z/Aggregate/Pv/Power`);
  });

  it('emits Z/Aggregate/Pv/Power even when only one AC PV source is observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
      'Dc/Pv/Power',
      'Ac/PvOnOutput/L1/Power',
    ], CUSTOM_AGGREGATE_DEFS.system ?? []);
    const pv = configs.find(c => c.unique_id === v('system_0_z_aggregate_pv_power'));
    expect(pv).toBeDefined();
  });

  it('emits exactly the expected system/0 entities (3 battery + 4 aggregates)', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, [
      'Dc/Battery/Soc',
      'Dc/Battery/Voltage',
      'Dc/Battery/State',
      'Dc/Pv/Power',
      'Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power',
      'Ac/Consumption/L1/Power',
      'Ac/Genset/L1/Power',
      'Ac/PvOnOutput/L1/Power',
      'Ac/PvOnGrid/L1/Power',
    ], CUSTOM_AGGREGATE_DEFS.system ?? []);
    const uniqueIds = configs.map(c => c.unique_id).sort();
    expect(uniqueIds).toEqual([
      v('system_0_dc_battery_soc'),
      v('system_0_dc_battery_state'),
      v('system_0_dc_battery_voltage'),
      v('system_0_z_aggregate_ac_consumption_power'),
      v('system_0_z_aggregate_ac_genset_power'),
      v('system_0_z_aggregate_ac_grid_power'),
      v('system_0_z_aggregate_pv_power'),
    ].sort());
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern DiscoveryConfigBuilder.test
```

Expected: PASS for all assertions including the new ones.

- [ ] **Step 9: Commit**

```bash
cd vrm-mqtt/app
git add src/ha/DiscoveryConfigBuilder.ts src/ha/__tests__/DiscoveryConfigBuilder.test.ts
git commit -m "feat(discovery): gate entities by forward flag, emit custom aggregates"
```

---

## Task 4: Update InstallationDevice — use getObservedPaths, pass custom aggregates

**Files:**
- Modify: `vrm-mqtt/app/src/ha/InstallationDevice.ts:9-29` (drop INSTALLATION_PATHS), `:46-64` (buildInstallationDiscovery)
- Test: covered by existing tests; verify by running

**Interfaces:**
- Consumes: `getObservedPaths()` from `./observedPaths`, `CUSTOM_AGGREGATE_DEFS` from `./entityDefs`
- Produces: updated `buildInstallationDiscovery` that derives observed paths and includes custom aggregates

- [ ] **Step 1: Drop `INSTALLATION_PATHS` constant**

Edit `vrm-mqtt/app/src/ha/InstallationDevice.ts`: delete lines 5-29 (the `INSTALLATION_PATHS` constant and its docstring) and update the import section to:

```typescript
import { buildDiscoveryConfigs } from './DiscoveryConfigBuilder';
import { CUSTOM_AGGREGATE_DEFS } from './entityDefs';
import { getObservedPaths } from './observedPaths';
import type { HaComponent, HaDeviceDiscoveryComponent, HaDeviceDiscoveryPayload, HaDiscoveryConfig } from './types';
```

- [ ] **Step 2: Update `buildInstallationDiscovery` to use the helper**

Replace `buildInstallationDiscovery` (InstallationDevice.ts:46-64) with:

```typescript
/**
 * Build the HA device discovery payload for one VRM installation.
 *
 * The set of entity configs is derived from the entity defs and custom
 * aggregates — see `getObservedPaths` for the derivation rule.
 */
export function buildInstallationDiscovery(
  idSite: number,
  installationName: string,
  appVersion: string,
): HaDeviceDiscoveryPayload {
  const meta = { productName: 'Victron Energy', customName: installationName };
  const configs = buildDiscoveryConfigs(
    idSite, 'system', 0, meta,
    getObservedPaths(),
    CUSTOM_AGGREGATE_DEFS.system ?? [],
  );

  return {
    device: {
      identifiers: [`vrm_${idSite}`],
      name: installationName,
      manufacturer: 'Victron Energy',
      model: 'Victron Energy System',
    },
    origin: { name: 'vrm-mqtt', sw_version: appVersion },
    availability_topic: `vrm/${idSite}/availability`,
    components: toComponents(configs),
  };
}
```

- [ ] **Step 3: Search for any remaining references to `INSTALLATION_PATHS`**

```bash
cd vrm-mqtt/app && grep -rn "INSTALLATION_PATHS" src/ test/ 2>/dev/null
```

Expected: no matches (the constant is only used internally).

- [ ] **Step 4: Run the full test suite**

```bash
cd vrm-mqtt/app && npm test
```

Expected: every existing test still passes. `DiscoveryPublisher.test.ts` may have references to the old behavior — see below.

- [ ] **Step 5: Check `DiscoveryPublisher.test.ts` for snapshot expectations**

If `DiscoveryPublisher.test.ts` (in `vrm-mqtt/app/src/ha/__tests__/`) references a specific number of components or specific entity IDs in the discovery payload, update those expectations to match the new derived set (7 entities: 3 battery + 4 aggregates). Read the test file and adjust any hardcoded counts or IDs.

Run:
```bash
cd vrm-mqtt/app && grep -n "Ac/Grid/AggPower\|Ac/Consumption/AggPower\|Ac/Genset/AggPower\|Ac/PvOn" src/ha/__tests__/DiscoveryPublisher.test.ts
```

For each match, update the expected unique_id to the new slug (`z_aggregate_ac_grid_power`, etc.).

- [ ] **Step 6: Commit**

```bash
cd vrm-mqtt/app
git add src/ha/InstallationDevice.ts src/ha/__tests__/DiscoveryPublisher.test.ts
git commit -m "feat(installationDevice): derive observed paths from entity defs"
```

---

## Task 5: Update MqttBridgeConnection — derive subscribe, use custom aggregates, gate forward

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:1-39` (imports + drop local expandAggregateSourcePaths + drop POSSIBLE_PHASE_INDICES), `:60-87` (constructor + forwardPaths), `:149-162` (buildSubscribeTopics), `:219-238` (handleMessage), `:240-259` (buildAggregator)
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts:748` (flip forward assertion), aggregate section (add Z/Aggregate/Pv/Power test), retained-clear section (verify only forwarded cleared)

**Interfaces:**
- Consumes: `getObservedPaths()` from `../ha/observedPaths`, `CUSTOM_AGGREGATE_DEFS` from `../ha/entityDefs`
- Produces: MqttBridgeConnection that derives subscribe topics, builds aggregator from custom aggregates, gates `handleMessage` by forwardPaths

- [ ] **Step 1: Update imports and replace local helpers**

Edit `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:1-39`. Replace the top of the file (imports + local helpers) with:

```typescript
import type { MqttClient } from 'mqtt';
import type { VrmInstallation } from './types';
import { MessageThrottle } from './MessageThrottle';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { HaBrokerClient } from '../ha/HaBrokerClient';
import { parseVrmTopic, routeFromVrm } from '../ha/MessageRouter';
import { VrmBrokerPool } from './VrmBrokerPool';
import { AggregateProcessor, type AggregateRule } from './AggregateProcessor';
import { SERVICE_ENTITY_DEFS, CUSTOM_AGGREGATE_DEFS } from '../ha/entityDefs';
import { getObservedPaths } from '../ha/observedPaths';

const POSSIBLE_PHASE_INDICES = ['1', '2', '3'] as const;

/**
 * Expand a list of aggregate source templates. Templates containing `{n}`
 * are expanded to indices 1, 2, 3; literal templates are kept as-is.
 * Result is sorted and deduplicated.
 *
 * Used at aggregator-build time. Differs from
 * DiscoveryConfigBuilder.expandAggregateSourcePaths in that this helper does
 * NOT filter by observed paths — at startup we wire up every possible source
 * so the aggregator is ready the moment a phase comes online.
 */
function expandAggregateSourcePaths(templates: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const t of templates) {
    if (t.includes('{n}')) {
      for (const n of POSSIBLE_PHASE_INDICES) {
        expanded.add(t.replace('{n}', n));
      }
    } else {
      expanded.add(t);
    }
  }
  return [...expanded].sort();
}
```

The old `expandAggregateSourcePaths(def: SensorEntityDef)` (line 27-39) is gone — the new signature takes `readonly string[]` and is called from `buildAggregator` (Step 6).

- [ ] **Step 2: Add `forwardPaths` set construction**

Edit the class field declarations (around `MqttBridgeConnection.ts:64`) to add `forwardPaths`:

After `private readonly aggregator: AggregateProcessor;`, add:

```typescript
  /** Paths the bridge forwards to HA (verbatim VRM message → vrm/{idSite}/...).
   *  Built once at construction from SERVICE_ENTITY_DEFS + CUSTOM_AGGREGATE_DEFS.
   *  Only paths with forward: true end up here. */
  private readonly forwardPaths: ReadonlySet<string>;
```

In the constructor, after `this.aggregator = this.buildAggregator();` (line 87), add:

```typescript
    this.forwardPaths = computeForwardPaths();
```

- [ ] **Step 3: Add the `computeForwardPaths` helper**

Insert near the top of the file (after the imports, before `MqttBridgeConnectionOptions`):

```typescript
/**
 * Build the set of paths that the bridge forwards to HA. A path is forwarded
 * if and only if:
 *   - it is the `path` of a forward: true normal entity (template-expanded
 *     to L-phase indices), OR
 *   - it is the `path` of a forward: true custom aggregate (template-expanded
 *     the same way).
 *
 * Note: this is the set of HA-side topics we publish on, derived from entity
 * `path`s. It is NOT the same as `getObservedPaths()` — that returns the
 * VRM-side topics we subscribe to (which also includes aggregate sources).
 */
function computeForwardPaths(): ReadonlySet<string> {
  const indices = ['1', '2', '3'] as const;
  const expand = (template: string): string[] =>
    template.includes('{n}')
      ? indices.map((n) => template.replace('{n}', n))
      : [template];
  const set = new Set<string>();
  for (const def of SERVICE_ENTITY_DEFS.system ?? []) {
    if (!def.forward) continue;
    for (const p of expand(def.path)) set.add(p);
  }
  for (const agg of CUSTOM_AGGREGATE_DEFS.system ?? []) {
    if (!agg.forward) continue;
    for (const p of expand(agg.path)) set.add(p);
  }
  return set;
}
```

- [ ] **Step 4: Replace `buildSubscribeTopics` with derived version**

Replace `buildSubscribeTopics()` (MqttBridgeConnection.ts:149-162) with:

```typescript
  private buildSubscribeTopics(): string[] {
    const id = this.installation.brokerPortalId;
    return getObservedPaths().map((path) => `N/${id}/system/0/${path}`);
  }
```

- [ ] **Step 5: Update `handleMessage` to gate forwarding by `forwardPaths`**

Replace `handleMessage` (MqttBridgeConnection.ts:219-238) with:

```typescript
  private handleMessage(topic: string, payload: Buffer): void {
    if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;

    const str = payload.toString();
    const parsed = parseVrmTopic(topic);
    if (!parsed) return;

    // Aggregate feed — always run for every parsed topic. The aggregator
    // no-ops on untracked paths.
    for (const agg of this.aggregator.feedPayload(parsed.path, str)) {
      this.publishedStateTopics.add(agg.topic);
      this.throttle.enqueue(agg.topic, agg.payload);
    }

    // HA forward — only for forward: true entities.
    if (this.forwardPaths.has(parsed.path)) {
      const out = routeFromVrm(topic, str, this.getIdSite);
      for (const msg of out) {
        this.publishedStateTopics.add(msg.topic);
        this.throttle.enqueue(msg.topic, msg.payload);
      }
    }
  }
```

Note: `routeFromVrm` already handles empty payloads (returns []) and unknown brokerPortalIds (returns []) — no need to re-check.

- [ ] **Step 6: Replace `buildAggregator` to use custom aggregates**

Replace `buildAggregator` (MqttBridgeConnection.ts:240-259) with:

```typescript
  /**
   * Build an AggregateProcessor from CUSTOM_AGGREGATE_DEFS['system'].
   * Only forward: true aggregates are wired up — non-forward aggregates
   * are still subscribed (their sources are in getObservedPaths) but the
   * processor never produces output for them.
   *
   * Source-path templates are expanded using the same L-phase indices
   * that getObservedPaths() uses for subscription. Literal templates are
   * kept as-is. The processor's observed-sources set then narrows the sum
   * to whichever phases actually report on this installation.
   */
  private buildAggregator(): AggregateProcessor {
    const rules: AggregateRule[] = [];
    for (const def of CUSTOM_AGGREGATE_DEFS.system ?? []) {
      if (!def.forward) continue;
      const sourcePaths = expandAggregateSourcePaths(def.aggregateFrom);
      if (sourcePaths.length === 0) continue;
      rules.push({
        targetTopic: `vrm/${this.installation.idSite}/system/0/${def.path}`,
        sourcePaths,
      });
    }
    return new AggregateProcessor(rules);
  }
```

The local `expandAggregateSourcePaths(templates: readonly string[])` and `POSSIBLE_PHASE_INDICES` constants are already defined at the top of the file (Step 1).

- [ ] **Step 7: Run typecheck**

```bash
cd vrm-mqtt/app && npm run typecheck
```

Expected: no errors. The unused `SensorEntityDef` import can be removed if lint complains — check after running lint.

- [ ] **Step 8: Run the MqttBridgeConnection tests**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern MqttBridgeConnection.test
```

Expected: failures in the "forwards the raw L-phase message AND the aggregate to HA" test (line 748) and the aggregate topic assertions (now `Ac/Grid/AggPower` → `Z/Aggregate/Ac/Grid/Power`).

- [ ] **Step 9: Update the failing tests**

Edit `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts:748-763`. Replace the test with:

```typescript
    it('does NOT forward raw L-phase message to HA, but DOES forward the aggregate', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);

      // Raw L1 topic MUST NOT be published to HA (forward: false).
      expect(ha.publish).not.toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Ac/Grid/L1/Power`,
        expect.anything(),
      );
      // Aggregate IS published.
      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Z/Aggregate/Ac/Grid/Power`,
        '{"value":100}',
      );
    });
```

In the aggregate section, update topic references from `Ac/Grid/AggPower` → `Z/Aggregate/Ac/Grid/Power`, `Ac/Consumption/AggPower` → `Z/Aggregate/Ac/Consumption/Power`, `Ac/Genset/AggPower` → `Z/Aggregate/Ac/Genset/Power`. Each appears in the form:

```typescript
const aggTopic = `vrm/${idSite}/system/0/Ac/Grid/AggPower`;
```

Replace these with:

```typescript
const aggTopic = `vrm/${idSite}/system/0/Z/Aggregate/Ac/Grid/Power`;
```

(and analogously for Consumption/Genset). There are 4 such references in the file — grep for `Ac/.*AggPower` to find them all.

- [ ] **Step 10: Add a test for the combined Z/Aggregate/Pv/Power**

Append to the `describe('aggregate sensors', ...)` block in `MqttBridgeConnection.test.ts` (before its closing `});` at line 784):

```typescript
    it('publishes Z/Aggregate/Pv/Power from DC + AC sources', () => {
      const { client, ha } = makeActiveConn();
      const aggTopic = `vrm/${idSite}/system/0/Z/Aggregate/Pv/Power`;

      emit(client, `N/${portalId}/system/0/Dc/Pv/Power`, '{"value":800}');
      emit(client, `N/${portalId}/system/0/Ac/PvOnOutput/L1/Power`, '{"value":100}');
      emit(client, `N/${portalId}/system/0/Ac/PvOnGrid/L1/Power`, '{"value":50}');
      jest.advanceTimersByTime(INTERVAL);

      // 800 + 100 + 50 = 950
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(950);
    });

    it('Z/Aggregate/Pv/Power does not include Dc/Pv/Power as a forwarded topic', () => {
      // The per-source Dc/Pv/Power has forward: false. The bridge subscribes
      // to it (for the aggregate) but never publishes it to HA.
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Dc/Pv/Power`, '{"value":800}');
      jest.advanceTimersByTime(INTERVAL);

      expect(ha.publish).not.toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Dc/Pv/Power`,
        expect.anything(),
      );
    });
```

- [ ] **Step 11: Update the retained-clear tests**

In `MqttBridgeConnection.test.ts:765-783` (`clears the aggregate buffer on stop() so a stale value is not retained`), the topic must change to the new aggregate path:

```typescript
      const aggTopic = `vrm/${idSite}/system/0/Z/Aggregate/Ac/Grid/Power`;
```

Also add a test asserting that subscribed-but-not-forwarded topics (L-phase) are NOT cleared on stop:

Insert after the retained-clear tests:

```typescript
    it('does NOT clear retained state for subscribed-but-not-forwarded topics', async () => {
      // Ac/Grid/L1/Power is subscribed (needed as aggregate source) but
      // forward: false — the bridge never publishes it, so stop() must
      // not emit an empty-retained clear for it.
      const { client, ha, conn } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);

      (ha.publish as jest.Mock).mockClear();
      await conn.stop();

      const lphaseClear = (ha.publish as jest.Mock).mock.calls.filter(
        ([t]: [string]) => t === `vrm/${idSite}/system/0/Ac/Grid/L1/Power`,
      );
      expect(lphaseClear).toEqual([]);
    });
```

- [ ] **Step 12: Run all MqttBridgeConnection tests**

```bash
cd vrm-mqtt/app && npm test -- --testPathPattern MqttBridgeConnection.test
```

Expected: PASS for every test in the file, including the new Z/Aggregate/Pv/Power tests and the L-phase-no-clear test.

- [ ] **Step 13: Run the full suite + lint + typecheck**

```bash
cd vrm-mqtt/app && npm test && npm run lint && npm run typecheck
```

Expected: all green.

- [ ] **Step 14: Commit**

```bash
cd vrm-mqtt/app
git add src/vrm/MqttBridgeConnection.ts src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat(bridge): derive subscribe topics, use custom aggregates, gate forward"
```

---

## Task 6: Update DOCS.md

**Files:**
- Modify: `vrm-mqtt/DOCS.md:51-57` (Discovery section)

- [ ] **Step 1: Update the discovery example**

Edit `vrm-mqtt/DOCS.md:51-57`. Replace the Discovery section with:

```markdown
## Discovery

Entities are published on a stable schema. Example for installation
`123456`:

- `homeassistant/sensor/vrm-123456/battery_soc/config` → battery state of charge
- `homeassistant/sensor/vrm-123456/battery_voltage/config` → battery voltage
- `homeassistant/sensor/vrm-123456/battery_state/config` → battery state
- `homeassistant/sensor/vrm-123456/z_aggregate_pv_power/config` → PV power (DC + AC combined)
- `homeassistant/sensor/vrm-123456/z_aggregate_ac_grid_power/config` → grid power (3-phase sum)

After startup the device panel contains 7 entities per installation:
3 battery sensors (`Dc/Battery/Soc`, `Dc/Battery/Voltage`, `Dc/Battery/State`)
and 4 `Z/Aggregate/*` aggregates. Per-phase readings and most other VRM
topics are subscribed internally (to feed the aggregates) but are not
exposed in HA.

The full per-topic mapping is documented in
[`docs/debug/topics/topics.txt`](https://github.com/KaiGrassnick/vrm-mqtt-apps/blob/main/vrm-mqtt/docs/debug/topics/topics.txt).

To expose additional entities, set `forward: true` on the corresponding
entry in `vrm-mqtt/app/src/ha/entityDefs.ts` (`SYSTEM_ENTITIES`). To define a
new aggregate (e.g. a per-phase PV breakdown), add an entry to
`CUSTOM_AGGREGATES` in the same file — `aggregateFrom` is required and may
mix `{n}`-template and literal source paths.
```

- [ ] **Step 2: Verify the change**

Read back the file to confirm the section reads cleanly:

```bash
sed -n '50,72p' vrm-mqtt/DOCS.md
```

- [ ] **Step 3: Commit**

```bash
cd vrm-mqtt
git add DOCS.md
git commit -m "docs: update discovery example + extension note"
```

---

## Task 7: Final verification — full repo test + lint + typecheck + manual smoke

**Files:**
- (No code changes; verification only)

- [ ] **Step 1: Run the full test suite from `vrm-mqtt/app/`**

```bash
cd vrm-mqtt/app && npm test
```

Expected: every test passes. No skipped, no pending.

- [ ] **Step 2: Run lint**

```bash
cd vrm-mqtt/app && npm run lint
```

Expected: clean.

- [ ] **Step 3: Run typecheck**

```bash
cd vrm-mqtt/app && npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Confirm the build succeeds**

```bash
cd vrm-mqtt/app && npm run build
```

Expected: `dist/` regenerated, no errors.

- [ ] **Step 5: Visual inspection of final entity registry**

In a REPL or one-off script:

```typescript
import { SERVICE_ENTITY_DEFS, CUSTOM_AGGREGATE_DEFS } from './src/ha/entityDefs';
import { getObservedPaths } from './src/ha/observedPaths';
console.log('Forward entities:', SERVICE_ENTITY_DEFS.system?.filter(d => d.forward).map(d => d.path));
console.log('Custom aggregates:', CUSTOM_AGGREGATE_DEFS.system?.map(a => a.path));
console.log('Observed paths (subscribe):', getObservedPaths());
```

Expected output:

- Forward entities: `['Dc/Battery/Soc', 'Dc/Battery/Voltage', 'Dc/Battery/State']`
- Custom aggregates: 4 entries (3 AC + Z/Aggregate/Pv/Power)
- Observed paths: 9 entries (Dc/Pv/Power, Dc/Battery/Soc, Dc/Battery/Voltage, Dc/Battery/State, Ac/{Grid,Consumption,Genset,PvOnOutput,PvOnGrid}/L{1,2,3}/Power = 3 + 3 + 3 + 3 + 3 = 15 source paths, deduplicated to 9 unique topics — matches pre-change behavior)

- [ ] **Step 6: Commit verification artifact (optional)**

If you created any inspection script in Step 5, delete it (no commit) — verification artifacts should not land in the repo.

- [ ] **Step 7: Final commit if anything outstanding**

If `npm run lint` produced any auto-fixable warnings that you addressed:

```bash
cd vrm-mqtt/app
git add -A
git commit -m "chore: post-verification cleanup"
```

Otherwise, no commit. The implementation is complete.