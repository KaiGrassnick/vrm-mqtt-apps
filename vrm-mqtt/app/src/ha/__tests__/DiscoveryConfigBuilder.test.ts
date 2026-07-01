import { buildDiscoveryConfigs, matchTemplateIndices } from '../DiscoveryConfigBuilder';
import { CUSTOM_ENTITY_DEFS } from '../entityDefs';
import type { HaSensorConfig } from '../types';

const ID_SITE = 12345;
const v = (suffix: string): string => `vrm_${ID_SITE}_${suffix}`;

// ── matchTemplateIndices ─────────────────────────────────────────────────────

describe('matchTemplateIndices', () => {
  it('extracts indices from numeric segment placeholders', () => {
    const result = matchTemplateIndices('Dc/{n}/Voltage', [
      'Dc/0/Voltage',
      'Dc/1/Voltage',
      'Dc/0/Current', // different path — should not match
    ]);
    expect(result).toEqual(['0', '1']);
  });

  it('extracts indices from infix placeholders (L{n})', () => {
    const result = matchTemplateIndices('Ac/L{n}/Power', [
      'Ac/L1/Power',
      'Ac/L2/Power',
      'Ac/L3/Power',
    ]);
    expect(result).toEqual(['1', '2', '3']);
  });

  it('returns results sorted numerically, not lexicographically', () => {
    const result = matchTemplateIndices('Relay/{n}/State', [
      'Relay/10/State',
      'Relay/2/State',
      'Relay/1/State',
    ]);
    expect(result).toEqual(['1', '2', '10']);
  });

  it('deduplicates the same index seen multiple times', () => {
    const result = matchTemplateIndices('Pv/{n}/V', ['Pv/0/V', 'Pv/0/V', 'Pv/1/V']);
    expect(result).toEqual(['0', '1']);
  });

  it('returns empty array when no paths match', () => {
    expect(matchTemplateIndices('Dc/{n}/Voltage', ['Soc', 'TimeToGo'])).toEqual([]);
  });

  it('does not partially match longer paths', () => {
    // Dc/0/Voltage/Extra should not match Dc/{n}/Voltage
    const result = matchTemplateIndices('Dc/{n}/Voltage', ['Dc/0/Voltage/Extra', 'Dc/0/Voltage']);
    expect(result).toEqual(['0']);
  });
});

// ── buildDiscoveryConfigs — common shape ─────────────────────────────────────

describe('buildDiscoveryConfigs', () => {
  describe('service with entity defs but no forward: true entities', () => {
    it('platform yields no configs (none of its entities are forward: true)', () => {
      expect(buildDiscoveryConfigs(ID_SITE, 'platform', 0, [])).toEqual([]);
    });
  });

  describe('index never observed', () => {
    it('emits nothing when the index never appears in observed paths (charger is now a wired-in service with zero forward: true entities, same reasoning as platform above)', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'charger', 30, ['Dc/0/Current']);
      expect(configs.find(c => c.unique_id.includes('dc_0_voltage'))).toBeUndefined();
    });
  });
});

// ── defensive value_templates (VRM may publish empty / non-JSON payloads) ────
//
// Only `forward: true` entities emit configs, so the defensive value_template
// format is asserted here against one of the forward-true sensors. The
// binary_sensor / switch / select / number / enum templates use the same
// `is defined` guard pattern and remain in place — the underlying switch in
// entityToConfig is unchanged.

describe('value_template defensiveness', () => {
  it('sensor (numeric) value_template defaults to "Unknown" when value_json is undefined', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, ['Dc/Battery/Voltage']);
    const config = configs.find(c => c.component === 'sensor');
    // Jinja's `default()` filter is applied to the result of `value_json.value`;
    // when value_json itself is undefined, accessing `.value` raises UndefinedError
    // before default() runs. An explicit `is defined` guard is required.
    expect(config?.value_template).toBe(
      "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
    );
  });
});

// ── aggregate sensors (custom/aggregate/*) ───────────────────────────────────

