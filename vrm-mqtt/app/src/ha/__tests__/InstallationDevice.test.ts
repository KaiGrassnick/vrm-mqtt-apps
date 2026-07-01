import { buildInstallationDiscovery } from '../InstallationDevice';

const ID_SITE = 12345;
const NAME = 'Beach House';
const APP_VERSION = '1.2.3';
const SYSTEM_PLATFORM_ONLY = new Map([
  ['system', new Set(['0'])],
  ['platform', new Set(['0'])],
]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;

describe('buildInstallationDiscovery', () => {
  it('builds the device block keyed by the portal-level identifier', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(payload.device).toEqual({
      identifiers: [`vrm_${ID_SITE}`],
      name: NAME,
      manufacturer: 'Victron Energy',
      model: 'Victron Energy System',
    });
  });

  it('builds the origin block from the app version', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(payload.origin).toEqual({ name: 'vrm-mqtt', sw_version: APP_VERSION });
  });

  it('sets availability_topic to vrm/{idSite}/availability', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(payload.availability_topic).toBe(`vrm/${ID_SITE}/availability`);
  });

  it('produces a non-empty components map', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(Object.keys(payload.components).length).toBeGreaterThan(0);
  });

  it('keys each component by its unique_id with the vrm_{idSite}_ prefix stripped', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    const socKey = `system_0_dc_battery_soc`;
    expect(payload.components[socKey]).toBeDefined();
    expect(payload.components[socKey].unique_id).toBe(`vrm_${ID_SITE}_${socKey}`);
  });

  it('renames component to platform on every entry', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    for (const component of Object.values(payload.components)) {
      expect(component.platform).toBeDefined();
      expect((component as unknown as Record<string, unknown>).component).toBeUndefined();
    }
  });

  it('does not carry a per-component device field — device grouping lives once at the payload level', () => {
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    for (const component of Object.values(payload.components)) {
      expect((component as unknown as Record<string, unknown>).device).toBeUndefined();
    }
  });

  it('produces a different device identifier for a different idSite', () => {
    const a = buildInstallationDiscovery(1, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    const b = buildInstallationDiscovery(2, NAME, APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(a.device.identifiers).toEqual(['vrm_1']);
    expect(b.device.identifiers).toEqual(['vrm_2']);
  });

  it('uses installationName for the device name, independent of idSite', () => {
    const payload = buildInstallationDiscovery(ID_SITE, 'My Custom Name', APP_VERSION, SYSTEM_PLATFORM_ONLY);
    expect(payload.device.name).toBe('My Custom Name');
  });

  it('merges configs from every service present in observedInstances, not just system', () => {
    const withVebus = new Map([
      ['system', new Set(['0'])],
      ['platform', new Set(['0'])],
      ['vebus', new Set(['0'])],
    ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
    // vebus has zero forward:true entities today, so this must not add any
    // components, but must not throw or drop the system components either.
    const payload = buildInstallationDiscovery(ID_SITE, NAME, APP_VERSION, withVebus);
    const socKey = `system_0_dc_battery_soc`;
    expect(payload.components[socKey]).toBeDefined();
  });
});
