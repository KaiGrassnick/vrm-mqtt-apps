import type { HaBrokerClient } from './HaBrokerClient';
import { buildInstallationDiscovery } from './InstallationDevice';

interface PublishedInstallation {
  discoveryTopic: string;
  payload: string;
  name: string;
}

/**
 * Publishes and tracks HA device discovery payloads — one per VRM installation.
 *
 * One instance is shared across all MqttBridgeConnections.
 */
export class DiscoveryPublisher {
  private static readonly BATCH_SIZE = 50;
  private static readonly BATCH_DELAY_MS = 100;

  private readonly ha: HaBrokerClient;
  private readonly appVersion: string;
  private readonly published = new Map<string, PublishedInstallation>();

  constructor(ha: HaBrokerClient, appVersion: string) {
    this.ha = ha;
    this.appVersion = appVersion;
  }

  /**
   * Build and publish the single-device discovery payload for one installation.
   * No-ops if the name is unchanged (idempotent on reconnect).
   */
  publishInstallation(portalId: string, installationName: string): void {
    const existing = this.published.get(portalId);
    if (existing && existing.name === installationName) return;

    const topic = `homeassistant/device/vrm_${portalId}/config`;
    const payload = JSON.stringify(buildInstallationDiscovery(portalId, installationName, this.appVersion));
    this.ha.publish(topic, payload, true);
    this.published.set(portalId, { discoveryTopic: topic, payload, name: installationName });
  }

  /** Publish online/offline to the installation-level availability topic (retained). */
  publishAvailability(portalId: string, online: boolean): void {
    this.ha.publish(`vrm/${portalId}/availability`, online ? 'online' : 'offline', true);
  }

  /** Remove one installation from HA by clearing its retained discovery topic. */
  async removeInstallation(portalId: string): Promise<void> {
    const entry = this.published.get(portalId);
    if (entry) {
      this.ha.publish(entry.discoveryTopic, '', true);
      this.published.delete(portalId);
    } else {
      // After a restart this.published is empty — directly clear the known deterministic topic.
      const topic = `homeassistant/device/vrm_${portalId}/config`;
      const retained = await this.ha.collectRetained(topic);
      for (const { topic: t, payload } of retained) {
        if (payload !== '') this.ha.publish(t, '', true);
      }
    }
    this.publishAvailability(portalId, false);
  }

  /**
   * Re-publish all stored discovery payloads and mark all installations online.
   * Called when HA sends online to homeassistant/status (HA restart / reload).
   */
  onHaBirth(): void {
    const entries = [...this.published.entries()];
    if (entries.length === 0) return;

    const publishBatch = (startIndex: number): void => {
      const batch = entries.slice(startIndex, startIndex + DiscoveryPublisher.BATCH_SIZE);
      for (const [, entry] of batch) {
        this.ha.publish(entry.discoveryTopic, entry.payload, true);
      }

      const nextIndex = startIndex + DiscoveryPublisher.BATCH_SIZE;
      if (nextIndex < entries.length) {
        setTimeout(() => publishBatch(nextIndex), DiscoveryPublisher.BATCH_DELAY_MS).unref();
      } else {
        for (const portalId of this.published.keys()) {
          this.publishAvailability(portalId, true);
        }
      }
    };

    publishBatch(0);
  }
}