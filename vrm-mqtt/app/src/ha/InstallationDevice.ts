import { buildDiscoveryConfigs } from './DiscoveryConfigBuilder';
import { CUSTOM_ENTITY_DEFS } from './entityDefs';
import { getObservedPaths } from './observedPaths';
import type { HaComponent, HaDeviceDiscoveryComponent, HaDeviceDiscoveryPayload, HaDiscoveryConfig } from './types';

function toComponents(configs: HaDiscoveryConfig[]): Record<string, HaDeviceDiscoveryComponent> {
  const result: Record<string, HaDeviceDiscoveryComponent> = {};
  for (const config of configs) {
    const raw = config as unknown as Record<string, unknown>;
    const { component, device: _device, ...rest } = raw;
    const componentKey = config.unique_id.replace(/^vrm_[^_]+_/, '');
    result[componentKey] = { platform: component as HaComponent, ...rest } as HaDeviceDiscoveryComponent;
  }
  return result;
}

/**
 * Build the HA device discovery payload for one VRM installation.
 *
 * The set of entity configs is derived from the entity defs and custom
 * aggregates — see `getObservedPaths` for the derivation rule.
 */
export function buildInstallationDiscovery(
  idSite: number,
  installationName: string,
  appVersion: string,
): HaDeviceDiscoveryPayload {
  const meta = { productName: 'Victron Energy', customName: installationName };
  const configs = buildDiscoveryConfigs(
    idSite, 'system', 0, meta,
    getObservedPaths(),
    CUSTOM_ENTITY_DEFS.aggregate,
  );

  return {
    device: {
      identifiers: [`vrm_${idSite}`],
      name: installationName,
      manufacturer: 'Victron Energy',
      model: 'Victron Energy System',
    },
    origin: { name: 'vrm-mqtt', sw_version: appVersion },
    availability_topic: `vrm/${idSite}/availability`,
    components: toComponents(configs),
  };
}
