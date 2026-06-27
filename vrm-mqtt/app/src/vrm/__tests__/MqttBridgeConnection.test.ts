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
  mqttHost: 'mqtt5.victronenergy.com',
  mqttWebHost: 'webmqtt5.victronenergy.com',
};

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

function makeMockHa() {
  return { publish: jest.fn() };
}
function makeMockPublisher() {
  return { publishAvailability: jest.fn(), publishInstallation: jest.fn() };
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

    it('subscribes to the 7 summary topics and sends empty keepalive after connect event', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      client.emit('connect');

      expect(client.subscribe).toHaveBeenCalledWith(
        expect.arrayContaining([
          `N/${installation.identifier}/system/0/Dc/Pv/Power`,
          `N/${installation.identifier}/system/0/Dc/Battery/Soc`,
          `N/${installation.identifier}/system/0/Ac/Grid/+/Power`,
        ]),
        { qos: 0 },
        expect.any(Function),
      );
      expect(client.publish).toHaveBeenCalledWith(
        `R/${installation.identifier}/keepalive`,
        '',
        { qos: 0 },
        expect.any(Function),
      );
    });

    it('subscribes to exactly 7 topics', () => {
      const client = makeMockClient(false);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();
      client.emit('connect');

      const topics = (client.subscribe as jest.Mock).mock.calls[0][0] as string[];
      expect(topics).toHaveLength(7);
    });
  });

  describe('start() with already-connected client', () => {
    it('immediately subscribes and sends empty keepalive', () => {
      const client = makeMockClient(true);
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
      conn.start();

      expect(client.subscribe).toHaveBeenCalledTimes(1);
      expect(client.publish).toHaveBeenCalledWith(
        `R/${installation.identifier}/keepalive`,
        '',
        { qos: 0 },
        expect.any(Function),
      );
    });
  });

  describe('discovery published on connect', () => {
    it('calls publishInstallation with portalId and name on connect', () => {
      const client = makeMockClient(false);
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never });
      conn.start();

      expect(publisher.publishInstallation).not.toHaveBeenCalled();
      client.emit('connect');
      expect(publisher.publishInstallation).toHaveBeenCalledWith(
        installation.identifier,
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
      const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: ha as never, publisher: makeMockPublisher() as never });
      conn.start();
      jest.advanceTimersByTime(500);

      client.emit('message', `N/${installation.identifier}/system/0/Dc/Battery/Soc`, Buffer.from('{"value":42}'));
      jest.advanceTimersByTime(500);

      expect(ha.publish).toHaveBeenCalledWith(
        `vrm/${installation.identifier}/system/0/Dc/Battery/Soc`,
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
        expect.arrayContaining([`N/${installation.identifier}/system/0/Dc/Pv/Power`]),
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
        installation.identifier,
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
        installation.identifier,
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

  describe('throttle behaviour', () => {
    const portalId = installation.identifier;
    const INTERVAL = 100;

    function makeThrottledConn() {
      const client = makeMockClient(false);
      const ha = makeMockHa();
      const publisher = makeMockPublisher();
      const conn = new MqttBridgeConnection({
        installation,
        pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool,
        ha: ha as never,
        publisher: publisher as never,
        throttleIntervalMs: INTERVAL,
      });
      conn.start();
      client.emit('connect');
      return { client, ha, publisher, conn };
    }

    function emit(client: ReturnType<typeof makeMockClient>, topic: string, payload: string) {
      client.emit('message', topic, Buffer.from(payload));
    }

    it('does not forward messages to HA until the interval fires', () => {
      const { client, ha } = makeThrottledConn();
      emit(client, `N/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
      expect(ha.publish).not.toHaveBeenCalledWith(expect.stringContaining('vrm/'), expect.anything());
      jest.advanceTimersByTime(INTERVAL);
      expect(ha.publish).toHaveBeenCalledWith(`vrm/${portalId}/system/0/Dc/Battery/Soc`, '{"value":80}');
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
      expect(stateCalls[0]).toEqual([`vrm/${portalId}/system/0/Dc/Battery/Soc`, '{"value":82}']);
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
        `vrm/${portalId}/system/0/Dc/Battery/Soc`,
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
        `vrm/${portalId}/system/0/Dc/Battery/Soc`,
        '{"value":80}',
      );
    });
  });
});
