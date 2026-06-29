import { buildDiscoveryConfigs, matchTemplateIndices } from '../DiscoveryConfigBuilder';
import type { DeviceMeta, HaSelectConfig, HaNumberConfig } from '../types';

const ID_SITE = 12345;
const v = (suffix: string) => `vrm_${ID_SITE}_${suffix}`;
const META: DeviceMeta = { productName: 'SmartShunt 500A', firmwareVersion: 'v4.12' };

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
  describe('returns empty array for unknown services', () => {
    it('platform has no entity defs', () => {
      expect(buildDiscoveryConfigs(ID_SITE, 'platform', 0, META, [])).toEqual([]);
    });
  });

  describe('device object', () => {
    it('omits via_device for system service', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Battery/Soc']);
      const config = configs.find(c => c.unique_id.includes('soc'));
      expect(config?.device.via_device).toBeUndefined();
    });

    it('uses the portal-level identifier for system service', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Battery/Soc']);
      expect(configs[0].device.identifiers).toEqual([v('system')]);
    });
  });

  describe('index never observed', () => {
    it('emits nothing when the index never appears in observed paths', () => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'charger', 30, META, ['Dc/0/Current']);
      expect(configs.find(c => c.unique_id.includes('dc_0_voltage'))).toBeUndefined();
    });
  });

  // ── select ────────────────────────────────────────────────────────────────

  describe('select (vebus/Mode)', () => {
    let config: HaSelectConfig;

    beforeEach(() => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'vebus', 256, META, ['Mode']);
      config = configs.find(c =>
        c.unique_id === v('vebus_256_mode'),
      ) as HaSelectConfig;
    });

    it('produces a select config', () => {
      expect(config.component).toBe('select');
    });

    it('options are the human-readable labels', () => {
      expect(config.options).toEqual(['Charger Only', 'Inverter Only', 'On', 'Off']);
    });

    it('value_template maps numeric VRM values to option labels', () => {
      expect(config.value_template).toContain("1: 'Charger Only'");
      expect(config.value_template).toContain("3: 'On'");
    });

    it('sets command_topic as state_topic + /set', () => {
      expect(config.command_topic).toBe(`${config.state_topic}/set`);
    });
  });

  // ── number ────────────────────────────────────────────────────────────────

  describe('number (vebus/Ac/In/1/CurrentLimit)', () => {
    let config: HaNumberConfig;

    beforeEach(() => {
      const configs = buildDiscoveryConfigs(ID_SITE, 'vebus', 256, META, [
        'Ac/In/1/CurrentLimit',
      ]);
      config = configs.find(c =>
        c.unique_id === v('vebus_256_ac_in_1_currentlimit'),
      ) as HaNumberConfig;
    });

    it('produces a number config', () => {
      expect(config.component).toBe('number');
    });

    it('carries min, max, step, unit, and device_class', () => {
      expect(config.min).toBe(0);
      expect(config.max).toBe(100);
      expect(config.step).toBe(0.1);
      expect(config.unit_of_measurement).toBe('A');
      expect(config.device_class).toBe('current');
    });

    it('sets command_topic as state_topic + /set', () => {
      expect(config.command_topic).toBe(`${config.state_topic}/set`);
    });
  });
});

// ── defensive value_templates (VRM may publish empty / non-JSON payloads) ────

describe('value_template defensiveness', () => {
  it('sensor (numeric) value_template defaults to "Unknown" when value_json is undefined', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Dc/Battery/Voltage']);
    const config = configs.find(c => c.component === 'sensor');
    // Jinja's `default()` filter is applied to the result of `value_json.value`;
    // when value_json itself is undefined, accessing `.value` raises UndefinedError
    // before default() runs. An explicit `is defined` guard is required.
    expect(config?.value_template).toBe(
      "{% if value_json is defined %}{{ value_json.value | default('Unknown') }}{% else %}Unknown{% endif %}",
    );
  });

  it('enum sensor value_template guards against missing value_json', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Ac/ActiveIn/Source']);
    const config = configs.find(c => c.component === 'sensor');
    expect(config?.value_template).toContain("{% if value_json is defined %}");
    expect(config?.value_template).toContain("{% else %}Unknown{% endif %}");
  });

  it('select value_template guards against missing value_json', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'vebus', 256, META, ['Mode']);
    const config = configs.find(c => c.component === 'select');
    expect(config?.value_template).toContain("{% if value_json is defined %}");
    expect(config?.value_template).toContain("{% else %}Unknown{% endif %}");
  });

  it('binary_sensor value_template defaults to "OFF" when value_json is undefined', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['DynamicEss/Active']);
    const config = configs.find(c => c.component === 'binary_sensor');
    expect(config?.value_template).toBe(
      "{% if value_json is defined and value_json.value | int > 0 %}ON{% else %}OFF{% endif %}",
    );
  });

  it('switch value_template defaults to "0" when value_json is undefined', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'system', 0, META, ['Relay/0/State']);
    const config = configs.find(c => c.component === 'switch');
    expect(config?.value_template).toBe(
      "{% if value_json is defined %}{{ value_json.value | int }}{% else %}0{% endif %}",
    );
  });

  it('number value_template defaults to "0" when value_json is undefined', () => {
    const configs = buildDiscoveryConfigs(ID_SITE, 'vebus', 256, META, ['Ac/In/1/CurrentLimit']);
    const config = configs.find(c => c.component === 'number');
    expect(config?.value_template).toBe(
      "{% if value_json is defined %}{{ value_json.value }}{% else %}0{% endif %}",
    );
  });
});