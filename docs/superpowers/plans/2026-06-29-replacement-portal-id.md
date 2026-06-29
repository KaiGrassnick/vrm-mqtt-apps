# Replacement Portal ID Topic Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge every VRM installation record (including those whose `identifier` is suffixed with `USEDASREPLACEMENT AT <ts>`) as its own HA device, with `idSite` as the HA-side topic key and the derived `brokerPortalId` as the VRM-side topic key. Clear any legacy `vrm_{identifier}/config` and `vrm/{identifier}/availability` retained messages on startup so upgrading users don't accumulate dead devices.

**Architecture:** Two identifier spaces split cleanly. `idSite` (VRM numeric site ID, guaranteed unique) keys every HA-side topic — discovery, state, availability, entity `unique_id`. `brokerPortalId` (derived from `identifier` by stripping the `USEDASREPLACEMENT` suffix) keys every VRM-side topic — `N/`, `W/`, `R/`. `MessageRouter.routeFromVrm` accepts an injected `brokerPortalId → idSite` lookup; `InstallationManager.routeHaCommand` rewrites an HA `W/{idSite}/…` topic to `W/{brokerPortalId}/…` before publishing to VRM. `DiscoveryPublisher.purgeLegacyDiscovery(installations)` clears any legacy retained messages on startup, idempotently.

**Tech Stack:** TypeScript, Node.js, Jest. No new dependencies. Existing `mqtt` and `dotenv` continue to handle the broker. Helper `toBrokerPortalId(identifier)` is pure, regex-based.

## Global Constraints

- **TDD with frequent commits** — write the failing test, see it fail, write minimal implementation, see it pass, commit. One commit per step or task as fits the change.
- **Identifier spaces do not leak** — `idSite: number` is HA-only; `brokerPortalId: string` is VRM-only; `identifier: string` is API-only (kept only to compute legacy topic paths during migration). Production code that publishes to the HA broker never uses `identifier` or `brokerPortalId` directly — it uses `idSite`. Production code that publishes to the VRM broker never uses `idSite` or `identifier` directly — it uses `brokerPortalId`.
- **`USEDASREPLACEMENT AT <digits>` is matched literally** — uppercase, single trailing marker, trailing digits. A future marker shape is a one-line regex change plus a test.
- **Replacement installs are never on the same `mqttHost` as their original** — per design discussion. Each replacement runs on its own `VrmBrokerPool` client and `MqttBridgeConnection`. No deduplication of messages required across connections.
- **Empty `brokerPortalId` is dropped at the API boundary** — `VrmApiClient.getInstallations` skips records whose derived `brokerPortalId` is `''`. We never build subscribe topics like `N//...`.
- **Empty payload drop is preserved** — `routeFromVrm` continues to drop zero-byte payloads (dbus-flashmq device-gone semantics).
- **Numeric idSite validation** — `routeHaCommand` rejects non-integer `parts[1]` with a warning, drops the command.
- **Match existing repository style** — see the existing tests for jest patterns (`makeMockHa`, `makeMockClient`), TS strict mode (`tsconfig.json`), and `PublishingFn` / `CommandHandler` style.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `vrm-mqtt/app/src/vrm/portalId.ts` | **new** | `toBrokerPortalId(identifier)` — pure regex-based derivation. |
| `vrm-mqtt/app/src/vrm/__tests__/portalId.test.ts` | **new** | Derivation table + edge cases. |
| `vrm-mqtt/app/src/vrm/types.ts` | **modify** | Add `brokerPortalId: string` to `VrmInstallation`. |
| `vrm-mqtt/app/src/vrm/VrmApiClient.ts` | **modify** | Derive `brokerPortalId` per record in `getInstallations`; drop empties. |
| `vrm-mqtt/app/src/vrm/__tests__/VrmApiClient.test.ts` | **modify** | New test for derivation + drop behaviour. |
| `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` | **modify** | Use `brokerPortalId` for VRM-side topics; expose `brokerPortalId` getter; accept `getIdSite` lookup option. |
| `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` | **modify** | Update fixture to include `brokerPortalId`; update tests that reference `installation.identifier`. |
| `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts` | **modify** | `published` keyed on `idSite: number`; `publishInstallation(idSite, identifier, name)`; add `purgeLegacyDiscovery`. |
| `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts` | **modify** | New tests for `purgeLegacyDiscovery`. Update existing tests for `idSite` shape. |
| `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts` | **modify** | `portalId: string` → `idSite: number` on `buildDiscoveryConfigs`. |
| `vrm-mqtt/app/src/ha/InstallationDevice.ts` | **modify** | `portalId: string` → `idSite: number` on `buildInstallationDiscovery`. |
| `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts` | **modify** | Update fixture `PORTAL` to numeric `ID_SITE`. |
| `vrm-mqtt/app/src/ha/MessageRouter.ts` | **modify** | `routeFromVrm` accepts `getIdSite`; emits `vrm/{idSite}/…`. `routeFromHa` still emits `W/{parts[1]}/…` (rewrite is in `routeHaCommand`). |
| `vrm-mqtt/app/src/ha/__tests__/MessageRouter.test.ts` | **modify** | Update `routeFromVrm` tests for injected lookup; update `routeFromHa` tests to expect `W/{idSite}/…` shape. |
| `vrm-mqtt/app/src/vrm/InstallationManager.ts` | **modify** | `connectionsByPortalId` → `connectionsByIdSite`; `routeHaCommand` parses numeric idSite, rewrites to `W/{brokerPortalId}/…`; construct connections with `getIdSite` lookup. |
| `vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts` | **modify** | Update fixture to include `brokerPortalId`; replace "replaced skips" suite with "replaced bridges alongside original"; add `routeHaCommand` rewrite tests. |
| `vrm-mqtt/app/src/index.ts` | **modify** | `pollInstallations` calls `await publisher.purgeLegacyDiscovery(installations)` before `await manager.reconcile(installations)`. |

All other files are untouched.

---

## Task 1: Add `toBrokerPortalId` helper (TDD)

**Files:**
- Create: `vrm-mqtt/app/src/vrm/portalId.ts`
- Test: `vrm-mqtt/app/src/vrm/__tests__/portalId.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces:
  ```ts
  export function toBrokerPortalId(identifier: string): string;
  ```
- Every later task that derives a broker portalId (VrmApiClient) imports from here.

- [ ] **Step 1: Write the failing test file**

Create `vrm-mqtt/app/src/vrm/__tests__/portalId.test.ts` with the contents below:

```ts
import { toBrokerPortalId } from '../portalId';

