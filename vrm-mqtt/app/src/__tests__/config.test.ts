import { jest } from '@jest/globals';

const ORIGINAL_ENV = process.env;

function reloadConfig(): typeof import('../config') {
  jest.resetModules();
  // `require` is intentional here — jest.resetModules() requires a fresh
  // module load via the CJS require path, not a static ESM import (which is
  // hoisted and cached).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../config');
}

describe('loadConfig', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws ConfigurationError when VRM_API_TOKEN is missing', () => {
    delete process.env.VRM_API_TOKEN;
    const { loadConfig } = reloadConfig();
    expect(() => loadConfig()).toThrow(/VRM_API_TOKEN/);
  });

  it('returns defaults when only required vars are set', () => {
    process.env = { VRM_API_TOKEN: 'tok' };
    const { loadConfig } = reloadConfig();
    const cfg = loadConfig();
    expect(cfg.vrm.apiToken).toBe('tok');
    expect(cfg.vrm.baseUrl).toBe('https://vrmapi.victronenergy.com/v2');
    expect(cfg.vrm.pollIntervalMs).toBe(300_000);
    expect(cfg.vrm.disabledInstallationIds).toEqual([]);
    expect(cfg.vrm.installationStartupDelayMs).toBe(500);
    expect(cfg.mqtt.host).toBe('addon_core_mosquitto');
    expect(cfg.mqtt.port).toBe(1883);
    expect(cfg.throttle.intervalMs).toBe(500);
  });

  it('parses integer env vars', () => {
    process.env = {
      ...ORIGINAL_ENV,
      VRM_API_TOKEN: 'tok',
      VRM_POLL_INTERVAL_MS: '60000',
      HA_MQTT_PORT: '1884',
      VRM_INSTALLATION_STARTUP_DELAY_MS: '1000',
      VRM_THROTTLE_INTERVAL_MS: '0',
    };
    const { loadConfig } = reloadConfig();
    const cfg = loadConfig();
    expect(cfg.vrm.pollIntervalMs).toBe(60_000);
    expect(cfg.mqtt.port).toBe(1884);
    expect(cfg.vrm.installationStartupDelayMs).toBe(1000);
    expect(cfg.throttle.intervalMs).toBe(0);
  });

  it('throws on non-integer VRM_POLL_INTERVAL_MS', () => {
    process.env = { ...ORIGINAL_ENV, VRM_API_TOKEN: 'tok', VRM_POLL_INTERVAL_MS: 'fast' };
    const { loadConfig } = reloadConfig();
    expect(() => loadConfig()).toThrow(/VRM_POLL_INTERVAL_MS.*integer/);
  });

  it('parses comma-separated VRM_DISABLED_INSTALLATION_IDS', () => {
    process.env = {
      ...ORIGINAL_ENV,
      VRM_API_TOKEN: 'tok',
      VRM_DISABLED_INSTALLATION_IDS: '123, 456 ,789',
    };
    const { loadConfig } = reloadConfig();
    const cfg = loadConfig();
    expect(cfg.vrm.disabledInstallationIds).toEqual(['123', '456', '789']);
  });

  it('treats empty VRM_DISABLED_INSTALLATION_IDS as []', () => {
    process.env = { ...ORIGINAL_ENV, VRM_API_TOKEN: 'tok', VRM_DISABLED_INSTALLATION_IDS: '' };
    const { loadConfig } = reloadConfig();
    expect(loadConfig().vrm.disabledInstallationIds).toEqual([]);
  });

  it('treats empty HA_MQTT_USERNAME/PASSWORD as empty strings', () => {
    process.env = { ...ORIGINAL_ENV, VRM_API_TOKEN: 'tok', HA_MQTT_USERNAME: '', HA_MQTT_PASSWORD: '' };
    const { loadConfig } = reloadConfig();
    const cfg = loadConfig();
    expect(cfg.mqtt.username).toBe('');
    expect(cfg.mqtt.password).toBe('');
  });
});
