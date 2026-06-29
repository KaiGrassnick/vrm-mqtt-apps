import { VrmBrokerPool } from './VrmBrokerPool';
import { MqttBridgeConnection } from './MqttBridgeConnection';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import type { VrmInstallation } from './types';
import type { HaBrokerClient } from '../ha/HaBrokerClient';
import type { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { routeFromHa } from '../ha/MessageRouter';

/**
 * Substring that VRM appends to the `identifier` of an installation when it
 * has been created as a replacement for another one (e.g. after migrating the
 * underlying Venus device). Such identifiers contain spaces and other illegal
 * MQTT topic characters — we skip them entirely rather than bridging them.
 */
const REPLACED_MARKER = 'USEDASREPLACEMENT';

export interface InstallationManagerOptions {
  apiToken: string;
  userEmail: string;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'removeInstallation' | 'publishAvailability' | 'publishInstallation'>;
  throttleIntervalMs?: number;
  disabledInstallationIds?: string[];
  installationStartupDelayMs?: number;
}

export class InstallationManager {
  private readonly pool: VrmBrokerPool;
  private readonly connections = new Map<number, MqttBridgeConnection>();
  /** Secondary index for O(1) portalId → connection lookups in routeHaCommand. */
  private readonly connectionsByPortalId = new Map<string, MqttBridgeConnection>();
  private readonly ha: HaBrokerClient;
  private readonly publisher: Pick<DiscoveryPublisher, 'removeInstallation' | 'publishAvailability' | 'publishInstallation'>;
  private readonly throttleIntervalMs: number;
  private readonly disabledInstallationIds: ReadonlySet<string>;
  private readonly installationStartupDelayMs: number;
  private readonly globalThrottle: RollingMessageThrottle;
  // Starts true so connections are queued until HA's first 'connect' event
  // triggers resume(). Prevents wasted VRM subscriptions when HA is unreachable.
  private suspended = true;

  constructor({ apiToken, userEmail, ha, publisher, throttleIntervalMs = 500, disabledInstallationIds = [], installationStartupDelayMs = 500 }: InstallationManagerOptions) {
    this.ha = ha;
    this.publisher = publisher;
    this.throttleIntervalMs = throttleIntervalMs;
    this.disabledInstallationIds = new Set(disabledInstallationIds);
    this.installationStartupDelayMs = installationStartupDelayMs;
    this.globalThrottle = new RollingMessageThrottle(throttleIntervalMs, (topic, payload) => ha.publish(topic, payload));
    this.pool = new VrmBrokerPool({
      username: userEmail,
      password: `Token ${apiToken}`,
    });
  }

  async reconcile(installations: VrmInstallation[]): Promise<void> {
    const isSkipped = (i: VrmInstallation): { skipped: boolean; reason: 'replaced' | 'disabled' | null } => {
      if (this.disabledInstallationIds.has(i.identifier)) return { skipped: true, reason: 'disabled' };
      if (i.identifier.includes(REPLACED_MARKER)) return { skipped: true, reason: 'replaced' };
      return { skipped: false, reason: null };
    };

    const active = installations.filter((i) => {
      const { skipped, reason } = isSkipped(i);
      if (skipped) {
        console.log(`[Manager] Skipping ${reason} installation ${i.name} (${i.identifier})`);
        return false;
      }
      return true;
    });
    const incomingIds = new Set(active.map((i) => i.idSite));

    for (const [idSite, conn] of this.connections) {
      if (!incomingIds.has(idSite)) {
        await conn.stop();
        await this.publisher.removeInstallation(conn.identifier);
        this.connectionsByPortalId.delete(conn.identifier);
        this.connections.delete(idSite);
        console.log(`[Manager] Removed installation idSite=${idSite}`);
      }
    }

    // Skipped installations (disabled or replaced) with no running connection
    // (e.g. after a restart): clean up any retained HA discovery topics from
    // the previous session so Home Assistant stops showing them.
    for (const inst of installations) {
      const { skipped, reason } = isSkipped(inst);
      if (skipped && !this.connections.has(inst.idSite)) {
        console.log(`[Manager] Purging HA discovery for ${reason} installation ${inst.name} (${inst.identifier})`);
        await this.publisher.removeInstallation(inst.identifier);
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
        });
        if (!this.suspended) {
          conn.start();
          // Stagger startup so we don't hammer the VRM broker with simultaneous connections
          await new Promise<void>((resolve) => setTimeout(resolve, this.installationStartupDelayMs));
        }
        this.connections.set(installation.idSite, conn);
        this.connectionsByPortalId.set(installation.identifier, conn);
        console.log(`[Manager] Added installation ${installation.name} (${installation.identifier}) @ ${installation.mqttHost}`);
      } else {
        existing.updateName(installation.name);
      }
    }
  }

  /**
   * Route a command received from the HA broker back to the correct VRM installation.
   * Called by HaBrokerClient.onCommand.
   */
  routeHaCommand(topic: string, payload: string): void {
    for (const msg of routeFromHa(topic, payload)) {
      // W/{portalId}/… — extract portalId to find the right connection
      const parts = msg.topic.split('/');
      if (parts[0] !== 'W' || parts.length < 4) continue;
      const portalId = parts[1];
      const conn = this.connectionsByPortalId.get(portalId);
      if (conn) {
        conn.publishToVrm(msg.topic, msg.payload);
      } else {
        console.warn(`[Manager] No connection found for portalId ${portalId} — dropping command`);
      }
    }
  }

  async suspend(): Promise<void> {
    if (this.suspended) return;
    this.suspended = true;
    console.log('[Manager] HA broker offline — suspending all VRM connections');
    await Promise.all([...this.connections.values()].map(c => c.stop()));
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    console.log('[Manager] HA broker reconnected — resuming all VRM connections');
    for (const conn of this.connections.values()) {
      conn.start();
    }
  }

  async shutdown(): Promise<void> {
    this.globalThrottle.stop();
    for (const conn of this.connections.values()) {
      this.publisher.publishAvailability(conn.identifier, false);
    }
    await Promise.all([...this.connections.values()].map((c) => c.stop()));
    this.connections.clear();
    this.connectionsByPortalId.clear();
    await this.pool.destroyAll();
  }
}
