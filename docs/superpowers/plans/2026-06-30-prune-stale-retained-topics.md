# Prune stale retained topics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear stale retained topics under `vrm/{idSite}/#` whenever the bridge starts, so changing an entity from `forward: true` to `forward: false` (or renaming/removing it) doesn't leave orphan topics on the HA broker.

**Architecture:** A new helper `getCurrentlyForwardedTopics(idSite)` derives the full set of HA-side topics the bridge currently publishes from `SERVICE_ENTITY_DEFS` + `CUSTOM_ENTITY_DEFS` (same source of truth as discovery). A new `DiscoveryPublisher.pruneRetainedTopics(idSite)` method scans the broker with the existing `HaBrokerClient.collectRetained` primitive and clears anything not in the keep set. `MqttBridgeConnection.handleConnect` invokes the prune fire-and-forget after publishing availability.

**Tech Stack:** TypeScript, Jest (CommonJS-style `require` for module-reload tests), MQTT.js for `HaBrokerClient.collectRetained` and `publish`.

**Spec:** `docs/superpowers/specs/2026-06-30-prune-stale-retained-topics-design.md`

## Global Constraints

- TypeScript: `^5.9.3` (per `vrm-mqtt/app/package.json`).
- Test runner: Jest `^29.7.0` via `npm test` in `vrm-mqtt/app/`.
- Lint: `npm run lint` in `vrm-mqtt/app/`. Typecheck: `npm run typecheck`.
- Existing default retain is `true` in `HaBrokerClient.publish()` (`vrm-mqtt/app/src/ha/HaBrokerClient.ts:85`) — the clear primitive is `publish(topic, '', true)`.
- Empty-payload + retain is the codebase's established way to clear a retained topic (see `MqttBridgeConnection.stop()` and `DiscoveryPublisher.removeInstallation()`).
- The `observedPaths.ts` module owns the "what paths the bridge uses" mental model and currently exports `getObservedPaths` plus the private `expandTemplate` helper at `vrm-mqtt/app/src/ha/observedPaths.ts`.
- `Aggregation target` topic shape is `vrm/{idSite}/custom/aggregate/{path}` (literal `path`, no `{n}`) — see `MqttBridgeConnection.buildAggregator()` at `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:280`.
- Normal-entity topic shape is `vrm/{idSite}/system/0/{path}` (currently only `system` is bridged, instance `0`).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts` | Modify | Export `makeStateTopic` so the helper below can reuse the topic format. |
| `vrm-mqtt/app/src/ha/observedPaths.ts` | Modify | Add `getCurrentlyForwardedTopics(idSite)` deriving the full HA-side keep set from `SERVICE_ENTITY_DEFS` + `CUSTOM_ENTITY_DEFS`. |
| `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts` | Modify | Add `describe('getCurrentlyForwardedTopics')` block. |
| `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts` | Modify | Add `pruneRetainedTopics(idSite)` method. |
| `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts` | Modify | Add `describe('pruneRetainedTopics')` block; extend `makeMockHa` with `collectRetained`. |
| `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` | Modify | In `handleConnect`, fire-and-forget call `publisher.pruneRetainedTopics(idSite)` after `publishAvailability`. |
| `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` | Modify | Add test that `pruneRetainedTopics` is called with `idSite` after `connect`; add test that a rejected prune doesn't block `sendKeepalive`. |

---

## Task 1: Export `makeStateTopic` from `DiscoveryConfigBuilder`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts:137-139`

**Interfaces:**
- Consumes: existing `makeStateTopic(idSite, service, instance, path)` definition.
- Produces: the function becomes available to `observedPaths.ts` under the same name and signature.

- [ ] **Step 1: Add the `export` keyword**

Open `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts`. Locate the `makeStateTopic` definition (around line 137):

```ts
function makeStateTopic(idSite: number, service: string, instance: string | number, path: string): string {
  return `vrm/${idSite}/${service}/${instance}/${path}`;
}
```

Replace with:

