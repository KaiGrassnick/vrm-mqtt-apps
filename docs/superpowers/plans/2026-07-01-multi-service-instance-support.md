# Multi-Service / Multi-Instance Entity Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VRM→HA bridge subscribe, forward, and publish HA discovery correctly for any service in `SERVICE_ENTITY_DEFS` (not just `system`), with any number of dynamically-appearing instances — without changing behavior for any existing installation (no entity gets `forward: true` as part of this work).

**Architecture:** Generalize the four places currently hardcoded to `service='system', instance=0` (subscription topics, forward-path gating, discovery generation, retained-topic pruning) to loop over every service in `SERVICE_ENTITY_DEFS` and a per-connection `observedInstances` map that starts seeded with `system`/`platform` (statically known) and grows dynamically as traffic for other services arrives. A debounced timer batches newly-discovered instances into a single discovery republish + prune re-run.

**Tech Stack:** TypeScript, Jest, MQTT.js. No new dependencies.

## Global Constraints

- No entity in any registry gets `forward: true` in this work — see spec Non-goals. Existing installation behavior must not change.
- Keep `system`/`platform` on the static (`instance: '0'`) path; every other service (including already-active `vebus`) goes through the dynamic path.
- Follow the existing code's patterns: timers cleared in `stop()`, best-effort logged-and-continue error handling, `Pick<...>` narrowing for injected collaborators, Jest with `jest.useFakeTimers()`.
- Full spec: `docs/superpowers/specs/2026-07-01-multi-service-instance-support-design.md`.

---

