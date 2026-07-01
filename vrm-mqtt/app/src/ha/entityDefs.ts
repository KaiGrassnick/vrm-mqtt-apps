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
  /**
   * When true, the bridge subscribes to the VRM topic (when needed), emits an
   * HA discovery config, and publishes the value to HA. When false or omitted,
   * the entity may still be subscribed as an aggregate source but never
   * appears in HA.
   *
   * Default: false. New entities must explicitly opt in.
   */
  forward?: boolean;
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

/**
 * A derived sensor whose value is the sum of one or more source paths on the
 * VRM bus. Aggregate entities live in `CUSTOM_ENTITY_DEFS.aggregate` (not in the
 * normal `SERVICE_ENTITY_DEFS` array) and have their own type so `aggregateFrom`
 * cannot be attached to a regular sensor by accident.
 *
 * Source paths may use `{n}` (expanded to indices 1, 2, 3) or be literal paths
 * (e.g. `Dc/Pv/Power`). The aggregate is the sum of source values that have
 * been observed at least once — a single-phase installation publishes a
 * one-phase sum, a three-phase installation publishes a three-phase sum.
 *
 * Aggregate entities MUST be subscribed for their sources to be observed,
 * regardless of their own `forward` flag.
 */
export interface CustomAggregateEntityDef {
  /** VRM dbus path the aggregate is published on, e.g. 'Ac/Grid/Power'. */
  path: string;
  /** Human-readable name shown in Home Assistant. */
  name: string;
  /** Required. Source paths to sum. Templates use `{n}` → 1, 2, 3. */
  aggregateFrom: string[];
  unit?: string;
  deviceClass?: HaSensorDeviceClass;
  stateClass?: HaStateClass;
  precision?: number;
  /** Default false. When true, emit HA discovery and publish the value. */
  forward?: boolean;
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

const CHARGER_STATE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 2, label: 'Fault' },
  { value: 3, label: 'Bulk' },
  { value: 4, label: 'Absorption' },
  { value: 5, label: 'Float' },
  { value: 6, label: 'Storage' },
  { value: 7, label: 'Equalize' },
  { value: 11, label: 'Power supply mode' },
  { value: 246, label: 'Repeated absorption' },
  { value: 247, label: 'Auto equalize / Recondition' },
  { value: 248, label: 'BatterySafe' },
];

// Solar charger / alternator / dcdc state
const MPPT_STATE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 2, label: 'Fault' },
  { value: 3, label: 'Bulk' },
  { value: 4, label: 'Absorption' },
  { value: 5, label: 'Float' },
  { value: 6, label: 'Storage' },
  { value: 7, label: 'Equalize' },
  { value: 252, label: 'External control' },
];

const MPPT_ERROR_ENUM = [
  { value: 0, label: 'No error' },
  { value: 1, label: 'Battery temperature too high' },
  { value: 2, label: 'Battery voltage too high' },
  { value: 3, label: 'Battery temperature sensor miswired (+)' },
  { value: 4, label: 'Battery temperature sensor miswired (-)' },
  { value: 5, label: 'Battery temperature sensor disconnected' },
  { value: 6, label: 'Battery voltage sense miswired (+)' },
  { value: 7, label: 'Battery voltage sense miswired (-)' },
  { value: 8, label: 'Battery voltage sense disconnected' },
  { value: 9, label: 'Battery voltage wire losses too high' },
  { value: 17, label: 'Charger temperature too high' },
  { value: 18, label: 'Charger over-current' },
  { value: 19, label: 'Charger current polarity reversed' },
  { value: 20, label: 'Bulk time limit reached' },
  { value: 21, label: 'Current sensor issue' },
  { value: 22, label: 'Charger temperature sensor miswired' },
  { value: 23, label: 'Charger temperature sensor disconnected' },
  { value: 26, label: 'Terminals overheated' },
  { value: 28, label: 'Converter issue' },
  { value: 33, label: 'Input voltage too high (solar panel)' },
  { value: 34, label: 'Input current too high' },
  { value: 38, label: 'Input shutdown (battery fully charged)' },
  { value: 39, label: 'Input shutdown (current flow while off)' },
  { value: 65, label: 'Lost communication with one of devices' },
  { value: 66, label: 'Synchronised charging device configuration issue' },
  { value: 67, label: 'BMS connection lost' },
  { value: 68, label: 'Network misconfigured' },
  { value: 116, label: 'Factory calibration data lost' },
  { value: 117, label: 'Invalid/incompatible firmware' },
  { value: 119, label: 'User settings invalid' },
];

const MPPT_OPERATION_MODE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Voltage/Current Limited' },
  { value: 2, label: 'MPPT Active' },
];

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

const GENSET_STATUS_ENUM = [
  { value: 0, label: 'Standby' },
  { value: 1, label: 'Startup 1' },
  { value: 2, label: 'Startup 2' },
  { value: 3, label: 'Startup 3' },
  { value: 4, label: 'Startup 4' },
  { value: 5, label: 'Startup 5' },
  { value: 6, label: 'Startup 6' },
  { value: 7, label: 'Startup 7' },
  { value: 8, label: 'Running' },
  { value: 9, label: 'Stopping' },
  { value: 10, label: 'Error' },
];

const GENERATOR_RUNNING_BY_CONDITION_ENUM = [
  { value: 0, label: 'Stopped' },
  { value: 1, label: 'Manual' },
  { value: 2, label: 'Test run' },
  { value: 3, label: 'Loss of communication' },
  { value: 4, label: 'SOC' },
  { value: 5, label: 'AC load' },
  { value: 6, label: 'Battery current' },
  { value: 7, label: 'Battery voltage' },
  { value: 8, label: 'Inverter high temp' },
  { value: 9, label: 'Inverter overload' },
];

