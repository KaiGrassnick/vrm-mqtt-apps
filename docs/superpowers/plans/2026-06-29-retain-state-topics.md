# Retain State Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `vrm/{idSite}/…` value topic the bridge publishes be retained on the local Home Assistant Mosquitto broker, so HA restart and VRM-side reconnects no longer leave entities showing `unavailable` / `null` / `0`.

**Architecture:** Flip `HaBrokerClient.publish`'s default `retained` flag to `true` so all throttle-driven state publishes retain for free. Add a `publishedStateTopics: Set<string>` to `MqttBridgeConnection` that records every HA-side topic it has forwarded; on `stop()` (the existing removal/teardown hook), publish empty-retained for each tracked topic and clear the set.

**Tech Stack:** TypeScript, Node.js, Jest with `useFakeTimers()`. No new dependencies. Existing `HaBrokerClient.publish`/`MqttBridgeConnection.handleMessage`/`MqttBridgeConnection.stop` test conventions.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `vrm-mqtt/app/src/ha/HaBrokerClient.ts` | **modify** line 85 | Default `retained = true` on `publish()`. |
| `vrm-mqtt/app/src/ha/__tests__/HaBrokerClient.test.ts` | **modify** | New test: default `publish()` flags `retain: true`. Existing explicit-true test still passes. |
| `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` | **modify** | New `publishedStateTopics: Set<string>` field. Track in `handleMessage`. Clear retained in `stop()`. |
| `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` | **modify** | Two new tests in a `describe('retained state topic cleanup')` block. |
| `vrm-mqtt/CHANGELOG.md` | **modify** | New entry under next patch bump. **No** `config.yaml` version bump in this plan — see Task 4 note. |
| `vrm-mqtt/config.yaml` | **NOT modified** | See Task 4 note. |

All other files (`DiscoveryPublisher`, `InstallationManager`, `MessageRouter`, `RollingMessageThrottle`, `MessageThrottle`, `VrmBrokerPool`, `VrmApiClient`, `HaBrokerClient.collectRetained`, `HaBrokerClient.start`, `HaBrokerClient.stop`) are untouched.

## Global Constraints

- **DRY / YAGNI / TDD with frequent commits** — failing test first, minimal impl, then commit.
- **No new add-on options** — `config.yaml` schema is unchanged.
- **No change to existing HA broker session semantics** — `clean: true` is about persistent subscriptions, not retained messages. It stays.
- **Match existing test patterns** — fake `mqtt` client via `EventEmitter` with `publish: jest.fn(..., cb)`; `mockHa = { publish: jest.fn() }`; `jest.useFakeTimers()`; existing throttle test setup in `MqttBridgeConnection.test.ts:374-461` is the template for new state-topic tests.
- **No `config.yaml` version bump** — this branch (`feature/rolling-updates`) has an uncommitted `CHANGELOG.md` entry for `0.1.6` (rolling throttle); bumping `config.yaml` here would put 0.1.5 → 0.1.6 markers on a branch where the CHANGELOG already references 0.1.6. Defer the version bump to the merge/MR step. **Add the CHANGELOG entry under a placeholder header that the merger can rename.**
- **`ha.publish` callers passing `retained` explicitly are unchanged** — only the default flips.

---

## Task 1: `HaBrokerClient.publish` defaults to retained

**Files:**
- Modify: `vrm-mqtt/app/src/ha/HaBrokerClient.ts:85`
- Modify: `vrm-mqtt/app/src/ha/__tests__/HaBrokerClient.test.ts` (add one test in the existing `describe('HaBrokerClient', …)` block)

- [ ] **Step 1: Add a failing test for the new default**

Append this test inside `describe('HaBrokerClient', () => { … })` in `HaBrokerClient.test.ts`, after the existing `it('publish() forwards to the underlying client when connected', …)` at line 115:

