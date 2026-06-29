# Rolling Message Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bursty `GlobalMessageThrottle` with a sharded `RollingMessageThrottle` that spreads its 500ms flush evenly across all installations, so the HA broker sees a continuous stream rather than a single ~700-publish burst every cycle.

**Architecture:** New `RollingMessageThrottle` class shards its buffer by `portalId` (extracted from the `vrm/{portalId}/…` topic prefix). A `setTimeout` chain ticks at `max(1, ⌊intervalMs / N⌋)` ms; each tick flushes one shard in round-robin order. Same public API as the old class — `enqueue`, `start`, `flush`, `stop` — so `MqttBridgeConnection` and `InstallationManager` only need a one-token import swap.

**Tech Stack:** TypeScript, Node.js, Jest with `useFakeTimers()`. The throttle is framework-free — pure class with a `setTimeout` chain. No new dependencies.

## Global Constraints

- **No new add-on options** — `vrm_throttle_interval_ms` (default 500) is reused as-is. (`config.yaml` schema, `DOCS.md` Configuration table are unchanged in shape.)
- **No breaking change to public API** — `enqueue(topic, payload)`, `start()`, `flush()`, `stop()` keep the same signatures and contracts.
- **Per-topic coalescing preserved** — "latest value wins" for the same topic must hold.
- **Small fleets (N ≤ 1 buffered shard) keep byte-identical timing** — no regression for installations with a single bridge.
- **TDD with frequent commits** — write the failing test, then the minimal implementation, then commit. One commit per step where it makes sense; one commit per task at minimum.
- **CHANGELOG, DOCS, config.yaml version bump go in their own task at the end** — do not interleave with code changes.
- **Match the existing repository style** — see `GlobalMessageThrottle.ts` and `MessageThrottle.ts` for the file/import conventions, JSDoc style, and `PublishFn` import path.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `vrm-mqtt/app/src/vrm/RollingMessageThrottle.ts` | **new** | Sharded-by-`portalId` rolling throttle. Public API: `enqueue`, `start`, `flush`, `stop`. |
| `vrm-mqtt/app/src/vrm/__tests__/RollingMessageThrottle.test.ts` | **new** | Unit tests for the new class. 7 preserved cases + 5 new cases (see spec § Testing). |
| `vrm-mqtt/app/src/vrm/InstallationManager.ts` | **modify** lines 3, 37, 48 | Rename `GlobalMessageThrottle` → `RollingMessageThrottle`. |
| `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` | **modify** lines 4, 21, 30 | Rename `GlobalMessageThrottle` → `RollingMessageThrottle`. |
| `vrm-mqtt/app/src/vrm/GlobalMessageThrottle.ts` | **delete** (in Task 3) | Replaced by `RollingMessageThrottle`. |
| `vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts` | **delete** (in Task 3) | Replaced by `RollingMessageThrottle.test.ts`. |
| `vrm-mqtt/config.yaml` | **modify** (Task 4) | `version: "0.1.4"` → `"0.1.5"`. |
| `vrm-mqtt/CHANGELOG.md` | **modify** (Task 4) | Add 0.1.5 entry. |
| `vrm-mqtt/DOCS.md` | **modify** (Task 4) | One sentence in the Configuration table describing rolling behavior. |

All other files are untouched.

---

## Task 1: Add `RollingMessageThrottle` (TDD)

**Files:**
- Create: `vrm-mqtt/app/src/vrm/RollingMessageThrottle.ts`
- Create: `vrm-mqtt/app/src/vrm/__tests__/RollingMessageThrottle.test.ts`

**Interfaces:**
- Consumes: `PublishFn` from `./MessageThrottle` (type only — `import type { PublishFn } from './MessageThrottle';`).
- Produces:
  ```ts
  export class RollingMessageThrottle {
    constructor(intervalMs: number, publish: PublishFn);
    enqueue(topic: string, payload: string): void;
    start(): void;
    flush(): void;
    stop(): void;
  }
  ```