const PVINVERTER_STATUS_ENUM = [
  { value: 0, label: 'Startup 0' },
  { value: 1, label: 'Startup 1' },
  { value: 2, label: 'Startup 2' },
  { value: 3, label: 'Startup 3' },
  { value: 4, label: 'Startup 4' },
  { value: 5, label: 'Startup 5' },
  { value: 6, label: 'Startup 6' },
  { value: 7, label: 'Running' },
  { value: 8, label: 'Standby' },
  { value: 9, label: 'Boot loading' },
  { value: 10, label: 'Error' },
];

const EVCHARGER_STATUS_ENUM = [
  { value: 0, label: 'Disconnected' },
  { value: 1, label: 'Connected' },
  { value: 2, label: 'Charging' },
  { value: 3, label: 'Charged' },
  { value: 4, label: 'Waiting for sun' },
  { value: 5, label: 'Waiting for RFID' },
  { value: 6, label: 'Waiting for start' },
  { value: 7, label: 'Low SOC' },
  { value: 8, label: 'Ground test error' },
  { value: 9, label: 'Welded contacts error' },
  { value: 10, label: 'CP input test error (shorted)' },
  { value: 11, label: 'Residual current detected' },
  { value: 12, label: 'Undervoltage detected' },
  { value: 13, label: 'Overvoltage detected' },
  { value: 14, label: 'Overheating detected' },
  { value: 20, label: 'Charging limit' },
];

const EVCHARGER_MODE_OPTIONS = [
  { label: 'Manual', value: 0 },
  { label: 'Auto', value: 1 },
];

const EVCHARGER_POSITION_ENUM = [
  { value: 0, label: 'AC Output' },
  { value: 1, label: 'AC Input' },
];

const TEMPERATURE_STATUS_ENUM = [
  { value: 0, label: 'Ok' },
  { value: 1, label: 'Disconnected' },
  { value: 2, label: 'Short circuited' },
  { value: 3, label: 'Reverse polarity' },
  { value: 4, label: 'Unknown' },
];

const TEMPERATURE_TYPE_ENUM = [
  { value: 0, label: 'Battery' },
  { value: 1, label: 'Fridge' },
  { value: 2, label: 'Generic' },
  { value: 3, label: 'Room' },
  { value: 4, label: 'Outdoor' },
  { value: 5, label: 'Water Heater' },
  { value: 6, label: 'Freezer' },
];

const TANK_FLUID_TYPE_ENUM = [
  { value: 0, label: 'Fuel' },
  { value: 1, label: 'Fresh water' },
  { value: 2, label: 'Waste water' },
  { value: 3, label: 'Live well' },
  { value: 4, label: 'Oil' },
  { value: 5, label: 'Black water' },
  { value: 6, label: 'Gasoline' },
  { value: 7, label: 'Diesel' },
  { value: 8, label: 'LPG' },
  { value: 9, label: 'LNG' },
  { value: 10, label: 'Hydraulic oil' },
  { value: 11, label: 'Raw water' },
];

const TANK_STATUS_ENUM = [
  { value: 0, label: 'Ok' },
  { value: 1, label: 'Disconnected' },
  { value: 2, label: 'Short circuited' },
  { value: 3, label: 'Unknown' },
  { value: 4, label: 'Configuration error' },
];

const INVERTER_STATE_ENUM = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Low Power' },
  { value: 2, label: 'Fault' },
  { value: 9, label: 'Inverting' },
];

const INVERTER_MODE_OPTIONS = [
  { label: 'Charger Only', value: 1 },
  { label: 'Inverter Only', value: 2 },
  { label: 'On', value: 3 },
  { label: 'Off', value: 4 },
  { label: 'Eco', value: 5 },
];

const CHARGER_MODE_OPTIONS = [
  { label: 'On', value: 1 },
  { label: 'Off', value: 4 },
];

// ── Per-service entity registries ────────────────────────────────────────────