```ts
it('publish() defaults retained to true so throttle-driven state messages retain on the broker', () => {
  const fake = makeFakeClient(true);
  mockedConnect.mockReturnValue(fake);

  const client = new HaBrokerClient({ host: 'h', port: 1 });
  client.start();

  client.publish('vrm/1/system/0/Dc/Battery/Voltage', '13.4');
  expect((fake as unknown as { publish: jest.Mock }).publish).toHaveBeenCalledWith(
    'vrm/1/system/0/Dc/Battery/Voltage',
    '13.4',
    expect.objectContaining({ retain: true }),
    expect.any(Function),
  );
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/HaBrokerClient.test.ts -t 'defaults retained to true'
```
Expected: FAIL with `"expected … objectContaining({ retain: true })"` vs `"received { retain: false }"`. (Confirm before moving on — if it passes without a code change, something is already retaining on default and this task is a no-op; surface that to the user before continuing.)

- [ ] **Step 3: Flip the default in `HaBrokerClient.publish`**

In `vrm-mqtt/app/src/ha/HaBrokerClient.ts`, on line 85, change:

```ts
publish(topic: string, payload: string, retained = false): void {
```

to:

```ts
publish(topic: string, payload: string, retained = true): void {
```

- [ ] **Step 4: Run all `HaBrokerClient` tests, verify they pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/HaBrokerClient.test.ts
```
Expected: 8 passing (the 7 existing + 1 new). The existing explicit-`true` test at line 115 still passes — it just keeps passing `true` explicitly.

- [ ] **Step 5: Commit**

```bash
cd vrm-mqtt
git add app/src/ha/HaBrokerClient.ts app/src/ha/__tests__/HaBrokerClient.test.ts
git commit -m "feat(ha): default HaBrokerClient.publish to retain=true"
```

---

## Task 2: `MqttBridgeConnection` tracks and clears retained state topics

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` (add field at line ~37, modify `handleMessage` at line ~176, modify `stop()` at line ~82)
- Modify: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` (add new `describe` block at end, after the existing `replaced installation` block around line 540)

The new code path: `handleMessage` records `msg.topic` into `publishedStateTopics` before enqueueing. `stop()` iterates the set, calls `this.ha.publish(topic, '', true)` for each, then clears the set. This must be **after** the existing `throttle.flush()` (line 87) so pending state messages drain before any retained-clear runs for the same topic.

- [ ] **Step 1: Add a failing test for tracking + clearing**

Append this block at the end of the existing `describe('MqttBridgeConnection', …)` in `MqttBridgeConnection.test.ts` (after the last `});` of the `replaced installation` block, before the outer `});`):

```ts
describe('retained state topic cleanup', () => {
  const portalId = installation.brokerPortalId;
  const idSite = installation.idSite;
  const INTERVAL = 100;

  function makeActiveConn(): {
    client: ReturnType<typeof makeMockClient>;
    ha: ReturnType<typeof makeMockHa>;
    conn: MqttBridgeConnection;
  } {
    const client = makeMockClient(true);
    const ha = makeMockHa();
    const conn = new MqttBridgeConnection({
      installation,
      pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
      ha: ha as never,
      publisher: makeMockPublisher() as never,
      throttleIntervalMs: INTERVAL,
      getIdSite: idSiteFor(installation),
    });
    conn.start();
    client.emit('connect');
    return { client, ha, conn };
  }

  function emit(client: ReturnType<typeof makeMockClient>, topic: string, payload: string): void {
    client.emit('message', topic, Buffer.from(payload));
  }

  it('publishes empty-retained for each forwarded state topic on stop()', async () => {
    const { client, ha, conn } = makeActiveConn();

    emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
    jest.advanceTimersByTime(INTERVAL);
    emit(client, `N/${portalId}/system/0/Dc/Battery/Voltage`, '{"value":13.4}');
    jest.advanceTimersByTime(INTERVAL);

    (ha.publish as jest.Mock).mockClear();
    await conn.stop();

    // One retained-clear per tracked state topic, with empty payload and retained=true.
    const clears = (ha.publish as jest.Mock).mock.calls.filter(
      ([_t, p, r]: [string, string, boolean]) => p === '' && r === true,
    );
    const clearTopics = clears.map(([t]: [string]) => t).sort();
    expect(clearTopics).toEqual([
      `vrm/${idSite}/system/0/Dc/Battery/Soc`,
      `vrm/${idSite}/system/0/Dc/Battery/Voltage`,
    ].sort());
  });

  it('does not publish retained-clear for topics that were never forwarded', async () => {
    const { ha, conn } = makeActiveConn();
    await conn.stop();
    const clears = (ha.publish as jest.Mock).mock.calls.filter(
      ([_t, p, r]: [unknown, string, boolean]) => p === '' && r === true,
    );
    expect(clears).toEqual([]);
  });

  it('flushes buffered state before clearing retained, so the broker ends with empty payload retained', async () => {
    const { client, ha, conn } = makeActiveConn();

    // Buffer without flushing (don't advance time).
    emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');

    (ha.publish as jest.Mock).mockClear();
    await conn.stop();

    // Order on the broker for this topic: retained payload, then empty retained.
    const stateCalls = (ha.publish as jest.Mock).mock.calls.filter(
      ([t]: [string]) => t === `vrm/${idSite}/system/0/Dc/Battery/Soc`,
    );
    expect(stateCalls.map(([, p]: [string, string]) => p)).toEqual(['{"value":80}', '']);
  });
});
```

(Mirror the `client / ha / conn` triple helper pattern from the existing `throttle behaviour` describe block at line 374. The shared helper exposes `client` so tests can emit 'message' events the same way existing tests do — see line 255 for the canonical pattern.)

- [ ] **Step 2: Run the new tests, verify they all fail**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/MqttBridgeConnection.test.ts -t 'retained state topic cleanup'
```
Expected: 3 failing. Failure mode: no `ha.publish` calls with `p === ''` (set is empty, stop() does nothing).

