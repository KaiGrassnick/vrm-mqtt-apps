import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { logger } from '../logger';

export interface VrmBrokerPoolOptions {
  username: string;
  password: string;
}

export class VrmBrokerPool {
  private readonly clients = new Map<string, MqttClient>();
  private readonly options: VrmBrokerPoolOptions;

  constructor(options: VrmBrokerPoolOptions) {
    this.options = options;
  }

  getOrCreate(host: string): MqttClient {
    const existing = this.clients.get(host);
    if (existing) return existing;

    const client = mqtt.connect(`mqtts://${host}:8883`, {
      username: this.options.username,
      password: this.options.password,
      clientId: `vrm-bridge-${host}-${Date.now()}`,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
      keepalive: 60,
      clean: true,
      resubscribe: false,
      // VRM broker uses a self-signed certificate. Verification is disabled
      // to allow the handshake; the connection is still TLS-encrypted.
      // Do not flip to `true` unless the broker ships a CA-signed cert or a
      // CA bundle is plumbed through via the `ca` option.
      rejectUnauthorized: false,
    });

    // VRM shards many installations across a small number of broker hostnames,
    // so this client is shared: every MqttBridgeConnection on the same host
    // attaches its own set of listeners to it. Node's default cap of 10 is
    // easily exceeded once more than ~2 installations share a host — raise it
    // so that's not mistaken for a leak (same pattern as HaBrokerClient).
    client.setMaxListeners(0);

    client.on('connect', () => {
      logger.info(`[Broker] Connected to ${host}`);
    });
    client.on('error', (err: Error) => {
      logger.error(`[Broker] Error on ${host}: ${err.message}`);
    });
    client.on('reconnect', () => {
      logger.info(`[Broker] Reconnecting to ${host}...`);
    });
    client.on('offline', () => {
      logger.info(`[Broker] ${host} went offline`);
    });

    this.clients.set(host, client);
    return client;
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.endAsync()));
    this.clients.clear();
  }
}