const SYSTEM_ENTITIES: EntityDef[] = [
  // DC / battery summary
  { path: 'Dc/Battery/Soc', component: 'sensor', name: 'Battery SOC', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1, forward: true },
  { path: 'Dc/Battery/Voltage', component: 'sensor', name: 'Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3, forward: true },
  { path: 'Dc/Battery/Current', component: 'sensor', name: 'Battery Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/Power', component: 'sensor', name: 'Battery Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1, forward: true},
  { path: 'Dc/Battery/TimeToGo', component: 'sensor', name: 'Battery Time To Go', unit: 's', deviceClass: 'duration' },
  { path: 'Dc/Battery/Temperature', component: 'sensor', name: 'Battery Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/ConsumedAmphours', component: 'sensor', name: 'Battery Consumed Amp Hours', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/Battery/State', component: 'sensor', name: 'Battery State', deviceClass: 'enum', enumValues: BATTERY_STATE_ENUM, forward: true },
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

const BATTERY_ENTITIES: EntityDef[] = [
  // Core measurements
  { path: 'Soc', component: 'sensor', name: 'State of Charge', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1 },
  { path: 'Soh', component: 'sensor', name: 'State of Health', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/MidVoltage', component: 'sensor', name: 'Mid Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/MidVoltageDeviation', component: 'sensor', name: 'Mid Voltage Deviation', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/1/Voltage', component: 'sensor', name: 'Starter Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'TimeToGo', component: 'sensor', name: 'Time To Go', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'ConsumedAmphours', component: 'sensor', name: 'Consumed Amp Hours', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  { path: 'Capacity', component: 'sensor', name: 'Capacity', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  { path: 'InstalledCapacity', component: 'sensor', name: 'Installed Capacity', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  // BMS charge limits
  { path: 'Info/MaxChargeCurrent', component: 'sensor', name: 'Max Charge Current (CCL)', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Info/MaxDischargeCurrent', component: 'sensor', name: 'Max Discharge Current (DCL)', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Info/MaxChargeVoltage', component: 'sensor', name: 'Max Charge Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Info/ChargeMode', component: 'sensor', name: 'Charge Mode' },
  // Cell-level monitoring
  { path: 'System/MaxCellVoltage', component: 'sensor', name: 'Max Cell Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'System/MinCellVoltage', component: 'sensor', name: 'Min Cell Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'System/MaxCellTemperature', component: 'sensor', name: 'Max Cell Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'System/MinCellTemperature', component: 'sensor', name: 'Min Cell Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'System/MaxTemperatureCellId', component: 'sensor', name: 'Max Temperature Cell' },
  { path: 'System/MinTemperatureCellId', component: 'sensor', name: 'Min Temperature Cell' },
  { path: 'System/MaxVoltageCellId', component: 'sensor', name: 'Max Voltage Cell' },
  { path: 'System/MinVoltageCellId', component: 'sensor', name: 'Min Voltage Cell' },
  { path: 'System/MOSTemperature', component: 'sensor', name: 'MOS Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'System/NrOfModulesBlockingCharge', component: 'sensor', name: 'Modules Blocking Charge', stateClass: 'measurement', precision: 0 },
  { path: 'System/NrOfModulesBlockingDischarge', component: 'sensor', name: 'Modules Blocking Discharge', stateClass: 'measurement', precision: 0 },
  { path: 'System/NrOfModulesOffline', component: 'sensor', name: 'Modules Offline', stateClass: 'measurement', precision: 0 },
  { path: 'System/NrOfModulesOnline', component: 'sensor', name: 'Modules Online', stateClass: 'measurement', precision: 0 },
  { path: 'Voltages/Diff', component: 'sensor', name: 'Cell Voltage Spread', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Voltages/Cell{n}', component: 'sensor', name: 'Cell {n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  // History
  { path: 'History/AutomaticSyncs', component: 'sensor', name: 'Automatic Syncs', stateClass: 'total_increasing' },
  { path: 'History/AverageDischarge', component: 'sensor', name: 'Average Discharge', unit: 'kWh', precision: 1 },
  { path: 'History/ChargeCycles', component: 'sensor', name: 'Charge Cycles', stateClass: 'total_increasing' },
  { path: 'History/ChargedEnergy', component: 'sensor', name: 'Total Charged Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'History/DeepestDischarge', component: 'sensor', name: 'Deepest Discharge', unit: 'kWh', precision: 1 },
  { path: 'History/DischargedEnergy', component: 'sensor', name: 'Total Discharged Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'History/LastDischarge', component: 'sensor', name: 'Last Discharge', unit: 'kWh', precision: 1 },
  { path: 'History/MaximumVoltage', component: 'sensor', name: 'Maximum Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'History/MinimumVoltage', component: 'sensor', name: 'Minimum Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'History/TimeSinceLastFullCharge', component: 'sensor', name: 'Time Since Full Charge', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'History/TotalAhDrawn', component: 'sensor', name: 'Total Ah Drawn', unit: 'Ah', stateClass: 'measurement', precision: 1 },
  // Control
  { path: 'Relay/0/State', component: 'switch', name: 'Relay', payloadOn: 1, payloadOff: 0 },
  { path: 'Io/AllowToCharge', component: 'binary_sensor', name: 'BMS Allow To Charge', deviceClass: 'battery_charging' },
  { path: 'Io/AllowToDischarge', component: 'binary_sensor', name: 'BMS Allow To Discharge' },
  { path: 'Balancing', component: 'binary_sensor', name: 'Balancing', deviceClass: 'running' },
  // Alarms
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowCellVoltage', component: 'binary_sensor', name: 'Low Cell Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighCellVoltage', component: 'binary_sensor', name: 'High Cell Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowSoc', component: 'binary_sensor', name: 'Low SOC Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowTemperature', component: 'binary_sensor', name: 'Low Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowChargeTemperature', component: 'binary_sensor', name: 'Low Charge Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighChargeTemperature', component: 'binary_sensor', name: 'High Charge Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/CellImbalance', component: 'binary_sensor', name: 'Cell Imbalance Alarm', deviceClass: 'problem' },
  { path: 'Alarms/ChargeBlocked', component: 'binary_sensor', name: 'Charge Blocked Alarm', deviceClass: 'problem' },
  { path: 'Alarms/DischargeBlocked', component: 'binary_sensor', name: 'Discharge Blocked Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighChargeCurrent', component: 'binary_sensor', name: 'High Charge Current Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighDischargeCurrent', component: 'binary_sensor', name: 'High Discharge Current Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighCurrent', component: 'binary_sensor', name: 'High Current Alarm', deviceClass: 'problem' },
  { path: 'Alarms/InternalFailure', component: 'binary_sensor', name: 'Internal Failure Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighInternalTemperature', component: 'binary_sensor', name: 'High Internal Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/MidVoltage', component: 'binary_sensor', name: 'Mid Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowStarterVoltage', component: 'binary_sensor', name: 'Low Starter Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighStarterVoltage', component: 'binary_sensor', name: 'High Starter Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Contactor', component: 'binary_sensor', name: 'Contactor Alarm', deviceClass: 'problem' },
  { path: 'Alarms/BmsCable', component: 'binary_sensor', name: 'BMS Cable Alarm', deviceClass: 'problem' },
  { path: 'Alarms/FuseBlown', component: 'binary_sensor', name: 'Fuse Blown Alarm', deviceClass: 'problem' },
];

const SOLARCHARGER_ENTITIES: EntityDef[] = [
  { path: 'Yield/Power', component: 'sensor', name: 'Yield Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Yield/User', component: 'sensor', name: 'Yield User', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Yield/System', component: 'sensor', name: 'Yield System', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'Battery Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'Battery Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  // PV trackers — single-tracker products use /Pv/V; multi-tracker use /Pv/{n}/V and /Pv/{n}/P
  { path: 'Pv/V', component: 'sensor', name: 'PV Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Pv/{n}/V', component: 'sensor', name: 'PV Tracker {n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Pv/{n}/P', component: 'sensor', name: 'PV Tracker {n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'MppOperationMode', component: 'sensor', name: 'MPPT Operating Mode', deviceClass: 'enum', enumValues: MPPT_OPERATION_MODE_ENUM },
  { path: 'Pv/{n}/MppOperationMode', component: 'sensor', name: 'Tracker {n} MPPT Mode', deviceClass: 'enum', enumValues: MPPT_OPERATION_MODE_ENUM },
  { path: 'Load/State', component: 'binary_sensor', name: 'Load Output', deviceClass: 'power' },
  { path: 'Load/I', component: 'sensor', name: 'Load Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Relay/0/State', component: 'switch', name: 'Relay', payloadOn: 1, payloadOff: 0 },
  { path: 'State', component: 'sensor', name: 'Charger State', deviceClass: 'enum', enumValues: MPPT_STATE_ENUM },
  { path: 'Mode', component: 'select', name: 'Charger Mode', options: CHARGER_MODE_OPTIONS },
  { path: 'ErrorCode', component: 'sensor', name: 'Error Code', deviceClass: 'enum', enumValues: MPPT_ERROR_ENUM },
  { path: 'DeviceOffReason', component: 'sensor', name: 'Device Off Reason' },
  { path: 'Settings/ChargeCurrentLimit', component: 'number', name: 'Charge Current Limit', unit: 'A', deviceClass: 'current', min: 0, max: 200, step: 1, precision: 1 },
  // Today's history
  { path: 'History/Daily/0/Yield', component: 'sensor', name: "Today's Yield", unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 2 },
  { path: 'History/Daily/0/MaxPower', component: 'sensor', name: "Today's Max Power", unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'History/Daily/1/Yield', component: 'sensor', name: "Yesterday's Yield", unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 2 },
  { path: 'History/Daily/1/MaxPower', component: 'sensor', name: "Yesterday's Max Power", unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/ShortCircuit', component: 'binary_sensor', name: 'Short Circuit Alarm', deviceClass: 'problem' },
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
  { path: 'Alarms/HighDcVoltage', component: 'binary_sensor', name: 'High DC Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowBattery', component: 'binary_sensor', name: 'Low Battery Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Overload', component: 'binary_sensor', name: 'Overload Alarm', deviceClass: 'problem' },
  { path: 'Alarms/GridLost', component: 'binary_sensor', name: 'Grid Lost Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/PhaseRotation', component: 'binary_sensor', name: 'Phase Rotation Alarm', deviceClass: 'problem' },
  { path: 'Alarms/TemperatureSensor', component: 'binary_sensor', name: 'Temperature Sensor Alarm', deviceClass: 'problem' },
  { path: 'Alarms/VoltageSensor', component: 'binary_sensor', name: 'Voltage Sensor Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Ripple', component: 'binary_sensor', name: 'DC Ripple Alarm', deviceClass: 'problem' },
  // Alarms — per phase
  { path: 'Alarms/L{n}/HighTemperature', component: 'binary_sensor', name: 'L{n} High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/LowBattery', component: 'binary_sensor', name: 'L{n} Low Battery Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/Overload', component: 'binary_sensor', name: 'L{n} Overload Alarm', deviceClass: 'problem' },
  { path: 'Alarms/L{n}/Ripple', component: 'binary_sensor', name: 'L{n} Ripple Alarm', deviceClass: 'problem' },
];

// Multi RS inverter/charger — separate dbus service from vebus but similar structure
const MULTI_ENTITIES: EntityDef[] = [
  // AC input per phase (input 1)
  { path: 'Ac/In/1/L{n}/P', component: 'sensor', name: 'AC In 1 L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/In/1/L{n}/I', component: 'sensor', name: 'AC In 1 L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/In/1/L{n}/V', component: 'sensor', name: 'AC In 1 L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/In/1/CurrentLimit', component: 'number', name: 'AC Input 1 Current Limit', unit: 'A', deviceClass: 'current', min: 0, max: 200, step: 0.1, precision: 1 },
  // AC output per phase (output 1)
  { path: 'Ac/Out/1/L{n}/P', component: 'sensor', name: 'AC Out L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/1/L{n}/I', component: 'sensor', name: 'AC Out L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/1/L{n}/V', component: 'sensor', name: 'AC Out L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  // DC
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'DC Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'DC Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'DC Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'DC Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Soc', component: 'sensor', name: 'State of Charge', unit: '%', deviceClass: 'battery', stateClass: 'measurement', precision: 1 },
  // Energy flows
  { path: 'Energy/AcIn1ToAcOut', component: 'sensor', name: 'AC In 1 to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcIn1ToInverter', component: 'sensor', name: 'AC In 1 to Inverter Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/InverterToAcOut', component: 'sensor', name: 'Inverter to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/InverterToAcIn1', component: 'sensor', name: 'Inverter to AC In 1 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/OutToInverter', component: 'sensor', name: 'AC Out to Inverter Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/AcOutToAcIn1', component: 'sensor', name: 'AC Out to AC In 1 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/SolarToAcIn1', component: 'sensor', name: 'Solar to AC In 1 Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/SolarToAcOut', component: 'sensor', name: 'Solar to AC Out Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Energy/SolarToBattery', component: 'sensor', name: 'Solar to Battery Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  // PV trackers
  { path: 'Yield/Power', component: 'sensor', name: 'PV Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Yield/User', component: 'sensor', name: 'PV Yield User', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Pv/{n}/V', component: 'sensor', name: 'PV Tracker {n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Pv/{n}/P', component: 'sensor', name: 'PV Tracker {n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Pv/{n}/MppOperationMode', component: 'sensor', name: 'Tracker {n} MPPT Mode', deviceClass: 'enum', enumValues: MPPT_OPERATION_MODE_ENUM },
  // ESS controls
  { path: 'Ess/AcPowerSetpoint', component: 'number', name: 'ESS AC Power Setpoint', unit: 'W', deviceClass: 'power', min: -12500, max: 12500, step: 1, precision: 1 },
  { path: 'Ess/DisableCharge', component: 'switch', name: 'Disable Charge', payloadOn: 1, payloadOff: 0 },
  { path: 'Ess/DisableFeedIn', component: 'switch', name: 'Disable Feed-In', payloadOn: 1, payloadOff: 0 },
  { path: 'Ess/InverterPowerSetpoint', component: 'sensor', name: 'ESS Inverter Power Setpoint', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Settings/Ess/MinimumSocLimit', component: 'number', name: 'Minimum SOC Limit', unit: '%', min: 0, max: 100, step: 5, precision: 1 },
  // State & control
  { path: 'State', component: 'sensor', name: 'Inverter State', deviceClass: 'enum', enumValues: VEBUS_STATE_ENUM },
  { path: 'Mode', component: 'select', name: 'Mode', options: VEBUS_MODE_OPTIONS },
  { path: 'Relay/0/State', component: 'switch', name: 'Relay', payloadOn: 1, payloadOff: 0 },
  // Alarms
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Overload', component: 'binary_sensor', name: 'Overload Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowSoc', component: 'binary_sensor', name: 'Low SOC Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Ripple', component: 'binary_sensor', name: 'DC Ripple Alarm', deviceClass: 'problem' },
];

const GRID_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'Grid Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/PowerFactor', component: 'sensor', name: 'Grid Power Factor', deviceClass: 'power_factor', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'Grid L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Voltage', component: 'sensor', name: 'Grid L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Current', component: 'sensor', name: 'Grid L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Energy/Forward', component: 'sensor', name: 'Grid L{n} Import', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/L{n}/Energy/Reverse', component: 'sensor', name: 'Grid L{n} Export', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/L{n}/PowerFactor', component: 'sensor', name: 'Grid L{n} Power Factor', deviceClass: 'power_factor', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'Grid Import', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Energy/Reverse', component: 'sensor', name: 'Grid Export', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Frequency', component: 'sensor', name: 'Grid Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  { path: 'Ac/Current', component: 'sensor', name: 'Grid Total Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Voltage', component: 'sensor', name: 'Grid Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
];

const ACLOAD_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'Load Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Current', component: 'sensor', name: 'Load Total Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Voltage', component: 'sensor', name: 'Load Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'Load L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Voltage', component: 'sensor', name: 'Load L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Current', component: 'sensor', name: 'Load L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Energy/Forward', component: 'sensor', name: 'Load L{n} Consumed', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/L{n}/Energy/Reverse', component: 'sensor', name: 'Load L{n} Returned', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/L{n}/PowerFactor', component: 'sensor', name: 'Load L{n} Power Factor', deviceClass: 'power_factor', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'Load Total Consumed', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Energy/Reverse', component: 'sensor', name: 'Load Total Returned', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Frequency', component: 'sensor', name: 'Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  { path: 'SwitchableOutput/{n}/State', component: 'switch', name: 'Output {n}', payloadOn: 1, payloadOff: 0 },
];

// genset (com.victronenergy.genset) — AC generator meter with engine data
const GENSET_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'Genset Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'Genset L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Voltage', component: 'sensor', name: 'Genset L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Current', component: 'sensor', name: 'Genset L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'Genset Total Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Frequency', component: 'sensor', name: 'Genset Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  { path: 'StatusCode', component: 'sensor', name: 'Genset Status', deviceClass: 'enum', enumValues: GENSET_STATUS_ENUM },
  { path: 'StarterVoltage', component: 'sensor', name: 'Starter Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Engine/Speed', component: 'sensor', name: 'Engine Speed', unit: 'RPM', stateClass: 'measurement', precision: 0 },
  { path: 'Engine/Load', component: 'sensor', name: 'Engine Load', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Engine/OilPressure', component: 'sensor', name: 'Engine Oil Pressure', unit: 'kPa', deviceClass: 'pressure', stateClass: 'measurement', precision: 1 },
  { path: 'Engine/OilTemperature', component: 'sensor', name: 'Engine Oil Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Engine/CoolantTemperature', component: 'sensor', name: 'Engine Coolant Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Engine/ExaustTemperature', component: 'sensor', name: 'Engine Exhaust Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Engine/OperatingHours', component: 'sensor', name: 'Engine Operating Hours', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'Engine/Starts', component: 'sensor', name: 'Engine Starts', stateClass: 'total_increasing', precision: 0 },
  { path: 'RemoteStartModeEnabled', component: 'binary_sensor', name: 'Remote Start Mode Enabled', deviceClass: 'running' },
];

// generator (com.victronenergy.generator) — start/stop control service
const GENERATOR_ENTITIES: EntityDef[] = [
  { path: 'State', component: 'binary_sensor', name: 'Generator Running', deviceClass: 'running' },
  { path: 'AutoStartEnabled', component: 'switch', name: 'Auto Start', payloadOn: 1, payloadOff: 0 },
  { path: 'ManualStart', component: 'switch', name: 'Manual Start', payloadOn: 1, payloadOff: 0 },
  { path: 'AccumulatedRuntime', component: 'sensor', name: 'Accumulated Runtime', unit: 's', deviceClass: 'duration', stateClass: 'total_increasing', precision: 0 },
  { path: 'TodayRuntime', component: 'sensor', name: 'Today Runtime', unit: 's', deviceClass: 'duration', stateClass: 'total_increasing', precision: 0 },
  { path: 'ServiceCounter', component: 'sensor', name: 'Service Counter', unit: 's', deviceClass: 'duration', stateClass: 'total_increasing', precision: 0 },
  { path: 'RunningByConditionCode', component: 'sensor', name: 'Running By Condition', deviceClass: 'enum', enumValues: GENERATOR_RUNNING_BY_CONDITION_ENUM },
];

const PVINVERTER_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'PV Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'PV L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Voltage', component: 'sensor', name: 'PV L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/L{n}/Current', component: 'sensor', name: 'PV L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Energy/Forward', component: 'sensor', name: 'PV L{n} Yield', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'PV Total Yield', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Frequency', component: 'sensor', name: 'AC Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  { path: 'Ac/Current', component: 'sensor', name: 'PV Total Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Voltage', component: 'sensor', name: 'PV Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'StatusCode', component: 'sensor', name: 'Status', deviceClass: 'enum', enumValues: PVINVERTER_STATUS_ENUM },
];

const EVCHARGER_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'Charger Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'Charger L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'Total Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Current', component: 'sensor', name: 'Charging Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Connected', component: 'binary_sensor', name: 'EV Connected', deviceClass: 'plug' },
  { path: 'Status', component: 'sensor', name: 'Status', deviceClass: 'enum', enumValues: EVCHARGER_STATUS_ENUM },
  { path: 'Mode', component: 'select', name: 'Charging Mode', options: EVCHARGER_MODE_OPTIONS },
  { path: 'Position', component: 'sensor', name: 'Position', deviceClass: 'enum', enumValues: EVCHARGER_POSITION_ENUM },
  { path: 'SetCurrent', component: 'number', name: 'Set Current', unit: 'A', deviceClass: 'current', min: 6, max: 32, step: 1, precision: 1 },
  { path: 'StartStop', component: 'switch', name: 'Start / Stop', payloadOn: 1, payloadOff: 0 },
  { path: 'AutoStart', component: 'switch', name: 'Auto Start', payloadOn: 1, payloadOff: 0 },
  { path: 'ChargingTime', component: 'sensor', name: 'Charging Time', unit: 's', deviceClass: 'duration' },
  { path: 'Session/Energy', component: 'sensor', name: 'Session Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Session/Time', component: 'sensor', name: 'Session Time', unit: 's', deviceClass: 'duration', precision: 0 },
  { path: 'MaxCurrent', component: 'sensor', name: 'Max Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'MinCurrent', component: 'sensor', name: 'Min Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
];

const TEMPERATURE_ENTITIES: EntityDef[] = [
  { path: 'Temperature', component: 'sensor', name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Status', component: 'sensor', name: 'Sensor Status', deviceClass: 'enum', enumValues: TEMPERATURE_STATUS_ENUM },
  { path: 'TemperatureType', component: 'sensor', name: 'Sensor Type', deviceClass: 'enum', enumValues: TEMPERATURE_TYPE_ENUM },
  { path: 'BatteryVoltage', component: 'sensor', name: 'Sensor Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Humidity', component: 'sensor', name: 'Humidity', unit: '%', deviceClass: 'humidity', stateClass: 'measurement', precision: 1 },
  { path: 'Pressure', component: 'sensor', name: 'Air Pressure', unit: 'hPa', deviceClass: 'atmospheric_pressure', stateClass: 'measurement', precision: 1 },
  { path: 'Offset', component: 'number', name: 'Temperature Offset', unit: '°C', step: 1, min: -100.0, max: 100.0, precision: 1},
  { path: 'Scale', component: 'number', name: 'Temperature Scale', step: 0.1, min: 0.1, max: 10.0, precision: 2 },
];

const TANK_ENTITIES: EntityDef[] = [
  { path: 'Level', component: 'sensor', name: 'Tank Level', unit: '%', stateClass: 'measurement', precision: 1 },
  { path: 'Remaining', component: 'sensor', name: 'Tank Remaining', unit: 'm³', deviceClass: 'volume', stateClass: 'measurement', precision: 1 },
  { path: 'Capacity', component: 'sensor', name: 'Tank Capacity', unit: 'm³' },
  { path: 'BatteryVoltage', component: 'sensor', name: 'Sensor Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Temperature', component: 'sensor', name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'FluidType', component: 'sensor', name: 'Fluid Type', deviceClass: 'enum', enumValues: TANK_FLUID_TYPE_ENUM },
  { path: 'Status', component: 'sensor', name: 'Sensor Status', deviceClass: 'enum', enumValues: TANK_STATUS_ENUM },
];

const INVERTER_ENTITIES: EntityDef[] = [
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Pv/V', component: 'sensor', name: 'PV Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Yield/Power', component: 'sensor', name: 'Yield Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Yield/User', component: 'sensor', name: 'Yield User', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Yield/System', component: 'sensor', name: 'Yield System', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/Out/L{n}/V', component: 'sensor', name: 'AC Output L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Out/L{n}/I', component: 'sensor', name: 'AC Output L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/L{n}/P', component: 'sensor', name: 'AC Output L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Out/L{n}/S', component: 'sensor', name: 'AC Output L{n} Apparent Power', unit: 'VA', deviceClass: 'apparent_power', stateClass: 'measurement', precision: 1 },
  { path: 'State', component: 'sensor', name: 'Inverter State', deviceClass: 'enum', enumValues: INVERTER_STATE_ENUM },
  { path: 'Mode', component: 'select', name: 'Mode', options: INVERTER_MODE_OPTIONS },
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowTemperature', component: 'binary_sensor', name: 'Low Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Overload', component: 'binary_sensor', name: 'Overload Alarm', deviceClass: 'problem' },
  { path: 'Alarms/Ripple', component: 'binary_sensor', name: 'DC Ripple Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowVoltageAcOut', component: 'binary_sensor', name: 'Low AC Out Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltageAcOut', component: 'binary_sensor', name: 'High AC Out Voltage Alarm', deviceClass: 'problem' },
];

const CHARGER_ENTITIES: EntityDef[] = [
  { path: 'Ac/In/L{n}/I', component: 'sensor', name: 'AC Input L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/In/L{n}/P', component: 'sensor', name: 'AC Input L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/{n}/Voltage', component: 'sensor', name: 'DC {n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/{n}/Current', component: 'sensor', name: 'DC {n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/{n}/Temperature', component: 'sensor', name: 'DC {n} Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'State', component: 'sensor', name: 'Charger State', deviceClass: 'enum', enumValues: CHARGER_STATE_ENUM },
  { path: 'Mode', component: 'select', name: 'Mode', options: CHARGER_MODE_OPTIONS },
  { path: 'ErrorCode', component: 'sensor', name: 'Error Code', deviceClass: 'enum', enumValues: MPPT_ERROR_ENUM },
  { path: 'Relay/0/State', component: 'switch', name: 'Relay', payloadOn: 1, payloadOff: 0 },
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
];

// Shared DC source measurements (alternator, dcsystem)
const DC_SOURCE_ENTITIES: EntityDef[] = [
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/1/Voltage', component: 'sensor', name: 'Secondary Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'History/EnergyOut', component: 'sensor', name: 'Total Energy Out', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowTemperature', component: 'binary_sensor', name: 'Low Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowStarterVoltage', component: 'binary_sensor', name: 'Low Secondary Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighStarterVoltage', component: 'binary_sensor', name: 'High Secondary Voltage Alarm', deviceClass: 'problem' },
];

const ALTERNATOR_ENTITIES: EntityDef[] = [
  ...DC_SOURCE_ENTITIES,
  { path: 'Dc/In/V', component: 'sensor', name: 'Input Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/In/I', component: 'sensor', name: 'Input Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/In/P', component: 'sensor', name: 'Input Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Mode', component: 'switch', name: 'Charger On/Off', payloadOn: 1, payloadOff: 4 },
  { path: 'Settings/ChargeCurrentLimit', component: 'number', name: 'Charge Current Limit', unit: 'A', deviceClass: 'current', min: 0, max: 200, step: 1, precision: 1 },
  { path: 'State', component: 'sensor', name: 'Charger State', deviceClass: 'enum', enumValues: MPPT_STATE_ENUM },
  { path: 'ErrorCode', component: 'sensor', name: 'Error Code', deviceClass: 'enum', enumValues: MPPT_ERROR_ENUM },
];

const DCDC_ENTITIES: EntityDef[] = [
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Output Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'Output Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'Output Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/In/V', component: 'sensor', name: 'Input Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/In/I', component: 'sensor', name: 'Input Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/In/P', component: 'sensor', name: 'Input Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Mode', component: 'switch', name: 'On/Off', payloadOn: 1, payloadOff: 4 },
  { path: 'State', component: 'sensor', name: 'State', deviceClass: 'enum', enumValues: MPPT_STATE_ENUM },
];

const DCSYSTEM_ENTITIES: EntityDef[] = [
  ...DC_SOURCE_ENTITIES,
  { path: 'History/EnergyIn', component: 'sensor', name: 'Total Energy In', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
];

const DCLOAD_ENTITIES: EntityDef[] = [
  { path: 'Dc/0/Voltage', component: 'sensor', name: 'Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Dc/0/Current', component: 'sensor', name: 'Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Power', component: 'sensor', name: 'Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/0/Temperature', component: 'sensor', name: 'Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'Dc/1/Voltage', component: 'sensor', name: 'Secondary Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'History/EnergyIn', component: 'sensor', name: 'Total Energy Consumed', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Alarms/LowVoltage', component: 'binary_sensor', name: 'Low Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighVoltage', component: 'binary_sensor', name: 'High Voltage Alarm', deviceClass: 'problem' },
  { path: 'Alarms/LowTemperature', component: 'binary_sensor', name: 'Low Temperature Alarm', deviceClass: 'problem' },
  { path: 'Alarms/HighTemperature', component: 'binary_sensor', name: 'High Temperature Alarm', deviceClass: 'problem' },
];

const DIGITALINPUT_ENTITIES: EntityDef[] = [
  { path: 'State', component: 'sensor', name: 'State' },
  { path: 'InputState', component: 'binary_sensor', name: 'Input State' },
  { path: 'Alarm', component: 'binary_sensor', name: 'Alarm', deviceClass: 'problem' },
  { path: 'Type', component: 'sensor', name: 'Input Type' },
];

// heatpump — same AC measurement structure as acload
const HEATPUMP_ENTITIES: EntityDef[] = [
  { path: 'Ac/Power', component: 'sensor', name: 'Heat Pump Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Current', component: 'sensor', name: 'Heat Pump Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/Voltage', component: 'sensor', name: 'Heat Pump Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Frequency', component: 'sensor', name: 'Heat Pump Frequency', unit: 'Hz', deviceClass: 'frequency', stateClass: 'measurement', precision: 2 },
  { path: 'Ac/L{n}/Power', component: 'sensor', name: 'Heat Pump L{n} Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Current', component: 'sensor', name: 'Heat Pump L{n} Current', unit: 'A', deviceClass: 'current', stateClass: 'measurement', precision: 1 },
  { path: 'Ac/L{n}/Voltage', component: 'sensor', name: 'Heat Pump L{n} Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Ac/Energy/Forward', component: 'sensor', name: 'Heat Pump Total Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'Ac/L{n}/Energy/Forward', component: 'sensor', name: 'Heat Pump L{n} Energy', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
];

const HUB4_ENTITIES: EntityDef[] = [
  { path: 'Overrides/ForceCharge', component: 'switch', name: 'Force Charge', payloadOn: 1, payloadOff: 0 },
  { path: 'Overrides/Setpoint', component: 'number', name: 'AC Power Setpoint', unit: 'W', deviceClass: 'power', min: -32767, max: 32767, step: 1, precision: 1 },
];

const GPS_ENTITIES: EntityDef[] = [
  { path: 'Position/Latitude', component: 'sensor', name: 'Latitude', stateClass: 'measurement' },
  { path: 'Position/Longitude', component: 'sensor', name: 'Longitude', stateClass: 'measurement' },
  { path: 'Speed', component: 'sensor', name: 'Speed', unit: 'm/s', deviceClass: 'speed', stateClass: 'measurement', precision: 2 },
  { path: 'Course', component: 'sensor', name: 'Course', unit: '°', stateClass: 'measurement', precision: 2 },
  { path: 'Altitude', component: 'sensor', name: 'Altitude', unit: 'm', deviceClass: 'distance', stateClass: 'measurement', precision: 2 },
  { path: 'Fix', component: 'binary_sensor', name: 'GPS Fix', deviceClass: 'running' },
  { path: 'Connected', component: 'binary_sensor', name: 'Connected', deviceClass: 'connectivity' },
  { path: 'NrOfSatellites', component: 'sensor', name: 'Satellites', stateClass: 'measurement' },
];

const METEO_ENTITIES: EntityDef[] = [
  { path: 'Irradiance', component: 'sensor', name: 'Solar Irradiance', unit: 'W/m²', deviceClass: 'irradiance', stateClass: 'measurement', precision: 1 },
  { path: 'ExternalTemperature', component: 'sensor', name: 'External Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'CellTemperature', component: 'sensor', name: 'Panel Temperature', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', precision: 1 },
  { path: 'WindSpeed', component: 'sensor', name: 'Wind Speed', unit: 'm/s', deviceClass: 'wind_speed', stateClass: 'measurement', precision: 2 },
  { path: 'WindDirection', component: 'sensor', name: 'Wind Direction', unit: '°', stateClass: 'measurement', precision: 2 },
  { path: 'InstallationPower', component: 'sensor', name: 'Installation Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1 },
  { path: 'TodaysYield', component: 'sensor', name: "Today's Yield", unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', precision: 1 },
  { path: 'TimeSinceLastSun', component: 'sensor', name: 'Time Since Last Sun', unit: 's', deviceClass: 'duration' },
  { path: 'BatteryVoltage', component: 'sensor', name: 'Sensor Battery Voltage', unit: 'V', deviceClass: 'voltage', stateClass: 'measurement', precision: 3 },
  { path: 'Alarms/LowBattery', component: 'binary_sensor', name: 'Sensor Low Battery', deviceClass: 'battery' },
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

// ── Custom aggregates registry ────────────────────────────────────────────────

const CUSTOM_AGGREGATES: CustomAggregateEntityDef[] = [
  { path: 'Ac/Consumption/Power', name: 'AC Consumption Aggregate Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1, aggregateFrom: ['Ac/Consumption/L{n}/Power'], forward: true },
  { path: 'Ac/Grid/Power', name: 'Grid Aggregate Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1, aggregateFrom: ['Ac/Grid/L{n}/Power'], forward: true },
  { path: 'Ac/Genset/Power', name: 'Generator Aggregate Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1, aggregateFrom: ['Ac/Genset/L{n}/Power'], forward: true },
  { path: 'Pv/Power', name: 'PV Aggregate Power', unit: 'W', deviceClass: 'power', stateClass: 'measurement', precision: 1, aggregateFrom: ['Dc/Pv/Power', 'Ac/PvOnOutput/L{n}/Power', 'Ac/PvOnGrid/L{n}/Power'], forward: true },
];

export const CUSTOM_ENTITY_DEFS = {
  aggregate: CUSTOM_AGGREGATES,
} as const;

// ── Service → entity lookup ───────────────────────────────────────────────────

// DO NOT DELETE COMMENTED ENTITY DEFS unless explicitly asked by the user!
export const SERVICE_ENTITY_DEFS: Partial<Record<VrmServiceName, EntityDef[]>> = {
  system: SYSTEM_ENTITIES,
  battery: BATTERY_ENTITIES,
  solarcharger: SOLARCHARGER_ENTITIES,
  vebus: VEBUS_ENTITIES,
  multi: MULTI_ENTITIES,
  grid: GRID_ENTITIES,
  acload: ACLOAD_ENTITIES,
  genset: GENSET_ENTITIES,
  generator: GENERATOR_ENTITIES,
  pvinverter: PVINVERTER_ENTITIES,
  evcharger: EVCHARGER_ENTITIES,
  temperature: TEMPERATURE_ENTITIES,
  tank: TANK_ENTITIES,
  inverter: INVERTER_ENTITIES,
  charger: CHARGER_ENTITIES,
  alternator: ALTERNATOR_ENTITIES,
  dcdc: DCDC_ENTITIES,
  dcsystem: DCSYSTEM_ENTITIES,
  dcload: DCLOAD_ENTITIES,
  digitalinput: DIGITALINPUT_ENTITIES,
  heatpump: HEATPUMP_ENTITIES,
  hub4: HUB4_ENTITIES,
  gps: GPS_ENTITIES,
  meteo: METEO_ENTITIES,
  platform: PLATFORM_ENTITIES,
};