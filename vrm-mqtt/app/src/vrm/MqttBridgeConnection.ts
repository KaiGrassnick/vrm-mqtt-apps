import type { MqttClient } from 'mqtt';
import type { VrmInstallation, VrmServiceName } from './types';
import { RollingMessageThrottle } from './RollingMessageThrottle';
import { DiscoveryPublisher } from '../ha/DiscoveryPublisher';
import { HaBrokerClient } from '../ha/HaBrokerClient';
import { parseVrmTopic, routeFromVrm } from '../ha/MessageRouter';
import { VrmBrokerPool } from './VrmBrokerPool';
import { AggregateProcessor, type AggregateRule } from './AggregateProcessor';
import { SERVICE_ENTITY_DEFS, CUSTOM_ENTITY_DEFS } from '../ha/entityDefs';
import { getObservedPaths } from '../ha/observedPaths';
import { logger } from '../logger';

const KEEPALIVE_INTERVAL_MS = 30_000;
const DISCOVERY_REFRESH_DEBOUNCE_MS = 2_000;
const SUPPRESS_REPUBLISH = JSON.stringify({ 'keepalive-options': ['suppress-republish'] });

const POSSIBLE_PHASE_INDICES = ['1', '2', '3'] as const;

/**
 * Expand a list of aggregate source templates. Templates containing `{n}`
 * are expanded to indices 1, 2, 3; literal templates are kept as-is.
 * Result is sorted and deduplicated.
 *
 * Used at aggregator-build time. Differs from
 * DiscoveryConfigBuilder.expandAggregateSourcePaths in that this helper does
 * NOT filter by observed paths — at startup we wire up every possible source
 * so the aggregator is ready the moment a phase comes online.
 */
function expandAggregateSourcePaths(templates: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const t of templates) {
    if (t.includes('{n}')) {
      for (const n of POSSIBLE_PHASE_INDICES) {
        expanded.add(t.replace('{n}', n));
      }
    } else {
      expanded.add(t);
    }
  }
  return [...expanded].sort();
}

function computeForwardPaths(): ReadonlyMap<VrmServiceName, ReadonlySet<string>> {
  const indices = ['1', '2', '3'] as const;
  const expand = (template: string): string[] =>
    template.includes('{n}')
      ? indices.map((n) => template.replace('{n}', n))
      : [template];
  const map = new Map<VrmServiceName, Set<string>>();
  for (const [service, defs] of Object.entries(SERVICE_ENTITY_DEFS) as [VrmServiceName, typeof SERVICE_ENTITY_DEFS[VrmServiceName]][]) {
    const set = new Set<string>();
    for (const def of defs ?? []) {
      if (!def.forward) continue;
      for (const p of expand(def.path)) set.add(p);
    }
    if (service === 'system') {
      for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
        if (!agg.forward) continue;
        for (const p of expand(agg.path)) set.add(p);
      }
    }
    map.set(service, set);
  }
  return map;
}

export interface MqttBridgeConnectionOptions {
  installation: VrmInstallation;
  pool: VrmBrokerPool;
  ha: HaBrokerClient;
  publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
  /** Throttle flush interval in ms. 0 = bypass (publish every message directly). Default 500. */
  throttleIntervalMs?: number;
  /** Shared global throttle across all installations. If provided, throttleIntervalMs is ignored. */
  globalThrottle?: RollingMessageThrottle;
  /** brokerPortalId → idSite lookup; undefined means "drop the message". */
  getIdSite?: (brokerPortalId: string) => number | undefined;
  /** Staleness timeout in ms. 0 = disable. Default 300_000. */
  offlineTimeoutMs?: number;
}

export class MqttBridgeConnection {
  private readonly installation: VrmInstallation;
  private client: MqttClient | null = null;
  private readonly pool: VrmBrokerPool;
  private readonly ha: HaBrokerClient;
  private readonly publisher: Pick<DiscoveryPublisher, 'publishAvailability' | 'publishInstallation' | 'pruneRetainedTopics' | 'refreshInstallationDiscovery'>;
  private readonly throttle: RollingMessageThrottle;
  private readonly getIdSite: (brokerPortalId: string) => number | undefined;
  private readonly subscribeTopics: string[];
  private readonly keepaliveTopic: string;
  private readonly aggregator: AggregateProcessor;
  /** Paths the bridge forwards to HA (verbatim VRM message → vrm/{idSite}/...).
   *  Built once at construction from SERVICE_ENTITY_DEFS + CUSTOM_ENTITY_DEFS.
   *  Only paths with forward: true end up here. */
  private readonly forwardPaths: ReadonlyMap<VrmServiceName, ReadonlySet<string>>;
  private readonly offlineTimeoutMs: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private isFirstKeepalive = true;
  /** True between the moment the staleness watchdog (or transport offline) publishes
   *  availability=offline and the moment a forwarded message republishes
   *  availability=online. Starts true so we don't claim online before VRM has
   *  actually sent us data. */
  private isStale = true;
  /** HA-side topics this connection has forwarded; cleared on stop() so the broker
   *  doesn't keep the old installation's last value retained. */
  private readonly publishedStateTopics = new Set<string>();
  /** (service, instance) pairs that have sent forwarded traffic. system/platform
   *  are seeded with instance '0' at construction; all others discovered dynamically. */
  private readonly observedInstances: Map<VrmServiceName, Set<string>> = new Map([
    ['system', new Set(['0'])],
    ['platform', new Set(['0'])],
  ]);