- [ ] **Step 3: Add the tracking field + handleMessage modification + stop() modification**

In `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`:

**(a)** Add this private field alongside the other `private readonly …` fields (after `private isFirstKeepalive = true;` around line 37):

```ts
/** HA-side topics this connection has forwarded; cleared on stop() so the broker
 *  doesn't keep the old installation's last value retained. */
private readonly publishedStateTopics = new Set<string>();
```

**(b)** Modify `handleMessage` (line 176) from:

```ts
private handleMessage(topic: string, payload: Buffer): void {
  if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;

  const str = payload.toString();
  for (const msg of routeFromVrm(topic, str, this.getIdSite)) {
    this.throttle.enqueue(msg.topic, msg.payload);
  }
}
```

to:

```ts
private handleMessage(topic: string, payload: Buffer): void {
  if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;

  const str = payload.toString();
  for (const msg of routeFromVrm(topic, str, this.getIdSite)) {
    this.publishedStateTopics.add(msg.topic);
    this.throttle.enqueue(msg.topic, msg.payload);
  }
}
```

**(c)** Modify `stop()` (line 82) so the body becomes:

```ts
async stop(): Promise<void> {
  if (this.keepaliveTimer !== null) {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
  this.throttle.flush();

  // Clear retained state values on the HA broker so the old installation's last
  // values don't linger after teardown.
  for (const topic of this.publishedStateTopics) {
    this.ha.publish(topic, '', true);
  }
  this.publishedStateTopics.clear();

  // No client means start() was never called — nothing to clean up.
  if (!this.client) return;

  this.client.off('connect', this.boundHandleConnect);
  this.client.off('message', this.boundHandleMessage);
  this.client.off('error', this.boundHandleError);
  this.client.off('offline', this.boundHandleOffline);
  this.client.off('reconnect', this.boundHandleReconnect);

  await new Promise<void>((resolve) => {
    this.client!.unsubscribe(this.subscribeTopics, (err) => {
      if (err) {
        console.error(`[MQTT] Unsubscribe error for ${this.installation.identifier}: ${err.message}`);
      }
      resolve();
    });
  });
}
```

