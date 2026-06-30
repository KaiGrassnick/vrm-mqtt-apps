export type HaComponent = 'sensor' | 'binary_sensor' | 'switch' | 'select' | 'number';

export type HaSensorDeviceClass =
  | 'apparent_power'
  | 'atmospheric_pressure'
  | 'battery'
  | 'current'
  | 'distance'
  | 'duration'
  | 'energy'
  | 'energy_storage'
  | 'frequency'
  | 'humidity'
  | 'irradiance'
  | 'power'
  | 'power_factor'
  | 'pressure'
  | 'signal_strength'
  | 'speed'
  | 'temperature'
  | 'volume'
  | 'voltage'
  | 'wind_speed'
  | 'enum';

export type HaBinarySensorDeviceClass = 'battery' | 'battery_charging' | 'cold' | 'connectivity' | 'heat' | 'plug' | 'power' | 'problem' | 'running' | 'sound';

export type HaStateClass = 'measurement' | 'total' | 'total_increasing';

export interface HaDevice {
  identifiers: string[];
  name: string;
  manufacturer: string;
  model: string;
  sw_version?: string;
  serial_number?: string;
  via_device?: string;
}

export interface HaOrigin {
  name: string;
  sw_version?: string;
  support_url?: string;
}

// Distribute Omit over a union so each member is independently narrowed.
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A single component entry inside the `components` map of a device discovery payload.
 * It is the entity config with `component` renamed to `p` (platform). Device
 * grouping lives once at the outer payload level, not per component.
 */
export type HaDeviceDiscoveryComponent = DistributedOmit<HaDiscoveryConfig, 'component'> & { platform: HaComponent };

/** The assembled device discovery payload published to homeassistant/device/{id}/config. */
export interface HaDeviceDiscoveryPayload {
  device: HaDevice;
  origin: HaOrigin;
  availability_topic?: string;
  components: Record<string, HaDeviceDiscoveryComponent>;
}

interface HaDiscoveryBase {
  /** Determines the discovery topic prefix — not serialised into the config payload. */
  component: HaComponent;
  name: string;
  unique_id: string;
  /** Sets the default entity_id, e.g. sensor.{default_entity_id}. */
  default_entity_id: string;
}

export interface HaSensorConfig extends HaDiscoveryBase {
  component: 'sensor';
  state_topic: string;
  value_template: string;
  unit_of_measurement?: string;
  device_class?: HaSensorDeviceClass;
  state_class?: HaStateClass;
  suggested_display_precision?: number;
}

export interface HaBinarySensorConfig extends HaDiscoveryBase {
  component: 'binary_sensor';
  state_topic: string;
  value_template: string;
  device_class?: HaBinarySensorDeviceClass;
  payload_on?: string | number;
  payload_off?: string | number;
}

export interface HaSwitchConfig extends HaDiscoveryBase {
  component: 'switch';
  state_topic: string;
  command_topic: string;
  value_template: string;
  payload_on: string | number;
  payload_off: string | number;
  state_on?: string | number;
  state_off?: string | number;
}

export interface HaSelectConfig extends HaDiscoveryBase {
  component: 'select';
  state_topic: string;
  command_topic: string;
  value_template: string;
  options: string[];
}

export interface HaNumberConfig extends HaDiscoveryBase {
  component: 'number';
  state_topic: string;
  command_topic: string;
  value_template: string;
  unit_of_measurement?: string;
  device_class?: HaSensorDeviceClass;
  min?: number;
  max?: number;
  step?: number;
}

export type HaDiscoveryConfig =
  | HaSensorConfig
  | HaBinarySensorConfig
  | HaSwitchConfig
  | HaSelectConfig
  | HaNumberConfig;

export interface DeviceMeta {
  productName: string;
  customName?: string;
  serial?: string;
  firmwareVersion?: string;
}

export interface MqttMessage {
  topic: string;
  payload: string;
}
