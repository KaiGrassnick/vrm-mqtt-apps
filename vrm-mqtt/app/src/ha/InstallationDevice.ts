import { buildDiscoveryConfigs } from './DiscoveryConfigBuilder';
import type { HaComponent, HaDeviceDiscoveryComponent, HaDeviceDiscoveryPayload, HaDiscoveryConfig } from './types';

/**
 * The 13 pre-expanded system/0 paths that form the installation summary device.
 * Used as `observedPaths` for buildDiscoveryConfigs (which resolves L{n} templates)
 * and to derive MQTT subscription topics.
 */
export const INSTALLATION_PATHS = [
  'Dc/Pv/Power',
  'Dc/Battery/Soc',
  'Dc/Battery/Voltage',
  'Dc/Battery/State',
  'Ac/Grid/L1/Power',
  'Ac/Grid/L2/Power',
  'Ac/Grid/L3/Power',
  'Ac/Consumption/L1/Power',
  'Ac/Consumption/L2/Power',
  'Ac/Consumption/L3/Power',
  'Ac/Genset/L1/Power',
  'Ac/Genset/L2/Power',
  'Ac/Genset/L3/Power',
] as const;

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
 * One device, 13 fixed summary entities, all on system/0.
 */
export function buildInstallationDiscovery(
  portalId: string,
  installationName: string,
  appVersion: string,
): HaDeviceDiscoveryPayload {
  const meta = { productName: 'Victron Energy', customName: installationName };
  const configs = buildDiscoveryConfigs(portalId, 'system', 0, meta, [...INSTALLATION_PATHS]);

  return {
    device: {
      identifiers: [`vrm_${portalId}`],
      name: installationName,
      manufacturer: 'Victron Energy',
      model: 'Victron Energy System',
    },
    origin: { name: 'vrm-mqtt', sw_version: appVersion },
    availability_topic: `vrm/${portalId}/availability`,
    components: toComponents(configs),
  };
}
