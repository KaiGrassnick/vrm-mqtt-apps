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