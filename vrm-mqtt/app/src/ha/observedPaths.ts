import { SERVICE_ENTITY_DEFS, CUSTOM_ENTITY_DEFS } from './entityDefs';
import { makeStateTopic } from './DiscoveryConfigBuilder';
import type { VrmServiceName } from '../vrm/types';

const POSSIBLE_PHASE_INDICES = ['1', '2', '3'] as const;

function expandTemplate(template: string): string[] {
  if (!template.includes('{n}')) return [template];
  return POSSIBLE_PHASE_INDICES.map((n) => template.replace('{n}', n));
}

/** system and platform are guaranteed present on every installation, with a fixed instance. */
const STATIC_SERVICES: ReadonlySet<VrmServiceName> = new Set(['system', 'platform']);

export interface ServiceObservedPaths {
  service: VrmServiceName;
  instanceSegment: '0' | '+';
  paths: string[];
}

/**
 * Shared walk over SERVICE_ENTITY_DEFS producing, per service, the sorted
 * deduplicated set of VRM-side paths the bridge cares about:
 *   - every `forward: true` normal entity path, and
 *   - for `system` only, every `aggregateFrom` source path from
 *     CUSTOM_ENTITY_DEFS.aggregate, regardless of the aggregate's own
 *     `forward` flag (aggregate sources must be observed even when the
 *     aggregate itself is not published).
 *
 * `expand` controls how each `{n}` template is turned into concrete path(s):
 * getObservedPaths enumerates real phase indices (1/2/3); getSubscribePaths
 * collapses `{n}` to a single MQTT `+` wildcard segment.
 */
function collectPaths(expand: (template: string) => string[]): ServiceObservedPaths[] {
  const result: ServiceObservedPaths[] = [];

  for (const service of Object.keys(SERVICE_ENTITY_DEFS) as VrmServiceName[]) {
    const defs = SERVICE_ENTITY_DEFS[service] ?? [];
    const paths = new Set<string>();
    for (const def of defs) {
      if (!def.forward) continue;
      for (const p of expand(def.path)) paths.add(p);
    }
    if (service === 'system') {
      for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
        for (const t of agg.aggregateFrom) {
          for (const p of expand(t)) paths.add(p);
        }
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

/**
 * Return, for every service present in SERVICE_ENTITY_DEFS, the sorted
 * deduplicated set of concrete VRM-side paths the bridge needs to observe,
 * with every `{n}` template expanded to real phase indices (1/2/3).
 *
 * `instanceSegment` is '0' for system/platform (guaranteed present, fixed
 * instance) and '+' for every other service (instance is learned
 * dynamically from live traffic — see MqttBridgeConnection.observedInstances).
 *
 * This concrete-path output is consumed by InstallationDevice /
 * DiscoveryConfigBuilder to decide which phase indices actually exist, so it
 * must NOT be wildcarded — use getSubscribePaths for building subscriptions.
 */
export function getObservedPaths(): ServiceObservedPaths[] {
  return collectPaths(expandTemplate);
}

/**
 * Same shape as getObservedPaths, but each `{n}` template is collapsed to a
 * single subscription using the MQTT single-level wildcard `+` (e.g.
 * `Ac/Grid/+/Power` instead of three L1/L2/L3 topics). This is only for
 * building broker subscriptions — it cuts subscription count roughly 3x.
 *
 * A `+` wildcard can admit topics beyond the literal 1/2/3 phase indices
 * (e.g. a hypothetical `Ac/Grid/L4/Power`). That is benign: every downstream
 * consumer (the forwardPaths gate in MqttBridgeConnection, AggregateProcessor)
 * keys strictly on the concrete 1/2/3 paths and silently ignores anything
 * else, exactly as it does today.
 */
export function getSubscribePaths(): ServiceObservedPaths[] {
  // Replace the whole path segment carrying `{n}` (e.g. `L{n}` or a bare `{n}`)
  // with `+`. MQTT single-level wildcards must occupy an entire level, so a
  // partial replacement like `Ac/Grid/L+/Power` would match nothing on the broker.
  return collectPaths((t) => [
    t.split('/').map((seg) => (seg.includes('{n}') ? '+' : seg)).join('/'),
  ]);
}

/**
 * Return the set of full HA-side topics the bridge currently publishes under
 * `vrm/{idSite}/#`, given the caller's current `observedInstances` snapshot.
 * Derived from SERVICE_ENTITY_DEFS + CUSTOM_ENTITY_DEFS — same source of
 * truth as discovery generation in InstallationDevice.
 *
 * This "forward: true paths per service" computation is duplicated in
 * `computeForwardPaths` (MqttBridgeConnection.ts) and `getObservedPaths`
 * above — keep all three mutually consistent; a divergence here is a real bug class.
 */
export function getCurrentlyForwardedTopics(
  idSite: number,
  observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
): Set<string> {
  const topics = new Set<string>();
  topics.add(`vrm/${idSite}/availability`);

  for (const [service, instances] of observedInstances) {
    const forwardPaths = new Set<string>();
    for (const def of SERVICE_ENTITY_DEFS[service] ?? []) {
      if (!def.forward) continue;
      for (const p of expandTemplate(def.path)) forwardPaths.add(p);
    }
    for (const instance of instances) {
      for (const path of forwardPaths) {
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