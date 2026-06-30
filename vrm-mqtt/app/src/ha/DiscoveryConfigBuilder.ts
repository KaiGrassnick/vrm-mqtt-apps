import type { DeviceMeta, HaDevice, HaDiscoveryConfig } from './types';
import type { CustomAggregateEntityDef, EntityDef } from './entityDefs';
import { SERVICE_ENTITY_DEFS } from './entityDefs';
import type { VrmServiceName } from '../vrm/types';

const MANUFACTURER = 'Victron Energy';

/**
 * Builds HA MQTT discovery configs for all entities of one VRM service instance.
 *
 * For entity definitions with `{n}` path templates, only indices that appear in
 * `observedPaths` produce configs — no entities are emitted for indices that have
 * never been seen on the MQTT bus.
 */
export function buildDiscoveryConfigs(
  idSite: number,
  service: VrmServiceName,
  instance: string | number,
  meta: DeviceMeta,
  observedPaths: string[],
  customAggregates: readonly CustomAggregateEntityDef[] = [],
): HaDiscoveryConfig[] {
  const defs = SERVICE_ENTITY_DEFS[service];
  if (!defs) return [];

  const device = buildDevice(idSite, service, instance, meta);
  const configs: HaDiscoveryConfig[] = [];
  const pathSet = new Set(observedPaths);

  // Normal entities — only those with forward: true are surfaced to HA.
  for (const def of defs) {
    if (!def.forward) continue;
    if (def.path.includes('{n}')) {
      for (const n of matchTemplateIndices(def.path, observedPaths)) {
        configs.push(entityToConfig(idSite, service, instance, device, def, n));
      }
    } else if (pathSet.has(def.path)) {
      configs.push(entityToConfig(idSite, service, instance, device, def));
    }
  }

  // Custom aggregates — same gating as the old aggregate branch.
  // Emitted under a fixed `custom/aggregate` scope so they sort below
  // system/0 entries in the device panel and stay distinct from observed
  // VRM services.
  // Only forward: true aggregates with at least one observed source emit configs.
  for (const agg of customAggregates) {
    if (!agg.forward) continue;
    if (expandAggregateSourcePaths(agg.aggregateFrom, observedPaths).length > 0) {
      configs.push(entityToConfig(idSite, 'custom', 'aggregate', device, agg));
    }
  }

  return configs;
}

/**
 * Resolve an `aggregateFrom` template list against observed paths. Templates
 * containing `{n}` are expanded with the same indices that `matchTemplateIndices`
 * would pick; literal templates are kept only if present in `observedPaths`.
 *
 * Result is sorted for deterministic discovery ordering.
 */
export function expandAggregateSourcePaths(templates: string[], observedPaths: string[]): string[] {
  const expanded = new Set<string>();
  for (const template of templates) {
    if (template.includes('{n}')) {
      for (const n of matchTemplateIndices(template, observedPaths)) {
        expanded.add(template.replace('{n}', n));
      }
    } else if (observedPaths.includes(template)) {
      expanded.add(template);
    }
  }
  return [...expanded].sort();
}

/**
 * Given a path template containing `{n}` and a list of observed paths, returns
 * the sorted list of index values (as strings) that were actually seen.
 *
 * Examples:
 *   matchTemplateIndices('Dc/{n}/Voltage', ['Dc/0/Voltage', 'Dc/1/Voltage'])
 *     → ['0', '1']
 *   matchTemplateIndices('Ac/L{n}/Power', ['Ac/L1/Power', 'Ac/L3/Power'])
 *     → ['1', '3']
 */