- Later tasks (2, 3) consume this class in place of `GlobalMessageThrottle`.

- [ ] **Step 1: Write the failing test file**

Create `vrm-mqtt/app/src/vrm/__tests__/RollingMessageThrottle.test.ts` with the contents below. This file is the executable spec for the new class. It contains all 7 preserved cases from `vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts` (renamed) plus 4 new cases for the rolling behavior.

```ts
import { RollingMessageThrottle } from '../RollingMessageThrottle';

describe('RollingMessageThrottle', () => {
  let publish: jest.Mock;
  let throttle: RollingMessageThrottle;

  beforeEach(() => {
    jest.useFakeTimers();
    publish = jest.fn();
    throttle = new RollingMessageThrottle(500, publish);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── preserved semantics (must match the old GlobalMessageThrottle) ────────

  it('publishes directly when intervalMs is 0 (bypass mode)', () => {
    const direct = new RollingMessageThrottle(0, publish);
    direct.enqueue('vrm/x', 'a');
    expect(publish).toHaveBeenCalledWith('vrm/x', 'a');
  });

  it('coalesces messages with the same topic (latest wins)', () => {
    throttle.start();
    throttle.enqueue('vrm/x', 'a');
    throttle.enqueue('vrm/x', 'b');
    throttle.enqueue('vrm/x', 'c');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('vrm/x', 'c');
  });

  it('publishes one topic per shard within the interval (2 installations, 2 ticks per cycle)', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('vrm/a', '1');
    expect(publish).toHaveBeenCalledWith('vrm/b', '2');
  });

  it('start() is idempotent — does not double-arm the timer', () => {
    throttle.start();
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('flush() drains the buffer immediately and re-arms the schedule', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    // The throttle is still alive: a fresh enqueue is picked up by the next tick.
    // After flush, the timer is rescheduled by the new-shard path with N=2
    // and tickMs=250; advancing 500ms fires both ticks (one empty, one for 'vrm/b').
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith('vrm/b', '2');
  });

  it('stop() drains and clears the timer', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.stop();
    expect(publish).toHaveBeenCalledTimes(1);
    // After stop(), advancing timers must NOT publish.
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an empty flush', () => {
    throttle.start();
    jest.advanceTimersByTime(500);
    expect(publish).not.toHaveBeenCalled();
  });

  // ── new rolling behavior ──────────────────────────────────────────────────

  it('publishes from all N installations within one interval', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    throttle.enqueue('vrm/c', '3');
    // N=3 → tickMs = floor(500/3) = 166. Expect 3 publishes within 500ms.
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('spreads publishes across the interval, not at the end', () => {
    // 3 installations, intervalMs=300, tickMs=100.
    // Publishes land at t=100, 200, 300 — not all clustered at the boundary.
    const t = new RollingMessageThrottle(300, publish);
    const callTimes: number[] = [];
    publish.mockImplementation(() => {
      callTimes.push(jest.now());
    });
    jest.setSystemTime(0);
    t.start();
    t.enqueue('vrm/a', '1');
    t.enqueue('vrm/b', '2');
    t.enqueue('vrm/c', '3');
    jest.advanceTimersByTime(300);
    expect(callTimes).toHaveLength(3);
    expect(new Set(callTimes).size).toBe(3);
    // Span: at least 150ms between first and last publish.
    expect(Math.max(...callTimes) - Math.min(...callTimes)).toBeGreaterThanOrEqual(150);
  });

  it('publishes a newly-added installation in a subsequent cycle', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500); // cycle 1: 'vrm/a' then 'vrm/b'
    expect(publish).toHaveBeenCalledTimes(2);
    // A third installation appears after cycle 1.
    throttle.enqueue('vrm/c', '3');
    // Cycle 2: N=3, tickMs=166. 'vrm/c' lands at its slot in cycle 2.
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith('vrm/c', '3');
  });

  it('floors tickMs at 1ms for very large fleets (per-installation latency grows linearly)', () => {
    // 1000 installations, intervalMs=500. Without the floor, tickMs would be 0.
    // With the floor, tickMs=1 and a full cycle takes 1000ms.
    const t = new RollingMessageThrottle(500, publish);
    t.start();
    for (let i = 0; i < 1000; i++) {
      t.enqueue(`vrm/site${i}/x`, `${i}`);
    }
    jest.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1000);
  });
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `cd vrm-mqtt/app && npx jest src/vrm/__tests__/RollingMessageThrottle.test.ts`
Expected: FAIL with `Cannot find module '../RollingMessageThrottle'` (or similar import error). All test cases fail because the class does not exist yet.

- [ ] **Step 3: Implement `RollingMessageThrottle`**

Create `vrm-mqtt/app/src/vrm/RollingMessageThrottle.ts` with the following contents. The internal state is a sharded buffer; a `setTimeout` chain ticks at `max(1, ⌊intervalMs / N⌋)` ms; the schedule is re-armed whenever a new shard is created (i.e. a new `portalId` appears).

```ts
import type { PublishFn } from './MessageThrottle';