```ts
export function makeStateTopic(idSite: number, service: string, instance: string | number, path: string): string {
  return `vrm/${idSite}/${service}/${instance}/${path}`;
}
```

- [ ] **Step 2: Verify no callers broke**

Run: `npm run typecheck --prefix vrm-mqtt/app`
Expected: exit 0, no diagnostics. The existing internal call at line 198 (`const sTopic = makeStateTopic(idSite, service, instance, path);`) keeps working unchanged.

- [ ] **Step 3: Commit**

```bash
git add vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts
git commit -m "refactor(discovery): export makeStateTopic for cross-module reuse"
```

---

## Task 2: Add `getCurrentlyForwardedTopics` helper

**Files:**
- Modify: `vrm-mqtt/app/src/ha/observedPaths.ts`
- Test: `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`

**Interfaces:**
- Consumes: `SERVICE_ENTITY_DEFS` + `CUSTOM_ENTITY_DEFS` (already imported in this file), `expandTemplate` (defined in the same file, file-local — call directly), `makeStateTopic` from `./DiscoveryConfigBuilder` (now exported by Task 1).
- Produces: `export function getCurrentlyForwardedTopics(idSite: number): Set<string>` — set of full HA-side topics the bridge publishes under `vrm/{idSite}/#`.

- [ ] **Step 1: Write the failing test**

Open `vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts`. Update the existing import line to also import the new helper:

```ts
import { getCurrentlyForwardedTopics, getObservedPaths } from '../observedPaths';
```

Append a new `describe` block at the end of the file (do not duplicate the leading `describe('getObservedPaths', ...)`):

