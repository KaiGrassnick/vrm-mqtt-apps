import { EventEmitter } from 'events';
import type { MqttClient } from 'mqtt';
import { MqttBridgeConnection } from '../MqttBridgeConnection';
import type { VrmInstallation } from '../types';
import type { VrmBrokerPool } from '../VrmBrokerPool';

const SUPPRESS = JSON.stringify({ 'keepalive-options': ['suppress-republish'] });

const installation: VrmInstallation = {
  idSite: 1,
  name: 'Test Site',
  identifier: 'test-portal-abcd1234',
  brokerPortalId: 'test-portal-abcd1234',
  mqttHost: 'mqtt5.victronenergy.com',
  mqttWebHost: 'webmqtt5.victronenergy.com',
};

const { identifier: _PORTAL, brokerPortalId: PORTAL } = installation;

const idSiteFor = (inst: VrmInstallation): ((brokerPortalId: string) => number | undefined) =>
  (brokerPortalId: string): number | undefined =>
    (brokerPortalId === inst.brokerPortalId ? inst.idSite : undefined);

function makeMockClient(connected = false): EventEmitter & { connected: boolean; subscribe: jest.Mock; unsubscribe: jest.Mock; publish: jest.Mock; off: jest.Mock } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connected,
    subscribe: jest.fn((_topic: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      cb?.(null);
    }),
    unsubscribe: jest.fn((_topic: string, cb?: (err: Error | null) => void) => {
      cb?.(null);
    }),
    publish: jest.fn(
      (_topic: string, _payload: string, _opts: unknown, cb?: (err: Error | undefined) => void) => {
        cb?.(undefined);
      },
    ),
    off: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
      emitter.removeListener(event, fn);
    }),
  });
}

