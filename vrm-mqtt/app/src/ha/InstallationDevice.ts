import { buildDiscoveryConfigs } from './DiscoveryConfigBuilder';
import { CUSTOM_ENTITY_DEFS } from './entityDefs';
import { getObservedPaths } from './observedPaths';
import type { HaComponent, HaDeviceDiscoveryComponent, HaDeviceDiscoveryPayload, HaDiscoveryConfig } from './types';
import type { VrmServiceName } from '../vrm/types';

function toComponents(configs: HaDiscoveryConfig[]): Record<string, HaDeviceDiscoveryComponent> {
  const result: Record<string, HaDeviceDiscoveryComponent> = {};
  for (const config of configs) {
    const raw = config as unknown as Record<string, unknown>;
    const { component, ...rest } = raw;
    const componentKey = config.unique_id.replace(/^vrm_[^_]+_/, '');
    result[componentKey] = { platform: component as HaComponent, ...rest } as HaDeviceDiscoveryComponent;
  }
  return result;
}

/**
 * Build the HA device discovery payload for one VRM installation, merging
 * configs for every (service, instance) pair present in `observedInstances`.
 */
export function buildInstallationDiscovery(
  idSite: number,
  installationName: string,
  appVersion: string,
  observedInstances: ReadonlyMap<VrmServiceName, ReadonlySet<string>>,
): HaDeviceDiscoveryPayload {
  const pathsByService = new Map(getObservedPaths().map(s => [s.service, s.paths]));
  const configs: HaDiscoveryConfig[] = [];

  for (const [service, instances] of observedInstances) {
    const paths = pathsByService.get(service) ?? [];
    for (const instance of instances) {
      configs.push(...buildDiscoveryConfigs(
        idSite,
        service,
        instance,
        paths,
        service === 'system' ? CUSTOM_ENTITY_DEFS.aggregate : [],
      ));
    }
  }

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
