export type VrmServiceName =
  | 'system'
  | 'battery'
  | 'solarcharger'
  | 'vebus'
  | 'multi'
  | 'grid'
  | 'acload'
  | 'genset'
  | 'generator'
  | 'pvinverter'
  | 'evcharger'
  | 'temperature'
  | 'tank'
  | 'inverter'
  | 'charger'
  | 'alternator'
  | 'dcdc'
  | 'dcsystem'
  | 'dcload'
  | 'digitalinput'
  | 'heatpump'
  | 'hub4'
  | 'gps'
  | 'meteo'
  | 'platform';

const VRM_SERVICE_NAME_SET = new Set<string>([
  'system', 'battery', 'solarcharger', 'vebus', 'multi',
  'grid', 'acload', 'genset', 'generator', 'pvinverter', 'evcharger',
  'temperature', 'tank', 'inverter', 'charger', 'alternator',
  'dcdc', 'dcsystem', 'dcload', 'digitalinput', 'heatpump', 'hub4',
  'gps', 'meteo', 'platform',
]);

export function isVrmServiceName(s: string): s is VrmServiceName {
  return VRM_SERVICE_NAME_SET.has(s);
}

export interface VrmMeResponse {
  user: VrmUserRecord;
  success: boolean;
}

export interface VrmUserRecord {
  id: number;
  name: string;
  email: string;
  country: string;
  accessLevel: number;
  [key: string]: unknown;
}

export interface VrmUser {
  id: number;
  name: string;
  email: string;
}

export interface VrmInstallationsResponse {
  records: VrmInstallationRecord[];
  success: boolean;
}

export interface VrmInstallationTag {
  idTag: number;
  name: string;
  automatic: boolean;
}

export interface VrmInstallationImage {
  idSiteImage: number;
  imageName: string;
  url: string;
}

export interface VrmInstallationViewPermissions {
  update_settings: boolean;
  settings: boolean;
  diagnostics: boolean;
  share: boolean;
  vnc: boolean;
  mqtt_rpc: boolean;
  vebus: boolean;
  twoway: boolean;
  exact_location: boolean;
  nodered: boolean;
  nodered_dash: boolean;
  signalk: boolean;
}

export interface VrmExtendedDataAttribute {
  idDataAttribute: number;
  code: string;
  description: string;
  formatWithUnit: string;
  dataType: string;
  textValue: string;
  instance: string;
  timestamp: string;
  dbusServiceType: string;
  dbusPath: string;
  rawValue: string;
  formattedValue: string;
  dataAttributeEnumValues: Array<{ nameEnum: string; valueEnum: number }>;
}

export interface VrmInstallationRecord {
  idSite: number;
  name: string;
  identifier: string;
  idUser: number;
  accessLevel: number;
  owner: boolean;
  is_admin: boolean;
  pvMax: number;
  timezone: string;
  phonenumber: string | null;
  notes: string | null;
  geofence: unknown | null;
  geofenceEnabled: boolean;
  realtimeUpdates: boolean;
  hasMains: number;
  hasGenerator: number;
  noDataAlarmTimeout: unknown | null;
  alarmMonitoring: number;
  syscreated: number;
  shared: boolean;
  device_icon: string;
  alarm: boolean;
  last_timestamp: number;
  current_time: string;
  timezone_offset: number;
  demo_mode: boolean;
  mqtt_host: string;
  mqtt_webhost: string;
  high_workload: boolean;
  is_on_grid: boolean;
  minimum_soc: number;
  current_alarms: string[];
  num_alarms: number;
  avatar_url: string | null;
  tags: VrmInstallationTag[];
  images: VrmInstallationImage[];
  view_permissions: VrmInstallationViewPermissions;
  extended: VrmExtendedDataAttribute[];
  [key: string]: unknown;
}

export interface VrmInstallation {
  idSite: number;
  name: string;
  identifier: string;
  brokerPortalId: string;
  mqttHost: string;
  mqttWebHost: string;
}
