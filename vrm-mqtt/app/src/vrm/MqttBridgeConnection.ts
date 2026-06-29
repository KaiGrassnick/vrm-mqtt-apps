import type { MqttClient } from 'mqtt';
import type { VrmInstallation } from './types';
import { MessageThrottle } from './MessageThrottle';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { HaBrokerClient } from '../ha/HaBrokerClient';
import { parseVrmTopic, routeFromVrm } from '../ha/MessageRouter';
import { VrmBrokerPool } from './VrmBrokerPool';
import { AggregateProcessor, type AggregateRule } from './AggregateProcessor';
import { SERVICE_ENTITY_DEFS, type SensorEntityDef } from '../ha/entityDefs';

const KEEPALIVE_INTERVAL_MS = 30_000;
const SUPPRESS_REPUBLISH = JSON.stringify({ 'keepalive-options': ['suppress-republish'] });

/**
 * L-phase indices the bridge pre-expands in `aggregateFrom` templates.
 * Three-phase systems are the common case; the processor's observed-sources
 * set then narrows the sum to whichever phases actually report.
 */
const POSSIBLE_PHASE_INDICES = ['1', '2', '3'];

/**
 * Resolve an `aggregateFrom` template list into concrete source paths using
 * the standard L1/L2/L3 indices. Templates containing `{n}` are expanded for
 * every possible phase; literal templates are kept as-is.
 */
function expandAggregateSourcePaths(def: SensorEntityDef): string[] {
  const expanded = new Set<string>();
  for (const template of def.aggregateFrom ?? []) {
    if (template.includes('{n}')) {
      for (const n of POSSIBLE_PHASE_INDICES) {
        expanded.add(template.replace('{n}', n));
      }
    } else {
      expanded.add(template);
    }
  }
  return [...expanded].sort();
}

export interface MqttBridgeConnectionOptions {
  installation: VrmInstallation;
  pool: VrmBrokerPool;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
  /** Throttle flush interval in ms. 0 = bypass (publish every message directly). Default 500. */
  throttleIntervalMs?: number;
  /** Shared global throttle across all installations. If provided, throttleIntervalMs is ignored. */
  globalThrottle?: RollingMessageThrottle;
  /** brokerPortalId → idSite lookup; undefined means "drop the message". */
  getIdSite?: (brokerPortalId: string) => number | undefined;
}

export class MqttBridgeConnection {
  private readonly installation: VrmInstallation;
  private client: MqttClient | null = null;
  private readonly pool: VrmBrokerPool;
  private readonly ha: HaBrokerClient;
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation'>;
  private readonly throttle: MessageThrottle | RollingMessageThrottle;
  private readonly getIdSite: (brokerPortalId: string) => number | undefined;
  private readonly subscribeTopics: string[];
  private readonly keepaliveTopic: string;
  private readonly aggregator: AggregateProcessor;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private isFirstKeepalive = true;
  /** HA-side topics this connection has forwarded; cleared on stop() so the broker
   *  doesn't keep the old installation's last value retained. */
  private readonly publishedStateTopics = new Set<string>();

  // Pre-bound so client.off() can remove the exact same reference
  private readonly boundHandleConnect: () => void;
  private readonly boundHandleMessage: (topic: string, payload: Buffer) => void;
  private readonly boundHandleError: (err: Error) => void;
  private readonly boundHandleOffline: () => void;
  private readonly boundHandleReconnect: () => void;

  constructor({ installation, pool, ha, publisher, throttleIntervalMs = 500, globalThrottle, getIdSite }: MqttBridgeConnectionOptions) {
    this.ha = ha;
    this.publisher = publisher;
    this.installation = installation;
    this.pool = pool;
    this.subscribeTopics = this.buildSubscribeTopics();
    this.keepaliveTopic = `R/${installation.brokerPortalId}/keepalive`;
    this.throttle = globalThrottle ?? new MessageThrottle(throttleIntervalMs, (topic, payload): void => ha.publish(topic, payload));
    this.getIdSite = getIdSite ?? ((): undefined => undefined);
    this.aggregator = this.buildAggregator();

    this.boundHandleConnect = (): void => { this.handleConnect(); };
    this.boundHandleMessage = (topic, payload): void => { this.handleMessage(topic, payload); };
    this.boundHandleError = (err): void => { this.handleError(err); };
    this.boundHandleOffline = (): void => { this.handleOffline(); };
    this.boundHandleReconnect = (): void => {
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

    // Clear retained state values on the HA broker so the old installation's last
    // values don't linger after teardown.
    for (const topic of this.publishedStateTopics) {
      this.ha.publish(topic, '', true);
    }
    this.publishedStateTopics.clear();
    this.aggregator.clear();

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
    const id = this.installation.brokerPortalId;
    return [
      `N/${id}/system/0/Dc/Pv/Power`,
      `N/${id}/system/0/Dc/Battery/Soc`,
      `N/${id}/system/0/Dc/Battery/Voltage`,
      `N/${id}/system/0/Dc/Battery/State`,
      `N/${id}/system/0/Ac/Grid/+/Power`,
      `N/${id}/system/0/Ac/Consumption/+/Power`,
      `N/${id}/system/0/Ac/Genset/+/Power`,
      `N/${id}/system/0/Ac/PvOnGrid/+/Power`,
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

    this.publisher.publishInstallation(this.installation.idSite, this.installation.name);
    this.publisher.publishAvailability(this.installation.idSite, true);
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

  get brokerPortalId(): string {
    return this.installation.brokerPortalId;
  }

  get idSite(): number {
    return this.installation.idSite;
  }

  private handleMessage(topic: string, payload: Buffer): void {
    if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;

    const str = payload.toString();
    for (const msg of routeFromVrm(topic, str, this.getIdSite)) {
      this.publishedStateTopics.add(msg.topic);
      this.throttle.enqueue(msg.topic, msg.payload);
    }

    // Feed the value to the aggregate processor; any updated aggregates are
    // enqueued through the same throttle. The parse-then-feed is done in
    // feedPayload which is a no-op for untracked paths and unparseable values.
    const parsed = parseVrmTopic(topic);
    if (parsed) {
      for (const agg of this.aggregator.feedPayload(parsed.path, str)) {
        this.publishedStateTopics.add(agg.topic);
        this.throttle.enqueue(agg.topic, agg.payload);
      }
    }
  }

  /**
   * Build an AggregateProcessor from the system/0 entity defs. Each def with
   * `aggregateFrom` becomes one rule. Source-path templates are pre-expanded
   * with the standard L1/L2/L3 indices; the processor's observed-sources set
   * then narrows the sum to whichever phases actually report.
   */
  private buildAggregator(): AggregateProcessor {
    const defs = SERVICE_ENTITY_DEFS['system'] ?? [];
    const rules: AggregateRule[] = [];
    for (const def of defs) {
      if (def.component !== 'sensor' || !def.aggregateFrom) continue;
      const sourcePaths = expandAggregateSourcePaths(def as SensorEntityDef);
      if (sourcePaths.length === 0) continue;
      rules.push({
        targetTopic: `vrm/${this.installation.idSite}/system/0/${def.path}`,
        sourcePaths,
      });
    }
    return new AggregateProcessor(rules);
  }

  /**
   * Update the installation name (called by InstallationManager when the VRM API
   * returns a changed name). Re-publishes discovery so HA picks up the new name.
   */
  updateName(newName: string): void {
    if (this.installation.name === newName) return;
    this.installation.name = newName;
    this.publisher.publishInstallation(this.installation.idSite, newName);
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
    this.publisher.publishAvailability(this.installation.idSite, false);
  }
}
