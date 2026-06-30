import mqtt, { type MqttClient } from 'mqtt';
import { logger } from '../logger';

export interface HaBrokerClientOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export type CommandHandler = (topic: string, payload: string) => void;
export type BirthHandler = () => void;
export type ConnectHandler = () => void;
export type OfflineHandler = () => void;

/**
 * Singleton MQTT connection to the local Home Assistant Mosquitto broker.
 *
 * Responsibilities:
 * - Publishes bridged state messages and retained discovery configs.
 * - Subscribes to vrm/#  and routes /set messages to the VRM write path.
 * - Subscribes to homeassistant/status and fires onBirth when HA restarts.
 */
export class HaBrokerClient {
  private client: MqttClient | null = null;
  private readonly options: HaBrokerClientOptions;

  onCommand?: CommandHandler;
  onBirth?: BirthHandler;
  onConnect?: ConnectHandler;
  onOffline?: OfflineHandler;

  constructor(options: HaBrokerClientOptions) {
    this.options = options;
  }

  start(): void {
    const { host, port, username, password } = this.options;
    this.client = mqtt.connect({
      host,
      port,
      username: username || undefined,
      password: password || undefined,
      clean: true,
      reconnectPeriod: 5_000,
      clientId: `vrm-mqtt-bridge-ha-${Math.random().toString(16).slice(2, 10)}`,
    });

    this.client.on('connect', () => {
      // mqtt.js registers one drain listener per queued write during burst forwarding.
      // These are transient (once), not a leak — suppress the false-positive warning.
      const stream = (this.client as unknown as { stream?: { setMaxListeners(n: number): void } }).stream;
      stream?.setMaxListeners(0);
      logger.info('[HA] Connected to HA MQTT broker');
      this.client!.subscribe(['homeassistant/status', 'vrm/#'], { qos: 0 }, (err) => {
        if (err) logger.error('[HA] Subscribe error:', err.message);
      });
      this.onConnect?.();
    });

    this.client.on('message', (topic, payload) => {
      const str = payload.toString();
      if (topic === 'homeassistant/status') {
        if (str === 'online') this.onBirth?.();
        return;
      }
      if (topic.startsWith('vrm/') && topic.endsWith('/set')) {
        this.onCommand?.(topic, str);
      }
    });

    this.client.on('error', (err) => {
      logger.error('[HA] Broker error:', err.message);
    });

    this.client.on('reconnect', () => {
      logger.info('[HA] Reconnecting to HA MQTT broker...');
    });

    this.client.on('offline', () => {
      logger.info('[HA] HA MQTT broker offline');
      this.onOffline?.();
    });
  }

  publish(topic: string, payload: string, retained = true): void {
    if (!this.client?.connected) {
      logger.warn(`[HA] Not connected — dropping publish to ${topic}`);
      return;
    }
    this.client.publish(topic, payload, { retain: retained, qos: 0 }, (err) => {
      if (err) logger.error(`[HA] Publish error on ${topic}:`, err.message);
    });
  }

  /**
   * Subscribe to `pattern`, collect all retained messages delivered within `timeoutMs`,
   * then unsubscribe. Retained messages arrive immediately on subscription.
   */
  async collectRetained(pattern: string, timeoutMs = 300): Promise<Array<{ topic: string; payload: string }>> {
    if (!this.client?.connected) return [];
    return new Promise((resolve) => {
      const results: Array<{ topic: string; payload: string }> = [];
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.client!.off('message', onMessage);
        this.client!.unsubscribe(pattern, () => resolve(results));
      };

      const onMessage = (topic: string, payload: Buffer): void => {
        results.push({ topic, payload: payload.toString() });
      };

      // Attach listener BEFORE subscribing to avoid losing retained messages
      // that arrive between subscribe-return and listener-attach.
      this.client!.on('message', onMessage);

      this.client!.subscribe(pattern, { qos: 0 }, (err) => {
        if (err) {
          logger.error('[HA] collectRetained subscribe failed:', err.message);
          finish();
        }
      });

      setTimeout(finish, timeoutMs);
    });
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    return new Promise<void>((resolve) => {
      this.client!.end(false, {}, () => resolve());
    });
  }
}