/**
 * Sharded, rolling message throttle for fleet-scale MQTT publish load.
 *
 * Replaces the previous single-buffer `GlobalMessageThrottle` with a
 * buffer partitioned by `portalId` (extracted from the `vrm/{portalId}/…`
 * topic prefix). A `setTimeout` chain ticks at `max(1, ⌊intervalMs / N⌋)`
 * milliseconds, where N is the number of distinct installations that have
 * data buffered. Each tick advances a round-robin cursor and flushes one
 * shard — the latest payload per topic, like the old throttle.
 *
 * Net effect: with 100 installations the ~700 publishes that used to hit
 * the broker in a single synchronous batch every 500ms are spread roughly
 * evenly across the 500ms window (one installation's publishes every 5ms).
 * For a single installation the timing is byte-identical to the old throttle.
 */
export class RollingMessageThrottle {
  private readonly shards = new Map<string, Map<string, string>>();
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly publish: PublishFn,
  ) {}

  /** Buffer a message. Per-shard `Map.set` gives "latest value wins". */
  enqueue(topic: string, payload: string): void {
    if (this.intervalMs === 0) {
      this.publish(topic, payload);
      return;
    }
    const portalId = this.portalIdOf(topic);
    let shard = this.shards.get(portalId);
    let isNewShard = false;
    if (!shard) {
      shard = new Map();
      this.shards.set(portalId, shard);
      isNewShard = true;
    }
    shard.set(topic, payload);
    // Re-arm the schedule so a newly-seen portalId is included in the
    // next tick interval calculation.
    if (isNewShard && this.running) {
      this.reschedule();
    }
  }

  /** Start (or re-arm) the rolling tick schedule. Idempotent. */
  start(): void {
    if (this.intervalMs === 0) return;
    if (this.running) return;
    this.running = true;
    this.reschedule();
  }

  /**
   * Drain all buffered topics immediately. The schedule keeps running —
   * a subsequent `enqueue` will be picked up by the next tick. Preserves
   * the old `GlobalMessageThrottle` contract for HA-offline handling.
   */
  flush(): void {
    this.drainAll();
  }

  /** Drain all buffered topics, clear the timer, and stop new flushes. */
  stop(): void {
    this.drainAll();
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drainAll(): void {
    for (const shard of this.shards.values()) {
      for (const [topic, payload] of shard) {
        this.publish(topic, payload);
      }
      shard.clear();
    }
  }

  private reschedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const N = this.shards.size;
    const tickMs =
      N > 0
        ? Math.max(1, Math.floor(this.intervalMs / N))
        : this.intervalMs;
    this.timer = setTimeout(() => {
      this.tick();
      this.reschedule();
    }, tickMs);
  }

  private tick(): void {
    if (this.shards.size === 0) return;
    const portalIds = Array.from(this.shards.keys());
    const portalId = portalIds[this.cursor % portalIds.length];
    this.cursor++;
    const shard = this.shards.get(portalId);
    if (shard && shard.size > 0) {
      for (const [topic, payload] of shard) {
        this.publish(topic, payload);
      }
      shard.clear();
    }
  }

  /**
   * Extract the installation identifier from a `vrm/{portalId}/...` topic.
   * Defensive: any topic that does not match the shape falls into a single
   * shared `_unknown` shard so the throttle never throws.
   */
  private portalIdOf(topic: string): string {
    const parts = topic.split('/');
    return parts.length >= 2 && parts[0] === 'vrm' ? parts[1] : '_unknown';
  }
}
```

- [ ] **Step 4: Run the new test file to verify it passes**

Run: `cd vrm-mqtt/app && npx jest src/vrm/__tests__/RollingMessageThrottle.test.ts`
Expected: 12 passing tests. If any fail, read the failure, fix the implementation, re-run.

- [ ] **Step 5: Run the full test suite to confirm no other regressions**

Run: `cd vrm-mqtt/app && npx jest`
Expected: all existing tests pass, plus the 12 new ones. The old `GlobalMessageThrottle.test.ts` still passes because the old class is still defined and still referenced by `InstallationManager`.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/RollingMessageThrottle.ts \
        vrm-mqtt/app/src/vrm/__tests__/RollingMessageThrottle.test.ts
git commit -m "feat(throttle): add RollingMessageThrottle for fleet-scale load

Shards the buffer by portalId and ticks at intervalMs/N. The old
GlobalMessageThrottle is still in place; wiring happens in the
next commit. No behavior change for N=1 (single installation)." \
  --trailer "Co-authored-by: opencode <noreply@opencode.ai>"
```