export function matchTemplateIndices(template: string, paths: string[]): string[] {
  const parts = template.split('{n}').map(escapeRegex);
  const regex = new RegExp(`^${parts.join('(\\d+)')}$`);
  const seen = new Set<string>();
  for (const path of paths) {
    const m = regex.exec(path);
    if (m) seen.add(m[1]);
  }
  return [...seen].sort((a, b) => Number(a) - Number(b));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDevice(
  idSite: number,
  service: VrmServiceName,
  instance: string | number,
  meta: DeviceMeta,
): HaDevice {
  const isSystem = service === 'system';
  return {
    identifiers: [
      isSystem
        ? `vrm_${idSite}_system`
        : `vrm_${idSite}_${service}_${instance}`,
    ],
    name: meta.customName ?? meta.productName,
    manufacturer: MANUFACTURER,
    model: meta.productName,
    sw_version: meta.firmwareVersion,
    serial_number: meta.serial,
    ...(isSystem ? {} : { via_device: `vrm_${idSite}_system` }),
  };
}

function resolveN(template: string, n: string): string {
  return template.replace('{n}', n);
}

function pathSlug(path: string): string {
  return path.toLowerCase().replace(/\//g, '_').replace(/[^a-z0-9_]/g, '_');
}

function makeUniqueId(idSite: number, service: string, instance: string | number, path: string): string {
  return `vrm_${idSite}_${service}_${instance}_${pathSlug(path)}`;
}

export function makeStateTopic(idSite: number, service: string, instance: string | number, path: string): string {
  return `vrm/${idSite}/${service}/${instance}/${path}`;
}

/**
 * Builds a Jinja2 value_template that maps numeric VRM values to string labels.
 * Used for both `sensor` (device_class: enum) and `select` entities.
 *
 * Output example:
 *   {% if value_json is defined %}
 *     {% set map = {0: 'Off', 3: 'Bulk', 4: 'Absorption'} %}
 *     {{ map[value_json.value | int] | default('Unknown') }}
 *   {% else %}Unknown{% endif %}
 *
 * The outer `is defined` guard prevents template errors when VRM publishes a
 * zero-byte (or otherwise non-JSON) payload — e.g. when a device disappears.
 */
function enumValueTemplate(values: Array<{ value: number; label: string }>): string {
  const pairs = values
    .map(v => `${v.value}: '${v.label.replace(/'/g, "\\'")}'`)
    .join(', ');
  return (
    "{% if value_json is defined %}" +
    `{% set map = {${pairs}} %}{{ map[value_json.value | int] | default('Unknown') }}` +
    "{% else %}Unknown{% endif %}"
  );
}

function entityToConfig(
  idSite: number,
  service: string,
  instance: string | number,
  device: HaDevice,
  def: EntityDef | CustomAggregateEntityDef,
  n?: string,
): HaDiscoveryConfig {
  // Custom aggregate — structurally a sensor whose value is published by the bridge.
  if (!('component' in def)) {
    const path = n !== undefined ? resolveN(def.path, n) : def.path;
    const name = n !== undefined ? resolveN(def.name, n) : def.name;
    const uniqueId = makeUniqueId(idSite, service, instance, path);
    const sTopic = makeStateTopic(idSite, service, instance, path);
    return {
      name,
      unique_id: uniqueId,
      default_entity_id: `sensor.${uniqueId}`,
      device,
      component: 'sensor',
      state_topic: sTopic,
      value_template:
        "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
      unit_of_measurement: def.unit,
      device_class: def.deviceClass,
      state_class: def.stateClass,
      ...(def.precision !== undefined && { suggested_display_precision: def.precision }),
    };
  }

  const path = n !== undefined ? resolveN(def.path, n) : def.path;
  const name = n !== undefined ? resolveN(def.name, n) : def.name;
  const uniqueId = makeUniqueId(idSite, service, instance, path);
  const sTopic = makeStateTopic(idSite, service, instance, path);
  const cTopic = `${sTopic}/set`;
  const base = { name, unique_id: uniqueId, default_entity_id: `${def.component}.${uniqueId}`, device };

  switch (def.component) {
    case 'sensor':
      return {
        ...base,
        component: 'sensor',
        state_topic: sTopic,
        value_template:
          def.deviceClass === 'enum' && def.enumValues?.length
            ? enumValueTemplate(def.enumValues)
            : "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
        unit_of_measurement: def.unit,
        device_class: def.deviceClass,
        state_class: def.stateClass,
        ...(def.precision !== undefined && { suggested_display_precision: def.precision }),
      };

    case 'binary_sensor':
      return {
        ...base,
        component: 'binary_sensor',
        state_topic: sTopic,
        // Normalise any non-zero value (0=no alarm, 1=warning, 2=alarm) to ON/OFF.
        // Guard against missing value_json (e.g. zero-byte device-gone payload).
        value_template:
          '{% if value_json is defined and value_json.value | int > 0 %}ON{% else %}OFF{% endif %}',
        device_class: def.deviceClass,
      };

    case 'switch':
      return {
        ...base,
        component: 'switch',
        state_topic: sTopic,
        command_topic: cTopic,
        value_template:
          '{% if value_json is defined %}{{ value_json.value | int }}{% else %}0{% endif %}',
        payload_on: def.payloadOn,
        payload_off: def.payloadOff,
      };

    case 'select':
      return {
        ...base,
        component: 'select',
        state_topic: sTopic,
        command_topic: cTopic,
        value_template: enumValueTemplate(def.options),
        options: def.options.map(o => o.label),
      };

    case 'number':
      return {
        ...base,
        component: 'number',
        state_topic: sTopic,
        command_topic: cTopic,
        value_template:
          '{% if value_json is defined %}{{ value_json.value }}{% else %}0{% endif %}',
        unit_of_measurement: def.unit,
        device_class: def.deviceClass,
        min: def.min,
        max: def.max,
        step: def.step,
      };
  }
}