  // Pre-bound so client.off() can remove the exact same reference
  private readonly boundHandleConnect: () => void;
  private readonly boundHandleMessage: (topic: string, payload: Buffer) => void;
  private readonly boundHandleError: (err: Error) => void;
  private readonly boundHandleOffline: () => void;
  private readonly boundHandleReconnect: () => void;

  constructor({ installation, pool, ha, publisher, throttleIntervalMs = 500, globalThrottle, getIdSite, offlineTimeoutMs = 300_000 }: MqttBridgeConnectionOptions) {
    this.ha = ha;
    this.publisher = publisher;
    this.installation = installation;
    this.pool = pool;
    this.subscribeTopics = this.buildSubscribeTopics();
    this.keepaliveTopic = `R/${installation.brokerPortalId}/keepalive`;
    this.throttle = globalThrottle ?? new RollingMessageThrottle(throttleIntervalMs, (topic, payload): void => ha.publish(topic, payload));
    this.getIdSite = getIdSite ?? ((): undefined => undefined);
    this.aggregator = this.buildAggregator(offlineTimeoutMs);
    this.forwardPaths = computeForwardPaths();
    this.offlineTimeoutMs = offlineTimeoutMs;

    this.boundHandleConnect = (): void => { this.handleConnect(); };
    this.boundHandleMessage = (topic, payload): void => { this.handleMessage(topic, payload); };
    this.boundHandleError = (err): void => { this.handleError(err); };
    this.boundHandleOffline = (): void => { this.handleOffline(); };
    this.boundHandleReconnect = (): void => {
      logger.info(`[MQTT] Reconnecting for ${this.installation.name} (${this.installation.identifier})`);
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
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.discoveryRefreshTimer !== null) {
      clearTimeout(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = null;
    }
    this.isStale = false;
    this.throttle.flush();
    // Drop our shard's map entry entirely (not just its contents) so a
    // removed/replaced installation doesn't leak an empty entry into the
    // shared throttle forever.
    this.throttle.removeShard(String(this.installation.idSite));

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
          logger.error(`[MQTT] Unsubscribe error for ${this.installation.identifier}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  private buildSubscribeTopics(): string[] {
    const id = this.installation.brokerPortalId;
    const topics: string[] = [];
    for (const { service, instanceSegment, paths } of getObservedPaths()) {
      for (const path of paths) {
        topics.push(`N/${id}/${service}/${instanceSegment}/${path}`);
      }
    }
    return topics;
  }

  private handleConnect(): void {
    if (!this.client) return;
    this.isFirstKeepalive = true;
    this.throttle.start();

    this.client.subscribe(this.subscribeTopics, { qos: 0 }, (err) => {
      if (err) {
        logger.error(`[MQTT] Subscribe failed for ${this.installation.identifier}: ${err.message}`);
      } else {
        logger.debug(`[MQTT] Subscribed ${this.subscribeTopics.length} topics for ${this.installation.identifier}`);
      }
    });

    this.publisher.publishInstallation(this.installation.idSite, this.installation.name, this.observedInstances);
    this.publisher.publishAvailability(this.installation.idSite, false);
    this.touch();
    // Fire-and-forget cleanup of stale retained topics from prior runs whose
    // entity defs are no longer in the forward set. Best-effort — failures
    // are logged at the wire-up site, never raised into handleConnect.
    this.publisher.pruneRetainedTopics(this.installation.idSite, this.observedInstances).catch((err) => {
      logger.error(`[HA] Prune failed for idSite=${this.installation.idSite}:`, err);
    });
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
        logger.error(`[MQTT] Keepalive failed for ${this.installation.identifier}: ${err.message}`);
      }
    });
  }

  private touch(): void {
    if (this.offlineTimeoutMs <= 0) return;
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.isStale = true;
      logger.info(`[MQTT] ${this.installation.name} (${this.installation.identifier}) stale — no updates for ${this.offlineTimeoutMs}ms`);
      this.publisher.publishAvailability(this.installation.idSite, false);
    }, this.offlineTimeoutMs);
  }

  /** Republish availability=online iff we are currently considered stale.
   *  Called when we have positive evidence of liveness (a forwarded message). */
  private markOnline(): void {
    if (this.isStale) {
      this.isStale = false;
      this.publisher.publishAvailability(this.installation.idSite, true);
    }
  }

  /** Re-publish availability reflecting our actual current state (not blindly
   *  online). Called after an HA birth event — a broker reconnect must not
   *  override a connection that is genuinely stale. */
  republishAvailability(): void {
    this.publisher.publishAvailability(this.installation.idSite, !this.isStale);
  }

  private scheduleDiscoveryRefresh(): void {
    if (this.discoveryRefreshTimer !== null) return;
    this.discoveryRefreshTimer = setTimeout(() => {
      this.discoveryRefreshTimer = null;
      this.onDiscoveryRefreshFire();
    }, DISCOVERY_REFRESH_DEBOUNCE_MS);
  }

  private onDiscoveryRefreshFire(): void {
    // Task 7 replaces this with the real refresh + prune re-run.
  }

  publishToVrm(topic: string, payload: string): void {
    // No client means start() was never called — drop the command silently.
    if (!this.client) return;
    this.client.publish(topic, payload, { qos: 0 }, (err) => {
      if (err) {
        logger.error(`[MQTT] Publish error for ${this.installation.identifier}: ${err.message}`);
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

  /** Snapshot of every (service, instance) pair this connection has forwarded traffic for. Read-only for callers. */
  get observedInstancesSnapshot(): ReadonlyMap<VrmServiceName, ReadonlySet<string>> {
    return this.observedInstances;
  }

  private handleMessage(topic: string, payload: Buffer): void {
    if (!topic.startsWith(`N/${this.installation.brokerPortalId}/`)) return;

    const str = payload.toString();
    const parsed = parseVrmTopic(topic);
    if (!parsed) return;

    let haPublished = false;

    // Aggregate feed — always run for every parsed topic. The aggregator
    // no-ops on untracked paths.
    for (const agg of this.aggregator.feedPayload(parsed.path, str)) {
      this.publishedStateTopics.add(agg.topic);
      this.throttle.enqueue(agg.topic, agg.payload);
      haPublished = true;
    }

    // HA forward — only for forward: true entities, scoped to the message's own service.
    if (this.forwardPaths.get(parsed.service as VrmServiceName)?.has(parsed.path)) {
      const service = parsed.service as VrmServiceName;
      let instances = this.observedInstances.get(service);
      if (!instances) {
        instances = new Set<string>();
        this.observedInstances.set(service, instances);
      }
      instances.add(parsed.instance);
      // (Task 4 hooks a "was this new?" signal in here.)

      const out = routeFromVrm(topic, str, this.getIdSite);
      for (const msg of out) {
        this.publishedStateTopics.add(msg.topic);
        this.throttle.enqueue(msg.topic, msg.payload);
        haPublished = true;
      }
    }

    if (haPublished) {
      this.markOnline();
      this.touch();
    }
  }

  /**
   * Build an AggregateProcessor from CUSTOM_ENTITY_DEFS.aggregate.
   * Only forward: true aggregates are wired up — non-forward aggregates
   * are still subscribed (their sources are in getObservedPaths) but the
   * processor never produces output for them.
   *
   * Source-path templates are expanded using the same L-phase indices
   * that getObservedPaths() uses for subscription. Literal templates are
   * kept as-is. The processor's observed-sources set then narrows the sum
   * to whichever phases actually report on this installation.
   */
  private buildAggregator(sourceExpiryMs: number): AggregateProcessor {
    const rules: AggregateRule[] = [];
    for (const def of CUSTOM_ENTITY_DEFS.aggregate) {
      if (!def.forward) continue;
      const sourcePaths = expandAggregateSourcePaths(def.aggregateFrom);
      if (sourcePaths.length === 0) continue;
      rules.push({
        targetTopic: `vrm/${this.installation.idSite}/custom/aggregate/${def.path}`,
        sourcePaths,
      });
    }
    // Reuse the connection's own staleness window: a phase that stops
    // reporting for longer than we'd tolerate for the whole installation
    // shouldn't keep contributing a stale value to the aggregate.
    return new AggregateProcessor(rules, sourceExpiryMs);
  }

  /**
   * Update the installation name (called by InstallationManager when the VRM API
   * returns a changed name). Re-publishes discovery so HA picks up the new name.
   */
  updateName(newName: string): void {
    if (this.installation.name === newName) return;
    this.installation.name = newName;
    this.publisher.publishInstallation(this.installation.idSite, newName, this.observedInstances);
  }

  private handleError(err: Error): void {
    logger.error(`[MQTT] Error for ${this.installation.name} (${this.installation.identifier}): ${err.message}`);
  }

  private handleOffline(): void {
    logger.info(`[MQTT] ${this.installation.name} (${this.installation.identifier}) offline`);
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    this.throttle.flush();
    this.isStale = true;
    this.publisher.publishAvailability(this.installation.idSite, false);
  }
}