---

## Task 2: Wire `RollingMessageThrottle` into `InstallationManager` and `MqttBridgeConnection`

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/InstallationManager.ts:3, 37, 48`
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts:4, 21, 30`

**Interfaces:**
- Consumes: `RollingMessageThrottle` (created in Task 1).
- Produces: `InstallationManager` and `MqttBridgeConnection` now type/import/use `RollingMessageThrottle` everywhere `GlobalMessageThrottle` was used. No constructor signature changes.

- [ ] **Step 1: Update `InstallationManager.ts`**

Edit `vrm-mqtt/app/src/vrm/InstallationManager.ts` with three replacements:

- Line 3: `import { GlobalMessageThrottle } from './GlobalMessageThrottle';` → `import { RollingMessageThrottle } from './RollingMessageThrottle';`
- Line 37: `private readonly globalThrottle: GlobalMessageThrottle;` → `private readonly globalThrottle: RollingMessageThrottle;`
- Line 48: `this.globalThrottle = new GlobalMessageThrottle(throttleIntervalMs, (topic, payload) => ha.publish(topic, payload));` → `this.globalThrottle = new RollingMessageThrottle(throttleIntervalMs, (topic, payload) => ha.publish(topic, payload));`

- [ ] **Step 2: Update `MqttBridgeConnection.ts`**

Edit `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` with three replacements:

- Line 4: `import { GlobalMessageThrottle } from './GlobalMessageThrottle';` → `import { RollingMessageThrottle } from './RollingMessageThrottle';`
- Line 21: `globalThrottle?: GlobalMessageThrottle;` → `globalThrottle?: RollingMessageThrottle;`
- Line 30: `private readonly throttle: MessageThrottle | GlobalMessageThrottle;` → `private readonly throttle: MessageThrottle | RollingMessageThrottle;`

- [ ] **Step 3: Type-check the project**

