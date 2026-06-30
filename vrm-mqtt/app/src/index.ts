import { loadConfig } from './config';
import { VrmApiClient } from './vrm/VrmApiClient';
import { InstallationManager } from './vrm/InstallationManager';
import { VrmApiError } from './errors';
import type { VrmUser, VrmInstallation } from './vrm/types';
import { HaBrokerClient } from './ha/HaBrokerClient';
import { DiscoveryPublisher } from './ha/DiscoveryPublisher';
import { withTimeout } from './withTimeout';
import { logger } from './logger';
import packageJson from '../package.json';
// package.json is resolved at import time via resolveJsonModule; caching
// it here avoids re-reading the file for every DiscoveryPublisher.

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Without these, an unexpected throw or rejection anywhere (e.g. an MQTT event
// handler bug for one installation) would crash the whole process and take
// down every installation, not just the offending one. Logging and exiting
// deliberately lets the add-on's supervisor (s6) restart cleanly instead of
// the process dying in an unknown state.
if (process.listenerCount('uncaughtException') === 0) {
  process.on('uncaughtException', (err: Error) => {
    logger.error('[VRM] Uncaught exception — exiting for a clean restart:', err);
    process.exit(1);
  });
}
if (process.listenerCount('unhandledRejection') === 0) {
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('[VRM] Unhandled promise rejection — exiting for a clean restart:', reason);
    process.exit(1);
  });
}

let pollInProgress = false;
// Singleton module state — shared across every pollInstallations call.

export async function pollInstallations(
  client: VrmApiClient,
  manager: InstallationManager,
  user: VrmUser,
): Promise<void> {
  if (pollInProgress) {
    logger.info('[Main] Poll already in progress, skipping tick');
    return;
  }
  pollInProgress = true;
  try {
    const installations: VrmInstallation[] = await client.getInstallations(user.id);
    logger.info(`[VRM] Found ${installations.length} installation(s)`);
    for (const inst of installations) {
      logger.info(`[VRM]   - ${inst.name} (${inst.identifier} -> brokerPortalId=${inst.brokerPortalId}) @ ${inst.mqttHost}`);
    }
    await manager.reconcile(installations);
  } finally {
    pollInProgress = false;
  }
}

function handlePollError(err: unknown): void {
  if (err instanceof VrmApiError) {
    logger.error(`[VRM] API error (${err.statusCode}): ${err.message}`);
  } else {
    logger.error('[VRM] Unexpected error during poll:', err);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  const ha = new HaBrokerClient({
    host: config.mqtt.host,
    port: config.mqtt.port,
    username: config.mqtt.username,
    password: config.mqtt.password,
  });
  const publisher = new DiscoveryPublisher(ha, packageJson.version);

  const client = new VrmApiClient({
    apiToken: config.vrm.apiToken,
    baseUrl: config.vrm.baseUrl,
  });

  let user: VrmUser;
  try {
    user = await client.getMe();
    logger.info(`[VRM] Authenticated as ${user.email} (id: ${user.id})`);
  } catch (err) {
    logger.error('[VRM] Fatal: could not authenticate with VRM API:', err);
    process.exit(1);
  }

  const manager = new InstallationManager({
    apiToken: config.vrm.apiToken,
    userEmail: user.email,
    ha,
    publisher,
    throttleIntervalMs: config.throttle.intervalMs,
    disabledInstallationIds: config.vrm.disabledInstallationIds,
    installationStartupDelayMs: config.vrm.installationStartupDelayMs,
    offlineTimeoutMs: config.vrm.offlineTimeoutMs,
  });

  ha.onConnect = (): void => { manager.resume(); };
  ha.onOffline = (): void => { void manager.suspend(); };
  ha.onBirth = (): void => {
    logger.info('[HA] Birth message received — re-publishing discovery configs');
    publisher.onHaBirth();
    manager.republishAvailability();
  };
  ha.onCommand = (topic, payload): void => { manager.routeHaCommand(topic, payload); };

  ha.start();

  const pollTimer = setInterval(() => {
    pollInstallations(client, manager, user).catch(handlePollError);
  }, config.vrm.pollIntervalMs);

  const shutdown = async (): Promise<void> => {
    logger.info('[VRM] Shutting down...');
    clearInterval(pollTimer);
    try {
      await withTimeout(
        (async (): Promise<void> => {
          await manager.shutdown();
          await ha.stop();
        })(),
        SHUTDOWN_TIMEOUT_MS,
        `Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms`,
      );
      logger.info('[VRM] Shutdown complete.');
      process.exit(0);
    } catch (err) {
      logger.error('[VRM] Shutdown did not complete in time — forcing exit:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  logger.info(`[VRM] Starting VRM MQTT Bridge (poll interval: ${config.vrm.pollIntervalMs}ms)`);

  await pollInstallations(client, manager, user).catch(handlePollError);
}

main().catch((err: unknown) => {
  logger.error('[VRM] Fatal startup error:', err);
  process.exit(1);
});
