import type { HaBrokerClient } from './HaBrokerClient';
import { buildInstallationDiscovery } from './InstallationDevice';
import type { VrmInstallation } from '../vrm/types';

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
  private readonly published = new Map<number, PublishedInstallation>();

  constructor(ha: HaBrokerClient, appVersion: string) {
    this.ha = ha;
    this.appVersion = appVersion;
  }

  /**
   * Build and publish the single-device discovery payload for one installation.
   * No-ops if the name is unchanged (idempotent on reconnect).
   */
  publishInstallation(idSite: number, installationName: string): void {
    const existing = this.published.get(idSite);
    if (existing && existing.name === installationName) return;

    const discoveryTopic = `homeassistant/device/vrm_${idSite}/config`;
    const payload = JSON.stringify(buildInstallationDiscovery(idSite, installationName, this.appVersion));
    this.ha.publish(discoveryTopic, payload, true);
    this.published.set(idSite, {
      discoveryTopic,
      payload,
      name: installationName,
    });
  }

  /** Publish online/offline to the installation-level availability topic (retained). */
  publishAvailability(idSite: number, online: boolean): void {
    this.ha.publish(`vrm/${idSite}/availability`, online ? 'online' : 'offline', true);
  }

  /** Remove one installation from HA by clearing its retained discovery topic. */
  async removeInstallation(idSite: number): Promise<void> {
    const entry = this.published.get(idSite);
    if (entry) {
      this.ha.publish(entry.discoveryTopic, '', true);
      this.published.delete(idSite);
    } else {
      // After a restart this.published is empty — directly clear the known deterministic topic.
      const topic = `homeassistant/device/vrm_${idSite}/config`;
      const retained = await this.ha.collectRetained(topic);
      for (const { topic: t, payload } of retained) {
        // Defensive: only clear when the broker returned the EXACT topic we
        // asked about. Don't trust unrelated topics the broker may surface
        // (e.g. accidental wildcard expansion, live messages captured during
        // the 300 ms collectRetained window).
        if (payload !== '' && t === topic) {
          this.ha.publish(t, '', true);
        }
      }
    }
    this.publishAvailability(idSite, false);
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
        for (const idSite of this.published.keys()) {
          this.publishAvailability(idSite, true);
        }
      }
    };

    publishBatch(0);
  }

  /**
   * One-time purge of legacy (identifier-keyed) HA discovery and availability
   * messages from a previous release. Called on startup / every poll before the
   * first reconcile so that an upgrading user doesn't accumulate dead devices.
   *
   * Idempotent: a fresh install (no retained legacy messages) is a no-op, and
   * subsequent polls are no-ops once the legacy messages have been cleared.
   *
   * Safety: the broker may surface topics other than the literal legacy one we
   * asked about (live messages arriving during the 300 ms collectRetained
   * window, or accidental MQTT-wildcard expansion if an identifier contains
   * '+' or '#'). We never clear any topic whose name is not exactly the
   * legacy pattern we requested.
   */
  async purgeLegacyDiscovery(installations: readonly VrmInstallation[]): Promise<void> {
    for (const inst of installations) {
      const legacyTopics = [
        `homeassistant/device/vrm_${inst.identifier}/config`,
        `vrm/${inst.identifier}/availability`,
      ] as const;
      for (const topic of legacyTopics) {
        const retained = await this.ha.collectRetained(topic);
        for (const { topic: t, payload } of retained) {
          if (payload !== '' && t === topic) {
            this.ha.publish(t, '', true);
            console.log(`[Discovery] Purged legacy HA topic ${t} (idSite=${inst.idSite})`);
          }
        }
      }
    }
  }
}