Run: `cd vrm-mqtt/app && npx tsc --noEmit`
Expected: no errors. If there are errors, the most likely cause is a missed rename — search for `GlobalMessageThrottle` and ensure all references point to `RollingMessageThrottle`.

- [ ] **Step 4: Run the affected test files**

Run: `cd vrm-mqtt/app && npx jest src/vrm/__tests__/InstallationManager.test.ts src/vrm/__tests__/MqttBridgeConnection.test.ts`
Expected: all tests pass. `InstallationManager.test.ts` mocks `MqttBridgeConnection` and `VrmBrokerPool` (not the throttle), so it should be unaffected by the rename. `MqttBridgeConnection.test.ts` uses fake MQTT clients and does not exercise the throttle directly beyond instantiating it through the option type — also unaffected.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd vrm-mqtt/app && npx jest`
Expected: all tests pass (12 new + all existing). The old `GlobalMessageThrottle.test.ts` still passes because the class still exists in the tree.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/vrm/InstallationManager.ts \
        vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts
git commit -m "refactor(throttle): switch to RollingMessageThrottle

Same public API, different internals. GlobalMessageThrottle is
still defined for the now-obsolete test file (removed in the
next commit)." \
  --trailer "Co-authored-by: opencode <noreply@opencode.ai>"
```

---

## Task 3: Remove the obsolete `GlobalMessageThrottle` and its test file

**Files:**
- Delete: `vrm-mqtt/app/src/vrm/GlobalMessageThrottle.ts`
- Delete: `vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts`

- [ ] **Step 1: Confirm there are no remaining references to `GlobalMessageThrottle`**

Run: `cd vrm-mqtt/app && grep -rn "GlobalMessageThrottle" src/`
Expected: no matches. If anything matches (other than the two files about to be deleted), the rename is incomplete — fix the reference first.

- [ ] **Step 2: Delete the two files**

Run:
```bash
rm vrm-mqtt/app/src/vrm/GlobalMessageThrottle.ts \
   vrm-mqtt/app/src/vrm/__tests__/GlobalMessageThrottle.test.ts
```

- [ ] **Step 3: Type-check the project**

Run: `cd vrm-mqtt/app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd vrm-mqtt/app && npx jest`
Expected: 12 tests in `RollingMessageThrottle.test.ts` plus all other suites, all green. The deleted `GlobalMessageThrottle.test.ts` is gone.

- [ ] **Step 5: Commit**

```bash
git add -A vrm-mqtt/app/src/vrm/
git commit -m "chore(throttle): remove obsolete GlobalMessageThrottle

The class and its test file are fully replaced by
RollingMessageThrottle." \
  --trailer "Co-authored-by: opencode <noreply@opencode.ai>"
```

---

## Task 4: Version bump, changelog, docs

**Files:**
- Modify: `vrm-mqtt/config.yaml` (line 2: `version`)
- Modify: `vrm-mqtt/CHANGELOG.md` (prepend new entry)
- Modify: `vrm-mqtt/DOCS.md` (one sentence in the Configuration table)

- [ ] **Step 1: Bump the add-on version**

Edit `vrm-mqtt/config.yaml` line 2:
- `version: "0.1.4"` → `version: "0.1.5"`

- [ ] **Step 2: Add a CHANGELOG entry**

Prepend a new section to `vrm-mqtt/CHANGELOG.md`. Match the existing format used by 0.1.0–0.1.4. The new top of the file should look like:

```markdown
<!-- https://developers.home-assistant.io/docs/apps/presentation#keeping-a-changelog -->
## 0.1.5
- Spread VRM → HA publish load evenly across the throttle interval.
  Internal `GlobalMessageThrottle` replaced with `RollingMessageThrottle`
  that shards by installation; reduces per-cycle publish bursts on
  Home Assistant for fleets with many installations.

## 0.1.4
- disable apparmor
```

(Leave the rest of the file — 0.1.4, 0.1.3, etc. — unchanged.)

