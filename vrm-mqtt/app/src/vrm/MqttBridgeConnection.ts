import type { MqttClient } from 'mqtt';
import type { VrmInstallation } from './types';
import { MessageThrottle } from './MessageThrottle';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { HaBrokerClient } from '../ha/HaBrokerClient';
import { routeFromVrm } from '../ha/MessageRouter';
import { VrmBrokerPool } from './VrmBrokerPool';

const KEEPALIVE_INTERVAL_MS = 30_000;
const SUPPRESS_REPUBLISH = JSON.stringify({ 'keepalive-options': ['suppress-republish'] });

export interface MqttBridgeConnectionOptions {
  installation: VrmInstallation;
  pool: VrmBrokerPool;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
  /** Throttle flush interval in ms. 0 = bypass (publish every message directly). Default 500. */
  throttleIntervalMs?: number;
  /** Shared global throttle across all installations. If provided, throttleIntervalMs is ignored. */
  globalThrottle?: RollingMessageThrottle;
}

export class MqttBridgeConnection {
  private readonly installation: VrmInstallation;
  private client: MqttClient | null = null;
  private readonly pool: VrmBrokerPool;
  private readonly ha: HaBrokerClient;
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
  private readonly throttle: MessageThrottle | RollingMessageThrottle;
  private readonly subscribeTopics: string[];
  private readonly keepaliveTopic: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private isFirstKeepalive = true;

  // Pre-bound so client.off() can remove the exact same reference
  private readonly boundHandleConnect: () => void;
  private readonly boundHandleMessage: (topic: string, payload: Buffer) => void;
  private readonly boundHandleError: (err: Error) => void;
  private readonly boundHandleOffline: () => void;
  private readonly boundHandleReconnect: () => void;

  constructor({ installation, pool, ha, publisher, throttleIntervalMs = 500, globalThrottle }: MqttBridgeConnectionOptions) {
    this.ha = ha;
    this.publisher = publisher;
    this.installation = installation;
    this.pool = pool;
    this.subscribeTopics = this.buildSubscribeTopics();
    this.keepaliveTopic = `R/${installation.identifier}/keepalive`;
    this.throttle = globalThrottle ?? new MessageThrottle(throttleIntervalMs, (topic, payload) => ha.publish(topic, payload));

    this.boundHandleConnect = () => { this.handleConnect(); };
    this.boundHandleMessage = (topic, payload) => { this.handleMessage(topic, payload); };
    this.boundHandleError = (err) => { this.handleError(err); };
    this.boundHandleOffline = () => { this.handleOffline(); };
    this.boundHandleReconnect = () => {
      console.log(`[MQTT] Reconnecting for ${this.installation.name} (${this.installation.identifier})`);
    };
  }

  start(): void {
    // Lazily obtain the VRM client from the pool. This defers TCP/TLS/CONNECT
    // until we're ready to bridge, so HA outages do not waste VRM auth sessions.
    this.client = this.pool.getOrCreate(this.installation.mqttHost);

    this.client.on('connect', this.boundHandleConnect);
    this.client.on('message', this.boundHandleMessage);
    this.client.on('error', this.boundHandleError);
    this.client.on('offline', this.boundHandleOffline);
    this.client.on('reconnect', this.boundHandleReconnect);

    // Late-joiner: if the broker client is already connected, 'connect' won't fire again
    if (this.client.connected) {
      this.handleConnect();
    }
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.throttle.flush();

    // No client means start() was never called — nothing to clean up.
    if (!this.client) return;

    this.client.off('connect', this.boundHandleConnect);
    this.client.off('message', this.boundHandleMessage);
    this.client.off('error', this.boundHandleError);
    this.client.off('offline', this.boundHandleOffline);
    this.client.off('reconnect', this.boundHandleReconnect);

    await new Promise<void>((resolve) => {
      this.client!.unsubscribe(this.subscribeTopics, (err) => {
        if (err) {
          console.error(`[MQTT] Unsubscribe error for ${this.installation.identifier}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  private buildSubscribeTopics(): string[] {
    const id = this.installation.identifier;
    return [
      `N/${id}/system/0/Dc/Pv/Power`,
      `N/${id}/system/0/Dc/Battery/Soc`,
      `N/${id}/system/0/Dc/Battery/Voltage`,
      `N/${id}/system/0/Dc/Battery/State`,
      `N/${id}/system/0/Ac/Grid/+/Power`,
      `N/${id}/system/0/Ac/Consumption/+/Power`,
      `N/${id}/system/0/Ac/Genset/+/Power`,
    ];
  }

  private handleConnect(): void {
    if (!this.client) return;
    this.isFirstKeepalive = true;
    this.throttle.start();

    this.client.subscribe(this.subscribeTopics, { qos: 0 }, (err) => {
      if (err) {
        console.error(`[MQTT] Subscribe failed for ${this.installation.identifier}: ${err.message}`);
      } else {
        console.log(`[MQTT] Subscribed ${this.subscribeTopics.length} topics for ${this.installation.identifier}`);
      }
    });

    this.publisher.publishInstallation(this.installation.identifier, this.installation.name);
    this.publisher.publishAvailability(this.installation.identifier, true);
    this.sendKeepalive();

    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => { this.sendKeepalive(); }, KEEPALIVE_INTERVAL_MS);
  }

  private sendKeepalive(): void {
    if (!this.client) return;
    const payload = this.isFirstKeepalive ? '' : SUPPRESS_REPUBLISH;
    this.isFirstKeepalive = false;

    this.client.publish(this.keepaliveTopic, payload, { qos: 0 }, (err) => {
      if (err) {
        console.error(`[MQTT] Keepalive failed for ${this.installation.identifier}: ${err.message}`);
      }
    });
  }

  publishToVrm(topic: string, payload: string): void {
    // No client means start() was never called — drop the command silently.
    if (!this.client) return;
    this.client.publish(topic, payload, { qos: 0 }, (err) => {
      if (err) {
        console.error(`[MQTT] Publish error for ${this.installation.identifier}: ${err.message}`);
      }
    });
  }

  get identifier(): string {
    return this.installation.identifier;
  }

  private handleMessage(topic: string, payload: Buffer): void {
    if (!topic.startsWith(`N/${this.installation.identifier}/`)) return;

    const str = payload.toString();
    for (const msg of routeFromVrm(topic, str)) {
      this.throttle.enqueue(msg.topic, msg.payload);
    }
  }

  /**
   * Update the installation name (called by InstallationManager when the VRM API
   * returns a changed name). Re-publishes discovery so HA picks up the new name.
   */
  updateName(newName: string): void {
    if (this.installation.name === newName) return;
    this.installation.name = newName;
    this.publisher.publishInstallation(this.installation.identifier, newName);
  }

  private handleError(err: Error): void {
    console.error(`[MQTT] Error for ${this.installation.name} (${this.installation.identifier}): ${err.message}`);
  }

  private handleOffline(): void {
    console.log(`[MQTT] ${this.installation.name} (${this.installation.identifier}) offline`);
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.throttle.flush();
    this.publisher.publishAvailability(this.installation.identifier, false);
  }
}