describe('toBrokerPortalId', () => {
  it('returns the identifier unchanged when no replacement marker is present', () => {
    expect(toBrokerPortalId('samplePortalId')).toBe('samplePortalId');
  });

  it('strips a " - USEDASREPLACEMENT AT <digits>" suffix', () => {
    expect(toBrokerPortalId('samplePortalId - USEDASREPLACEMENT AT 1234567890'))
      .toBe('samplePortalId');
  });

  it('strips the suffix even when surrounded by variable whitespace', () => {
    expect(toBrokerPortalId('samplePortalId   USEDASREPLACEMENT   AT   1234567890'))
      .toBe('samplePortalId');
  });

  it('accepts any digit run as the timestamp (defensive)', () => {
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT AT 1')).toBe('samplePortalId');
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT AT 99999999999'))
      .toBe('samplePortalId');
  });

  it('does not match "USEDASREPLACEMENT" without the trailing "AT <digits>"', () => {
    // Tokens without a digit run must be left alone — defends against partial matches.
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT')).toBe('samplePortalId USEDASREPLACEMENT');
  });

  it('matches the marker case-sensitively', () => {
    expect(toBrokerPortalId('samplePortalId usedasreplacement at 1234567890'))
      .toBe('samplePortalId usedasreplacement at 1234567890');
  });

  it('returns "" for an empty input', () => {
    expect(toBrokerPortalId('')).toBe('');
  });

  it('trims trailing whitespace after stripping the marker', () => {
    // 'samplePortalId  USEDASREPLACEMENT AT 17  ' → strips the marker, trims whitespace.
    expect(toBrokerPortalId('samplePortalId  USEDASREPLACEMENT AT 17  ')).toBe('samplePortalId');
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/portalId.test.ts
```
Expected: FAIL — `Cannot find module '../portalId'`.

- [ ] **Step 3: Implement `toBrokerPortalId`**

Create `vrm-mqtt/app/src/vrm/portalId.ts`:

```ts
/**
 * Derive the value the VRM broker actually uses as the N/{portalId}/... topic
 * segment from the API's `identifier` field.
 *
 * VRM appends the marker `USEDASREPLACEMENT AT <unix-timestamp>` to the
 * identifier of an installation that was created as a replacement for another
 * one. The broker keeps the original portalId for both — only the API record
 * carries the marker. We strip it here so that N/{...} subscriptions and
 * W/{...} publishes can address the broker's actual topic key.
 *
 * Returns '' when the result is empty after stripping — callers should drop
 * the record rather than build an N//... subscribe path.
 */
export function toBrokerPortalId(identifier: string): string {
  const stripped = identifier.replace(/ USEDASREPLACEMENT AT \d+\s*$/, '');
  return stripped.trim();
}
```

- [ ] **Step 4: Run tests; verify they pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/portalId.test.ts
```
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add vrm-mqtt/app/src/vrm/portalId.ts vrm-mqtt/app/src/vrm/__tests__/portalId.test.ts
git commit -m "feat(portalId): toBrokerPortalId derivation"
```

---

## Task 2: Extend `VrmInstallation` with `brokerPortalId` and derive it in `VrmApiClient`

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/types.ts:150-156` (`VrmInstallation`)
- Modify: `vrm-mqtt/app/src/vrm/VrmApiClient.ts:32-43` (`getInstallations`)
- Modify: `vrm-mqtt/app/src/vrm/__tests__/VrmApiClient.test.ts` (add derivation test, update fixtures)

**Interfaces:**
- Consumes: `toBrokerPortalId` from Task 1.
- Produces: `VrmInstallation.brokerPortalId: string` populated on every record returned by `getInstallations`. Records whose derivation yields `''` are dropped with a `[VRM] Dropping installation idSite=N: empty brokerPortalId` log.

- [ ] **Step 1: Read the current `VrmApiClient.test.ts` to identify fixture shape**

Note the field shape in `makeInstallationResponse` (or equivalent) — you'll need to extend it with `identifier` cases that exercise the derivation.

- [ ] **Step 2: Update `VrmInstallation` type**

In `vrm-mqtt/app/src/vrm/types.ts`, replace the interface (lines 150-156):

```ts
export interface VrmInstallation {
  idSite: number;
  name: string;
  identifier: string;
  brokerPortalId: string;
  mqttHost: string;
  mqttWebHost: string;
}
```

- [ ] **Step 3: Add the failing API-client test**

In `vrm-mqtt/app/src/vrm/__tests__/VrmApiClient.test.ts`, add a `describe('getInstallations derivation')` block after the existing tests. The new block must cover:

1. A normal identifier is returned as-is in `brokerPortalId`.
2. An identifier with `USEDASREPLACEMENT AT <ts>` yields `brokerPortalId` with the suffix stripped.
3. A record whose `brokerPortalId` derivation would be empty (use `'  USEDASREPLACEMENT AT 1'` — `trim()` after the regex still leaves something; instead use a record that would need an empty identifier — since VRM never returns empty, we instead cover the "not empty but the regex strips everything" case by inserting the marker alone; see implementation below).

Skeletal test (the body must match whatever your fixture helpers look like — copy from `VrmApiClient.test.ts`'s actual structure):

```ts
describe('getInstallations derivation', () => {
  it('returns brokerPortalId equal to identifier when no marker is present', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({
      records: [{
        idSite: 1, name: 'Site', identifier: 'samplePortalId',
        mqtt_host: 'mqtt5.example', mqtt_webhost: 'webmqtt5.example',
      }],
      success: true,
    }));

    const installations = await client.getInstallations(42);

    expect(installations).toHaveLength(1);
    expect(installations[0].brokerPortalId).toBe('samplePortalId');
    expect(installations[0].identifier).toBe('samplePortalId');
  });

  it('strips the USEDASREPLACEMENT suffix from brokerPortalId', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({
      records: [{
        idSite: 2, name: 'Replaced',
        identifier: 'samplePortalId - USEDASREPLACEMENT AT 1234567890',
        mqtt_host: 'mqtt7.example', mqtt_webhost: 'webmqtt7.example',
      }],
      success: true,
    }));

    const installations = await client.getInstallations(42);

    expect(installations).toHaveLength(1);
    expect(installations[0].identifier).toBe('samplePortalId - USEDASREPLACEMENT AT 1234567890');
    expect(installations[0].brokerPortalId).toBe('samplePortalId');
  });
});
```

(Adapt the `makeResponse` / `fetchMock` invocation to match the file's existing style — they're already in use in earlier tests.)

- [ ] **Step 4: Run the new tests; verify they fail**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/VrmApiClient.test.ts -t "derivation"
```
Expected: FAIL — `expected installations[0].brokerPortalId` to equal `'samplePortalId'` but got `undefined`.

- [ ] **Step 5: Implement derivation in `VrmApiClient.getInstallations`**

In `vrm-mqtt/app/src/vrm/VrmApiClient.ts`, modify `getInstallations` (currently lines 32-43):

```ts
import { toBrokerPortalId } from './portalId';
import { VrmApiError, VrmApiAuthError } from '../errors';
import type {
  VrmMeResponse,
  VrmUser,
  VrmInstallationsResponse,
  VrmInstallation,
} from './types';

export interface VrmApiClientConfig {
  apiToken: string;
  baseUrl: string;
}

export class VrmApiClient {
  // ... constructor unchanged ...

  async getInstallations(userId: number): Promise<VrmInstallation[]> {
    const data = await this.get<VrmInstallationsResponse>(
      `/users/${userId}/installations?extended=1`,
    );
    const installations: VrmInstallation[] = [];
    for (const r of data.records) {
      const brokerPortalId = toBrokerPortalId(r.identifier);
      if (brokerPortalId === '') {
        console.warn(`[VRM] Dropping installation idSite=${r.idSite}: empty brokerPortalId after derivation`);
        continue;
      }
      installations.push({
        idSite: r.idSite,
        name: r.name,
        identifier: r.identifier,
        brokerPortalId,
        mqttHost: r.mqtt_host,
        mqttWebHost: r.mqtt_webhost,
      });
    }
    return installations;
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 6: Run all `VrmApiClient` tests; verify they pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/VrmApiClient.test.ts
```
Expected: existing tests + 2 new derivation tests PASS. (No existing test asserts an object-literal shape on the returned installation that excludes `brokerPortalId`, but double-check the suite if anything breaks — most tests assert individual fields, not exact-shape equality.)

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/app/src/vrm/types.ts vrm-mqtt/app/src/vrm/VrmApiClient.ts vrm-mqtt/app/src/vrm/__tests__/VrmApiClient.test.ts
git commit -m "feat(vrm): derive brokerPortalId per installation record"
```

---

## Task 3: `MqttBridgeConnection` uses `brokerPortalId` for VRM-side topics

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts` — `:49` (keepalive topic), `:104-115` (subscribe topics), `:165` (message filter), `:160-161` (existing `identifier` getter stays for logging).
- Modify: `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts` — fixture includes `brokerPortalId`; tests assert VRM-side topics use `brokerPortalId`, not `identifier`.

**Interfaces:**
- Consumes: `installation.brokerPortalId` (Task 2).
- Produces: `MqttBridgeConnection` getter `brokerPortalId: string` reading `installation.brokerPortalId`. All VRM-side publish/subscribe topics use `brokerPortalId` instead of `identifier`. The existing `identifier` getter stays unchanged (it still returns `installation.identifier` — used for log messages and the legacy-topic list construction).

- [ ] **Step 1: Update the test fixture**

In `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`, at the top, change the `installation` constant (lines 9-15) to:

```ts
const installation: VrmInstallation = {
  idSite: 1,
  name: 'Test Site',
  identifier: 'test-portal-abcd1234',
  brokerPortalId: 'test-portal-abcd1234',
  mqttHost: 'mqtt5.victronenergy.com',
  mqttWebHost: 'webmqtt5.victronenergy.com',
};
```

(The fixture uses a non-replaced identifier, so `brokerPortalId === identifier`. A second fixture for a replaced case will be added in Task 8.)

- [ ] **Step 2: Confirm existing tests still pass with the new fixture**

Most tests use `installation.identifier` in topic assertions — those still need to change because the bridge now uses `brokerPortalId`. Don't run yet; first update the tests.

- [ ] **Step 3: Update tests that assert VRM-side topic strings**

In `vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts`, change every literal `installation.identifier` reference inside an `expect(...)` of a topic string to use a separate local constant `brokerPortalId`. Cleanest: hoist the constant out of the `describe` blocks:

At top of file (after the `installation` constant):

```ts
const { identifier: _PORTAL, brokerPortalId: PORTAL } = installation;
```

(We destructure so the existing tests that still use `installation.identifier` for non-topic assertions continue to compile. But every VRM-side topic assertion must use `PORTAL`.)

In `describe('start() with disconnected client', ...)`:

- Line 124-126: change the subscribe-topic assertions so the URL is `N/${PORTAL}/...`:
  ```ts
  expect(client.subscribe).toHaveBeenCalledWith(
    expect.arrayContaining([
      `N/${PORTAL}/system/0/Dc/Pv/Power`,
      `N/${PORTAL}/system/0/Dc/Battery/Soc`,
      `N/${PORTAL}/system/0/Ac/Grid/+/Power`,
    ]),
    { qos: 0 },
    expect.any(Function),
  );
  ```
- Line 131: change keepalive topic to `R/${PORTAL}/keepalive`.

In `describe('start() with already-connected client', ...)` line 157: change keepalive topic to `R/${PORTAL}/keepalive`.

In `describe('message filtering', ...)`:
- Line 235 `'N/otheridentifier/system/0/Ac'` — leave as-is (that's the "other identifier" string).
- Line 248 `N/${installation.identifier}/system/0/Dc/Battery/Soc` → `N/${PORTAL}/system/0/Dc/Battery/Soc`.

In `describe('stop()', ...)` line 279: `N/${installation.identifier}/system/0/Dc/Pv/Power` → `N/${PORTAL}/system/0/Dc/Pv/Power`.

In `describe('throttle behaviour', ...)`:
- Line 367 hoist `const portalId = installation.brokerPortalId;` (rename from `identifier`).
- Update every topic string from `installation.identifier` to `PORTAL` (or keep `portalId` constant if simpler — the variable rename from `portalId` to `brokerPortalId` is fine).

- [ ] **Step 4: Add two new tests proving the bridge handles a replaced installation**

Append (in the same `MqttBridgeConnection.test.ts`):

```ts
describe('replaced installation (USEDASREPLACEMENT in identifier)', () => {
  const replacedInstallation: VrmInstallation = {
    idSite: 2,
    name: 'Replaced Site',
    identifier: 'samplePortalId - USEDASREPLACEMENT AT 1234567890',
    brokerPortalId: 'samplePortalId',  // the broker keeps the base — derivation result
    mqttHost: 'mqtt7.victronenergy.com',
    mqttWebHost: 'webmqtt7.victronenergy.com',
  };

  it('subscribes using brokerPortalId, not identifier', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({
      installation: replacedInstallation,
      pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
      ha: makeMockHa() as never,
      publisher: makeMockPublisher() as never,
    });
    conn.start();
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith(
      expect.arrayContaining([`N/${replacedInstallation.brokerPortalId}/system/0/Dc/Pv/Power`]),
      { qos: 0 },
      expect.any(Function),
    );
    expect(client.subscribe).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.stringContaining('USEDASREPLACEMENT')]),
      { qos: 0 },
      expect.any(Function),
    );
  });

  it('sends keepalive to R/{brokerPortalId}/keepalive', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({
      installation: replacedInstallation,
      pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
      ha: makeMockHa() as never,
      publisher: makeMockPublisher() as never,
    });
    conn.start();
    client.emit('connect');

    expect(client.publish).toHaveBeenCalledWith(
      `R/${replacedInstallation.brokerPortalId}/keepalive`,
      '',
      { qos: 0 },
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 5: Run tests; expect the new tests to fail and confirm so**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/MqttBridgeConnection.test.ts
```
Expected: FAIL — the connect test expects `R/${PORTAL}/keepalive` but the bridge still uses `R/${installation.identifier}/keepalive`. Existing tests still in suite.

- [ ] **Step 6: Replace identifier with brokerPortalId in `MqttBridgeConnection`**

In `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`:

- Line 49 (`keepaliveTopic`): change `installation.identifier` → `installation.brokerPortalId`.
- Lines 104-115 (`buildSubscribeTopics`): change `const id = this.installation.identifier;` → `const id = this.installation.brokerPortalId;`.
- Line 165 (message filter): change `N/${this.installation.identifier}/` → `N/${this.installation.brokerPortalId}/`.

Leave the `identifier` getter (lines 160-161) untouched — it is still useful for log messages and the legacy-topic list in `DiscoveryPublisher`.

Add a new getter immediately after the `identifier` getter:

```ts
get brokerPortalId(): string {
  return this.installation.brokerPortalId;
}
```

- [ ] **Step 7: Run tests; verify all pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/MqttBridgeConnection.test.ts
```
Expected: full suite PASS, including both new "replaced installation" tests.

- [ ] **Step 8: Commit**

```bash
git add vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts vrm-mqtt/app/src/vrm/__tests__/MqttBridgeConnection.test.ts
git commit -m "refactor(bridge): use brokerPortalId for VRM-side topics"
```

---

## Task 4: `MessageRouter.routeFromVrm` accepts an injected `getIdSite` lookup; `routeFromHa` emits `W/{idSite}/…`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/MessageRouter.ts:43-49` (`routeFromVrm`); `:64-85` (`routeFromHa` — only test signatures change; impl unchanged).
- Modify: `vrm-mqtt/app/src/ha/__tests__/MessageRouter.test.ts`.

**Interfaces:**
- Consumes: the broker-portal-id from a parsed VRM topic; a `getIdSite(brokerPortalId: string) => number | undefined` callback supplied by the caller (ultimately the per-connection lookup defined in Task 6).
- Produces:
  ```ts
  export function routeFromVrm(
    topic: string,
    payload: string,
    getIdSite: (brokerPortalId: string) => number | undefined,
  ): MqttMessage[];
  // Returns [] when the lookup returns undefined.
  ```
- `routeFromHa` keeps its current shape and behaviour. The emitted `msg.topic` contains `W/{parts[1]}/...`, where `parts[1]` is now a numeric `idSite`. The translation to `W/{brokerPortalId}/...` happens in `InstallationManager.routeHaCommand` (Task 6) so the router stays pure.

- [ ] **Step 1: Update `routeFromVrm` tests to pass a `getIdSite` and assert the new shape**

In `vrm-mqtt/app/src/ha/__tests__/MessageRouter.test.ts`:

- Add at the top of the `routeFromVrm` `describe`:

  ```ts
  const idSiteFor = (brokerPortalId: string) =>
    brokerPortalId === 'abc123' ? 42 : undefined;
  ```

- Update every existing `routeFromVrm(topic, payload)` call to `routeFromVrm(topic, payload, idSiteFor)`.
- Update the existing assertion to use the numeric idSite:
  ```ts
  expect(routeFromVrm('N/abc123/battery/279/Soc', '{"value":87.4}', idSiteFor))
    .toEqual([{ topic: 'vrm/42/battery/279/Soc', payload: '{"value":87.4}' }]);
  ```
  and the parallel multi-segment assertion to `vrm/42/battery/279/Dc/0/Voltage`.

- Add new tests at the bottom of the `routeFromVrm` describe:

  ```ts
  it('returns [] when the broker portalId is unknown to the caller', () => {
    const lookup: (brokerPortalId: string) => number | undefined = () => undefined;
    expect(routeFromVrm('N/abc123/battery/279/Soc', '{"value":1}', lookup)).toEqual([]);
  });

  it('preserves the empty-payload drop', () => {
    // Already covered in the existing suite — keep that test unchanged.
  });
  ```

- Update `routeFromHa` tests: every literal `'abc123'` in a topic string must be replaced with a numeric idSite `'42'`; the asserted `msg.topic` likewise becomes `W/42/...`. Idiomatic fix: hoist a `const idSiteNum = '42'; const portalNum = '42';` and use them in both topic strings and assertions. Pick the smallest set of replacements that keeps each `it()` block compiling.

- [ ] **Step 2: Run tests; expect failures**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/MessageRouter.test.ts
```
Expected: FAIL — every `routeFromVrm` assertion still expects `vrm/abc123/...` because the implementation hasn't been changed yet; the `routeFromHa` topic-shape assertions still expect `W/abc123/...` but the implementation's `parts[1]` is now numeric, so existing assertions should still pass for the topic extraction part — only the new `W/...` literal changes.

- [ ] **Step 3: Modify `routeFromVrm` in `MessageRouter.ts`**

In `vrm-mqtt/app/src/ha/MessageRouter.ts`, replace `routeFromVrm` (lines 43-49):

```ts
/**
 * Route an incoming VRM MQTT message to the local HA broker.
 *
 * N/{brokerPortalId}/{service}/{instance}/{path} → vrm/{idSite}/{service}/{instance}/{path}
 *
 * The caller supplies `getIdSite` to translate the broker-side portalId to the
 * HA-side numeric idSite. A `undefined` return means the broker portalId is
 * not one this bridge currently tracks (e.g. an installation was removed) —
 * drop the message silently rather than publishing to an unknown topic.
 *
 * Payload is forwarded verbatim — HA entities extract the value via
 * value_template: "{{ value_json.value }}".
 *
 * Empty payloads are dropped: dbus-flashmq publishes zero-byte messages when a
 * device disappears from D-Bus. Forwarding them to HA leaves `value_json`
 * undefined and breaks every value_template that references `value_json.value`.
 * HA marks the device unavailable via the bridge's availability_topic instead.
 *
 * Returns [] for topics that do not match the VRM N/… format, for empty
 * payloads, or when the broker portalId is unknown to the caller.
 */
export function routeFromVrm(
  topic: string,
  payload: string,
  getIdSite: (brokerPortalId: string) => number | undefined,
): MqttMessage[] {
  const parsed = parseVrmTopic(topic);
  if (!parsed) return [];
  if (payload === '') return [];
  const idSite = getIdSite(parsed.portalId);
  if (idSite === undefined) return [];
  const { service, instance, path } = parsed;
  return [{ topic: `vrm/${idSite}/${service}/${instance}/${path}`, payload }];
}
```

- [ ] **Step 4: Leave `routeFromHa` body unchanged; ensure it still extracts `parts[1]`**

No code changes to `routeFromHa` other than what the test renames suggest — the body already extracts `parts[1]` and embeds it into the emitted `W/{...}` topic. The shape of that topic now corresponds to `W/{idSite}/...` and is corrected in `routeHaCommand` (Task 6).

- [ ] **Step 5: Run tests; verify all pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/MessageRouter.test.ts
```
Expected: full suite PASS, including the new `routeFromVrm` "unknown lookup" test.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/ha/MessageRouter.ts vrm-mqtt/app/src/ha/__tests__/MessageRouter.test.ts
git commit -m "feat(router): routeFromVrm accepts getIdSite lookup"
```

---

## Task 5: Discovery side uses `idSite` — `DiscoveryConfigBuilder`, `InstallationDevice`, `DiscoveryPublisher`

**Files:**
- Modify: `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts` — `portalId: string` → `idSite: number` on `buildDiscoveryConfigs` and `buildDevice`.
- Modify: `vrm-mqtt/app/src/ha/InstallationDevice.ts` — `portalId: string` → `idSite: number` on `buildInstallationDiscovery`.
- Modify: `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts` — `published` keyed on `idSite: number`; `publishInstallation(idSite: number, identifier: string, name: string)`; add `purgeLegacyDiscovery(installations)`.
- Modify: `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts`, `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`.

**Interfaces:**
- Consumes: numeric `idSite` from the caller (ultimately `installation.idSite` per Task 2).
- Produces: `publishInstallation(idSite, identifier, name)` now stores under `idSite` and embeds legacy topics for one-time purge. `purgeLegacyDiscovery(installations: readonly VrmInstallation[]): Promise<void>` empties retained legacy discovery + availability messages per installation.

- [ ] **Step 1: Update `DiscoveryConfigBuilder` to take `idSite: number`**

In `vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts`:

- `buildDiscoveryConfigs(portalId: string, ...)` → `buildDiscoveryConfigs(idSite: number, ...)`.
- Internal `buildDevice(portalId: string, ...)` → `buildDevice(idSite: number, ...)`. Update its `identifiers` and `via_device` keys: `vrm_${idSite}_system`, etc.
- `makeUniqueId(portalId, ...)` → `makeUniqueId(idSite, ...)`. Its body becomes `vrm_${idSite}_${service}_${instance}_${pathSlug(path)}`.
- `makeStateTopic(portalId, ...)` → `makeStateTopic(idSite, ...)`. Body becomes `vrm/${idSite}/${service}/${instance}/${path}`.
- Update the `entityToConfig` helper signature to take `idSite`.

- [ ] **Step 2: Update `InstallationDevice` to take `idSite: number`**

In `vrm-mqtt/app/src/ha/InstallationDevice.ts`:

- `buildInstallationDiscovery(portalId, installationName, appVersion)` → `buildInstallationDiscovery(idSite, installationName, appVersion)`.
- Update the `availability_topic` string to `vrm/${idSite}/availability`.
- Update the device-level `identifiers` to `[`vrm_${idSite}`]`.
- Update the inner `buildDiscoveryConfigs` call to pass `idSite`.

- [ ] **Step 3: Update `DiscoveryConfigBuilder.test.ts` fixture and assertions**

In `vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts`:

- Replace `const PORTAL = 'abc123';` with `const ID_SITE = 12345;` (numeric).
- Every `buildDiscoveryConfigs(PORTAL, ...)` becomes `buildDiscoveryConfigs(ID_SITE, ...)`.
- Assertions on `vrm_${PORTAL}_...` must be updated. Easiest: add a helper at top of file:
  ```ts
  const v = (suffix: string) => `vrm_${ID_SITE}_${suffix}`;
  ```
  and replace each `vrm_${PORTAL}_foo` literal with `v('foo')`. Strings like `vrm/abc123/system/0/...` similarly become `vrm/${ID_SITE}/system/0/...`.

- [ ] **Step 4: Run `DiscoveryConfigBuilder` tests; expect failures, verify, then proceed**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/DiscoveryConfigBuilder.test.ts
```
Expected: FAIL — TS errors will surface first because `buildDiscoveryConfigs(ID_SITE, ...)` won't type-check until the implementation is updated. (You completed the implementation in steps 1-2, so they should pass once both source and test are updated together; if you run before step 1-2 you'll see "expected PORTAL but got ID_SITE" runtime failures.)

- [ ] **Step 5: Update `DiscoveryPublisher`**

In `vrm-mqtt/app/src/ha/DiscoveryPublisher.ts`, apply three changes:

(a) Replace the `PublishedInstallation` shape and the `published` map:

```ts
interface PublishedInstallation {
  discoveryTopic: string;
  payload: string;
  name: string;
  legacyTopics: readonly string[];
  legacyPurged: boolean;
}

// ...
private readonly published = new Map<number, PublishedInstallation>();
```

(b) Replace `publishInstallation(portalId, name)` with `publishInstallation(idSite, identifier, name)`:

```ts
publishInstallation(idSite: number, identifier: string, installationName: string): void {
  const existing = this.published.get(idSite);
  if (existing && existing.name === installationName) return;

  const legacyTopics = [
    `homeassistant/device/vrm_${identifier}/config`,
    `vrm/${identifier}/availability`,
  ];
  const discoveryTopic = `homeassistant/device/vrm_${idSite}/config`;
  const payload = JSON.stringify(buildInstallationDiscovery(idSite, installationName, this.appVersion));
  this.ha.publish(discoveryTopic, payload, true);
  this.published.set(idSite, {
    discoveryTopic,
    payload,
    name: installationName,
    legacyTopics,
    legacyPurged: false,
  });
}
```

(c) Update `publishAvailability(idSite: number, online: boolean)`:

```ts
publishAvailability(idSite: number, online: boolean): void {
  this.ha.publish(`vrm/${idSite}/availability`, online ? 'online' : 'offline', true);
}
```

(d) Update `removeInstallation(idSite: number)`:

```ts
async removeInstallation(idSite: number): Promise<void> {
  const entry = this.published.get(idSite);
  if (entry) {
    this.ha.publish(entry.discoveryTopic, '', true);
    this.published.delete(idSite);
  } else {
    // After a restart this.published is empty — directly clear the known deterministic topic.
    const topic = `homeassistant/device/vrm_${idSite}/config`;
    const retained = await this.ha.collectRetained(topic);
    for (const { topic: t, payload } of retained) {
      if (payload !== '') this.ha.publish(t, '', true);
    }
  }
  this.publishAvailability(idSite, false);
}
```

(e) Update `onHaBirth` to iterate the numeric-keyed map (key form changes from `portalId` to `idSite` — internal rename only, behaviour unchanged).

(f) Add `purgeLegacyDiscovery`:

```ts
/**
 * One-time purge of legacy (identifier-keyed) HA discovery and availability
 * messages from a previous release. Called on startup / every poll before the
 * first reconcile so that an upgrading user doesn't accumulate dead devices.
 *
 * Idempotent: a fresh install (no retained legacy messages) is a no-op.
 */
async purgeLegacyDiscovery(installations: readonly VrmInstallation[]): Promise<void> {
  for (const inst of installations) {
    const legacyDiscovery = `homeassistant/device/vrm_${inst.identifier}/config`;
    const legacyAvailability = `vrm/${inst.identifier}/availability`;
    for (const topic of [legacyDiscovery, legacyAvailability]) {
      const retained = await this.ha.collectRetained(topic);
      for (const { topic: t, payload } of retained) {
        if (payload !== '') {
          this.ha.publish(t, '', true);
          console.log(`[Discovery] Purged legacy HA topic ${t} (idSite=${inst.idSite})`);
        }
      }
    }
  }
}
```

(You'll need to import `VrmInstallation` from `../vrm/types`.)

- [ ] **Step 6: Update `DiscoveryPublisher.test.ts`**

In `vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts`:

- Replace `const PORTAL = 'abc123';` with `const ID_SITE = 12345; const IDENTIFIER = 'abc123';`.
- Update every `pub.publishInstallation(PORTAL, NAME)` to `pub.publishInstallation(ID_SITE, IDENTIFIER, NAME)`.
- Update every `pub.publishAvailability(PORTAL, true)` to `pub.publishAvailability(ID_SITE, true)`.
- Update every `pub.removeInstallation(PORTAL)` to `pub.removeInstallation(ID_SITE)`.
- Update every assertion on `vrm_${PORTAL}` to `vrm_${ID_SITE}` and every assertion on `vrm/${PORTAL}/availability` to `vrm/${ID_SITE}/availability`.
- Update every assertion on `homeassistant/device/vrm_${PORTAL}/config` to `homeassistant/device/vrm_${ID_SITE}/config`.

Add a new `describe('purgeLegacyDiscovery')` block at the bottom:

```ts
describe('purgeLegacyDiscovery', () => {
  const installations: VrmInstallation[] = [
    { idSite: 1, name: 'A', identifier: 'abc', brokerPortalId: 'abc', mqttHost: 'h', mqttWebHost: 'h' },
    { idSite: 2, name: 'B', identifier: 'samplePortalId - USEDASREPLACEMENT AT 1234567890', brokerPortalId: 'samplePortalId', mqttHost: 'h', mqttWebHost: 'h' },
  ];

  it('publishes empty retained for each non-empty legacy payload it finds', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockImplementation(async (pattern: string) => {
      if (pattern === 'homeassistant/device/vrm_abc/config') return [{ topic: pattern, payload: '{"device":{}}' }];
      if (pattern === 'vrm/abc/availability') return [{ topic: pattern, payload: 'online' }];
      return [];
    });
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.purgeLegacyDiscovery(installations);

    expect(ha.publish).toHaveBeenCalledWith('homeassistant/device/vrm_abc/config', '', true);
    expect(ha.publish).toHaveBeenCalledWith('vrm/abc/availability', '', true);
  });

  it('does not publish empty retained when the broker has no legacy messages', async () => {
    const { pub, ha } = publisher(); // collectRetained mock already returns []
    await pub.purgeLegacyDiscovery(installations);
    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('skips legacy messages whose retained payload is already empty', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockResolvedValue([
      { topic: 'homeassistant/device/vrm_abc/config', payload: '' },
    ]);
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.purgeLegacyDiscovery(installations);

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.every(([t]) => t !== 'homeassistant/device/vrm_abc/config')).toBe(true);
  });
});
```

(`VrmInstallation` is imported from `../../vrm/types`. The mock `HaBrokerClient`'s `collectRetained` signature already accepts a string pattern.)

- [ ] **Step 7: Run the discovery tests; verify pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/ha/__tests__/DiscoveryConfigBuilder.test.ts src/ha/__tests__/DiscoveryPublisher.test.ts
```
Expected: full suites PASS, including the new `purgeLegacyDiscovery` tests.

- [ ] **Step 8: Commit**

```bash
git add vrm-mqtt/app/src/ha/DiscoveryConfigBuilder.ts vrm-mqtt/app/src/ha/InstallationDevice.ts vrm-mqtt/app/src/ha/DiscoveryPublisher.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryConfigBuilder.test.ts vrm-mqtt/app/src/ha/__tests__/DiscoveryPublisher.test.ts
git commit -m "refactor(discovery): idSite-keyed discovery + purgeLegacyDiscovery"
```

---

## Task 6: `InstallationManager` keys connections by `idSite`, rewrites the write-back topic, threads the lookup function

**Files:**
- Modify: `vrm-mqtt/app/src/vrm/InstallationManager.ts` — `:30-31` (map field rename), `:55-117` (reconcile), `:123-136` (`routeHaCommand`), `:155-163` (`shutdown`).
- Modify: `vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts`.

**Interfaces:**
- Consumes: `installation.idSite: number` (Task 2); `connection.brokerPortalId: string` (Task 3).
- Produces:
  - `connectionsByIdSite: Map<number, MqttBridgeConnection>` keyed on numeric `idSite`.
  - `routeHaCommand(topic, payload)` parses numeric idSite, looks up the connection, rewrites the topic's `W/{idSite}/...` to `W/{brokerPortalId}/...`, and calls `conn.publishToVrm(...)`.
  - Per-connection `getIdSite` lookup passed to `MqttBridgeConnection` so its `routeFromVrm` call can map broker portalId → numeric idSite.

- [ ] **Step 1: Replace the `connectionsByPortalId` field and its usage**

In `vrm-mqtt/app/src/vrm/InstallationManager.ts`:

- Line 31: rename `private readonly connectionsByPortalId` → `private readonly connectionsByIdSite`, type `Map<number, MqttBridgeConnection>`.
- Line 76 (in `reconcile`): `this.connectionsByPortalId.delete(conn.identifier)` → `this.connectionsByIdSite.delete(conn.idSite)`. Add a read-only `idSite` getter on `MqttBridgeConnection` returning `installation.idSite` (right next to the existing `identifier` getter).
- Line 111: `this.connectionsByPortalId.set(installation.identifier, conn)` → `this.connectionsByIdSite.set(installation.idSite, conn)`.
- Line 161 (in `shutdown`): same rename for `.clear()`.

The `isSkipped` helper (lines 56-60) and the disabled/replaced handling (lines 82-91) still operate on `installation.identifier`. We will replace the "skip if USEDASREPLACEMENT" rule in Task 8 — for now, it stays as-is.

- [ ] **Step 2: Update `routeHaCommand` to parse idSite and rewrite**

Replace `routeHaCommand` (currently lines 123-136):

```ts
/**
 * Route a command received from the HA broker back to the correct VRM installation.
 *
 * HA topics from MessageRouter use the numeric idSite as the topic's `parts[1]`
 * segment: `W/{idSite}/{service}/{instance}/{path}`. We look up the connection
 * by idSite and rewrite that segment to the connection's brokerPortalId before
 * publishing — keeping the bridge's VRM-side topic vocabulary independent of
 * the HA-side idSite key.
 */
routeHaCommand(topic: string, payload: string): void {
  for (const msg of routeFromHa(topic, payload)) {
    const parts = msg.topic.split('/');
    if (parts[0] !== 'W' || parts.length < 4) continue;
    const idSite = Number(parts[1]);
    if (!Number.isInteger(idSite)) {
      console.warn(`[Manager] Dropping command with non-numeric idSite ${parts[1]}`);
      continue;
    }
    const conn = this.connectionsByIdSite.get(idSite);
    if (!conn) {
      console.warn(`[Manager] No connection found for idSite ${idSite} — dropping command`);
      continue;
    }
    parts[1] = conn.brokerPortalId;
    conn.publishToVrm(parts.join('/'), msg.payload);
  }
}
```

- [ ] **Step 3: Pass the per-connection `getIdSite` lookup when constructing connections**

In `reconcile` (lines 93-116), update the `new MqttBridgeConnection({...})` block (currently lines 98-104):

```ts
const conn = new MqttBridgeConnection({
  installation,
  pool: this.pool,
  ha: this.ha,
  publisher: this.publisher,
  globalThrottle: this.globalThrottle,
  getIdSite: (brokerPortalId) =>
    brokerPortalId === installation.brokerPortalId ? installation.idSite : undefined,
});
```

- [ ] **Step 4: Update the `MqttBridgeConnection` constructor to accept `getIdSite`**

In `vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts`:

(a) Add the field declaration at the top of the class (next to `this.throttle`):

```ts
private readonly getIdSite: (brokerPortalId: string) => number | undefined;
```

(b) Extend the options interface:

```ts
export interface MqttBridgeConnectionOptions {
  installation: VrmInstallation;
  pool: VrmBrokerPool;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
  throttleIntervalMs?: number;
  globalThrottle?: RollingMessageThrottle;
  /** brokerPortalId → idSite lookup; undefined means "drop the message". */
  getIdSite?: (brokerPortalId: string) => number | undefined;
}
```

(c) In the constructor body, store it (defaulting to a no-op lookup):

```ts
this.getIdSite = getIdSite ?? (() => undefined);
```

In `handleMessage`, pass `this.getIdSite` into `routeFromVrm`:

```ts
private handleMessage(topic: string, payload: Buffer): void {
  if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;
  const str = payload.toString();
  for (const msg of routeFromVrm(topic, str, this.getIdSite)) {
    this.throttle.enqueue(msg.topic, msg.payload);
  }
}
```

- [ ] **Step 5: Update `InstallationManager.test.ts`**

In `vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts`:

- Add a `brokerPortalId` field to every `makeInstallation(...)` result. Easiest: derive it from `identifier` using a tiny helper inside the test file:
  ```ts
  function makeInstallation(idSite: number, mqttHost = 'mqtt5.victronenergy.com'): VrmInstallation {
    const identifier = `id${idSite}`;
    return {
      idSite,
      name: `Site ${idSite}`,
      identifier,
      brokerPortalId: identifier,
      mqttHost,
      mqttWebHost: 'webmqtt5.victronenergy.com',
    };
  }
  ```

- Update `MockedConn.mockImplementation` so the stubbed connection exposes `idSite`, `brokerPortalId`, and `publishToVrm` alongside the existing `identifier`:
  ```ts
  MockedConn.mockImplementation((options) => {
    const inst = (options as { installation: VrmInstallation }).installation;
    const conn = {
      start: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      updateName: jest.fn(),
      publishToVrm: jest.fn(),
      identifier: inst.identifier,
      idSite: inst.idSite,
      brokerPortalId: inst.brokerPortalId,
    } as unknown as MqttBridgeConnection;
    createdConns.push(conn as unknown as { start: jest.Mock; stop: jest.Mock; updateName: jest.Mock; identifier: string });
    connCounter++;
    return conn;
  });
  ```

  (`publishToVrm` is needed by the new `routeHaCommand` tests in this task. The `createdConns` element's cast stays the same — only the field set used in tests grows.)

- In the `'disabled installations'` describe block, every `mockPublisher.removeInstallation.mock.calls` and every assertion on `createdConns[0].identifier` still uses the identifier — no change needed there.

- Add the new test block at the bottom of the file (just before the final describe):

  ```ts
  describe('routeHaCommand — idSite-keyed lookup and brokerPortalId rewrite', () => {
    let manager: InstallationManager;

    beforeEach(async () => {
      manager = new InstallationManager(opts);
      // Two installations with different idSites — both will be registered.
      await manager.reconcile([
        makeInstallation(1, 'mqtt5.victronenergy.com'),
        makeInstallation(2, 'mqtt7.victronenergy.com'),
      ]);
    });

    it('parses W/{idSite}/.../set, looks up connection, and rewrites to W/{brokerPortalId}/...', () => {
      const conn1 = createdConns[0] as unknown as { publishToVrm: jest.Mock };
      manager.routeHaCommand('vrm/1/vebus/256/Mode/set', 'On');
      expect(conn1.publishToVrm).toHaveBeenCalledTimes(1);
      expect(conn1.publishToVrm).toHaveBeenCalledWith(
        'W/id1/vebus/256/Mode',  // idSite 1 has identifier 'id1' and brokerPortalId 'id1'
        expect.stringContaining('"value":3'),
      );
    });

    it('routes to the right connection when both sites have the same brokerPortalId', async () => {
      // Make a manager where installation 2 has the same brokerPortalId as
      // installation 1 but a different idSite — exercises the replacement case.
      const m = new InstallationManager(opts);
      await m.reconcile([
        { ...makeInstallation(1, 'mqtt5.victronenergy.com') },
        {
          ...makeInstallation(2, 'mqtt7.victronenergy.com'),
          identifier: 'samplePortalId - USEDASREPLACEMENT AT 1234567890',
          brokerPortalId: 'samplePortalId',
        },
      ]);

      const conn2 = createdConns[1] as unknown as { publishToVrm: jest.Mock };
      // HA sends vrm/{idSite=2}/.../set — must reach conn2 (not conn1).
      m.routeHaCommand('vrm/2/vebus/256/Mode/set', 'On');
      expect(conn2.publishToVrm).toHaveBeenCalledTimes(1);
      expect(conn2.publishToVrm.mock.calls[0][0]).toBe('W/samplePortalId/vebus/256/Mode');
    });

    it('warns and drops when parts[1] is not a numeric idSite', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const conn1 = createdConns[0] as unknown as { publishToVrm: jest.Mock };
      // 'W/abc/...' — "abc" is not a valid idSite.
      manager.routeHaCommand('vrm/abc/vebus/256/Mode/set', 'On');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('non-numeric idSite abc'),
      );
      expect(conn1.publishToVrm).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns and drops when no connection matches the idSite', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      manager.routeHaCommand('vrm/9999/vebus/256/Mode/set', 'On');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No connection found for idSite 9999'),
      );
      warn.mockRestore();
    });
  });
  ```

- [ ] **Step 6: Run the full InstallationManager + MqttBridgeConnection + MessageRouter suites; verify pass**

Run:
```bash
cd vrm-mqtt/app && npx jest src/vrm/__tests__/InstallationManager.test.ts src/vrm/__tests__/MqttBridgeConnection.test.ts src/ha/__tests__/MessageRouter.test.ts
```
Expected: all suites PASS. Existing disabled-installations tests continue to pass because they operate on `identifier` strings.

- [ ] **Step 7: Commit**

```bash
git add vrm-mqtt/app/src/vrm/InstallationManager.ts vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts vrm-mqtt/app/src/vrm/MqttBridgeConnection.ts
git commit -m "feat(manager): connectionsByIdSite + routeHaCommand rewrite to brokerPortalId"
```

---

## Task 7: Wire `purgeLegacyDiscovery` into `pollInstallations` and drop the `USEDASREPLACEMENT` skip

**Files:**
- Modify: `vrm-mqtt/app/src/index.ts:15-35` (`pollInstallations`).
- Modify: `vrm-mqtt/app/src/vrm/InstallationManager.ts` — drop the `USEDASREPLACEMENT` skip and update its tests in `__tests__/InstallationManager.test.ts`.

**Interfaces:**
- Consumes: `publisher.purgeLegacyDiscovery(installations)` (Task 5).
- Produces: `pollInstallations` clears retained legacy messages before reconcile; `isSkipped` no longer rejects `USEDASREPLACEMENT` records.

- [ ] **Step 1: Update `pollInstallations`**

In `vrm-mqtt/app/src/index.ts`, replace the `pollInstallations` body (lines 15-35):

```ts
export async function pollInstallations(
  client: VrmApiClient,
  manager: InstallationManager,
  user: VrmUser,
  publisher: DiscoveryPublisher,
): Promise<void> {
  if (pollInProgress) {
    console.log('[Main] Poll already in progress, skipping tick');
    return;
  }
  pollInProgress = true;
  try {
    const installations: VrmInstallation[] = await client.getInstallations(user.id);
    console.log(`[VRM] Found ${installations.length} installation(s)`);
    for (const inst of installations) {
      console.log(`[VRM]   - ${inst.name} (${inst.identifier} -> brokerPortalId=${inst.brokerPortalId}) @ ${inst.mqttHost}`);
    }
    // Idempotent: clears any retained legacy identifier-keyed messages from
    // previous (pre-idSite) versions of the bridge. Fresh installs no-op.
    await publisher.purgeLegacyDiscovery(installations);
    await manager.reconcile(installations);
  } finally {
    pollInProgress = false;
  }
}
```

- [ ] **Step 2: Update the two call-sites of `pollInstallations`**

The signature changed (now takes a `publisher`). Update the callers in `src/index.ts` `main()` (line 106, line 108-110):

```ts
await pollInstallations(client, manager, user, publisher).catch(handlePollError);

pollTimer = setInterval(() => {
  pollInstallations(client, manager, user, publisher).catch(handlePollError);
}, config.vrm.pollIntervalMs);
```

- [ ] **Step 3: Drop the `USEDASREPLACEMENT` skip from `InstallationManager`**

In `vrm-mqtt/app/src/vrm/InstallationManager.ts`, delete the `REPLACED_MARKER` constant (lines 9-15) and remove the `replaced` branch from `isSkipped`:

```ts
const isSkipped = (i: VrmInstallation): { skipped: boolean; reason: 'disabled' | null } => {
  if (this.disabledInstallationIds.has(i.identifier)) return { skipped: true, reason: 'disabled' };
  return { skipped: false, reason: null };
};
```

Also remove the now-stale comment block at the top of the file (lines 9-15) entirely. And update the message-format in the `for (const inst of installations)` purge loop (line 87-88) to no longer mention `'replaced'`.

- [ ] **Step 4: Replace the "replaced installations" test suite with the new "bridges replacement alongside original" suite**

In `vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts`, replace the entire `describe('replaced installations (USESREPLACEMENT marker in identifier)', ...)` block (lines 213-255) with:

```ts
describe('replaced installations (brokerPortalId derived from identifier)', () => {
  function makeReplacedInstallation(idSite: number, mqttHost: string): VrmInstallation {
    return {
      idSite,
      name: `Site ${idSite}`,
      identifier: `samplePortalId - USEDASREPLACEMENT AT 1700000000`,
      brokerPortalId: 'samplePortalId',  // derived via toBrokerPortalId
      mqttHost,
      mqttWebHost: 'webmqtt5.victronenergy.com',
    };
  }

  function makeOriginalInstallation(idSite: number, mqttHost: string): VrmInstallation {
    return {
      idSite,
      name: `Site ${idSite}`,
      identifier: 'samplePortalId',
      brokerPortalId: 'samplePortalId',
      mqttHost,
      mqttWebHost: 'webmqtt5.victronenergy.com',
    };
  }

  it('bridges a USEDASREPLACEMENT installation (does not skip)', async () => {
    const manager = new InstallationManager(opts);
    await manager.reconcile([makeReplacedInstallation(99, 'mqtt7.victronenergy.com')]);
    expect(MockedConn).toHaveBeenCalledTimes(1);
  });

  it('bridges both the original and the replacement (different idSite, different mqttHost, same brokerPortalId)', async () => {
    const manager = new InstallationManager(opts);
    await manager.reconcile([
      makeOriginalInstallation(1, 'mqtt5.victronenergy.com'),
      makeReplacedInstallation(2, 'mqtt7.victronenergy.com'),
    ]);
    expect(MockedConn).toHaveBeenCalledTimes(2);
  });

  it('publishes the new discovery (idSite-keyed) for a replaced installation', async () => {
    const manager = new InstallationManager(opts);
    await manager.reconcile([makeReplacedInstallation(99, 'mqtt7.victronenergy.com')]);
    // Connections are queued (suspended by default); reconcile just registers them.
    expect((manager as unknown as { connectionsByIdSite: Map<number, unknown> }).connectionsByIdSite.has(99))
      .toBe(true);
  });
});
```

- [ ] **Step 5: Run all suites; verify pass**

Run:
```bash
cd vrm-mqtt/app && npx jest
```
Expected: full suite PASS. The "skips replaced installation" assertion no longer exists; the new "bridges a USEDASREPLACEMENT installation" assertion takes its place.

- [ ] **Step 6: Commit**

```bash
git add vrm-mqtt/app/src/index.ts vrm-mqtt/app/src/vrm/InstallationManager.ts vrm-mqtt/app/src/vrm/__tests__/InstallationManager.test.ts
git commit -m "feat(bridge): wire legacy purge; bridge USEDASREPLACEMENT installations"
```

---

## Task 8: Final verification

**No file changes; pure verification.**

- [ ] **Step 1: Typecheck**

Run:
```bash
cd vrm-mqtt/app && npm run typecheck
```
Expected: clean — no errors. (Especially watch for `MqttBridgeConnectionOptions.getIdSite` being optional and `InstallationManagerOpts` no longer requiring the `REPLACED_MARKER` constant.)

- [ ] **Step 2: Lint**

Run:
```bash
cd vrm-mqtt/app && npm run lint
```
Expected: clean — no warnings. If `eslint` complains about the renamed field references in mock implementations, fix the casts in place.

- [ ] **Step 3: Full test suite (single command)**

Run:
```bash
cd vrm-mqtt/app && npm test
```
Expected: every suite PASS. The total expected new tests:

- `portalId.test.ts`: 8 tests.
- `VrmApiClient.test.ts`: +2 derivation tests.
- `MqttBridgeConnection.test.ts`: +2 replaced-installation tests.
- `MessageRouter.test.ts`: +1 unknown-lookup test (existing tests updated in place).
- `DiscoveryConfigBuilder.test.ts`: existing tests updated to numeric `idSite`.
- `DiscoveryPublisher.test.ts`: +3 `purgeLegacyDiscovery` tests.
- `InstallationManager.test.ts`: existing fixtures updated; replaced-blocks replaced with bridging tests; +4 `routeHaCommand` tests.

- [ ] **Step 4: Build**

Run:
```bash
cd vrm-mqtt/app && npm run build
```
Expected: clean compile to `dist/`.

- [ ] **Step 5: Final commit (only if Step 1-4 surfaced any fix-up)**

```bash
# Only if you changed anything during verification:
git add -u vrm-mqtt/app/
git commit -m "chore: post-implementation lint/type/build fixes"
```

If Steps 1-4 are clean, this commit is unnecessary.

---

## Self-Review Notes

- Coverage map (spec → task):
  - Spec § "Two identifier spaces" → Task 1 (helper) + Task 2 (type/api).
  - Spec § "VRM-side topic transforms" → Task 3.
  - Spec § "HA-side topic transforms" → Task 4 + Task 5.
  - Spec § "Connection lookup and write-back" → Task 6.
  - Spec § "Migration purge" → Task 5 (impl) + Task 7 (wire).
  - Spec § "Concern: same brokerPortalId, different mqttHost" → exercised in Task 6's "same brokerPortalId" test and Task 7's "bridges both" test.
  - Spec § "Error handling" → Task 2 (empty derivation), Task 6 (non-integer idSite), Task 5 (offline-collectRetained no-op).
  - Spec § "Testing" file inventory → all tasks.
- Type consistency:
  - `VrmInstallation.brokerPortalId: string` introduced Task 2; consumed Tasks 3, 5, 6.
  - `MqttBridgeConnection.brokerPortalId` getter introduced Task 3; consumed Task 6.
  - `MqttBridgeConnection.idSite` getter introduced Task 6 (only used in tests for `connectionsByIdSite.delete(conn.idSite)`).
  - `DiscoveryPublisher.publishInstallation(idSite, identifier, name)` introduced Task 5; consumed by every existing call site through Task 6's compile-time shock — update each in the relevant task.
- Placeholders: none. Each step has the exact code, command, or assertion expected.
- Drift: spec calls for a one-time purge; we run it on every poll (cheap, idempotent) — that's a defensive superset, acceptable per the spec's "idempotent" wording.
