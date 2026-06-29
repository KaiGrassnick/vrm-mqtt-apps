import type { MqttMessage } from './types';
import type { SelectEntityDef } from './entityDefs';
import { SERVICE_ENTITY_DEFS } from './entityDefs';
import type { VrmServiceName } from '../vrm/types';

export interface ParsedVrmTopic {
  portalId: string;
  service: string;
  instance: string;
  path: string;
}

/**
 * Parse a VRM MQTT topic of the form N/{portalId}/{service}/{instance}/{path...}.
 * Returns null for topics that do not match this shape.
 */
export function parseVrmTopic(topic: string): ParsedVrmTopic | null {
  const parts = topic.split('/');
  if (parts[0] !== 'N' || parts.length < 5) return null;
  return {
    portalId: parts[1],
    service: parts[2],
    instance: parts[3],
    path: parts.slice(4).join('/'),
  };
}

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

/**
 * Route an HA command to the VRM write topic.
 *
 * vrm/{portalId}/{service}/{instance}/{path}/set → W/{portalId}/{service}/{instance}/{path}
 *
 * - select entities: payload is a human-readable option label (e.g. "On").
 *   Resolved to the VRM numeric value via SERVICE_ENTITY_DEFS.
 *   Returns [] if the label is not recognised — avoids sending garbage to VRM.
 * - all other writables: payload is wrapped as {"value": x}, coercing numeric
 *   strings to numbers so VRM receives the correct type.
 *
 * Returns [] for topics that don't match vrm/…/set, or for empty payloads.
 */
export function routeFromHa(topic: string, payload: string): MqttMessage[] {
  if (!payload) return [];
  if (!topic.startsWith('vrm/')) return [];

  const parts = topic.split('/');
  // minimum: vrm / portalId / service / instance / path / set  →  6 parts
  if (parts.length < 6 || parts[parts.length - 1] !== 'set') return [];

  const portalId = parts[1];
  const service  = parts[2];
  const instance = parts[3];
  const path     = parts.slice(4, -1).join('/');

  const lookup = lookupSelect(service, path, payload);
  if (lookup.kind === 'unknown-label') return [];

  const vrmPayload = lookup.kind === 'found'
    ? `{"value":${lookup.value}}`
    : wrapPayload(payload);

  return [{ topic: `W/${portalId}/${service}/${instance}/${path}`, payload: vrmPayload }];
}

// ── helpers ───────────────────────────────────────────────────────────────────

type SelectLookup =
  | { kind: 'not-select' }
  | { kind: 'found'; value: number }
  | { kind: 'unknown-label' };

function lookupSelect(service: string, path: string, label: string): SelectLookup {
  const defs = SERVICE_ENTITY_DEFS[service as VrmServiceName];
  if (!defs) return { kind: 'not-select' };
  const def = defs.find(d => d.component === 'select' && d.path === path);
  if (!def) return { kind: 'not-select' };
  const option = (def as SelectEntityDef).options.find(o => o.label === label);
  return option !== undefined
    ? { kind: 'found', value: option.value }
    : { kind: 'unknown-label' };
}

/**
 * Wrap an HA command payload in the VRM {"value": x} envelope.
 * Numeric strings are coerced to numbers; everything else is kept as a JSON string.
 */
function wrapPayload(payload: string): string {
  const trimmed = payload.trim();
  const num = Number(trimmed);
  if (trimmed !== '' && !isNaN(num) && isFinite(num)) {
    return `{"value":${num}}`;
  }
  return `{"value":${JSON.stringify(payload)}}`;
}