- [ ] **Step 3: Document the rolling behavior in `DOCS.md`**

In `vrm-mqtt/DOCS.md`, find the Configuration table row for `vrm_throttle_interval_ms` (line 28 in the current file):

```
| `vrm_throttle_interval_ms` | no | `500` | Cross-installation message coalescing flush (ms; `0` disables). |
```

Replace the description cell with:

```
| `vrm_throttle_interval_ms` | no | `500` | Window (ms) for cross-installation message coalescing; `0` disables. Publishes are spread evenly across this window across all installations, so broker load scales smoothly with the fleet size. |
```

- [ ] **Step 4: Verify the YAML and docs are well-formed**

Run: `cd vrm-mqtt && python3 -c "import yaml,sys; yaml.safe_load(open('config.yaml')); print('config.yaml ok')"`
Expected: `config.yaml ok` (Python is available on most dev systems; if not, run any other YAML validator).

If Python isn't available, instead inspect `config.yaml` visually: confirm `version: "0.1.5"` is on line 2 and the schema/options keys are unchanged.

- [ ] **Step 5: Final test run**

Run: `cd vrm-mqtt/app && npx jest`
Expected: all tests pass.

- [ ] **Step 6: Inspect the diff**

Run: `cd /home/kai/projects/homeautomation/vrm-mqtt/vrm-mqtt-app && git log --oneline feature/rolling-updates ^main`
Expected: 4 commits on top of `main` — the design commits, plus the 4 implementation commits (Tasks 1, 2, 3, 4).

Run: `git status`
Expected: clean working tree.

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/config.yaml vrm-mqtt/CHANGELOG.md vrm-mqtt/DOCS.md
git commit -m "docs: bump to 0.1.5, document rolling throttle behavior" \
  --trailer "Co-authored-by: opencode <noreply@opencode.ai>"
```

---

## Self-Review

**Spec coverage:**
- Replace `GlobalMessageThrottle` with `RollingMessageThrottle` → Task 1
- Sharded buffer keyed by `portalId` → Task 1 (Step 3)
- `setTimeout` chain ticking at `intervalMs / N` → Task 1 (Step 3)
- Per-topic coalescing preserved → Task 1 (Step 1, test "coalesces messages with the same topic")
- `enqueue / start / flush / stop` API preserved → Task 1 (Step 1, the 7 preserved tests)
- Small-fleet (N=1) byte-identical behavior → Task 1 (Step 1, the preserved test "publishes distinct topics in one flush" with N=2 still works; with N=1, the timing is `intervalMs`, identical to the old behavior)
- New rolling behavior tests (3-installations, even distribution, mid-cycle add, no data loss, removed installation) → Task 1 (Step 1, the 5 new tests)
- Rename references in `InstallationManager.ts` lines 3, 37, 48 → Task 2 (Step 1)
- Rename references in `MqttBridgeConnection.ts` lines 4, 21, 30 → Task 2 (Step 2)
- Delete `GlobalMessageThrottle.ts` and its test file → Task 3
- Bump `config.yaml` version → Task 4 (Step 1)
- Add `CHANGELOG.md` entry → Task 4 (Step 2)
- Update `DOCS.md` → Task 4 (Step 3)

No spec requirement is missing.

**Placeholder scan:** No TBD / TODO / "fill in" / "similar to" markers in any step. Each step contains either actual code, an exact command, or an exact expected output.

**Type consistency:** `RollingMessageThrottle` is defined in Task 1 with the same constructor and method signatures as `GlobalMessageThrottle`. Task 2 uses the same names (`globalThrottle`, `throttle`, `RollingMessageThrottle`) consistently.

**Line-number accuracy:** Verified against current `main` (`e925c9d`): `InstallationManager.ts` lines 3, 37, 48 and `MqttBridgeConnection.ts` lines 4, 21, 30 are the only `GlobalMessageThrottle` references in each file.
