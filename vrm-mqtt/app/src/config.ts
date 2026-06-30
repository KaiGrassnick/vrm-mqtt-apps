import 'dotenv/config';
import { ConfigurationError } from './errors';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new ConfigurationError(
      `Environment variable ${name} must be an integer, got: ${raw}`,
    );
  }
  return parsed;
}

function optionalEnvStringList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface AppConfig {
  vrm: {
    apiToken: string;
    baseUrl: string;
    pollIntervalMs: number;
    disabledInstallationIds: string[];
    /** Delay between starting each installation's VRM MQTT connection on startup/reconcile, in ms. */
    installationStartupDelayMs: number;
    /** Per-installation staleness timeout in ms. 0 = disable. Default 300_000. */
    offlineTimeoutMs: number;
  };
  mqtt: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
  throttle: {
    /** Flush interval in ms. 0 = bypass (publish every message directly). */
    intervalMs: number;
  };
}

export function loadConfig(): AppConfig {
  return {
    vrm: {
      apiToken: requireEnv('VRM_API_TOKEN'),
      baseUrl: optionalEnv('VRM_API_BASE_URL', 'https://vrmapi.victronenergy.com/v2'),
      pollIntervalMs: optionalEnvInt('VRM_POLL_INTERVAL_MS', 300_000),
      disabledInstallationIds: optionalEnvStringList('VRM_DISABLED_INSTALLATION_IDS'),
      installationStartupDelayMs: optionalEnvInt('VRM_INSTALLATION_STARTUP_DELAY_MS', 500),
      offlineTimeoutMs: optionalEnvInt('VRM_OFFLINE_TIMEOUT_MS', 300_000),
    },
    mqtt: {
      host: optionalEnv('HA_MQTT_HOST', 'addon_core_mosquitto'),
      port: optionalEnvInt('HA_MQTT_PORT', 1883),
      username: optionalEnv('HA_MQTT_USERNAME', ''),
      password: optionalEnv('HA_MQTT_PASSWORD', ''),
    },
    throttle: {
      intervalMs: optionalEnvInt('VRM_THROTTLE_INTERVAL_MS', 500),
    },
  };
}
