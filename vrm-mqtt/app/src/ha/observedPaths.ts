import { SERVICE_ENTITY_DEFS, CUSTOM_ENTITY_DEFS } from './entityDefs';
import { makeStateTopic } from './DiscoveryConfigBuilder';

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
 *   2. Every `aggregateFrom` entry from CUSTOM_ENTITY_DEFS.aggregate (template-expanded).
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
  const customAggregates = CUSTOM_ENTITY_DEFS.aggregate;

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