import * as mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';

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

    client.on('connect', () => {
      console.log(`[Broker] Connected to ${host}`);
    });
    client.on('error', (err: Error) => {
      console.error(`[Broker] Error on ${host}: ${err.message}`);
    });
    client.on('reconnect', () => {
      console.log(`[Broker] Reconnecting to ${host}...`);
    });
    client.on('offline', () => {
      console.log(`[Broker] ${host} went offline`);
    });

    this.clients.set(host, client);
    return client;
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.endAsync()));
    this.clients.clear();
  }
}
