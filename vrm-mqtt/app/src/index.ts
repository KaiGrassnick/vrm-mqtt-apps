import { loadConfig } from './config';
import { VrmApiClient } from './vrm/VrmApiClient';
import { InstallationManager } from './vrm/InstallationManager';
import { VrmApiError } from './errors';
import type { VrmUser, VrmInstallation } from './vrm/types';
import { HaBrokerClient } from './ha/HaBrokerClient';
import { DiscoveryPublisher } from './ha/DiscoveryPublisher';
import packageJson from '../package.json';
// package.json is resolved at import time via resolveJsonModule; caching
// it here avoids re-reading the file for every DiscoveryPublisher.

let pollInProgress = false;
// Singleton module state — shared across every pollInstallations call.

export async function pollInstallations(
  client: VrmApiClient,
  manager: InstallationManager,
  user: VrmUser,
): Promise<void> {
  if (pollInProgress) {
    console.log('[Main] Poll already in progress, skipping tick');
    return;
  }
  pollInProgress = true;
  try {
    const installations: VrmInstallation[] = await client.getInstallations(user.id);
    console.log(`[VRM] Found ${installations.length} installation(s)`);
    for (const inst of installations) {
      console.log(`[VRM]   - ${inst.name} (${inst.identifier} -> brokerPortalId=${inst.brokerPortalId}) @ ${inst.mqttHost}`);
    }
    await manager.reconcile(installations);
  } finally {
    pollInProgress = false;
  }
}

function handlePollError(err: unknown): void {
  if (err instanceof VrmApiError) {
    console.error(`[VRM] API error (${err.statusCode}): ${err.message}`);
  } else {
    console.error('[VRM] Unexpected error during poll:', err);
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
    console.log(`[VRM] Authenticated as ${user.email} (id: ${user.id})`);
  } catch (err) {
    console.error('[VRM] Fatal: could not authenticate with VRM API:', err);
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
    console.log('[HA] Birth message received — re-publishing discovery configs');
    publisher.onHaBirth();
    manager.republishAvailability();
  };
  ha.onCommand = (topic, payload): void => { manager.routeHaCommand(topic, payload); };

  ha.start();

  const pollTimer = setInterval(() => {
    pollInstallations(client, manager, user).catch(handlePollError);
  }, config.vrm.pollIntervalMs);

  const shutdown = async (): Promise<void> => {
    console.log('[VRM] Shutting down...');
    clearInterval(pollTimer);
    await manager.shutdown();
    await ha.stop();
    console.log('[VRM] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  console.log(`[VRM] Starting VRM MQTT Bridge (poll interval: ${config.vrm.pollIntervalMs}ms)`);

  await pollInstallations(client, manager, user).catch(handlePollError);
}

main().catch((err: unknown) => {
  console.error('[VRM] Fatal startup error:', err);
  process.exit(1);
});
