import type { HaBinarySensorDeviceClass, HaSensorDeviceClass, HaStateClass } from './types';
import type { VrmServiceName } from '../vrm/types';

// ── Entity definition types ──────────────────────────────────────────────────

interface EntityDefBase {
  /**
   * VRM dbus path relative to the service/instance prefix.
   * Use `{n}` as a placeholder for any dynamic numeric index, e.g.:
   *   `Dc/{n}/Voltage`   → matches Dc/0/Voltage, Dc/1/Voltage, Dc/2/Voltage …
   *   `Ac/L{n}/Power`    → matches Ac/L1/Power, Ac/L2/Power, Ac/L3/Power …
   *   `Relay/{n}/State`  → matches Relay/0/State, Relay/1/State …
   * Paths without `{n}` are static and produce exactly one entity.
   */
  path: string;
  /**
   * Human-readable name template shown in Home Assistant.
   * Use `{n}` at the same position as in `path` to carry the discovered index
   * through to the entity name, e.g. `AC L{n} Power` → "AC L2 Power".
   */
  name: string;
}

export interface SensorEntityDef extends EntityDefBase {
  component: 'sensor';
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  stateClass?: HaStateClass;
  precision?: number;
  /** Populated when deviceClass is 'enum' — used to build the value_template. */
  enumValues?: Array<{ value: number; label: string }>;
}

export interface BinarySensorEntityDef extends EntityDefBase {
  component: 'binary_sensor';
  deviceClass?: HaBinarySensorDeviceClass;
}

export interface SwitchEntityDef extends EntityDefBase {
  component: 'switch';
  payloadOn: number;
  payloadOff: number;
}

export interface SelectOption {
  label: string;
  value: number;
}

export interface SelectEntityDef extends EntityDefBase {
  component: 'select';
  options: SelectOption[];
}

export interface NumberEntityDef extends EntityDefBase {
  component: 'number';
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}

export type EntityDef =
  | SensorEntityDef
  | BinarySensorEntityDef
  | SwitchEntityDef
  | SelectEntityDef
  | NumberEntityDef;

// ── Shared enum arrays ────────────────────────────────────────────────────────

const VEBUS_STATE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Low Power Mode' },
  { value: 2, label: 'Fault' },
  { value: 3, label: 'Bulk' },
  { value: 4, label: 'Absorption' },
  { value: 5, label: 'Float' },
  { value: 6, label: 'Storage' },
  { value: 7, label: 'Equalize' },
  { value: 8, label: 'Passthru' },
  { value: 9, label: 'Inverting' },
  { value: 10, label: 'Power assist' },
  { value: 11, label: 'Power supply mode' },
  { value: 244, label: 'Sustain' },
  { value: 245, label: 'Wake-up' },
  { value: 252, label: 'External control' },
];

const VEBUS_MODE_OPTIONS = [
  { label: 'Charger Only', value: 1 },
  { label: 'Inverter Only', value: 2 },
  { label: 'On', value: 3 },
  { label: 'Off', value: 4 },
];

const BATTERY_STATE_ENUM = [
  { value: 0, label: 'Idle' },
  { value: 1, label: 'Charging' },
  { value: 2, label: 'Discharging' },
];

const AC_ACTIVEIN_SOURCE_ENUM = [
  { value: 0, label: 'Not available' },
  { value: 1, label: 'Grid' },
  { value: 2, label: 'Generator' },
  { value: 3, label: 'Shore' },
  { value: 240, label: 'Inverting' },
];

const SYSTEM_STATE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Low power' },
  { value: 2, label: 'VE.Bus Fault' },
  { value: 3, label: 'Bulk charging' },
  { value: 4, label: 'Absorption charging' },
  { value: 5, label: 'Float charging' },
  { value: 6, label: 'Storage mode' },
  { value: 7, label: 'Equalisation charging' },
  { value: 8, label: 'Passthru' },
  { value: 9, label: 'Inverting' },
  { value: 10, label: 'Assisting' },
  { value: 244, label: 'Battery Sustain' },
  { value: 252, label: 'External control' },
  { value: 256, label: 'Discharging' },
  { value: 257, label: 'Sustain' },
  { value: 258, label: 'Recharge' },
  { value: 259, label: 'Scheduled recharge' },
];

const AC_ACTIVEIN_ACTIVEINPUT_ENUM = [
  { value: 0, label: 'AC In 1' },
  { value: 1, label: 'AC In 2' },
  { value: 240, label: 'Inverting' },
];

