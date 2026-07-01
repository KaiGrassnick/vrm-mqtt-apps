import { VrmBrokerPool } from './VrmBrokerPool';
import { MqttBridgeConnection } from './MqttBridgeConnection';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import type { VrmInstallation } from './types';
import type { HaBrokerClient } from '../ha/HaBrokerClient';
import type { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { routeFromHa } from '../ha/MessageRouter';
import { logger } from '../logger';

export interface InstallationManagerOptions {
  apiToken: string;
  userEmail: string;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'removeInstallation' | 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
  throttleIntervalMs?: number;
  disabledInstallationIds?: string[];
  installationStartupDelayMs?: number;
  /** Staleness timeout in ms. 0 = disable. Default 300_000. */
  offlineTimeoutMs?: number;
}

export class InstallationManager {
  private readonly pool: VrmBrokerPool;
  private readonly connections = new Map<number, MqttBridgeConnection>();
  /** Secondary index for O(1) idSite → connection lookups in routeHaCommand. */
  private readonly connectionsByIdSite = new Map<number, MqttBridgeConnection>();
  private readonly ha: HaBrokerClient;
  private readonly publisher: Pick<DiscoveryPublisher, 'removeInstallation' | 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
  private readonly throttleIntervalMs: number;
  private readonly disabledInstallationIds: ReadonlySet<string>;
  private readonly installationStartupDelayMs: number;
  private readonly offlineTimeoutMs: number;
  private readonly globalThrottle: RollingMessageThrottle;
  // Starts true so connections are queued until HA's first 'connect' event
  // triggers resume(). Prevents wasted VRM subscriptions when HA is unreachable.
  private suspended = true;

  constructor({ apiToken, userEmail, ha, publisher, throttleIntervalMs = 500, disabledInstallationIds = [], installationStartupDelayMs = 500, offlineTimeoutMs = 300_000 }: InstallationManagerOptions) {
    this.ha = ha;
    this.publisher = publisher;
    this.throttleIntervalMs = throttleIntervalMs;
    this.disabledInstallationIds = new Set(disabledInstallationIds);
    this.installationStartupDelayMs = installationStartupDelayMs;
    this.offlineTimeoutMs = offlineTimeoutMs;
    this.globalThrottle = new RollingMessageThrottle(throttleIntervalMs, (topic, payload) => ha.publish(topic, payload));
    this.pool = new VrmBrokerPool({
      username: userEmail,
      password: `Token ${apiToken}`,
    });
  }

  async reconcile(installations: VrmInstallation[]): Promise<void> {
    const isSkipped = (i: VrmInstallation): { skipped: boolean; reason: 'disabled' | null } => {
      if (this.disabledInstallationIds.has(i.identifier)) return { skipped: true, reason: 'disabled' };
      return { skipped: false, reason: null };
    };

    const active = installations.filter((i) => {
      const { skipped, reason } = isSkipped(i);
      if (skipped) {
        logger.info(`[Manager] Skipping ${reason} installation ${i.name} (${i.identifier})`);
        return false;
      }
      return true;
    });
    const incomingIds = new Set(active.map((i) => i.idSite));

    for (const [idSite, conn] of this.connections) {
      if (!incomingIds.has(idSite)) {
        await conn.stop();
        await this.publisher.removeInstallation(conn.idSite);
        this.connectionsByIdSite.delete(conn.idSite);
        this.connections.delete(idSite);
        logger.info(`[Manager] Removed installation idSite=${idSite}`);
      }
    }

    // Disabled installations with no running connection (e.g. after a restart):
    // clean up any retained HA discovery topics from the previous session so
    // Home Assistant stops showing them.
    for (const inst of installations) {
      const { skipped, reason } = isSkipped(inst);
      if (skipped && !this.connections.has(inst.idSite)) {
        logger.info(`[Manager] Purging HA discovery for ${reason} installation ${inst.name} (${inst.identifier})`);
        await this.publisher.removeInstallation(inst.idSite);
      }
    }

    for (const installation of active) {
      const existing = this.connections.get(installation.idSite);
      if (!existing) {
        // Start the global throttle on the first new connection
        this.globalThrottle.start();
        const conn = new MqttBridgeConnection({
          installation,
          pool: this.pool,
          ha: this.ha,
          publisher: this.publisher,
          globalThrottle: this.globalThrottle,
          offlineTimeoutMs: this.offlineTimeoutMs,
          getIdSite: (brokerPortalId): number | undefined =>
            brokerPortalId === installation.brokerPortalId ? installation.idSite : undefined,
        });
        if (!this.suspended) {
          conn.start();
          // Stagger startup so we don't hammer the VRM broker with simultaneous connections
          await new Promise<void>((resolve) => setTimeout(resolve, this.installationStartupDelayMs));
        }
        this.connections.set(installation.idSite, conn);
        this.connectionsByIdSite.set(installation.idSite, conn);
        logger.info(`[Manager] Added installation ${installation.name} (${installation.identifier}) @ ${installation.mqttHost}`);
      } else {
        existing.updateName(installation.name);
      }
    }
  }

  /**
   * Route a command received from the HA broker back to the correct VRM installation.
   *
   * HA topics from MessageRouter use the numeric idSite as the topic's `parts[1]`
   * segment: `W/{idSite}/{service}/{instance}/{path}`. We look up the connection
   * by idSite and rewrite that segment to the connection's brokerPortalId before
   * publishing — keeping the bridge's VRM-side topic vocabulary independent of
   * the HA-side idSite key.
   */
  routeHaCommand(topic: string, payload: string): void {
    for (const msg of routeFromHa(topic, payload)) {
      const parts = msg.topic.split('/');
      if (parts[0] !== 'W' || parts.length < 4) continue;
      const idSite = Number(parts[1]);
      if (!Number.isInteger(idSite)) {
        logger.warn(`[Manager] Dropping command with non-numeric idSite ${parts[1]}`);
        continue;
      }
      const conn = this.connectionsByIdSite.get(idSite);
      if (!conn) {
        logger.warn(`[Manager] No connection found for idSite ${idSite} — dropping command`);
        continue;
      }
      parts[1] = conn.brokerPortalId;
      conn.publishToVrm(parts.join('/'), msg.payload);
    }
  }

  /** Re-publish each connection's actual current availability. Called after an
   *  HA birth event so a broker reconnect doesn't blindly mark every installation
   *  online regardless of whether its VRM connection is genuinely stale. */
  republishAvailability(): void {
    for (const conn of this.connections.values()) {
      conn.republishAvailability();
    }
  }

  async suspend(): Promise<void> {
    if (this.suspended) return;
    this.suspended = true;
    logger.info('[Manager] HA broker offline — suspending all VRM connections');
    await Promise.all([...this.connections.values()].map(c => c.stop()));
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    logger.info('[Manager] HA broker reconnected — resuming all VRM connections');
    for (const conn of this.connections.values()) {
      conn.start();
    }
  }

  async shutdown(): Promise<void> {
    this.globalThrottle.stop();
    for (const conn of this.connections.values()) {
      this.publisher.publishAvailability(conn.idSite, false);
    }
    await Promise.all([...this.connections.values()].map((c) => c.stop()));
    this.connections.clear();
    this.connectionsByIdSite.clear();
    await this.pool.destroyAll();
  }
}