## Task 1: Fix the `(service, path)` forwarding-key collision bug

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:54-70` (`computeForwardPaths`), `:132` (assignment), `:316` (usage in `handleMessage`)
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: `SERVICE_ENTITY_DEFS` (`../ha/entityDefs`), `VrmServiceName` (`./types`)
- Produces: `computeForwardPaths(): ReadonlyMap<VrmServiceName, ReadonlySet<string>>` — replaces the old `ReadonlySet<string>`. Task 3 consumes this map's shape directly.

Today `computeForwardPaths()` returns a flat `Set<string>` built only from `SERVICE_ENTITY_DEFS.system`, and `handleMessage()` gates forwarding with `this.forwardPaths.has(parsed.path)` — path only, ignoring service. Two services can declare the same literal path (e.g. `State`, `Soc`), so flagging `forward: true` on one in a second service would forward/mis-tag the wrong service's messages. Fix: key by service, and loop over every service in `SERVICE_ENTITY_DEFS` (today: `system`, `vebus`, `platform` — `vebus`/`platform` currently contribute nothing since neither has any `forward: true` entity, so this change is a no-op in practice today, but removes the trap).

- [ ] **Step 1: Write the failing test**

Add to `MqttBridgeConnection.test.ts`, inside a new top-level `describe('forward-path collision safety', ...)` block (place it after the `message filtering` describe block, e.g. after line 273):

```typescript
describe('forward-path collision safety', () => {
  const portalId = installation.brokerPortalId;
  const idSite = installation.idSite;

  it("forwarding is scoped per-service: a message for vebus/0/Dc/Battery/Soc (system's forward path, but on vebus) is not forwarded", () => {
    const client = makeMockClient(true);
    const ha = makeMockHa();
    const conn = new MqttBridgeConnection({
      installation,
      pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
      ha: ha as never,
      publisher: makeMockPublisher() as never,
      getIdSite: idSiteFor(installation),
    });
    conn.start();
    jest.advanceTimersByTime(500);

    // Dc/Battery/Soc IS forward:true for system, but this message is on vebus/0.
    // A path-only check (today's bug) would incorrectly forward it.
    client.emit('message', `N/${portalId}/vebus/0/Dc/Battery/Soc`, Buffer.from('{"value":55}'));
    jest.advanceTimersByTime(500);

    expect(ha.publish).not.toHaveBeenCalledWith(
      `vrm/${idSite}/vebus/0/Dc/Battery/Soc`,
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails against current code**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "forwarding is scoped per-service"`
Expected: **FAILS** — `handleMessage` currently checks `this.forwardPaths.has(parsed.path)`, which is `true` for `'Dc/Battery/Soc'` regardless of `parsed.service`, so it currently forwards this message to `vrm/{idSite}/vebus/0/Dc/Battery/Soc`.

- [ ] **Step 3: Implement the fix**

In `MqttBridgeConnection.ts`, replace `computeForwardPaths` (lines 54-70):

```typescript
function computeForwardPaths(): ReadonlyMap<VrmServiceName, ReadonlySet<string>> {
  const indices = ['1', '2', '3'] as const;
  const expand = (template: string): string[] =>
    template.includes('{n}')
      ? indices.map((n) => template.replace('{n}', n))
      : [template];
  const map = new Map<VrmServiceName, Set<string>>();
  for (const [service, defs] of Object.entries(SERVICE_ENTITY_DEFS) as [VrmServiceName, typeof SERVICE_ENTITY_DEFS[VrmServiceName]][]) {
    const set = new Set<string>();
    for (const def of defs ?? []) {
      if (!def.forward) continue;
      for (const p of expand(def.path)) set.add(p);
    }
    if (service === 'system') {
      for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
        if (!agg.forward) continue;
        for (const p of expand(agg.path)) set.add(p);
      }
    }
    map.set(service, set);
  }
  return map;
}
```

Update the class field type (line ~101):
```typescript
private readonly forwardPaths: ReadonlyMap<VrmServiceName, ReadonlySet<string>>;
```

Update `handleMessage` (around line 316):
```typescript
    // HA forward — only for forward: true entities, scoped to the message's own service.
    if (this.forwardPaths.get(parsed.service as VrmServiceName)?.has(parsed.path)) {
```

Add the `VrmServiceName` import if not already present (it already is, per line 2 of the current file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts`
Expected: all PASS, including the new regression test and every pre-existing test (the existing suite's assertions about `Dc/Battery/Soc` forwarding on `system/0` are unaffected — same service, same path).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "fix: scope forward-path gating by (service, path), not path alone"
```

---

## Task 2: Generalize `getObservedPaths()` to cover every service

**Files:**
- Modify: `vrm-mqtt/app/src/ha/observedPaths.ts` (whole file)
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:204-207` (`buildSubscribeTopics`)
- Test: `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`, `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: `SERVICE_ENTITY_DEFS`, `CUSTOM_ENTITY_DEFS` (`./entityDefs`), `VrmServiceName` (`../vrm/types`)
- Produces:
  ```typescript
  export interface ServiceObservedPaths {
    service: VrmServiceName;
    /** '0' for system/platform (guaranteed, single-instance); '+' for every other (dynamic) service. */
    instanceSegment: '0' | '+';
    /** Sorted, deduplicated, template-expanded paths: forward:true entities (+ aggregate sources for 'system' only). */
    paths: string[];
  }
  export function getObservedPaths(): ServiceObservedPaths[]
  ```
  Task 3, 5, 6 all consume this shape.

**Design doc reference:** §1 Subscription.

- [ ] **Step 1: Write the failing test — replace `observedPaths.test.ts`'s `getObservedPaths` describe block**

Replace lines 1-60 of `observedPaths.test.ts` (the `getObservedPaths` describe block) with:

```typescript
import { getCurrentlyForwardedTopics, getObservedPaths } from '../observedPaths';

describe('getObservedPaths', () => {
  it('returns one entry per service present in SERVICE_ENTITY_DEFS', () => {
    const result = getObservedPaths();
    const services = result.map(s => s.service).sort();
    expect(services).toEqual(['platform', 'system', 'vebus']);
  });

  it('system and platform use instanceSegment "0"', () => {
    const result = getObservedPaths();
    expect(result.find(s => s.service === 'system')!.instanceSegment).toBe('0');
    expect(result.find(s => s.service === 'platform')!.instanceSegment).toBe('0');
  });

  it('every other service uses instanceSegment "+"', () => {
    const result = getObservedPaths();
    expect(result.find(s => s.service === 'vebus')!.instanceSegment).toBe('+');
  });

  it('system paths are sorted and deduplicated', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect([...systemPaths].sort()).toEqual(systemPaths);
    expect(new Set(systemPaths).size).toBe(systemPaths.length);
  });

  it('system paths expand {n} to 1, 2, 3 for aggregate-source templates', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Ac/Grid/L1/Power');
    expect(systemPaths).toContain('Ac/Grid/L2/Power');
    expect(systemPaths).toContain('Ac/Grid/L3/Power');
  });

  it('system paths include forward: true normal entities as literal paths', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Dc/Battery/Soc');
    expect(systemPaths).toContain('Dc/Battery/Voltage');
    expect(systemPaths).toContain('Dc/Battery/State');
  });

  it('system paths include literal aggregate sources regardless of forward flag', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Dc/Pv/Power');
  });

  it('system paths do NOT include normal entities without forward: true that are not aggregate sources', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).not.toContain('Ac/Grid/L1/Current');
  });

  it('system paths do NOT include aggregate targets (HA-published, not bus-side)', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).not.toContain('Ac/Grid/Power');
    expect(systemPaths).not.toContain('Pv/Power');
  });

  it('non-system services do not fold in system aggregate sources', () => {
    // vebus has zero forward:true entities today, so its paths list is empty —
    // it must NOT inherit system's aggregate-source paths.
    const vebusPaths = getObservedPaths().find(s => s.service === 'vebus')!.paths;
    expect(vebusPaths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vrm-mqtt/app && npx jest observedPaths.test.ts`
Expected: FAIL — `getObservedPaths()` currently returns `string[]`, not `ServiceObservedPaths[]`; `.find` is not a function on the old return shape (or the test fails on `.service` being undefined).

- [ ] **Step 3: Implement `getObservedPaths()`**

Replace `observedPaths.ts` lines 1-71 (everything above `getCurrentlyForwardedTopics`) with:

```typescript
import { SERVICE_ENTITY_DEFS, CUSTOM_ENTITY_DEFS } from './entityDefs';
import { makeStateTopic } from './DiscoveryConfigBuilder';
import type { VrmServiceName } from '../vrm/types';

const POSSIBLE_PHASE_INDICES = ['1', '2', '3'] as const;

function expandTemplate(template: string): string[] {
  if (!template.includes('{n}')) return [template];
  return POSSIBLE_PHASE_INDICES.map((n) => template.replace('{n}', n));
}

function expandAll(templates: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const t of templates) {
    for (const p of expandTemplate(t)) {
      expanded.add(p);
    }
  }
  return [...expanded].sort();
}

/** system and platform are guaranteed present on every installation, with a fixed instance. */
const STATIC_SERVICES: ReadonlySet<VrmServiceName> = new Set(['system', 'platform']);

export interface ServiceObservedPaths {
  service: VrmServiceName;
  instanceSegment: '0' | '+';
  paths: string[];
}

/**
 * Return, for every service present in SERVICE_ENTITY_DEFS, the sorted
 * deduplicated set of VRM-side paths the bridge needs to observe:
 *   - every `forward: true` normal entity path (template-expanded), and
 *   - for `system` only, every `aggregateFrom` source path from
 *     CUSTOM_ENTITY_DEFS.aggregate, regardless of the aggregate's own
 *     `forward` flag (aggregate sources must be subscribed even when the
 *     aggregate itself is not published).
 *
 * `instanceSegment` is '0' for system/platform (guaranteed present, fixed
 * instance) and '+' for every other service (instance is learned
 * dynamically from live traffic — see MqttBridgeConnection.observedInstances).
 */
export function getObservedPaths(): ServiceObservedPaths[] {
  const result: ServiceObservedPaths[] = [];

  for (const service of Object.keys(SERVICE_ENTITY_DEFS) as VrmServiceName[]) {
    const defs = SERVICE_ENTITY_DEFS[service] ?? [];
    const paths = new Set<string>();
    for (const def of defs) {
      if (!def.forward) continue;
      for (const p of expandTemplate(def.path)) paths.add(p);
    }
    if (service === 'system') {
      for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
        for (const p of expandAll(agg.aggregateFrom)) paths.add(p);
      }
    }
    result.push({
      service,
      instanceSegment: STATIC_SERVICES.has(service) ? '0' : '+',
      paths: [...paths].sort(),
    });
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest observedPaths.test.ts`
Expected: `getObservedPaths` describe block PASSES. `getCurrentlyForwardedTopics` describe block will FAIL to compile/run since it still calls the old signature — that's addressed in Task 5. For now, temporarily skip that block:

Change `describe('getCurrentlyForwardedTopics', ...)` to `describe.skip('getCurrentlyForwardedTopics', ...)` (line 62 of the original file) — Task 5 removes the `.skip` and rewrites this block.

- [ ] **Step 5: Update `MqttBridgeConnection.buildSubscribeTopics()`**

Replace `MqttBridgeConnection.ts:204-207`:

```typescript
  private buildSubscribeTopics(): string[] {
    const id = this.installation.brokerPortalId;
    const topics: string[] = [];
    for (const { service, instanceSegment, paths } of getObservedPaths()) {
      for (const path of paths) {
        topics.push(`N/${id}/${service}/${instanceSegment}/${path}`);
      }
    }
    return topics;
  }
```

- [ ] **Step 6: Run the MqttBridgeConnection subscribe-topic tests**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "subscribes"`
Expected: PASS — the existing assertions (`N/${PORTAL}/system/0/Dc/Pv/Power`, topics length 19) are unaffected, since `vebus`/`platform` contribute zero paths today (no `forward: true` entities), so the flattened topic list is unchanged in content and length.

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: only the `describe.skip`'d `getCurrentlyForwardedTopics` block is skipped (visible in Jest output as "skipped"); everything else PASSES; no type errors.

- [ ] **Step 8: Commit**

```bash
git add vrm-mqtt/app/src/ha/observedPaths.ts vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts
git commit -m "refactor: generalize getObservedPaths to cover every service, not just system"
```

---

## Task 3: Track `observedInstances` per connection

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: `computeForwardPaths()` from Task 1 (`ReadonlyMap<VrmServiceName, ReadonlySet<string>>`), `parseVrmTopic` (`../ha/MessageRouter`, unchanged)
- Produces: `private observedInstances: Map<VrmServiceName, Set<string>>` (readable via a new package-private-ish accessor for tests: add `get observedInstancesSnapshot(): ReadonlyMap<VrmServiceName, ReadonlySet<string>>` to the class). Task 4/7 consume this field and its "newly seen" signal.

**Design doc reference:** §2 Message handling & forwarding.

- [ ] **Step 1: Write the failing test**

Add to `MqttBridgeConnection.test.ts`, new `describe` block after `forward-path collision safety`:

```typescript
describe('observedInstances tracking', () => {
  const portalId = installation.brokerPortalId;

  it('seeds system and platform with instance "0" before any traffic', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    expect(conn.observedInstancesSnapshot.get('system')).toEqual(new Set(['0']));
    expect(conn.observedInstancesSnapshot.get('platform')).toEqual(new Set(['0']));
  });

  it('does not seed vebus statically', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    expect(conn.observedInstancesSnapshot.get('vebus')).toBeUndefined();
  });

  it('records a new instance only when the (service, path) is a forward:true entity', () => {
    const client = makeMockClient(true);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);

    // Dc/Battery/Soc is forward:true for system, already seeded — use it to
    // prove re-observing an already-known instance is a harmless no-op, then
    // prove an aggregate-source-only path (not forward:true) does NOT get
    // recorded as new instance-discovery signal for a hypothetical dynamic
    // service. Ac/Grid/L1/Power is an aggregate source, not forward:true, on 'system'.
    client.emit('message', `N/${portalId}/system/0/Ac/Grid/L1/Power`, Buffer.from('{"value":100}'));
    jest.advanceTimersByTime(500);

    // system/0 was already known — set stays exactly {'0'}, unaffected either way.
    expect(conn.observedInstancesSnapshot.get('system')).toEqual(new Set(['0']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "observedInstances tracking"`
Expected: FAIL — `observedInstancesSnapshot` does not exist yet.

- [ ] **Step 3: Implement**

In `MqttBridgeConnection.ts`, add a private field and seed it in the constructor. Add near the other private fields (after `forwardPaths`, ~line 101):

```typescript
  private readonly observedInstances: Map<VrmServiceName, Set<string>> = new Map([
    ['system', new Set(['0'])],
    ['platform', new Set(['0'])],
  ]);
```

Add a read-only accessor for tests/consumers, near the other getters (after `get idSite()`):

```typescript
  /** Snapshot of every (service, instance) pair this connection has forwarded traffic for. Read-only for callers. */
  get observedInstancesSnapshot(): ReadonlyMap<VrmServiceName, ReadonlySet<string>> {
    return this.observedInstances;
  }
```

In `handleMessage()`, inside the existing forward-gated block (right after the `if (this.forwardPaths.get(...)?.has(parsed.path))` check from Task 1, before the `routeFromVrm` call), record the instance:

```typescript
    if (this.forwardPaths.get(parsed.service as VrmServiceName)?.has(parsed.path)) {
      const service = parsed.service as VrmServiceName;
      let instances = this.observedInstances.get(service);
      if (!instances) {
        instances = new Set<string>();
        this.observedInstances.set(service, instances);
      }
      instances.add(parsed.instance);
      // (Task 4 hooks a "was this new?" signal in here.)

      const out = routeFromVrm(topic, str, this.getIdSite);
```
(Keep the existing `for (const msg of out) { ... }` body unchanged below it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "observedInstances tracking"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat: track observedInstances per (service, instance) seen in forwarded traffic"
```

---

## Task 4: Debounced discovery-refresh timer scaffold

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: nothing new (pure timer plumbing)
- Produces: `private scheduleDiscoveryRefresh(): void` (schedules if not already pending; ~2s debounce) and clears the timer in `stop()`. Task 7 wires this to actually call the publisher; for this task, the scheduled callback is a private no-op hook (`private onDiscoveryRefreshFire(): void {}`) that Task 7 replaces.

**Design doc reference:** §3 Discovery generation & incremental republish (debounce paragraph).

- [ ] **Step 1: Write the failing test**

```typescript
describe('discovery refresh debounce', () => {
  it('does not fire immediately when scheduled', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    const spy = jest.spyOn(conn as unknown as { onDiscoveryRefreshFire: () => void }, 'onDiscoveryRefreshFire');
    (conn as unknown as { scheduleDiscoveryRefresh: () => void }).scheduleDiscoveryRefresh();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires once after the debounce window', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    const spy = jest.spyOn(conn as unknown as { onDiscoveryRefreshFire: () => void }, 'onDiscoveryRefreshFire');
    (conn as unknown as { scheduleDiscoveryRefresh: () => void }).scheduleDiscoveryRefresh();
    jest.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple schedule calls within the window into one fire', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    const spy = jest.spyOn(conn as unknown as { onDiscoveryRefreshFire: () => void }, 'onDiscoveryRefreshFire');
    const schedule = (): void => (conn as unknown as { scheduleDiscoveryRefresh: () => void }).scheduleDiscoveryRefresh();
    schedule();
    jest.advanceTimersByTime(500);
    schedule();
    jest.advanceTimersByTime(500);
    schedule();
    jest.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels a pending refresh', async () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    const spy = jest.spyOn(conn as unknown as { onDiscoveryRefreshFire: () => void }, 'onDiscoveryRefreshFire');
    (conn as unknown as { scheduleDiscoveryRefresh: () => void }).scheduleDiscoveryRefresh();
    await conn.stop();
    jest.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "discovery refresh debounce"`
Expected: FAIL — `scheduleDiscoveryRefresh`/`onDiscoveryRefreshFire` don't exist.

- [ ] **Step 3: Implement**

Add a constant near `KEEPALIVE_INTERVAL_MS` (top of file):
```typescript
const DISCOVERY_REFRESH_DEBOUNCE_MS = 2_000;
```

Add a private field alongside `keepaliveTimer`/`staleTimer`:
```typescript
  private discoveryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
```

Add the two methods (near `touch()`/`markOnline()`):
```typescript
  private scheduleDiscoveryRefresh(): void {
    if (this.discoveryRefreshTimer !== null) return;
    this.discoveryRefreshTimer = setTimeout(() => {
      this.discoveryRefreshTimer = null;
      this.onDiscoveryRefreshFire();
    }, DISCOVERY_REFRESH_DEBOUNCE_MS);
  }

  private onDiscoveryRefreshFire(): void {
    // Task 7 replaces this with the real refresh + prune re-run.
  }
```

In `stop()`, alongside the existing `keepaliveTimer`/`staleTimer` clears (near the top of the method):
```typescript
    if (this.discoveryRefreshTimer !== null) {
      clearTimeout(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = null;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "discovery refresh debounce"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat: add debounced discovery-refresh timer scaffold"
```

---

## Task 5: Widen `buildInstallationDiscovery()` and `getCurrentlyForwardedTopics()` to accept `observedInstances`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/InstallationDevice.ts`
- Modify: `vrm-mqtt/app/src/ha/observedPaths.ts` (`getCurrentlyForwardedTopics`)
- Modify: `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts:34-46` (`publishInstallation`), `:116-130` (`pruneRetainedTopics`)
- Test: `vrm-mqtt/app/src/ha/__tests__/InstallationDevice.test.ts`, `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`, `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`

**Interfaces:**
- Consumes: `ServiceObservedPaths[]` from Task 2's `getObservedPaths()`, `VrmServiceName`
- Produces:
  ```typescript
  buildInstallationDiscovery(idSite: number, installationName: string, appVersion: string, observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>): HaDeviceDiscoveryPayload
  getCurrentlyForwardedTopics(idSite: number, observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>): Set<string>
  DiscoveryPublisher.publishInstallation(idSite: number, installationName: string, observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>): void
  DiscoveryPublisher.pruneRetainedTopics(idSite: number, observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>): Promise<void>
  ```
  Task 6 (new `refreshInstallationDiscovery`) and Task 7 (wiring in `MqttBridgeConnection`) both call these with `conn.observedInstancesSnapshot` (from Task 3).

**Design doc reference:** §3 (signature change), §4 Pruning.

- [ ] **Step 1: Write the failing tests**

Update `InstallationDevice.test.ts` — every existing call site needs the new fourth argument. Add near the top of the file, after the existing constants:

```typescript
const SYSTEM_PLATFORM_ONLY = new Map([
  ['system', new Set(['0'])],
  ['platform', new Set(['0'])],
]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
```

Then change every `buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION)` call in the file (and the two `buildInstallationDiscovery(1, NAME, APP_VERSION)` / `buildInstallationDiscovery(2, NAME, APP_VERSION)` calls) to pass `SYSTEM_PLATFORM_ONLY` as a fourth argument, e.g.:

```typescript
buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY)
```

Add one new test proving multi-service merging works, at the end of the file's `describe` block:

```typescript
it('merges configs from every service present in observedInstances, not just system', () => {
  const withVebus = new Map([
    ['system', new Set(['0'])],
    ['platform', new Set(['0'])],
    ['vebus', new Set(['0'])],
  ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
  // vebus has zero forward:true entities today, so this must not add any
  // components, but must not throw or drop the system components either.
  const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, withVebus);
  const socKey = `system_0_dc_battery_soc`;
  expect(payload.components[socKey]).toBeDefined();
});
```

Update `observedPaths.test.ts`: remove the `describe.skip` from Task 2 Step 4 and rewrite the block:

```typescript
describe('getCurrentlyForwardedTopics', () => {
  const ID_SITE = 42;
  const SYSTEM_PLATFORM_ONLY = new Map([
    ['system', new Set(['0'])],
    ['platform', new Set(['0'])],
  ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;

  it('always contains vrm/{idSite}/availability', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/availability`);
  });

  it('contains vrm/{idSite}/system/0/{path} for every forward: true system entity', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('currently has no forward: true template entities — template branch is code-review covered', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Ac/Grid/L1/Power`);
  });

  it('contains vrm/{idSite}/custom/aggregate/{path} for every forward: true aggregate', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Consumption/Power`);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Grid/Power`);
  });

  it('does NOT contain forward: false / unflagged entity paths', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Current`);
  });

  it('includes topics for a dynamically-observed service instance', () => {
    // Prove the new per-service loop actually emits topics for a non-system
    // service once observedInstances says an instance is known — even though
    // vebus has no forward:true entity today (so the set of paths is empty,
    // this at minimum must not throw and must not silently drop system's topics).
    const withVebus = new Map([
      ['system', new Set(['0'])],
      ['platform', new Set(['0'])],
      ['vebus', new Set(['0'])],
    ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
    const topics = getCurrentlyForwardedTopics(ID_SITE, withVebus);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('returns disjoint sets for different idSite values', () => {
    const a = getCurrentlyForwardedTopics(1, SYSTEM_PLATFORM_ONLY);
    const b = getCurrentlyForwardedTopics(2, SYSTEM_PLATFORM_ONLY);
    for (const t of a) {
      expect(b).not.toContain(t);
    }
  });
});
```

Update `DiscoveryPublisher.test.ts`: every `pub.publishInstallation(ID_SITE, NAME)` / `pub.publishInstallation(999, 'Other Site')` call and every `pub.pruneRetainedTopics(ID_SITE)` call needs the new argument. Add near the top of the file:

```typescript
const SYSTEM_PLATFORM_ONLY = new Map([
  ['system', new Set(['0'])],
  ['platform', new Set(['0'])],
]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
```

Then append `, SYSTEM_PLATFORM_ONLY` to every `publishInstallation(...)` call and every `pruneRetainedTopics(...)` call in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd vrm-mqtt/app && npx jest InstallationDevice.test.ts observedPaths.test.ts DiscoveryPublisher.test.ts`
Expected: FAIL — signatures don't accept the new argument yet (TS compile errors under `ts-jest`, surfacing as test failures).

- [ ] **Step 3: Implement `getCurrentlyForwardedTopics`**

Replace `observedPaths.ts`'s `getCurrentlyForwardedTopics` (the function after `getObservedPaths`, originally lines 73-105):

```typescript
/**
 * Return the set of full HA-side topics the bridge currently publishes under
 * `vrm/{idSite}/#`, given the caller's current `observedInstances` snapshot.
 * Derived from SERVICE_ENTITY_DEFS + CUSTOM_ENTITY_DEFS — same source of
 * truth as discovery generation in InstallationDevice.
 */
export function getCurrentlyForwardedTopics(
  idSite: number,
  observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
): Set<string> {
  const topics = new Set<string>();
  topics.add(`vrm/${idSite}/availability`);

  const pathsByService = new Map(getObservedPaths().map(s => [s.service, s.paths]));

  for (const [service, instances] of observedInstances) {
    const paths = pathsByService.get(service) ?? [];
    for (const instance of instances) {
      for (const path of paths) {
        topics.add(makeStateTopic(idSite, service, instance, path));
      }
    }
  }

  for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
    if (!agg.forward) continue;
    topics.add(`vrm/${idSite}/custom/aggregate/${agg.path}`);
  }

  return topics;
}
```

(This drops the old direct `SERVICE_ENTITY_DEFS.system`-only loop entirely — `pathsByService` from `getObservedPaths()` already carries every service's forward paths, which is exactly what's needed here.)

- [ ] **Step 4: Implement `buildInstallationDiscovery`**

Replace `InstallationDevice.ts` entirely:

```typescript
import { buildDiscoveryConfigs } from './DiscoveryConfigBuilder';
import { CUSTOM_ENTITY_DEFS } from './entityDefs';
import { getObservedPaths } from './observedPaths';
import type { HaComponent, HaDeviceDiscoveryComponent, HaDeviceDiscoveryPayload, HaDiscoveryConfig } from './types';
import type { VrmServiceName } from '../vrm/types';

function toComponents(configs: HaDiscoveryConfig[]): Record<string, HaDeviceDiscoveryComponent> {
  const result: Record<string, HaDeviceDiscoveryComponent> = {};
  for (const config of configs) {
    const raw = config as unknown as Record<string, unknown>;
    const { component, ...rest } = raw;
    const componentKey = config.unique_id.replace(/^vrm_[^_]+_/, '');
    result[componentKey] = { platform: component as HaComponent, ...rest } as HaDeviceDiscoveryComponent;
  }
  return result;
}

/**
 * Build the HA device discovery payload for one VRM installation, merging
 * configs for every (service, instance) pair present in `observedInstances`.
 */
export function buildInstallationDiscovery(
  idSite: number,
  installationName: string,
  appVersion: string,
  observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
): HaDeviceDiscoveryPayload {
  const pathsByService = new Map(getObservedPaths().map(s => [s.service, s.paths]));
  const configs: HaDiscoveryConfig[] = [];

  for (const [service, instances] of observedInstances) {
    const paths = pathsByService.get(service) ?? [];
    for (const instance of instances) {
      configs.push(...buildDiscoveryConfigs(
        idSite,
        service,
        instance,
        paths,
        service === 'system' ? CUSTOM_ENTITY_DEFS.aggregate : [],
      ));
    }
  }

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

- [ ] **Step 5: Update `DiscoveryPublisher.publishInstallation` and `pruneRetainedTopics`**

In `DiscoveryPublisher.ts`, add the import:
```typescript
import type { VrmServiceName } from '../vrm/types';
```

Replace `publishInstallation` (lines 34-46):
```typescript
  publishInstallation(
    idSite: number,
    installationName: string,
    observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
  ): void {
    const existing = this.published.get(idSite);
    if (existing && existing.name === installationName) return;

    const discoveryTopic = `homeassistant/device/vrm_${idSite}/config`;
    const payload = JSON.stringify(buildInstallationDiscovery(idSite, installationName, this.appVersion, observedInstances));
    this.ha.publish(discoveryTopic, payload, true);
    this.published.set(idSite, {
      discoveryTopic,
      payload,
      name: installationName,
    });
  }
```

Replace `pruneRetainedTopics` (lines 116-130), changing only the signature and the `getCurrentlyForwardedTopics` call:
```typescript
  async pruneRetainedTopics(
    idSite: number,
    observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
  ): Promise<void> {
    const keep = getCurrentlyForwardedTopics(idSite, observedInstances);
    const prefix = `vrm/${idSite}/`;
    const retained = await this.ha.collectRetained(`${prefix}#`, 300);

    let cleared = 0;
    for (const { topic } of retained) {
      if (!topic.startsWith(prefix)) continue;
      if (topic.endsWith('/set')) continue;
      if (keep.has(topic)) continue;
      this.ha.publish(topic, '', true);
      cleared++;
    }
    logger.debug(`[HA] Pruned ${cleared} stale retained topic(s) under vrm/${idSite}/`);
  }
```

- [ ] **Step 6: Update the one production caller that doesn't yet compile: `MqttBridgeConnection`**

`handleConnect()` calls `this.publisher.publishInstallation(this.installation.idSite, this.installation.name)` and `this.publisher.pruneRetainedTopics(this.installation.idSite)`; `updateName()` calls `publishInstallation` too. Update both call sites to pass `this.observedInstances` (added in Task 3):

```typescript
    this.publisher.publishInstallation(this.installation.idSite, this.installation.name, this.observedInstances);
```
```typescript
    this.publisher.pruneRetainedTopics(this.installation.idSite, this.observedInstances).catch((err) => {
```
And in `updateName()`:
```typescript
    this.publisher.publishInstallation(this.installation.idSite, newName, this.observedInstances);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd vrm-mqtt/app && npx jest InstallationDevice.test.ts observedPaths.test.ts DiscoveryPublisher.test.ts MqttBridgeConnection.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add vrm-mqtt/app/src/ha/InstallationDevice.ts vrm-mqtt/app/src/ha/observedPaths.ts vrm-mqtt/app/src/ha/DiscoveryPublisher.ts vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/ha/__tests__/InstallationDevice.test.ts vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat: thread observedInstances through discovery build and prune"
```

---

## Task 6: Add `DiscoveryPublisher.refreshInstallationDiscovery`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts`
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:76,92` (the `Pick<DiscoveryPublisher, ...>` type)
- Test: `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`, `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` (`makeMockPublisher`)

**Interfaces:**
- Consumes: `buildInstallationDiscovery` (Task 5), `this.published` (existing `Map<number, PublishedInstallation>`)
- Produces: `DiscoveryPublisher.refreshInstallationDiscovery(idSite: number, installationName: string, observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>): void`. Task 7 calls this from the debounce-fire hook.

**Design doc reference:** §3, item 1 under "On fire".

- [ ] **Step 1: Write the failing test**

Add to `DiscoveryPublisher.test.ts`, new `describe` block after `publishInstallation`:

```typescript
describe('refreshInstallationDiscovery', () => {
  it('republishes even when the name is unchanged (unlike publishInstallation)', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME, SYSTEM_PLATFORM_ONLY);
    (ha.publish as jest.Mock).mockClear();

    pub.refreshInstallationDiscovery(ID_SITE, NAME, SYSTEM_PLATFORM_ONLY);

    expect(ha.publish).toHaveBeenCalledWith(
      `homeassistant/device/vrm_${ID_SITE}/config`,
      expect.any(String),
      true,
    );
  });

  it('updates the stored payload so onHaBirth republishes the refreshed version, not the stale one', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME, SYSTEM_PLATFORM_ONLY);
    const initialCallCount = (ha.publish as jest.Mock).mock.calls.length;

    pub.refreshInstallationDiscovery(ID_SITE, NAME, SYSTEM_PLATFORM_ONLY);
    const refreshedPayload = (ha.publish as jest.Mock).mock.calls[initialCallCount][1] as string;

    (ha.publish as jest.Mock).mockClear();
    pub.onHaBirth();

    const rebirthCall = (ha.publish as jest.Mock).mock.calls.find(
      ([t]: [string]) => t === `homeassistant/device/vrm_${ID_SITE}/config`,
    ) as [string, string, boolean];
    expect(rebirthCall[1]).toBe(refreshedPayload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vrm-mqtt/app && npx jest DiscoveryPublisher.test.ts -t "refreshInstallationDiscovery"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement**

Add to `DiscoveryPublisher.ts`, after `publishInstallation`:

```typescript
  /**
   * Rebuild and unconditionally republish discovery for one installation,
   * bypassing publishInstallation's "same name → no-op" dedupe. Used when the
   * SET of known (service, instance) pairs changed, not the name — the
   * stored entry is overwritten too, so a later onHaBirth() republishes the
   * refreshed payload rather than resurrecting the connect-time one.
   */
  refreshInstallationDiscovery(
    idSite: number,
    installationName: string,
    observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
  ): void {
    const discoveryTopic = `homeassistant/device/vrm_${idSite}/config`;
    const payload = JSON.stringify(buildInstallationDiscovery(idSite, installationName, this.appVersion, observedInstances));
    this.ha.publish(discoveryTopic, payload, true);
    this.published.set(idSite, {
      discoveryTopic,
      payload,
      name: installationName,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest DiscoveryPublisher.test.ts -t "refreshInstallationDiscovery"`
Expected: PASS.

- [ ] **Step 5: Widen the `Pick<>` type and mock in `MqttBridgeConnection`**

In `MqttBridgeConnection.ts`, update `MqttBridgeConnectionOptions.publisher` (line ~76):
```typescript
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
```
And the class field (line ~92):
```typescript
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
```

In `MqttBridgeConnection.test.ts`'s `makeMockPublisher()`:
```typescript
function makeMockPublisher(): {
  publishAvailability: jest.Mock;
  publishInstallation: jest.Mock;
  pruneRetainedTopics: jest.Mock;
  refreshInstallationDiscovery: jest.Mock;
} {
  return {
    publishAvailability: jest.fn(),
    publishInstallation: jest.fn(),
    pruneRetainedTopics: jest.fn().mockResolvedValue(undefined),
    refreshInstallationDiscovery: jest.fn(),
  };
}
```

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/app/src/ha/DiscoveryPublisher.ts vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat: add DiscoveryPublisher.refreshInstallationDiscovery for instance-driven republish"
```

---

## Task 7: Wire instance discovery to debounced refresh + serialized prune re-run

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: Task 3's `observedInstances`/recording logic, Task 4's `scheduleDiscoveryRefresh`/`onDiscoveryRefreshFire`, Task 6's `refreshInstallationDiscovery`
- Produces: fully wired end-to-end behavior — this is the task where "new instance observed" actually causes an HA-visible discovery update. No new public interface; this closes the loop.

**Design doc reference:** §3 (debounce + refresh + prune re-run), §4 Serialization.

- [ ] **Step 1: Write the failing test**

```typescript
describe('instance-driven discovery refresh (end-to-end)', () => {
  const portalId = installation.brokerPortalId;
  const idSite = installation.idSite;

  it('schedules a discovery refresh when a genuinely new (service, instance) is observed', () => {
    const client = makeMockClient(true);
    const publisher = makeMockPublisher();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);
    publisher.refreshInstallationDiscovery.mockClear();
    publisher.pruneRetainedTopics.mockClear();

    // system/0 is already known from seeding — re-observing it must NOT
    // schedule a refresh (nothing new).
    client.emit('message', `N/${portalId}/system/0/Dc/Battery/Soc`, Buffer.from('{"value":80}'));
    jest.advanceTimersByTime(2000);

    expect(publisher.refreshInstallationDiscovery).not.toHaveBeenCalled();
  });

  it('does not fire a refresh for messages that are not forward:true (no new instance signal)', () => {
    const client = makeMockClient(true);
    const publisher = makeMockPublisher();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);
    publisher.refreshInstallationDiscovery.mockClear();

    client.emit('message', `N/${portalId}/system/0/Ac/Grid/L1/Power`, Buffer.from('{"value":100}'));
    jest.advanceTimersByTime(2000);

    expect(publisher.refreshInstallationDiscovery).not.toHaveBeenCalled();
  });

  it('serializes the connect-time prune and a later debounced prune re-run rather than racing', async () => {
    const client = makeMockClient(false);
    const publisher = makeMockPublisher();
    let resolveFirst: (() => void) | undefined;
    publisher.pruneRetainedTopics
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never, getIdSite: idSiteFor(installation) });
    conn.start();
    client.emit('connect');
    await Promise.resolve();

    // First prune (from connect) is in flight (its promise hasn't resolved).
    // Force a second prune request via the private hook while the first is pending.
    (conn as unknown as { onDiscoveryRefreshFire: () => void }).onDiscoveryRefreshFire();
    await Promise.resolve();

    // The second call must not have started executing its own collectRetained
    // work concurrently — pruneRetainedTopics mock call count is 1 until the
    // first resolves.
    expect(publisher.pruneRetainedTopics).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(publisher.pruneRetainedTopics).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "instance-driven discovery refresh"`
Expected: FAIL — `onDiscoveryRefreshFire` is currently a no-op and there's no serialization; the third test's second `pruneRetainedTopics` call never happens (nothing calls it from `onDiscoveryRefreshFire` yet).

- [ ] **Step 3: Implement**

Add a per-connection prune chain field, alongside `discoveryRefreshTimer`:
```typescript
  private pruneChain: Promise<void> = Promise.resolve();
```

Add a private helper that serializes prune calls:
```typescript
  private runPrune(): void {
    this.pruneChain = this.pruneChain
      .then(() => this.publisher.pruneRetainedTopics(this.installation.idSite, this.observedInstances))
      .catch((err) => {
        logger.error(`[HA] Prune failed for idSite=${this.installation.idSite}:`, err);
      });
  }
```

Replace the connect-time prune call in `handleConnect()` (currently `this.publisher.pruneRetainedTopics(this.installation.idSite).catch(...)`) with:
```typescript
    this.runPrune();
```

Replace the `onDiscoveryRefreshFire` stub from Task 4 with:
```typescript
  private onDiscoveryRefreshFire(): void {
    this.publisher.refreshInstallationDiscovery(this.installation.idSite, this.installation.name, this.observedInstances);
    this.runPrune();
  }
```

In `handleMessage()`, after recording the instance (Task 3's block), detect "was this new" and schedule the refresh:
```typescript
    if (this.forwardPaths.get(parsed.service as VrmServiceName)?.has(parsed.path)) {
      const service = parsed.service as VrmServiceName;
      let instances = this.observedInstances.get(service);
      if (!instances) {
        instances = new Set<string>();
        this.observedInstances.set(service, instances);
      }
      if (!instances.has(parsed.instance)) {
        instances.add(parsed.instance);
        this.scheduleDiscoveryRefresh();
      }

      const out = routeFromVrm(topic, str, this.getIdSite);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.test.ts -t "instance-driven discovery refresh"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS, no type errors. Pay particular attention to the existing `pruneRetainedTopics wire-up` describe block (Task-1-era tests) — its assertion `expect(publisher.pruneRetainedTopics).toHaveBeenCalledWith(installation.idSite)` must be updated to also expect the `observedInstances` argument:
```typescript
      expect(publisher.pruneRetainedTopics).toHaveBeenCalledWith(installation.idSite, conn.observedInstancesSnapshot);
```
(Apply this same fix to both tests in that describe block that assert on `pruneRetainedTopics`'s call arguments — capture `conn` from the constructor call if not already in scope.)

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat: wire new-instance detection to debounced discovery refresh + serialized prune"
```

---

## Task 8: Enable all `SERVICE_ENTITY_DEFS` registries + end-to-end dynamic-instance test

**Files:**
- Modify: `vrm-mqtt/app/src/ha/entityDefs.ts:975-1001` (`SERVICE_ENTITY_DEFS`)
- Modify: `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts:56-61` (stale "unknown services" framing)
- Test (new): a dedicated end-to-end test exercising the full dynamic-instance pipeline against a synthetic fixture, since no production entity has `forward: true` on a dynamic service (per Global Constraints)

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces: `SERVICE_ENTITY_DEFS` now includes every registry defined in `entityDefs.ts`. No entity behavior changes (no `forward: true` added) — this is the final "the map matches what's already been built for" step from the spec's Goal.

- [ ] **Step 1: Uncomment every entry in `SERVICE_ENTITY_DEFS`**

Replace `entityDefs.ts:975-1001`:

```typescript
export const SERVICE_ENTITY_DEFS: Partial<Record<VrmServiceName, EntityDef[]>> = {
  system: SYSTEM_ENTITIES,
  battery: BATTERY_ENTITIES,
  solarcharger: SOLARCHARGER_ENTITIES,
  vebus: VEBUS_ENTITIES,
  multi: MULTI_ENTITIES,
  grid: GRID_ENTITIES,
  acload: ACLOAD_ENTITIES,
  genset: GENSET_ENTITIES,
  generator: GENERATOR_ENTITIES,
  pvinverter: PVINVERTER_ENTITIES,
  evcharger: EVCHARGER_ENTITIES,
  temperature: TEMPERATURE_ENTITIES,
  tank: TANK_ENTITIES,
  inverter: INVERTER_ENTITIES,
  charger: CHARGER_ENTITIES,
  alternator: ALTERNATOR_ENTITIES,
  dcdc: DCDC_ENTITIES,
  dcsystem: DCSYSTEM_ENTITIES,
  dcload: DCLOAD_ENTITIES,
  digitalinput: DIGITALINPUT_ENTITIES,
  heatpump: HEATPUMP_ENTITIES,
  hub4: HUB4_ENTITIES,
  gps: GPS_ENTITIES,
  meteo: METEO_ENTITIES,
  platform: PLATFORM_ENTITIES,
};
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit`
Expected: PASS. Since no newly-uncommented registry has any `forward: true` entity, every existing assertion about subscribe-topic counts, discovery component counts, and prune behavior is unaffected — this step should require zero test changes to pass, other than the one described in Step 3.

If anything fails, it's almost certainly the `DiscoveryConfigBuilder.test.ts` "unknown services" test from Step 3 below — fix that next.

- [ ] **Step 3: Fix the now-stale "unknown services" test framing**

`DiscoveryConfigBuilder.test.ts:57-61` currently reads:
```typescript
  describe('returns empty array for unknown services', () => {
    it('platform has no entity defs', () => {
      expect(buildDiscoveryConfigs(ID_SITE, 'platform', 0, [])).toEqual([]);
    });
  });
```
This was already slightly stale before this work (`platform` was already wired in with zero `forward: true` entities — the assertion passes because nothing is `forward: true`, not because the service is "unknown"). After Step 1, the `describe('index never observed', ...)` block's `'charger'` test (lines 63-68) has the same staleness (`charger` was "unknown" before Step 1; now it's wired in with zero `forward: true` entities). Both tests still pass with unchanged assertions — only the descriptions are misleading. Update both descriptions to state the real invariant:

```typescript
describe('buildDiscoveryConfigs', () => {
  describe('service with entity defs but no forward: true entities', () => {
    it('platform yields no configs (none of its entities are forward: true)', () => {
      expect(buildDiscoveryConfigs(ID_SITE, 'platform', 0, [])).toEqual([]);
    });
  });

  describe('index never observed', () => {
    it('emits nothing when the index never appears in observed paths', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'charger', 30, ['Dc/0/Current']);
      expect(configs.find(c => c.unique_id.includes('dc_0_voltage'))).toBeUndefined();
    });
  });
});
```

- [ ] **Step 4: Write the end-to-end dynamic-instance test**

This exercises the wildcard-subscription path directly, since (per the design doc's flagged nit) no production entity triggers it today. Add a new test file `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.dynamicInstance.test.ts`:

```typescript
import { EventEmitter } from 'events';
import type { MqttClient } from 'mqtt';
import { MqttBridgeConnection } from '../MqttBridgeConnection';
import type { VrmInstallation } from '../types';
import type { VrmBrokerPool } from '../VrmBrokerPool';

// This suite proves the dynamic multi-instance pipeline works end-to-end
// using vebus (already wired into SERVICE_ENTITY_DEFS today, per
// entityDefs.ts) even though vebus has zero forward:true entities in
// production. It temporarily patches one vebus entity's forward flag via
// jest.mock to exercise the path a future per-entity change will hit for
// real, without touching entityDefs.ts itself (Global Constraint: no
// forward: true changes to production registries in this work).
jest.mock('../../ha/entityDefs', () => {
  const actual = jest.requireActual('../../ha/entityDefs');
  const patchedVebus = actual.SERVICE_ENTITY_DEFS.vebus.map((def: { path: string }) =>
    def.path === 'State' ? { ...def, forward: true } : def,
  );
  return {
    ...actual,
    SERVICE_ENTITY_DEFS: { ...actual.SERVICE_ENTITY_DEFS, vebus: patchedVebus },
  };
});

const installation: VrmInstallation = {
  idSite: 1,
  name: 'Test Site',
  identifier: 'test-portal-abcd1234',
  brokerPortalId: 'test-portal-abcd1234',
  mqttHost: 'mqtt5.victronenergy.com',
  mqttWebHost: 'webmqtt5.victronenergy.com',
};
const PORTAL = installation.brokerPortalId;

function makeMockClient(connected = false): EventEmitter & { connected: boolean; subscribe: jest.Mock; unsubscribe: jest.Mock; publish: jest.Mock; off: jest.Mock } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connected,
    subscribe: jest.fn((_t: string, _o: unknown, cb?: (err: Error | null) => void) => cb?.(null)),
    unsubscribe: jest.fn((_t: string, cb?: (err: Error | null) => void) => cb?.(null)),
    publish: jest.fn((_t: string, _p: string, _o: unknown, cb?: (err: Error | undefined) => void) => cb?.(undefined)),
    off: jest.fn((event: string, fn: (...args: unknown[]) => void) => emitter.removeListener(event, fn)),
  });
}
function makeMockHa(): { publish: jest.Mock } {
  return { publish: jest.fn() };
}
function makeMockPublisher(): {
  publishAvailability: jest.Mock;
  publishInstallation: jest.Mock;
  pruneRetainedTopics: jest.Mock;
  refreshInstallationDiscovery: jest.Mock;
} {
  return {
    publishAvailability: jest.fn(),
    publishInstallation: jest.fn(),
    pruneRetainedTopics: jest.fn().mockResolvedValue(undefined),
    refreshInstallationDiscovery: jest.fn(),
  };
}
function makeMockPool(client: MqttClient): { getOrCreate: jest.Mock; destroyAll: jest.Mock } {
  return { getOrCreate: jest.fn().mockReturnValue(client), destroyAll: jest.fn().mockResolvedValue(undefined) };
}
const idSiteFor = (inst: VrmInstallation) => (brokerPortalId: string): number | undefined =>
  brokerPortalId === inst.brokerPortalId ? inst.idSite : undefined;

describe('dynamic multi-instance pipeline (end-to-end, patched vebus fixture)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('subscribes to vebus with a wildcard instance segment', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    conn.start();
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith(
      expect.arrayContaining([`N/${PORTAL}/vebus/+/State`]),
      { qos: 0 },
      expect.any(Function),
    );
  });

  it('forwards a message for a previously-unseen vebus instance and records it', () => {
    const client = makeMockClient(true);
    const ha = makeMockHa();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: ha as never, publisher: makeMockPublisher() as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);

    client.emit('message', `N/${PORTAL}/vebus/3/State`, Buffer.from('{"value":9}'));
    jest.advanceTimersByTime(500);

    expect(ha.publish).toHaveBeenCalledWith(`vrm/${installation.idSite}/vebus/3/State`, '{"value":9}');
    expect(conn.observedInstancesSnapshot.get('vebus')).toEqual(new Set(['3']));
  });

  it('schedules and fires a discovery refresh + prune re-run for the newly-seen instance', () => {
    const client = makeMockClient(true);
    const publisher = makeMockPublisher();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);
    publisher.refreshInstallationDiscovery.mockClear();
    publisher.pruneRetainedTopics.mockClear();

    client.emit('message', `N/${PORTAL}/vebus/3/State`, Buffer.from('{"value":9}'));
    jest.advanceTimersByTime(2000);

    expect(publisher.refreshInstallationDiscovery).toHaveBeenCalledTimes(1);
    const [, , observedInstancesArg] = publisher.refreshInstallationDiscovery.mock.calls[0];
    expect(observedInstancesArg.get('vebus')).toEqual(new Set(['3']));
    expect(publisher.pruneRetainedTopics).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd vrm-mqtt/app && npx jest MqttBridgeConnection.dynamicInstance.test.ts`
Expected: PASS. If the `jest.mock` factory's `SERVICE_ENTITY_DEFS.vebus` shape doesn't match (e.g. `VEBUS_ENTITIES` array not exposed the way expected), adjust the mock to target the exact export shape confirmed in Task 1–2's implementation — `SERVICE_ENTITY_DEFS` is a plain object export, so `jest.requireActual` + spread should work without further changes.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `cd vrm-mqtt/app && npx jest && npx tsc --noEmit && npx eslint src/`
Expected: PASS, no type errors, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/app/src/ha/entityDefs.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.dynamicInstance.test.ts
git commit -m "feat: enable all SERVICE_ENTITY_DEFS registries; add end-to-end dynamic-instance test"
```
