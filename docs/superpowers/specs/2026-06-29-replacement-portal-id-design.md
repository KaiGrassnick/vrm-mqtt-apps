# Replaced-Installation Topic Mapping — Design

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `feature/replacement-portal-id`

## Context

VRM creates a "replacement" installation record when an installation is migrated (for example, the underlying Venus device changes). The replacement record's `identifier` is suffixed with the marker `USEDASREPLACEMENT AT <unix-timestamp>`:

- `c0619ab417b5`                             — original record
- `c0619ab417b5 - USEDASREPLACEMENT AT 1719937767` — replacement record

Those suffixes contain spaces and other characters that are illegal in MQTT topics. Today, the bridge filters out any installation whose identifier contains the substring `USEDASREPLACEMENT` (`src/vrm/InstallationManager.ts:15,58`), which is safe from a topic-validity standpoint but drops active installations the user wants to see in Home Assistant.

The user wants to keep these records bridged. The complication: the original and the replacement are **distinct physical devices on distinct VRM brokers** (different `mqttHost`) whose `brokerPortalId` on the broker side happens to coincide (`c0619ab417b5`). On our local HA broker we therefore cannot use `c0619ab417b5` as the topic segment for the replacement: it would collide with the original installation's HA topic, duplicate HA entity identifiers, and break discovery.

The user also wants write-back (`HA → VRM`) to keep working in the future, which requires the bridge to know the mapping from an HA topic back to the correct VRM connection and broker portalId.

## Goal

Bridge every installation record — original or replacement — as its own HA device with a guaranteed-unique HA-side key, while preserving the existing VRM-side subscribe/keepalive/write behavior and enabling future write-back for every bridged record.

## Non-goals

- Persisting bridge state across restarts (no on-disk schema file, no DB). Upgrade detection uses only the HA broker's retained messages.
- Changing any other HA discovery payload content (entity properties, icons, unit_of_measurement, etc.) — only the identifiers in topics and unique_ids change.
- Coordinating write-back for installations that share a `brokerPortalId`. By construction they cannot: the replacement is on a different `mqttHost`, so each runs its own `VrmBrokerPool` client and `MqttBridgeConnection`.
- Handling a hypothetical future VRM marker shape. The token `USEDASREPLACEMENT` is matched literally today; a new shape is one regex change plus a test.
- Reading or writing D-Bus flashmq messages on the empty-payload protocol (already handled in `routeFromVrm` and out of scope here).

## Design

### Two identifier spaces

| Key | Type | Role | Source |
|---|---|---|---|
| `idSite` | `number` | HA-side key — topics, discovery, unique_ids, entity identifiers, availability | VRM API record `idSite` |
| `brokerPortalId` | `string` | VRM-side key — `N/`, `W/`, `R/` topic segments | Derived from `identifier` |

`identifier` (the VRM API field) stays as a stored property because we need it to compute the legacy-topic list during migration, but it is no longer the HA-side key.

### Deriving `brokerPortalId`

```ts
export function toBrokerPortalId(identifier: string): string {
  const stripped = identifier.replace(/\s*-?\s*USEDASREPLACEMENT\s+AT\s+\d+\s*$/, '');
  return stripped.trim();
}
```

For a normal installation `c0619ab417b5`, the regex does not match and `toBrokerPortalId(c0619ab417b5) === c0619ab417b5`. For `c0619ab417b5 - USEDASREPLACEMENT AT 1719937767`, the regex consumes the canonical ` - ` separator that VRM emits between `portalId` and the marker, and the function returns `c0619ab417b5`.

This function lives in `src/vrm/portalId.ts` as a free function so it can be unit-tested independently and used wherever needed. `VrmApiClient.getInstallations` calls it once per record when constructing the `VrmInstallation` value.

An empty result (impossible per VRM schema but defensively handled) is logged and the record is dropped before reaching the manager, so that we never build subscribe topics like `N//...`.

### Data model — `src/vrm/types.ts`

```ts
export interface VrmInstallation {
  idSite: number;          // HA-side key — unique per VRM account
  name: string;
  identifier: string;      // API value (may contain ' USEDASREPLACEMENT AT …'); kept for legacy-topic derivation
  brokerPortalId: string;  // derived via toBrokerPortalId; what the VRM broker uses as N/{…} topic
  mqttHost: string;
  mqttWebHost: string;
}
```

### VRM-side topic transforms — `src/vrm/MqttBridgeConnection.ts`

Substitute `brokerPortalId` for `identifier` everywhere the connection currently splices the API value into a VRM-side topic:

- `this.keepaliveTopic = `R/${installation.brokerPortalId}/keepalive`` (currently `:49`)
- `buildSubscribeTopics()` `N/${installation.brokerPortalId}/system/0/…` (currently `:104-115`)
- `handleMessage` prefix guard `topic.startsWith(`N/${this.installation.brokerPortalId}/`)` (currently `:165`)