```ts
describe('getCurrentlyForwardedTopics', () => {
  const ID_SITE = 42;

  it('always contains vrm/{idSite}/availability', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    expect(topics).toContain(`vrm/${ID_SITE}/availability`);
  });

  it('contains vrm/{idSite}/system/0/{path} for every forward: true system entity', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    // Dc/Battery/Soc has forward: true in entityDefs.ts.
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('expands {n} to 1, 2, 3 for forward: true template entities', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    // Ac/Consumption/L{n}/Power is a forward: true entity template.
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Ac/Consumption/L1/Power`);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Ac/Consumption/L2/Power`);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Ac/Consumption/L3/Power`);
  });

  it('contains vrm/{idSite}/custom/aggregate/{path} for every forward: true aggregate', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Consumption/Power`);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Grid/Power`);
  });

  it('does NOT contain forward: false / unflagged entity paths', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    // Dc/Battery/Current has no forward flag (defaults to false) in entityDefs.ts.
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Current`);
  });

  it('does NOT contain vebus / platform entity paths (different service)', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE);
    // Ac/Out/L1/P is a vebus entity — must not leak into system/0.
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Ac/Out/L1/P`);
  });

  it('returns disjoint sets for different idSite values', () => {
    const a = getCurrentlyForwardedTopics(1);
    const b = getCurrentlyForwardedTopics(2);
    for (const t of a) {
      expect(b).not.toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern observedPaths`
Expected: the new `describe('getCurrentlyForwardedTopics')` tests fail with "getCurrentlyForwardedTopics is not a function" (or `Cannot find named export`). The existing `describe('getObservedPaths')` tests still pass.

- [ ] **Step 3: Implement the helper**

Open `vrm-mqtt/app/src/ha/observedPaths.ts`. Add an import at the top:

```ts
import { makeStateTopic } from './DiscoveryConfigBuilder';
```

Append the function at the end of the file (after `getObservedPaths`):

```ts
/**
 * Return the set of full HA-side topics the bridge currently publishes under
 * `vrm/{idSite}/#`. Derived from `SERVICE_ENTITY_DEFS` + `CUSTOM_ENTITY_DEFS`
 * — same source of truth as discovery generation in `DiscoveryConfigBuilder`.
 *
 * Topic construction:
 *   - `vrm/{idSite}/availability`                       (always)
 *   - `vrm/{idSite}/system/0/{path}`                    (per forward: true entity,
 *                                                       `{n}` expanded to 1, 2, 3)
 *   - `vrm/{idSite}/custom/aggregate/{path}`            (per forward: true aggregate;
 *                                                       `path` is literal)
 *
 * Only `system/0` is bridged today; if additional services / instances are
 * bridged in future, extend the per-service loop accordingly.
 */
export function getCurrentlyForwardedTopics(idSite: number): Set<string> {
  const topics = new Set<string>();
  topics.add(`vrm/${idSite}/availability`);

  for (const def of SERVICE_ENTITY_DEFS.system ?? []) {
    if (!def.forward) continue;
    for (const expanded of expandTemplate(def.path)) {
      topics.add(makeStateTopic(idSite, 'system', 0, expanded));
    }
  }

  for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
    if (!agg.forward) continue;
    topics.add(`vrm/${idSite}/custom/aggregate/${agg.path}`);
  }

  return topics;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern observedPaths`
Expected: all tests in the file pass.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck --prefix vrm-mqtt/app && npm run lint --prefix vrm-mqtt/app`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/ha/observedPaths.ts vrm-mqtt/app/src/ha/__tests__/observedPaths.test.ts
git commit -m "feat(observedPaths): add getCurrentlyForwardedTopics helper"
```

---

## Task 3: Add `pruneRetainedTopics` method on `DiscoveryPublisher`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts`
- Test: `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`

**Interfaces:**
- Consumes: `this.ha.collectRetained(pattern, timeoutMs)` — already returns `Array<{topic, payload}>`; `this.ha.publish(topic, payload, retain)` — already retains by default.
- Produces: `async pruneRetainedTopics(idSite: number): Promise<void>` — scans `vrm/{idSite}/#`, clears any retained topic whose prefix/name falls outside `getCurrentlyForwardedTopics(idSite)`.

- [ ] **Step 1: Verify the existing mock factory covers `collectRetained`**

Open `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts` (around line 4). The existing `makeMockHa` already mocks both `publish` and `collectRetained`:

```ts
function makeMockHa(): jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> {
  return {
    publish: jest.fn(),
    collectRetained: jest.fn().mockResolvedValue([]),
  };
}
```

No edit needed — both methods the prune will call are already mocked. The factory's existing return type `jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>>` flows through `publisher()` into `pub: DiscoveryPublisher`, so calls inside `pruneRetainedTopics` to `this.ha.publish(...)` and `this.ha.collectRetained(...)` resolve to the jest mocks at compile time.

- [ ] **Step 2: Write the failing test for `pruneRetainedTopics`**

Append a new `describe` block at the end of `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`:

```ts
describe('pruneRetainedTopics', () => {
  const KEEP_TOPIC = `vrm/${ID_SITE}/system/0/Dc/Battery/Soc`;
  const STALE_TOPIC = `vrm/${ID_SITE}/system/0/Ac/Sample`;
  const AVAIL_TOPIC = `vrm/${ID_SITE}/availability`;
  const SET_TOPIC = `vrm/${ID_SITE}/system/0/Dc/Battery/Soc/set`;
  const SIBLING_TOPIC = `vrm/${ID_SITE + 1}/system/0/Dc/Battery/Soc`;

  function seedRetained(
    ha: jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>>,
    topics: string[],
  ): void {
    ha.collectRetained.mockResolvedValueOnce(
      topics.map(t => ({ topic: t, payload: '{"value":42}' })),
    );
  }

  it('clears only the stale retained topics (not in keep set)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [KEEP_TOPIC, STALE_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).toHaveBeenCalledTimes(1);
    expect(ha.publish).toHaveBeenCalledWith(STALE_TOPIC, '', true);
  });

  it('skips the availability topic even when the broker surfaces it', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [AVAIL_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('skips /set topics (live command writes during collect window)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [SET_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('skips topics that belong to a different idSite (defensive)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [SIBLING_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('clears every stale topic when there are many', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [
      KEEP_TOPIC,
      `vrm/${ID_SITE}/system/0/Ac/Whatever`,
      `vrm/${ID_SITE}/system/0/Old/Removed/Path`,
    ]);
    await pub.pruneRetainedTopics(ID_SITE);

    const cleared = (ha.publish as jest.Mock).mock.calls.map(([t]: [string]) => t);
    expect(cleared).toEqual([
      `vrm/${ID_SITE}/system/0/Ac/Whatever`,
      `vrm/${ID_SITE}/system/0/Old/Removed/Path`,
    ]);
  });

  it('is a no-op when the broker returns no retained topics', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, []);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('logs the number of pruned topics', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { pub, ha } = publisher();
    seedRetained(ha, [`vrm/${ID_SITE}/system/0/A`, `vrm/${ID_SITE}/system/0/B`]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/Pruned 2 stale retained topic\(s\) under vrm\/12345\//),
    );
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern DiscoveryPublisher`
Expected: compile error or runtime error — `pub.pruneRetainedTopics is not a function` (or property does not exist on type `DiscoveryPublisher`).

- [ ] **Step 4: Implement `pruneRetainedTopics`**

Open `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts`. Add an import at the top:

```ts
import { getCurrentlyForwardedTopics } from './observedPaths';
```

Append the new method inside the class (anywhere; the `pruneRetainedTopics` block after `onHaBirth` keeps related cleanup code together):

```ts
  /**
   * Scan the broker for retained topics under `vrm/{idSite}/#` and clear any
   * that are not currently forwarded by the bridge. Idempotent — after the
   * first successful run, the broker returns zero stale topics and the call
   * is a no-op. Best-effort — no error path raises out of the method.
   *
   * `availability` and live `/set` writes (the bridge subscribes to `vrm/#`
   * and may surface `/set` messages during the 300ms collect window) are
   * skipped defensively; the keep set is derived from
   * `getCurrentlyForwardedTopics`.
   */
  async pruneRetainedTopics(idSite: number): Promise<void> {
    const keep = getCurrentlyForwardedTopics(idSite);
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
    console.log(`[HA] Pruned ${cleared} stale retained topic(s) under vrm/${idSite}/`);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern DiscoveryPublisher`
Expected: all tests in the file pass, including the new `describe('pruneRetainedTopics')` block.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck --prefix vrm-mqtt/app && npm run lint --prefix vrm-mqtt/app`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/app/src/ha/DiscoveryPublisher.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts
git commit -m "feat(discovery): prune stale retained topics under vrm/{idSite}/#"
```

---

## Task 4: Wire up the prune in `MqttBridgeConnection.handleConnect`

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`
- Test: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`

**Interfaces:**
- Consumes: `this.publisher.pruneRetainedTopics(idSite): Promise<void>` — added in Task 3.
- Produces: `handleConnect` invokes the prune fire-and-forget after `publishAvailability`.

- [ ] **Step 1: Update the publisher mock to include the new method**

Open `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`. Update the `makeMockPublisher` factory (around line 48):

Replace:

```ts
function makeMockPublisher(): { publishAvailability: jest.Mock; publishInstallation: jest.Mock } {
  return { publishAvailability: jest.fn(), publishInstallation: jest.fn() };
}
```

With:

```ts
function makeMockPublisher(): {
  publishAvailability: jest.Mock;
  publishInstallation: jest.Mock;
  pruneRetainedTopics: jest.Mock;
} {
  return {
    publishAvailability: jest.fn(),
    publishInstallation: jest.fn(),
    pruneRetainedTopics: jest.fn().mockResolvedValue(undefined),
  };
}
```

Note: if existing tests reference the union type of the mock publisher, the `Pick<DiscoveryPublisher, ...>` annotation on `MqttBridgeConnection`'s constructor will need updating (see next step).

- [ ] **Step 2: Extend the publisher type accepted by `MqttBridgeConnection`**

Open `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`. Find the `MqttBridgeConnectionOptions` interface and the `private readonly publisher:` field (around lines 76 and 90).

In `MqttBridgeConnectionOptions` at line 76, change:

```ts
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
```

To:

```ts
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics'>;
```

And the matching field at line 90:

```ts
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
```

To:

```ts
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics'>;
```

No call sites of these helpers need to change — both still take `(idSite, …)`.

- [ ] **Step 3: Write the failing test for the wire-up**

Append two new tests inside the top-level `describe('MqttBridgeConnection', …)` block in `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` (after the existing `describe('retained state topic cleanup', …)` block — search for the closing `});` of that block if needed):

```ts
  describe('pruneRetainedTopics wire-up', () => {
    it('calls publisher.pruneRetainedTopics(idSite) after connect', async () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: publisher as never,
      });
      conn.start();
      client.emit('connect');

      // handleConnect fires synchronously, but prune call scheduling uses
      // unhandled promise — let microtasks flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(publisher.pruneRetainedTopics).toHaveBeenCalledTimes(1);
      expect(publisher.pruneRetainedTopics).toHaveBeenCalledWith(installation.idSite);
    });

    it('does not block sendKeepalive when prune rejects', async () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const publisher = makeMockPublisher();
      const err = new Error('broker scan failed');
      // Silence the expected error log so the test output stays clean.
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      publisher.pruneRetainedTopics.mockRejectedValueOnce(err);

      const conn = new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: publisher as never,
      });
      conn.start();
      client.emit('connect');

      // sendKeepalive must fire its publish (broker heartbeat) regardless of
      // the prune outcome.
      expect(client.publish).toHaveBeenCalledWith(
        expect.stringMatching(/^R\/.+\/keepalive$/),
        expect.any(String),
        expect.objectContaining({ qos: 0 }),
        expect.any(Function),
      );
      errSpy.mockRestore();
    });
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern MqttBridgeConnection -t "pruneRetainedTopics"`
Expected: failures — the wire-up doesn't exist; `publisher.pruneRetainedTopics` was never called. The first test asserts `toHaveBeenCalledTimes(1)` (fails with 0). The second test fails on the same assertion.

- [ ] **Step 5: Implement the wire-up**

Open `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`. Inside `handleConnect`, after the existing `this.publisher.publishAvailability(this.installation.idSite, true);` call (around line 204), insert:

```ts
    // Fire-and-forget cleanup of stale retained topics from prior runs whose
    // entity defs are no longer in the forward set. Best-effort — failures
    // are logged at the wire-up site, never raised into handleConnect.
    this.publisher.pruneRetainedTopics(this.installation.idSite).catch((err) => {
      console.error(`[HA] Prune failed for idSite=${this.installation.idSite}:`, err);
    });
```

The line ordering inside `handleConnect` becomes:
1. `this.isFirstKeepalive = true;`
2. `this.throttle.start();`
3. `this.client.subscribe(...)`
4. `this.publisher.publishInstallation(...)`
5. `this.publisher.publishAvailability(...)`
6. **`this.publisher.pruneRetainedTopics(...).catch(...)`**  ← new
7. `this.sendKeepalive();`
8. `this.keepaliveTimer = setInterval(...)`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test --prefix vrm-mqtt/app -- --testPathPattern MqttBridgeConnection`
Expected: all tests in the file pass, including the two new wire-up tests. (The `sendKeepalive` test passes because `sendKeepalive` is still called synchronously after the fire-and-forget prune — the `client.publish` keepalive call is the second `publish` call from this client overall, but the existing tests are written loosely enough that the new test's `toHaveBeenCalledWith(expect.stringMatching(/^R\/.+\/keepalive$/), …)` passes regardless of order.)

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck --prefix vrm-mqtt/app && npm run lint --prefix vrm-mqtt/app`
Expected: both exit 0.

- [ ] **Step 8: Run the full suite once more**

Run: `npm test --prefix vrm-mqtt/app`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat(bridge): prune stale retained topics on handleConnect"
```