(The only changes vs. the existing body: the retained-clear loop after `throttle.flush()`, and the explicit `publishedStateTopics.clear()` line below it.)

- [ ] **Step 4: Run the new tests, verify they pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/MqttBridgeConnection.test.ts -t 'retained state topic cleanup'
```
Expected: 3 passing.

- [ ] **Step 5: Run the full `MqttBridgeConnection` suite, verify no regressions**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/MqttBridgeConnection.test.ts
```
Expected: All tests passing. The two `2-arg`-form `toHaveBeenCalledWith` assertions throughout the file (e.g. line 410, line 423) keep passing because `expect` only matches the supplied positional args — the now-retained third arg is ignored.

- [ ] **Step 6: Run the full project test suite**

Run:
```bash
cd vrm-mqtt/app && npx jest
```
Expected: All green. No other tests are affected (existing `ha.publish` callers passing `true` explicitly are unchanged; throttle's `ha.publish(topic, payload)` 2-arg call now retains but no test asserts on the third arg there).

- [ ] **Step 7: Commit**

```bash
cd vrm-mqtt
git add app/src/vrm/MqttBridgeConnection.ts app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "feat(vrm): track and clear retained state topics on connection teardown"
```

---

## Task 3: CHANGELOG entry

**Files:**
- Modify: `vrm-mqtt/CHANGELOG.md`

- [ ] **Step 1: Add the entry**

`vrm-mqtt/CHANGELOG.md` currently has an uncommitted `## 0.1.6` block (rolling throttle). **Insert a new placeholder header above it** with this content:

```markdown
## 0.1.7
- Retain every bridged VRM state value on the local broker so Home Assistant
  restarts and VRM-side reconnects no longer show entities as `unknown` /
  `null` / `0`. On installation removal, retained state for that installation
  is cleared.
```

Place it as the **first** `##` heading in the file (above the existing `## 0.1.6`). The merger who bundles this branch with the rolling-throttle work can renumber as appropriate.

- [ ] **Step 2: Commit**

```bash
cd vrm-mqtt
git add CHANGELOG.md
git commit -m "docs: changelog entry for retain state topics"
```

**Do not touch `config.yaml` in this plan.** This branch (`feature/rolling-updates`) already has uncommitted `0.1.6` CHANGELOG entries from prior work; bumping `version` here would conflict. The version bump belongs on whichever branch the user merges these through for release.

---

## Self-Review (filled while writing the plan)

- **Spec coverage:**
  - §1 flip default → Task 1.
  - §2 track topics → Task 2 step 3(b).
  - §3 clear retained on stop → Task 2 step 3(c).
  - Testing strategy → Task 1 step 1, Task 2 step 1.
  - Migration & rollout (version bump) → explicitly deferred with rationale.
- **Placeholder scan:** none.
- **Type consistency:** `publishedStateTopics: Set<string>` used identically in field declaration, `handleMessage.add`, and `stop()` iteration. No renames across tasks.
- **Edge cases:**
  - Empty set on stop → test 2 covers it.
  - Buffered messages + stop race → test 3 covers the flush-before-clear ordering.
  - Test 3 expectation: `stateCalls.map(p) === ['{"value":80}', '']` proves (a) the buffered retained publish happens, then (b) the empty-retained clear happens on the same topic, leaving the broker with an empty retained payload — net correct.
- **Test helper pattern:** every new test now mirrors the `makeActiveConn` triple `{client, ha, conn}` shape from the existing `throttle behaviour` block (line 374) — review the helper and the `emit()` shim before implementing, both fit on one screen and prevent the reader from inventing their own variant.