function makeMockHa(): { publish: jest.Mock } {
  return { publish: jest.fn() };
}
function makeMockPublisher(): {
  publishAvailability: jest.Mock;
  publishInstallation: jest.Mock;
  pruneRetainedTopics: jest.Mock;
} {
  return {
    publishAvailability: jest.fn(),
    publishInstallation: jest.fn(),
    pruneRetainedTopics: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockPool(client: MqttClient): {
  getOrCreate: jest.Mock;
  destroyAll: jest.Mock;
} {
  return {
    getOrCreate: jest.fn().mockReturnValue(client),
    destroyAll: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MqttBridgeConnection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('lazy pool access', () => {
    it('calls pool.getOrCreate with installation.mqttHost when start() is called', () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const conn = new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: makeMockPublisher() as never,
      });
      conn.start();
      expect(pool.getOrCreate).toHaveBeenCalledTimes(1);
      expect(pool.getOrCreate).toHaveBeenCalledWith(installation.mqttHost);
    });

    it('does not call pool.getOrCreate before start() is called', () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: makeMockPublisher() as never,
      });
      expect(pool.getOrCreate).not.toHaveBeenCalled();
    });

    it('publishToVrm() is a no-op when start() was never called', () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const conn = new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: makeMockPublisher() as never,
      });
      expect(() => conn.publishToVrm('W/portal/x/y', '{"value":1}')).not.toThrow();
      expect(pool.getOrCreate).not.toHaveBeenCalled();
      expect(client.publish).not.toHaveBeenCalled();
    });
  });

  describe('start() with disconnected client', () => {
    it('does not subscribe or publish before connect event', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      expect(client.subscribe).not.toHaveBeenCalled();
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('subscribes to the derived observed paths and sends empty keepalive after connect event', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      client.emit('connect');

      expect(client.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([
          `N/${PORTAL}/system/0/Dc/Pv/Power`,
          `N/${PORTAL}/system/0/Dc/Battery/Soc`,
          `N/${PORTAL}/system/0/Ac/Grid/L1/Power`,
        ]),
        { qos: 0 },
        expect.any(Function),
      );
      expect(client.publish).toHaveBeenCalledWith(
        `R/${PORTAL}/keepalive`,
        '',
        { qos: 0 },
        expect.any(Function),
      );
    });

    it('subscribes to every forward: true entity path expanded for L-phases', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      client.emit('connect');

      const topics = (client.subscribe as jest.Mock).mock.calls[0][0] as string[];
      // forward: true entities (template-expanded) + aggregate sources (template-expanded).
      // 3 forward literals + 16 aggregate-source paths = 19.
      expect(topics).toHaveLength(19);
    });
  });

  describe('start() with already-connected client', () => {
    it('immediately subscribes and sends empty keepalive', () => {
      const client = makeMockClient(true);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      expect(client.subscribe).toHaveBeenCalledTimes(1);
      expect(client.publish).toHaveBeenCalledWith(
        `R/${PORTAL}/keepalive`,
        '',
        { qos: 0 },
        expect.any(Function),
      );
    });
  });

  describe('discovery published on connect', () => {
    it('calls publishInstallation with idSite and name on connect', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();

      expect(publisher.publishInstallation).not.toHaveBeenCalled();
      client.emit('connect');
      expect(publisher.publishInstallation).toHaveBeenCalledWith(
        installation.idSite,
        installation.name,
      );
    });

    it('re-publishes discovery on reconnect', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();
      client.emit('connect');
      client.emit('connect');
      expect(publisher.publishInstallation).toHaveBeenCalledTimes(2);
    });
  });

  describe('keepalive payload sequence', () => {
    it('sends empty payload first, suppress-republish on subsequent ticks', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      client.emit('connect');

      const firstCall = (client.publish as jest.Mock).mock.calls[0] as [string, string, unknown, unknown];
      expect(firstCall[1]).toBe('');

      jest.advanceTimersByTime(30_000);
      const secondCall = (client.publish as jest.Mock).mock.calls[1] as [string, string, unknown, unknown];
      expect(secondCall[1]).toBe(SUPPRESS);

      jest.advanceTimersByTime(30_000);
      const thirdCall = (client.publish as jest.Mock).mock.calls[2] as [string, string, unknown, unknown];
      expect(thirdCall[1]).toBe(SUPPRESS);
    });

    it('resets to empty keepalive after reconnect', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      client.emit('connect');
      jest.advanceTimersByTime(30_000); // now in STEADY state

      // Reconnect — should reset
      client.emit('connect');
      const calls = (client.publish as jest.Mock).mock.calls as [string, string, unknown, unknown][];
      const lastPayload = calls[calls.length - 1][1];
      expect(lastPayload).toBe('');
    });
  });

  describe('message filtering', () => {
    it('ignores messages for other installation identifiers', () => {
      const client = makeMockClient(true);
      const ha = makeMockHa();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: ha as never, publisher: makeMockPublisher() as never });
      conn.start();
      jest.advanceTimersByTime(500);

      client.emit('message', 'N/otheridentifier/system/0/Ac', Buffer.from('{"value":1}'));
      jest.advanceTimersByTime(500);

      expect(ha.publish).not.toHaveBeenCalled();
    });

    it('delivers messages for the correct installation identifier', () => {
      const client = makeMockClient(true);
      const ha = makeMockHa();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: ha as never, publisher: makeMockPublisher() as never, getIdSite: idSiteFor(installation) });
      conn.start();
      jest.advanceTimersByTime(500);

      client.emit('message', `N/${PORTAL}/system/0/Dc/Battery/Soc`, Buffer.from('{"value":42}'));
      jest.advanceTimersByTime(500);

      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${installation.idSite}/system/0/Dc/Battery/Soc`,
        '{"value":42}',
      );
    });
  });

  describe('stop()', () => {
    it('clears the keepalive timer', async () => {
      const client = makeMockClient(true);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      const publishCountBefore = (client.publish as jest.Mock).mock.calls.length;
      await conn.stop();

      jest.advanceTimersByTime(60_000);
      expect((client.publish as jest.Mock).mock.calls.length).toBe(publishCountBefore);
    });

    it('calls unsubscribe for the installation topics', async () => {
      const client = makeMockClient(true);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      await conn.stop();

      expect(client.unsubscribe).toHaveBeenCalledWith(
        expect.arrayContaining([`N/${PORTAL}/system/0/Dc/Pv/Power`]),
        expect.any(Function),
      );
    });

    it('removes all event listeners from the client', async () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      await conn.stop();

      expect(client.listenerCount('connect')).toBe(0);
      expect(client.listenerCount('message')).toBe(0);
      expect(client.listenerCount('error')).toBe(0);
      expect(client.listenerCount('offline')).toBe(0);
      expect(client.listenerCount('reconnect')).toBe(0);
    });

    it('does not publish keepalives after stop even if connect fires', async () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      await conn.stop();

      (client.publish as jest.Mock).mockClear();
      client.emit('connect');
      jest.advanceTimersByTime(60_000);

      expect(client.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateName', () => {
    it('is a no-op when the name has not changed', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();
      client.emit('connect');
      publisher.publishInstallation.mockClear();

      conn.updateName(installation.name);
      expect(publisher.publishInstallation).not.toHaveBeenCalled();
    });

    it('republishes discovery with new name when name changes', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();
      client.emit('connect');
      publisher.publishInstallation.mockClear();

      conn.updateName('Renamed Site');
      expect(publisher.publishInstallation).toHaveBeenCalledWith(
        installation.idSite,
        'Renamed Site',
      );
    });

    it('works even before any connect event fires', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();

      conn.updateName('Early Rename');
      expect(publisher.publishInstallation).toHaveBeenCalledWith(
        installation.idSite,
        'Early Rename',
      );
    });
  });

  describe('offline event', () => {
    it('clears keepalive timer when client goes offline', () => {
      const client = makeMockClient(true);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      const publishCountBefore = (client.publish as jest.Mock).mock.calls.length;
      client.emit('offline');

      jest.advanceTimersByTime(60_000);
      expect((client.publish as jest.Mock).mock.calls.length).toBe(publishCountBefore);
    });
  });

  describe('staleness watchdog', () => {
    const portalId = installation.brokerPortalId;
    const idSite = installation.idSite;
    const TIMEOUT = 1000;

    function makeConn(opts: { offlineTimeoutMs: number; connected?: boolean }): {
      client: ReturnType<typeof makeMockClient>;
      publisher: ReturnType<typeof makeMockPublisher>;
      conn: MqttBridgeConnection;
    } {
      const client = makeMockClient(opts.connected ?? false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({
        installation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: publisher as never,
        getIdSite: idSiteFor(installation),
        offlineTimeoutMs: opts.offlineTimeoutMs,
      });
      conn.start();
      if (opts.connected ?? false) {
        // already-connected client triggers handleConnect on start() (line 146-148)
      } else {
        client.emit('connect');
      }
      return { client, publisher, conn };
    }

    function emitForwarded(client: ReturnType<typeof makeMockClient>): void {
      // Dc/Battery/Soc is in the forward set (SERVICE_ENTITY_DEFS.system).
      client.emit('message', `N/${portalId}/system/0/Dc/Battery/Soc`, Buffer.from('{"value":80}'));
    }

    function emitUnobserved(client: ReturnType<typeof makeMockClient>): void {
      // Not in forwardPaths and not an aggregate source — observed but not forwarded.
      client.emit('message', `N/${portalId}/system/0/Some/Unobserved/Path`, Buffer.from('{"value":1}'));
    }

    function emitAggregateSource(client: ReturnType<typeof makeMockClient>): void {
      // Dc/Pv/Power is one of the aggregate sources for CUSTOM_ENTITY_DEFS.aggregate's
      // Pv/Power rule. Emitting it triggers the aggregator to fire, which exercises
      // handleMessage's touch() path through the aggregate branch.
      client.emit('message', `N/${portalId}/system/0/Dc/Pv/Power`, Buffer.from('{"value":100}'));
    }

    it('marks installation offline after the configured silence', () => {
      const { publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenCalledWith(idSite, false);
    });

    it('does not mark offline while forwarded messages keep arriving', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      // handleConnect always publishes one baseline offline call on connect
      // (starts stale until proven otherwise) — count beyond that baseline.
      const offlineCallsAtConnect = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      ).length;
      jest.advanceTimersByTime(TIMEOUT - 1);
      emitForwarded(client);
      jest.advanceTimersByTime(TIMEOUT - 1);
      emitForwarded(client);
      jest.advanceTimersByTime(TIMEOUT - 1);
      const offlineCalls = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      );
      expect(offlineCalls).toHaveLength(offlineCallsAtConnect);
    });

    it('unobserved paths do not reset the timer', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      emitUnobserved(client);
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenCalledWith(idSite, false);
    });

    it('aggregate output resets the timer', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      // handleConnect always publishes one baseline offline call on connect
      // (starts stale until proven otherwise) — count beyond that baseline.
      const offlineCallsAtConnect = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      ).length;
      // Sanity: the aggregate source path is observed.
      emitAggregateSource(client);
      jest.advanceTimersByTime(TIMEOUT - 1);
      // If the aggregate fired (publishedStateTopics grew), the timer reset.
      const offlineCalls = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      );
      expect(offlineCalls).toHaveLength(offlineCallsAtConnect);
    });

    it('handleOffline clears the timer (no double offline publish)', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      jest.advanceTimersByTime(TIMEOUT / 2);
      client.emit('offline');
      const callsAtOffline = (publisher.publishAvailability as jest.Mock).mock.calls.length;
      jest.advanceTimersByTime(TIMEOUT * 3);
      expect((publisher.publishAvailability as jest.Mock).mock.calls.length).toBe(callsAtOffline);
    });

    it('stop() clears the timer', async () => {
      const { conn, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      jest.advanceTimersByTime(TIMEOUT / 2);
      const callsBeforeStop = (publisher.publishAvailability as jest.Mock).mock.calls.length;
      await conn.stop();
      jest.advanceTimersByTime(TIMEOUT * 3);
      expect((publisher.publishAvailability as jest.Mock).mock.calls.length).toBe(callsBeforeStop);
    });

    it('offlineTimeoutMs=0 disables the watchdog', () => {
      const { publisher } = makeConn({ offlineTimeoutMs: 0 });
      // handleConnect always publishes one baseline offline call on connect
      // (starts stale until proven otherwise) — count beyond that baseline.
      const offlineCallsAtConnect = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      ).length;
      jest.advanceTimersByTime(60 * 60 * 1000);
      const offlineCalls = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === false,
      );
      expect(offlineCalls).toHaveLength(offlineCallsAtConnect);
    });

    it('does not publish availability online on first-ever connect (starts offline until a message arrives)', () => {
      const { publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      const onlineCalls = (publisher.publishAvailability as jest.Mock).mock.calls.filter(
        ([_id, online]: [number, boolean]) => online === true,
      );
      expect(onlineCalls).toHaveLength(0);
    });

    it('flips availability to online on the first forwarded message after first-ever connect', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      // Only the baseline offline publish from connect so far — no online yet.
      expect(publisher.publishAvailability).toHaveBeenCalledTimes(1);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, false);
      emitForwarded(client);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, true);
    });

    it('flips availability back to online when a forwarded message arrives after the staleness watchdog fired', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      // Silence period elapses → watchdog fires → offline.
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, false);

      // A forwarded VRM message arrives after the silence → recovery.
      emitForwarded(client);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, true);
    });

    it('does not flip to online on recovery for messages that do not touch the timer', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, false);

      // Unobserved message → no touch() → no online flip.
      emitUnobserved(client);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, false);
    });

    it('reconnect re-arms the timer', () => {
      const { client, publisher } = makeConn({ offlineTimeoutMs: TIMEOUT });
      const countOffline = (): number =>
        (publisher.publishAvailability as jest.Mock).mock.calls.filter(
          ([_id, online]: [number, boolean]) => online === false,
        ).length;

      // First staleness window: no messages → fires after TIMEOUT+1 (on top of
      // the baseline offline call handleConnect always publishes on connect).
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenCalledWith(idSite, false);
      const offlineCallsBeforeReconnect = countOffline();

      // Reconnect: handleConnect republishes the baseline offline call and re-arms the timer.
      client.emit('connect');
      expect(countOffline()).toBe(offlineCallsBeforeReconnect + 1);

      jest.advanceTimersByTime(TIMEOUT - 1);
      // No NEW offline call yet — the post-reconnect window hasn't elapsed.
      expect(countOffline()).toBe(offlineCallsBeforeReconnect + 1);

      jest.advanceTimersByTime(2);
      // Second staleness window elapsed: timer fires again.
      expect(countOffline()).toBe(offlineCallsBeforeReconnect + 2);
    });

    it('republishAvailability() re-publishes offline when stale (HA birth must not override a genuinely offline installation)', () => {
      const { publisher, conn } = makeConn({ offlineTimeoutMs: TIMEOUT });
      jest.advanceTimersByTime(TIMEOUT + 1);
      expect(publisher.publishAvailability).toHaveBeenLastCalledWith(idSite, false);

      (publisher.publishAvailability as jest.Mock).mockClear();
      conn.republishAvailability();
      expect(publisher.publishAvailability).toHaveBeenCalledWith(idSite, false);
    });

    it('republishAvailability() re-publishes online when not stale', () => {
      const { client, publisher, conn } = makeConn({ offlineTimeoutMs: TIMEOUT });
      emitForwarded(client);

      (publisher.publishAvailability as jest.Mock).mockClear();
      conn.republishAvailability();
      expect(publisher.publishAvailability).toHaveBeenCalledWith(idSite, true);
    });
  });

  describe('throttle behaviour', () => {
    const portalId = installation.brokerPortalId;
    const idSite = installation.idSite;
    const INTERVAL = 100;

    function makeThrottledConn(): {
      client: ReturnType<typeof makeMockClient>;
      ha: ReturnType<typeof makeMockHa>;
      publisher: ReturnType<typeof makeMockPublisher>;
      conn: MqttBridgeConnection;
    } {
      const client = makeMockClient(false);
      const ha = makeMockHa();
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({
        installation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: ha as never,
        publisher: publisher as never,
        throttleIntervalMs: INTERVAL,
        getIdSite: idSiteFor(installation),
      });
      conn.start();
      client.emit('connect');
      return { client, ha, publisher, conn };
    }

    function emit(client: ReturnType<typeof makeMockClient>, topic: string, payload: string): void {
      client.emit('message', topic, Buffer.from(payload));
    }

    it('does not forward messages to HA until the interval fires', () => {
      const { client, ha } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      expect(ha.publish).not.toHaveBeenCalledWith(expect.stringContaining('vrm/'), expect.anything());
      jest.advanceTimersByTime(INTERVAL);
      expect(ha.publish).toHaveBeenCalledWith(`vrm/${idSite}/system/0/Dc/Battery/Soc`, '{"value":80}');
    });

    it('coalesces rapid updates for the same topic to a single publish', () => {
      const { client, ha } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":81}');
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":82}');
      jest.advanceTimersByTime(INTERVAL);
      const stateCalls = (ha.publish as jest.Mock).mock.calls.filter(
        ([t]: [string]) => t.startsWith('vrm/'),
      );
      expect(stateCalls).toHaveLength(1);
      expect(stateCalls[0]).toEqual([`vrm/${idSite}/system/0/Dc/Battery/Soc`, '{"value":82}']);
    });

    it('flushes buffered messages before publishing availability=offline', () => {
      const { client, ha, publisher } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');

      client.emit('offline');

      const haCalls = (ha.publish as jest.Mock).mock.calls as [string, string][];
      const stateCall = haCalls.find(([t]) => t.startsWith('vrm/') && !t.endsWith('/availability'));
      const availabilityCall = (publisher.publishAvailability as jest.Mock).mock.calls[0];

      expect(stateCall).toBeDefined();
      expect(availabilityCall).toBeDefined();
    });

    it('flushes buffered messages on stop()', async () => {
      const { client, ha, conn } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      await conn.stop();
      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Dc/Battery/Soc`,
        '{"value":80}',
      );
    });

    it('resets the throttle timer on reconnect without losing mid-buffer messages', () => {
      const { client, ha } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      // reconnect before interval fires — timer re-arms, buffer preserved
      client.emit('connect');
      jest.advanceTimersByTime(INTERVAL);
      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Dc/Battery/Soc`,
        '{"value":80}',
      );
    });
  });

  describe('replaced installation (USEDASREPLACEMENT in identifier)', () => {
    const replacedInstallation: VrmInstallation = {
      idSite: 2,
      name: 'Replaced Site',
      identifier: 'samplePortalId - USEDASREPLACEMENT AT 1234567890',
      brokerPortalId: 'samplePortalId',
      mqttHost: 'mqtt7.victronenergy.com',
      mqttWebHost: 'webmqtt7.victronenergy.com',
    };

    it('subscribes using brokerPortalId, not identifier', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({
        installation: replacedInstallation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: makeMockPublisher() as never,
      });
      conn.start();
      client.emit('connect');

      expect(client.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([`N/${replacedInstallation.brokerPortalId}/system/0/Dc/Pv/Power`]),
        { qos: 0 },
        expect.any(Function),
      );
      expect(client.subscribe).toHaveBeenCalledWith(
        expect.not.arrayContaining([expect.stringContaining('USEDASREPLACEMENT')]),
        { qos: 0 },
        expect.any(Function),
      );
    });

    it('sends keepalive to R/{brokerPortalId}/keepalive', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({
        installation: replacedInstallation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: makeMockPublisher() as never,
      });
      conn.start();
      client.emit('connect');

      expect(client.publish).toHaveBeenCalledWith(
        `R/${replacedInstallation.brokerPortalId}/keepalive`,
        '',
        { qos: 0 },
        expect.any(Function),
      );
    });

    it('ignores messages whose topic carries the suffixed identifier', () => {
      // Spec invariant: handleMessage filters by brokerPortalId, never by the
      // raw identifier. If a message arrives on N/{identifier-with-marker}/...,
      // the connection drops it — the broker never publishes there, but the
      // filter must hold defensively.
      const client = makeMockClient(true);
      const ha = makeMockHa();
      const conn = new MqttBridgeConnection({
        installation: replacedInstallation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: ha as never,
        publisher: makeMockPublisher() as never,
      });
      conn.start();
      jest.advanceTimersByTime(500);

      client.emit(
        'message',
        `N/${replacedInstallation.identifier}/system/0/Dc/Battery/Soc`,
        Buffer.from('{"value":42}'),
      );
      jest.advanceTimersByTime(500);

      expect(ha.publish).not.toHaveBeenCalled();
    });
  });

  describe('retained state topic cleanup', () => {
    const portalId = installation.brokerPortalId;
    const idSite = installation.idSite;
    const INTERVAL = 100;

    function makeActiveConn(): {
      client: ReturnType<typeof makeMockClient>;
      ha: ReturnType<typeof makeMockHa>;
      conn: MqttBridgeConnection;
    } {
      const client = makeMockClient(true);
      const ha = makeMockHa();
      const conn = new MqttBridgeConnection({
        installation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: ha as never,
        publisher: makeMockPublisher() as never,
        throttleIntervalMs: INTERVAL,
        getIdSite: idSiteFor(installation),
      });
      conn.start();
      client.emit('connect');
      return { client, ha, conn };
    }

    function emit(client: ReturnType<typeof makeMockClient>, topic: string, payload: string): void {
      client.emit('message', topic, Buffer.from(payload));
    }

    it('publishes empty-retained for each forwarded state topic on stop()', async () => {
      const { client, ha, conn } = makeActiveConn();

      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      jest.advanceTimersByTime(INTERVAL);
      emit(client, `N/${portalId}/system/0/Dc/Battery/Voltage`, '{"value":13.4}');
      jest.advanceTimersByTime(INTERVAL);

      (ha.publish as jest.Mock).mockClear();
      await conn.stop();

      // One retained-clear per tracked state topic, with empty payload and retained=true.
      const clears = (ha.publish as jest.Mock).mock.calls.filter(
        ([_t, p, r]: [string, string, boolean]) => p === '' && r === true,
      );
      const clearTopics = clears.map(([t]: [string]) => t).sort();
      expect(clearTopics).toEqual([
        `vrm/${idSite}/system/0/Dc/Battery/Soc`,
        `vrm/${idSite}/system/0/Dc/Battery/Voltage`,
      ].sort());
    });

    it('does not publish retained-clear for topics that were never forwarded', async () => {
      const { ha, conn } = makeActiveConn();
      await conn.stop();
      const clears = (ha.publish as jest.Mock).mock.calls.filter(
        ([_t, p, r]: [unknown, string, boolean]) => p === '' && r === true,
      );
      expect(clears).toEqual([]);
    });

    it('flushes buffered state before clearing retained, so the broker ends with empty payload retained', async () => {
      const { client, ha, conn } = makeActiveConn();

      // Buffer without flushing (don't advance time).
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');

      (ha.publish as jest.Mock).mockClear();
      await conn.stop();

      // Order on the broker for this topic: retained payload, then empty retained.
      const stateCalls = (ha.publish as jest.Mock).mock.calls.filter(
        ([t]: [string]) => t === `vrm/${idSite}/system/0/Dc/Battery/Soc`,
      );
      expect(stateCalls.map(([, p]: [string, string]) => p)).toEqual(['{"value":80}', '']);
    });
  });

  // ── aggregate sensors (L{n}/Power → custom/aggregate) ───────────────────────

  describe('aggregate sensors', () => {
    const portalId = installation.brokerPortalId;
    const idSite = installation.idSite;
    const INTERVAL = 100;

    function makeActiveConn(): {
      client: ReturnType<typeof makeMockClient>;
      ha: ReturnType<typeof makeMockHa>;
      conn: MqttBridgeConnection;
    } {
      const client = makeMockClient(true);
      const ha = makeMockHa();
      const conn = new MqttBridgeConnection({
        installation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: ha as never,
        publisher: makeMockPublisher() as never,
        throttleIntervalMs: INTERVAL,
        getIdSite: idSiteFor(installation),
      });
      conn.start();
      client.emit('connect');
      return { client, ha, conn };
    }

    function emit(client: ReturnType<typeof makeMockClient>, topic: string, payload: string): void {
      client.emit('message', topic, Buffer.from(payload));
    }

    function aggregateCalls(ha: ReturnType<typeof makeMockHa>, aggregateTopic: string): Array<[string, string]> {
      return (ha.publish as jest.Mock).mock.calls.filter(
        ([t]: [string]) => t === aggregateTopic,
      ) as Array<[string, string]>;
    }

    function aggregatePayloads(ha: ReturnType<typeof makeMockHa>, aggregateTopic: string): number[] {
      return aggregateCalls(ha, aggregateTopic)
        .map(([, p]: [string, string]) => JSON.parse(p).value as number);
    }

    it('publishes a one-phase sum when only L1 reports (single-phase install)', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;
      expect(aggregatePayloads(ha, aggTopic)).toEqual([100]);
    });

    it('publishes a three-phase sum when L1, L2, L3 all report (3-phase install)', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L2/Power`, '{"value":150}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L3/Power`, '{"value":50}');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;
      // Bridge publishes the aggregate once per L-phase update.
      // Final value: 100 + 150 + 50 = 300.
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(300);
    });

    it('recomputes the aggregate when an already-reported phase updates', () => {
      const { client, ha } = makeActiveConn();
      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;

      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L2/Power`, '{"value":150}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L3/Power`, '{"value":50}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":200}');
      jest.advanceTimersByTime(INTERVAL);

      // 200 + 150 + 50 = 400
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(400);
    });

    it('handles negative values (e.g. power flowing back to grid)', () => {
      const { client, ha } = makeActiveConn();
      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;

      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L2/Power`, '{"value":-200}');
      emit(client, `N/${portalId}/system/0/Ac/Grid/L3/Power`, '{"value":-50}');
      jest.advanceTimersByTime(INTERVAL);

      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(-150);
    });

    it('publishes Ac/Consumption aggregate from consumption L-phase values', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Consumption/L1/Power`, '{"value":300}');
      emit(client, `N/${portalId}/system/0/Ac/Consumption/L2/Power`, '{"value":400}');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Consumption/Power`;
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(700);
    });

    it('publishes Ac/Genset aggregate from genset L-phase values', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Genset/L1/Power`, '{"value":2000}');
      emit(client, `N/${portalId}/system/0/Ac/Genset/L2/Power`, '{"value":2100}');
      emit(client, `N/${portalId}/system/0/Ac/Genset/L3/Power`, '{"value":2200}');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Genset/Power`;
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(6300);
    });

    it('does not aggregate an unparseable payload', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, 'not-json');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;
      expect(aggregateCalls(ha, aggTopic)).toEqual([]);
    });

    it('does not aggregate a payload whose value is not numeric', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":"foo"}');
      jest.advanceTimersByTime(INTERVAL);

      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;
      expect(aggregateCalls(ha, aggTopic)).toEqual([]);
    });

    it('does NOT forward raw L-phase message to HA, but DOES forward the aggregate', () => {
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);

      // Raw L1 topic MUST NOT be published to HA (forward: false).
      expect(ha.publish).not.toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Ac/Grid/L1/Power`,
        expect.anything(),
      );
      // Aggregate IS published.
      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`,
        '{"value":100}',
      );
    });

    it('clears the aggregate buffer on stop() so a stale value is not retained', async () => {
      const { client, ha, conn } = makeActiveConn();
      const aggTopic = `vrm/${idSite}/custom/aggregate/Ac/Grid/Power`;

      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);
      // Confirm we published the aggregate.
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(100);

      (ha.publish as jest.Mock).mockClear();
      await conn.stop();

      // On stop, the aggregate topic must be cleared with empty retained —
      // otherwise HA would keep showing the last value across reconnects.
      const clears = (ha.publish as jest.Mock).mock.calls.filter(
        ([t, p, r]: [string, string, boolean]) => t === aggTopic && p === '' && r === true,
      );
      expect(clears).toHaveLength(1);
    });

    it('publishes Pv/Power from DC + AC sources', () => {
      const { client, ha } = makeActiveConn();
      const aggTopic = `vrm/${idSite}/custom/aggregate/Pv/Power`;

      emit(client, `N/${portalId}/system/0/Dc/Pv/Power`, '{"value":800}');
      emit(client, `N/${portalId}/system/0/Ac/PvOnOutput/L1/Power`, '{"value":100}');
      emit(client, `N/${portalId}/system/0/Ac/PvOnGrid/L1/Power`, '{"value":50}');
      jest.advanceTimersByTime(INTERVAL);

      // 800 + 100 + 50 = 950
      expect(aggregatePayloads(ha, aggTopic).at(-1)).toBe(950);
    });

    it('Pv/Power does not include Dc/Pv/Power as a forwarded topic', () => {
      // The per-source Dc/Pv/Power has forward: false. The bridge subscribes
      // to it (for the aggregate) but never publishes it to HA.
      const { client, ha } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Dc/Pv/Power`, '{"value":800}');
      jest.advanceTimersByTime(INTERVAL);

      expect(ha.publish).not.toHaveBeenCalledWith(
        `vrm/${idSite}/system/0/Dc/Pv/Power`,
        expect.anything(),
      );
    });

    it('does NOT clear retained state for subscribed-but-not-forwarded topics', async () => {
      // Ac/Grid/L1/Power is subscribed (needed as aggregate source) but
      // forward: false — the bridge never publishes it, so stop() must
      // not emit an empty-retained clear for it.
      const { client, ha, conn } = makeActiveConn();
      emit(client, `N/${portalId}/system/0/Ac/Grid/L1/Power`, '{"value":100}');
      jest.advanceTimersByTime(INTERVAL);

      (ha.publish as jest.Mock).mockClear();
      await conn.stop();

      const lphaseClear = (ha.publish as jest.Mock).mock.calls.filter(
        ([t]: [string]) => t === `vrm/${idSite}/system/0/Ac/Grid/L1/Power`,
      );
      expect(lphaseClear).toEqual([]);
    });
  });

  describe('pruneRetainedTopics wire-up', () => {
    it('calls publisher.pruneRetainedTopics(idSite) after connect', async () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({
        installation,
        pool: pool as unknown as VrmBrokerPool,
        ha: makeMockHa() as never,
        publisher: publisher as never,
      });
      conn.start();
      client.emit('connect');

      // handleConnect fires synchronously, but prune call scheduling uses
      // unhandled promise — let microtasks flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(publisher.pruneRetainedTopics).toHaveBeenCalledTimes(1);
      expect(publisher.pruneRetainedTopics).toHaveBeenCalledWith(installation.idSite);
    });

    it('does not block sendKeepalive when prune rejects', async () => {
      const client = makeMockClient(false);
      const pool = makeMockPool(client as unknown as MqttClient);
      const publisher = makeMockPublisher();
      const err = new Error('broker scan failed');
      // Silence the expected error log so the test output stays clean.
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      publisher.pruneRetainedTopics.mockRejectedValueOnce(err);

      try {
        const conn = new MqttBridgeConnection({
          installation,
          pool: pool as unknown as VrmBrokerPool,
          ha: makeMockHa() as never,
          publisher: publisher as never,
        });
        conn.start();
        client.emit('connect');

        // Drain microtasks so the .catch handler has run before we assert on it.
        await Promise.resolve();
        await Promise.resolve();

        // (a) The wire-up's .catch handler must have logged the failure.
        // Asserting this proves the catch is still attached — a future
        // maintainer who drops the .catch would surface an unhandled
        // rejection AND fail this assertion.
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringMatching(/\[HA\] Prune failed for idSite=1/),
          err,
        );

        // (b) sendKeepalive must still fire its publish (broker heartbeat)
        // regardless of the prune outcome.
        expect(client.publish).toHaveBeenCalledWith(
          expect.stringMatching(/^R\/.+\/keepalive$/),
          expect.any(String),
          expect.objectContaining({ qos: 0 }),
          expect.any(Function),
        );
      } finally {
        // Restore in finally so the spy is removed even if an assertion fails.
        errSpy.mockRestore();
      }
    });
  });
});