const VEBUS_CHARGE_STATE_ENUM = [
  { value: 1, label: 'Bulk' },
  { value: 2, label: 'Absorption' },
  { value: 3, label: 'Float' },
  { value: 4, label: 'Storage' },
  { value: 5, label: 'Repeat absorption' },
  { value: 6, label: 'Forced absorption' },
  { value: 7, label: 'Equalise' },
  { value: 8, label: 'Bulk stopped' },
];

// ── Per-service entity registries ────────────────────────────────────────────

const SYSTEM_ENTITIES: EntityDef[] = [
  // DC / battery summary
  { path: 'Dc/Battery/Soc', component: 'sensor', name: 'Battery SOC', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/Voltage', component: 'sensor', name: 'Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/Battery/Current', component: 'sensor', name: 'Battery Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/Power', component: 'sensor', name: 'Battery Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/TimeToGo', component: 'sensor', name: 'Battery Time To Go', unit: 's', deviceClass: 'duration' },
  { path: 'Dc/Battery/Temperature', component: 'sensor', name: 'Battery Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/ConsumedAmphours', component: 'sensor', name: 'Battery Consumed Amp Hours', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/State', component: 'sensor', name: 'Battery State', deviceClass: 'enum', enumValues: BATTERY_STATE_ENUM },
  // DC power sources
  { path: 'Dc/Pv/Power', component: 'sensor', name: 'PV Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Pv/Current', component: 'sensor', name: 'PV Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'PV/Current', component: 'sensor', name: 'PV Total Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/System/Power', component: 'sensor', name: 'DC System Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Vebus/Power', component: 'sensor', name: 'VE.Bus DC Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Vebus/Current', component: 'sensor', name: 'VE.Bus DC Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/InverterCharger/Power', component: 'sensor', name: 'Inverter/Charger Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/InverterCharger/Current', component: 'sensor', name: 'Inverter/Charger Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Charger/Power', component: 'sensor', name: 'DC Charger Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Alternator/Power', component: 'sensor', name: 'Alternator Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  // AC consumption
  { path: 'Ac/Consumption/L{n}/Power', component: 'sensor', name: 'AC Consumption L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Consumption/L{n}/Current', component: 'sensor', name: 'AC Consumption L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ConsumptionOnInput/L{n}/Power', component: 'sensor', name: 'AC Consumption On Input L{n}', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ConsumptionOnOutput/L{n}/Power', component: 'sensor', name: 'AC Consumption On Output L{n}', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  // AC active input
  { path: 'Ac/ActiveIn/L{n}/Power', component: 'sensor', name: 'AC Active Input L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/L{n}/Current', component: 'sensor', name: 'AC Active Input L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/Source', component: 'sensor', name: 'AC Input Source', deviceClass: 'enum', enumValues: AC_ACTIVEIN_SOURCE_ENUM },
  // AC grid
  { path: 'Ac/Grid/L{n}/Power', component: 'sensor', name: 'Grid L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Grid/L{n}/Current', component: 'sensor', name: 'Grid L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  // AC genset
  { path: 'Ac/Genset/L{n}/Power', component: 'sensor', name: 'Generator L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  // AC PV
  { path: 'Ac/PvOnOutput/L{n}/Power', component: 'sensor', name: 'PV On Output L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/PvOnOutput/L{n}/Current', component: 'sensor', name: 'PV On Output L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/PvOnGrid/L{n}/Power', component: 'sensor', name: 'PV On Grid L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  // ESS control limits
  { path: 'Control/ActiveSocLimit', component: 'sensor', name: 'Active SOC Limit', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Control/ScheduledSoc', component: 'sensor', name: 'Scheduled SOC', unit: '%', stateClass: 'measurement', precision: 1 },
  // Dynamic ESS
  { path: 'DynamicEss/Active', component: 'binary_sensor', name: 'Dynamic ESS Active', deviceClass: 'running' },
  { path: 'DynamicEss/Available', component: 'binary_sensor', name: 'Dynamic ESS Available', deviceClass: 'running' },
  { path: 'DynamicEss/AllowGridFeedIn', component: 'binary_sensor', name: 'Dynamic ESS Allow Grid Feed-In', deviceClass: 'running' },
  { path: 'DynamicEss/AvailableOverhead', component: 'sensor', name: 'Dynamic ESS Available Overhead', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'DynamicEss/ErrorCode', component: 'sensor', name: 'Dynamic ESS Error Code' },
  { path: 'DynamicEss/MinimumSoc', component: 'sensor', name: 'Dynamic ESS Minimum SOC', unit: '%', stateClass: 'measurement', precision: 0 },
  { path: 'DynamicEss/NumberOfSchedules', component: 'sensor', name: 'Dynamic ESS Schedules', stateClass: 'measurement' },
  { path: 'DynamicEss/TargetSoc', component: 'sensor', name: 'Dynamic ESS Target SOC', unit: '%', stateClass: 'measurement', precision: 0 },
  // System state
  { path: 'SystemState/State', component: 'sensor', name: 'System State', deviceClass: 'enum', enumValues: SYSTEM_STATE_ENUM },
  // Timers
  { path: 'Timers/TimeOnGrid', component: 'sensor', name: 'Time On Grid', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'Timers/TimeOnInverter', component: 'sensor', name: 'Time On Inverter', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'Timers/TimeOnGenerator', component: 'sensor', name: 'Time On Generator', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'Timers/TimeOff', component: 'sensor', name: 'Time Off', unit: 's', deviceClass: 'duration', precision: 0 },
  // IO
  { path: 'Relay/{n}/State', component: 'switch', name: 'Relay {n}', payloadOn: 1, payloadOff: 0 },
  { path: 'SwitchableOutput/{n}/State', component: 'switch', name: 'Output {n}', payloadOn: 1, payloadOff: 0 },
  { path: 'Buzzer/State', component: 'binary_sensor', name: 'Buzzer', deviceClass: 'sound' },
];

const VEBUS_ENTITIES: EntityDef[] = [
  // AC output per phase
  { path: 'Ac/Out/L{n}/P', component: 'sensor', name: 'AC Output L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/L{n}/S', component: 'sensor', name: 'AC Output L{n} Apparent Power', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/L{n}/V', component: 'sensor', name: 'AC Output L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Out/L{n}/I', component: 'sensor', name: 'AC Output L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/L{n}/F', component: 'sensor', name: 'AC Output L{n} Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  // AC output totals
  { path: 'Ac/Out/P', component: 'sensor', name: 'AC Output Total Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/S', component: 'sensor', name: 'AC Output Total Apparent Power', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement', precision: 1 },
  // AC input per phase
  { path: 'Ac/ActiveIn/L{n}/P', component: 'sensor', name: 'AC Input L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/L{n}/S', component: 'sensor', name: 'AC Input L{n} Apparent Power', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/L{n}/V', component: 'sensor', name: 'AC Input L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/ActiveIn/L{n}/I', component: 'sensor', name: 'AC Input L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/L{n}/F', component: 'sensor', name: 'AC Input L{n} Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  // AC input totals
  { path: 'Ac/ActiveIn/P', component: 'sensor', name: 'AC Input Total Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/ActiveIn/S', component: 'sensor', name: 'AC Input Total Apparent Power', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement', precision: 1 },
  // AC input state
  { path: 'Ac/ActiveIn/ActiveInput', component: 'sensor', name: 'Active AC Input', deviceClass: 'enum', enumValues: AC_ACTIVEIN_ACTIVEINPUT_ENUM },
  { path: 'Ac/State/IgnoreAcIn1', component: 'binary_sensor', name: 'Ignoring AC In 1' },
  { path: 'Ac/State/RemoteGeneratorSelected', component: 'binary_sensor', name: 'Remote Generator Selected', deviceClass: 'running' },
  // AC input controls
  { path: 'Ac/In/1/CurrentLimit', component: 'number', name: 'AC Input 1 Current Limit', unit: 'A', deviceClass: 'current', min: 0, max: 100, step: 0.1, precision: 1 },
  { path: 'Ac/In/2/CurrentLimit', component: 'number', name: 'AC Input 2 Current Limit', unit: 'A', deviceClass: 'current', min: 0, max: 100, step: 0.1, precision: 1 },
  { path: 'Ac/Control/IgnoreAcIn1', component: 'switch', name: 'Ignore AC In 1', payloadOn: 1, payloadOff: 0 },
  // DC / battery
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'DC Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'DC Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'DC Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'DC Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Soc', component: 'sensor', name: 'State of Charge', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1 },
  // Battery sense
  { path: 'BatterySense/Temperature', component: 'sensor', name: 'Battery Sense Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'BatterySense/Voltage', component: 'sensor', name: 'Battery Sense Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  // Energy flow counters
  { path: 'Energy/AcIn1ToAcOut', component: 'sensor', name: 'AC In 1 to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcIn2ToAcOut', component: 'sensor', name: 'AC In 2 to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/InverterToAcOut', component: 'sensor', name: 'Inverter to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcIn1ToInverter', component: 'sensor', name: 'AC In 1 to Inverter Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcIn2ToInverter', component: 'sensor', name: 'AC In 2 to Inverter Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/OutToInverter', component: 'sensor', name: 'AC Out to Inverter Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcOutToAcIn1', component: 'sensor', name: 'AC Out to AC In 1 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcOutToAcIn2', component: 'sensor', name: 'AC Out to AC In 2 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/InverterToAcIn1', component: 'sensor', name: 'Inverter to AC In 1 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/InverterToAcIn2', component: 'sensor', name: 'Inverter to AC In 2 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  // State & control
  { path: 'State', component: 'sensor', name: 'Inverter State', deviceClass: 'enum', enumValues: VEBUS_STATE_ENUM },
  { path: 'VebusChargeState', component: 'sensor', name: 'VE.Bus Charge State', deviceClass: 'enum', enumValues: VEBUS_CHARGE_STATE_ENUM },
  { path: 'VebusError', component: 'sensor', name: 'VE.Bus Error' },
  { path: 'Mode', component: 'select', name: 'Mode', options: VEBUS_MODE_OPTIONS },
  { path: 'Connected', component: 'binary_sensor', name: 'Connected', deviceClass: 'running' },
  // BMS
  { path: 'Bms/AllowToCharge', component: 'binary_sensor', name: 'BMS Allow To Charge', deviceClass: 'battery_charging' },
  { path: 'Bms/AllowToDischarge', component: 'binary_sensor', name: 'BMS Allow To Discharge' },
  { path: 'Bms/PreAlarm', component: 'binary_sensor', name: 'BMS Pre-Alarm', deviceClass: 'problem' },
  // ESS Hub4 controls per phase
  { path: 'Hub4/L{n}/AcPowerSetpoint', component: 'number', name: 'ESS AC Power Setpoint L{n}', unit: 'W', deviceClass: 'power', min: -10000, max: 10000, step: 1, precision: 1 },
  // Settings
  { path: 'Settings/Alarm/System/GridLost', component: 'switch', name: 'Grid Lost Alarm', payloadOn: 1, payloadOff: 0 },
  { path: 'Settings/AssistCurrentBoostFactor', component: 'number', name: 'Assist Current Boost Factor', step: 0.125, min: 0.25, max: 3.5, precision: 3 },
  // Alarms — generic
  { path: 'Alarms/HighDcCurrent', component: 'binary_sensor', name: 'High DC Current Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/HighTemperature', component: 'binary_sensor', name: 'L{n} High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/LowBattery', component: 'binary_sensor', name: 'L{n} Low Battery Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/Overload', component: 'binary_sensor', name: 'L{n} Overload Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/Ripple', component: 'binary_sensor', name: 'L{n} Ripple Alarm', deviceClass: 'problem' },
];

const PLATFORM_ENTITIES: EntityDef[] = [
  { path: 'Firmware/Installed/Version', component: 'sensor', name: 'Firmware Version' },
  { path: 'Firmware/Online/AvailableVersion', component: 'sensor', name: 'Available Firmware Version' },
  { path: 'Network/Wifi/SignalStrength', component: 'sensor', name: 'WiFi Signal', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Notifications/NumberOfActiveAlarms', component: 'sensor', name: 'Active Alarms', stateClass: 'measurement' },
  { path: 'Notifications/NumberOfActiveWarnings', component: 'sensor', name: 'Active Warnings', stateClass: 'measurement' },
  { path: 'Notifications/NumberOfActiveInformations', component: 'sensor', name: 'Active Informations', stateClass: 'measurement' },
  { path: 'Notifications/NumberOfUnAcknowledgedAlarms', component: 'sensor', name: 'Unacknowledged Alarms', stateClass: 'measurement' },
];

// ── Service → entity lookup ───────────────────────────────────────────────────

// Only services with write-side entity definitions are registered here
// (currently system, vebus, platform); read-only services like battery,
// solarcharger, grid, etc. have no entries by design.
export const SERVICE_ENTITY_DEFS: Partial<Record<VrmServiceName, EntityDef[]>> = {
  system: SYSTEM_ENTITIES,
  vebus: VEBUS_ENTITIES,
  platform: PLATFORM_ENTITIES,
};