`publishToVrm` no longer needs to know about the HA topic shape: it will receive an already-rewritten VRM-shaped topic from `InstallationManager.routeHaCommand`. Its signature remains `(vrmTopic, payload)` and it remains the single publish call from the bridge side to VRM.

### HA-side topic transforms — `src/ha/*`

Replace the `portalId: string` parameter with `idSite: number` throughout the HA-build pipeline. Concrete changes:

**`src/ha/MessageRouter.ts`**

- `routeFromVrm` becomes a 3-arg function:
  ```ts
  routeFromVrm(
    topic: string,
    payload: string,
    getIdSite: (brokerPortalId: string) => number | undefined,
  ): MqttMessage[]
  ```
  It parses the VRM topic, calls `getIdSite(parsed.portalId)` to look up the `idSite`, and emits `[{ topic: `vrm/${idSite}/${service}/${instance}/${path}`, payload }]`. Returns `[]` when the lookup returns `undefined` (the message is from an installation we no longer track — drop it). The empty-payload drop and the parse failure drop are unchanged.
- `routeFromHa` keeps its current shape (it only parses the HA topic) but `parts[1]` is now a numeric `idSite`. The emitted topic uses `idSite` so that `routeHaCommand` can rewrite it back to the broker `portalId`.

**`src/ha/DiscoveryPublisher.ts`**

- Internal `published` map is keyed on `idSite: number`:
  ```ts
  private readonly published = new Map<number, {
    discoveryTopic: string;          // 'homeassistant/device/vrm_{idSite}/config'
    payload: string;
    name: string;
    legacyTopics: readonly string[]; // ['homeassistant/device/vrm_{identifier}/config', 'vrm/{identifier}/availability']
    legacyPurged: boolean;
  }>();
  ```
- `publishInstallation(idSite: number, identifier: string, name: string)` — `identifier` is needed only to build `legacyTopics` and is captured at first publish. Subsequent publishes with the same `idSite` no-op when `name` is unchanged (existing idempotence contract).
- `publishAvailability(idSite, online)` → `vrm/${idSite}/availability`.
- `removeInstallation(idSite)` clears the same `published` entry and the new discovery topic.

**`src/ha/DiscoveryConfigBuilder.ts` and `src/ha/InstallationDevice.ts`**

- `portalId: string` is replaced by `idSite: number` on every helper signature that builds discovery payloads.
- Unique ID: `vrm_${idSite}_${service}_${instance}_${pathSlug(path)}`.
- State topic: `vrm/${idSite}/${service}/${instance}/${path}`.
- Device identifiers list: `[`vrm_${idSite}_system`, `vrm_${idSite}_${service}_${instance}`]`.
- `via_device`: `vrm_${idSite}_system`.
- The JSON content of each `entity` (sensor values, units, icons, value_template, etc.) is unchanged.

### Connection lookup and write-back — `src/vrm/InstallationManager.ts`

`connectionsByPortalId` is renamed to `connectionsByIdSite: Map<number, MqttBridgeConnection>`. Reconcile populates it with `installation.idSite` (numeric).

`routeHaCommand(topic, payload)` becomes:

```ts
routeHaCommand(topic: string, payload: string): void {
  for (const msg of routeFromHa(topic, payload)) {
    // msg.topic shape: W/{idSite}/{service}/{instance}/{path}
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
    // Rewrite the idSite segment to the connection's brokerPortalId for VRM.
    const brokerPortalId = conn.brokerPortalId;
    parts[1] = brokerPortalId;
    const vrmTopic = parts.join('/');
    conn.publishToVrm(vrmTopic, msg.payload);
  }
}
```

`MqttBridgeConnection` exposes a read-only `brokerPortalId` getter (alongside the existing `identifier` getter, which we keep returning the original API value for logging and for the legacy-topic list computation in `DiscoveryPublisher`).

### Lookup function for the router — wiring

`MessageRouter.routeFromVrm` needs a `brokerPortalId → idSite` lookup. The simplest wiring is to have `MqttBridgeConnection` build and own this lookup for its own messages only — every install bridges one record, so each connection knows only its own `idSite`. We add a tiny constructor option:

```ts
// MqttBridgeConnection
private readonly getIdSite: (brokerPortalId: string) => number | undefined;

constructor({ installation, ..., getIdSite }: MqttBridgeConnectionOptions) {
  // ...
  this.getIdSite = getIdSite;
  this.brokerPortalId = installation.brokerPortalId;
}
```

`InstallationManager` constructs connections with `getIdSite = (p) => p === installation.brokerPortalId ? installation.idSite : undefined`. The lookup is intentionally minimal — each connection only ever sees its own `brokerPortalId`, so a one-shot cache or even an inline function is fine. We inline.

### Migration purge of legacy discovery topics

On startup and on every reconciliation, the bridge opportunistically clears any retained legacy discovery / availability messages it can find. The check is a single `HaBrokerClient.collectRetained(...)` call per topic — no persistent state. Concretely, in `src/ha/DiscoveryPublisher.ts`:

```ts
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

`HaBrokerClient.collectRetained` (`HaBrokerClient.ts:99-129`) already returns early when not connected, so the purge is a no-op until HA comes online. We invoke `purgeLegacyDiscovery` once at startup and once at the head of every `pollInstallations` cycle in `src/index.ts`. Idempotent — fresh installs will see no retained payload and do nothing; upgrading installs clear the legacy messages before re-publishing new ones.

### Concern: same `brokerPortalId`, different `mqttHost`

Original record and replacement record both produce `brokerPortalId = c0619ab417b5`, but they live on different `mqttHost` values. Consequence: two distinct `VrmBrokerPool` clients, two distinct `MqttBridgeConnection`s, each independently subscribing to its own broker. No deduplication of messages, no coordination — they just look like two installations with two distinct HA devices and (different) state values in HA. The conflict in the HA-side topic space (where the user observed the bad topic) is fully resolved by switching the HA-side key from the colliding string to `idSite`.

### Error handling

- `toBrokerPortalId('')` → `''`. `VrmApiClient.getInstallations` drops records with an empty result and logs `[VRM] Dropping installation idSite=N: empty brokerPortalId after derivation`.
- HA topic with non-numeric `parts[1]`: existing code's "drop + warn" branch is preserved with an explicit `Number.isInteger` check.
- HA-side command for an unknown `idSite`: existing "[Manager] No connection found" warning preserved.
- Legacy purge when HA broker is offline: `collectRetained` returns `[]`, purge silently no-ops; the next poll re-attempts.
- Subscription failure on a `N/{brokerPortalId}/...` topic: existing error path in `MqttBridgeConnection.handleConnect` (logs the subscribe error and continues) preserved — same idempotence contract, just different topic strings.

### Testing

| Test file | Coverage |
|---|---|
| `src/vrm/__tests__/deriveBrokerPortalId.test.ts` *(new)* | `toBrokerPortalId` derivation table: normal identifier unchanged; suffixed stripped; trailing whitespace collapsed; multiple spaces handled; missing timestamp left alone; empty input → `''` and triggers drop downstream. |
| `src/vrm/__tests__/MqttBridgeConnection.test.ts` *(new or extended)* | `buildSubscribeTopics` uses `brokerPortalId`; `keepaliveTopic` uses `brokerPortalId`; `handleMessage` filters by `brokerPortalId`. |
| `src/vrm/__tests__/InstallationManager.test.ts` *(updated)* | Replace the "skips replaced installation" suite with "bridges replacement alongside original". Cover: both records produce connections; `connectionsByIdSite` keyed on numeric `idSite`; `routeHaCommand` parses numeric idSite and rewrites to W/{brokerPortalId}/...; warning when idSite is non-numeric; warning when idSite is unknown. |
| `src/ha/__tests__/MessageRouter.test.ts` | `routeFromVrm` emits `vrm/{idSite}/...` via the injected `getIdSite`; emits nothing on undefined; preserves the empty-payload drop. `routeFromHa` parses numeric idSite; emits `W/{idSite}/.../set` (the `idSite → brokerPortalId` rewrite is owned by `routeHaCommand`). |
| `src/ha/__tests__/DiscoveryPublisher.test.ts` *(new or extended)* | `publishInstallation` writes idSite-keyed topics and stores `legacyTopics` once; `purgeLegacyDiscovery` clears only non-empty retained payloads and is idempotent on empty ones; ordering preserves "legacy purge before new publish" within a single call. |

### File inventory

Production files modified in place:

- `src/vrm/portalId.ts` *(new)* — `toBrokerPortalId` helper.
- `src/vrm/types.ts` — extend `VrmInstallation` with `brokerPortalId`.
- `src/vrm/VrmApiClient.ts` — derive `brokerPortalId` per record in `getInstallations`.
- `src/vrm/MqttBridgeConnection.ts` — use `brokerPortalId` on VRM-side; expose `brokerPortalId` getter; accept `getIdSite` option; remove the no-longer-needed `identifier`-on-VRM-side references.
- `src/vrm/InstallationManager.ts` — `connectionsByIdSite: Map<number, MqttBridgeConnection>`; rewritten `routeHaCommand` with idSite parsing + `idSite → brokerPortalId` rewrite before `publishToVrm`.
- `src/ha/MessageRouter.ts` — `routeFromVrm` accepts `getIdSite`.
- `src/ha/DiscoveryPublisher.ts` — idSite-keyed state; `publishInstallation(idSite, identifier, name)`; new `purgeLegacyDiscovery(installations)`.
- `src/ha/DiscoveryConfigBuilder.ts` and `src/ha/InstallationDevice.ts` — replace `portalId: string` with `idSite: number` throughout.
- `src/index.ts` — call `await publisher.purgeLegacyDiscovery(installations)` before `await manager.reconcile(installations)` in `pollInstallations`.

Test files: see the testing table above.

No documentation files beyond this spec require changes; if a README bumps in lockstep with the version, that is out of scope of this spec.