describe('aggregate sensors', () => {
  describe('Ac/Grid/Power', () => {
    it('emits a sensor when at least one L-phase grid power path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Grid/L1/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_grid_power'));
      expect(agg).toBeDefined();
    });

    it('points state_topic at the custom/aggregate topic', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Grid/L1/Power',
        'Ac/Grid/L2/Power',
        'Ac/Grid/L3/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_grid_power'));
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/custom/aggregate/Ac/Grid/Power`);
    });

    it('inherits the source unit, device_class, and state_class', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Grid/L1/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_grid_power')) as HaSensorConfig;
      expect(agg?.unit_of_measurement).toBe('W');
      expect(agg?.device_class).toBe('power');
      expect(agg?.state_class).toBe('measurement');
    });

    it('omits the aggregate when no L-phase grid power path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Dc/Pv/Power',
        'Dc/Battery/Soc',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_grid_power'));
      expect(agg).toBeUndefined();
    });

    it('uses the standard numeric value_template (bridge publishes the sum)', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Grid/L1/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_grid_power'));
      expect(agg?.value_template).toBe(
        "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
      );
    });
  });

  describe('Ac/Consumption/Power', () => {
    it('emits a sensor when at least one L-phase consumption path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Consumption/L1/Power',
        'Ac/Consumption/L2/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_consumption_power'));
      expect(agg).toBeDefined();
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/custom/aggregate/Ac/Consumption/Power`);
    });
  });

  describe('Ac/Genset/Power', () => {
    it('emits a sensor when at least one L-phase genset path is observed', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
        'Ac/Genset/L3/Power',
      ], CUSTOM_ENTITY_DEFS.aggregate);
      const agg = configs.find(c => c.unique_id === v('custom_aggregate_ac_genset_power'));
      expect(agg).toBeDefined();
      expect(agg?.state_topic).toBe(`vrm/${ID_SITE}/custom/aggregate/Ac/Genset/Power`);
    });
  });

  it('non-aggregate entity defs (no aggregateFrom) are unaffected by the aggregate branch', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, ['Dc/Battery/Soc'], CUSTOM_ENTITY_DEFS.aggregate);
    const soc = configs.find(c => c.unique_id === v('system_0_dc_battery_soc'));
    expect(soc).toBeDefined();
    expect(soc?.state_topic).toBe(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });
});

// ── forward flag ─────────────────────────────────────────────────────────────

describe('forward flag', () => {
  it('emits forward: true normal entities when their path is observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, ['Dc/Battery/Soc'], CUSTOM_ENTITY_DEFS.aggregate);
    const soc = configs.find(c => c.unique_id === v('system_0_dc_battery_soc'));
    expect(soc).toBeDefined();
  });

  it('omits normal entities without forward: true even when observed', () => {
    // Dc/Pv/Power is no longer forward: true.
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, ['Dc/Pv/Power'], CUSTOM_ENTITY_DEFS.aggregate);
    const dcPv = configs.find(c => c.unique_id === v('system_0_dc_pv_power'));
    expect(dcPv).toBeUndefined();
  });

  it('omits per-phase L{n} entities (no forward: true) even when observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
      'Ac/Grid/L1/Power',
      'Ac/Grid/L2/Power',
      'Ac/Grid/L3/Power',
    ], CUSTOM_ENTITY_DEFS.aggregate);
    // No individual L{n}/Power configs — only the aggregate.
    const lphase = configs.find(c => c.unique_id === v('system_0_ac_grid_l1_power'));
    expect(lphase).toBeUndefined();
    const lphase2 = configs.find(c => c.unique_id === v('system_0_ac_grid_l2_power'));
    expect(lphase2).toBeUndefined();
    const lphase3 = configs.find(c => c.unique_id === v('system_0_ac_grid_l3_power'));
    expect(lphase3).toBeUndefined();
  });

  it('emits Pv/Power when both DC and AC PV sources are observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
      'Dc/Pv/Power',
      'Ac/PvOnOutput/L1/Power',
      'Ac/PvOnGrid/L1/Power',
    ], CUSTOM_ENTITY_DEFS.aggregate);
    const pv = configs.find(c => c.unique_id === v('custom_aggregate_pv_power'));
    expect(pv).toBeDefined();
    expect(pv?.state_topic).toBe(`vrm/${ID_SITE}/custom/aggregate/Pv/Power`);
  });

  it('emits Pv/Power even when only one AC PV source is observed', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
      'Dc/Pv/Power',
      'Ac/PvOnOutput/L1/Power',
    ], CUSTOM_ENTITY_DEFS.aggregate);
    const pv = configs.find(c => c.unique_id === v('custom_aggregate_pv_power'));
    expect(pv).toBeDefined();
  });

  it('emits exactly the expected entities (3 battery + 4 custom aggregates)', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, [
      'Dc/Battery/Soc',
      'Dc/Battery/Voltage',
      'Dc/Battery/State',
      'Dc/Pv/Power',
      'Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power',
      'Ac/Consumption/L1/Power',
      'Ac/Genset/L1/Power',
      'Ac/PvOnOutput/L1/Power',
      'Ac/PvOnGrid/L1/Power',
    ], CUSTOM_ENTITY_DEFS.aggregate);
    const uniqueIds = configs.map(c => c.unique_id).sort();
    expect(uniqueIds).toEqual([
      v('custom_aggregate_ac_consumption_power'),
      v('custom_aggregate_ac_genset_power'),
      v('custom_aggregate_ac_grid_power'),
      v('custom_aggregate_pv_power'),
      v('system_0_dc_battery_soc'),
      v('system_0_dc_battery_state'),
      v('system_0_dc_battery_voltage'),
    ].sort());
  });
});