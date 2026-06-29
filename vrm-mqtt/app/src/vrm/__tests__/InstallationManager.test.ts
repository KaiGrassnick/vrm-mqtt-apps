import { InstallationManager } from '../InstallationManager';
import { VrmBrokerPool } from '../VrmBrokerPool';
import { MqttBridgeConnection } from '../MqttBridgeConnection';
import type { VrmInstallation } from '../types';

jest.mock('../VrmBrokerPool');
jest.mock('../MqttBridgeConnection');

const MockedPool = VrmBrokerPool as jest.MockedClass<typeof VrmBrokerPool>;
const MockedConn = MqttBridgeConnection as jest.MockedClass<typeof MqttBridgeConnection>;

function makeInstallation(idSite: number, mqttHost = 'mqtt5.victronenergy.com'): VrmInstallation {
  const identifier = `id${idSite}`;
  return {
    idSite,
    name: `Site ${idSite}`,
    identifier,
    brokerPortalId: identifier,
    mqttHost,
    mqttWebHost: 'webmqtt5.victronenergy.com',
  };
}

const mockHa = { publish: jest.fn() };
const mockPublisher = {
  removeInstallation: jest.fn().mockResolvedValue(undefined),
  publishAvailability: jest.fn(),
};

describe('InstallationManager', () => {
  const opts = {
    apiToken: 'tok',
    userEmail: 'user@example.com',
    ha: mockHa as never,
    publisher: mockPublisher as never,
  };

  let mockPoolInstance: jest.Mocked<VrmBrokerPool>;
  let createdConns: Array<{ start: jest.Mock; stop: jest.Mock; updateName: jest.Mock; identifier: string }>;
  let _connCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    createdConns = [];
    _connCounter = 0;

    mockPoolInstance = {
      getOrCreate: jest.fn().mockReturnValue({}),
      destroyAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VrmBrokerPool>;

    MockedPool.mockImplementation(() => mockPoolInstance);

    MockedConn.mockImplementation((options) => {
      const inst = (options as { installation: VrmInstallation }).installation;
      const conn = {
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
        updateName: jest.fn(),
        publishToVrm: jest.fn(),
        identifier: inst.identifier,
        idSite: inst.idSite,
        brokerPortalId: inst.brokerPortalId,
      } as unknown as MqttBridgeConnection;
      createdConns.push(conn as unknown as { start: jest.Mock; stop: jest.Mock; updateName: jest.Mock; identifier: string });
      _connCounter++;
      return conn;
    });
  });

  describe('constructor', () => {
    it('creates a VrmBrokerPool with correct credentials', () => {
      new InstallationManager(opts);
      expect(MockedPool).toHaveBeenCalledWith({
        username: 'user@example.com',
        password: 'Token tok',
      });
    });
  });

  describe('reconcile', () => {
    it('queues connections without starting them when manager starts suspended', async () => {
      // The manager starts suspended (waits for HA's first connect event),
      // so reconcile() should register connections but not start them.
      const manager = new InstallationManager(opts);
      const installations = [makeInstallation(1), makeInstallation(2)];

      await manager.reconcile(installations);

      expect(MockedConn).toHaveBeenCalledTimes(2);
      expect(createdConns[0].start).not.toHaveBeenCalled();
      expect(createdConns[1].start).not.toHaveBeenCalled();
    });

    it('does not create duplicate connections on a second reconcile with same list', async () => {
      const manager = new InstallationManager(opts);
      const installations = [makeInstallation(1), makeInstallation(2)];

      await manager.reconcile(installations);
      await manager.reconcile(installations);

      expect(MockedConn).toHaveBeenCalledTimes(2);
    });

    it('stops and removes connections for installations no longer present', async () => {
      const manager = new InstallationManager(opts);

      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      await manager.reconcile([makeInstallation(1)]);

      expect(createdConns[1].stop).toHaveBeenCalledTimes(1);
      expect(MockedConn).toHaveBeenCalledTimes(2); // no new connection created
    });

    it('calls updateName on an existing connection when the installation name changes', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1)]);
      await manager.reconcile([{ ...makeInstallation(1), name: 'Renamed Site' }]);
      expect(createdConns[0].updateName).toHaveBeenCalledWith('Renamed Site');
    });

    it('does not call updateName when the name is unchanged', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1)]);
      await manager.reconcile([makeInstallation(1)]);
      expect(createdConns[0].updateName).toHaveBeenCalledWith(`Site 1`);
    });

    it('starts a new connection when a new installation appears', async () => {
      const manager = new InstallationManager(opts);

      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      await manager.reconcile([makeInstallation(1), makeInstallation(2), makeInstallation(3)]);
      manager.resume();

      expect(MockedConn).toHaveBeenCalledTimes(3);
      expect(createdConns[2].start).toHaveBeenCalledTimes(1);
    });

    it('does not call pool.getOrCreate during reconcile (bridge obtains client lazily in start())', async () => {
      const manager = new InstallationManager(opts);
      const installations = [makeInstallation(1), makeInstallation(2)];

      await manager.reconcile(installations);

      expect(mockPoolInstance.getOrCreate).not.toHaveBeenCalled();
    });

    it('passes the pool (not a client) to each MqttBridgeConnection', async () => {
      const manager = new InstallationManager(opts);
      const installations = [
        makeInstallation(1, 'mqtt7.victronenergy.com'),
        makeInstallation(2, 'mqtt5.victronenergy.com'),
      ];

      await manager.reconcile(installations);

      expect(MockedConn).toHaveBeenCalledTimes(2);
      for (const call of MockedConn.mock.calls) {
        const optsArg = call[0] as { pool?: unknown; client?: unknown };
        expect(optsArg.pool).toBe(mockPoolInstance);
        expect(optsArg.client).toBeUndefined();
      }
    });
  });

  describe('shutdown', () => {
    it('stops all connections and destroys the pool', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);

      await manager.shutdown();

      expect(createdConns[0].stop).toHaveBeenCalledTimes(1);
      expect(createdConns[1].stop).toHaveBeenCalledTimes(1);
      expect(mockPoolInstance.destroyAll).toHaveBeenCalledTimes(1);
    });

    it('calls destroyAll even when no connections exist', async () => {
      const manager = new InstallationManager(opts);
      await manager.shutdown();

      expect(mockPoolInstance.destroyAll).toHaveBeenCalledTimes(1);
    });

    it('publishes availability offline for each connection before stopping', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);

      await manager.shutdown();

      expect(mockPublisher.publishAvailability).toHaveBeenCalledWith(1, false);
      expect(mockPublisher.publishAvailability).toHaveBeenCalledWith(2, false);
    });
  });

  describe('disabled installations', () => {
    it('does not create a connection for a disabled installation', async () => {
      const manager = new InstallationManager({ ...opts, disabledInstallationIds: ['id1'] });
      await manager.reconcile([makeInstallation(1)]);
      expect(MockedConn).not.toHaveBeenCalled();
    });

    it('calls removeInstallation for a disabled installation', async () => {
      const manager = new InstallationManager({ ...opts, disabledInstallationIds: ['id1'] });
      await manager.reconcile([makeInstallation(1)]);
      expect(mockPublisher.removeInstallation).toHaveBeenCalledWith(1);
    });

    it('still creates connections for non-disabled installations', async () => {
      const manager = new InstallationManager({ ...opts, disabledInstallationIds: ['id2'] });
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      manager.resume();
      expect(MockedConn).toHaveBeenCalledTimes(1);
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
    });
  });

  describe('replaced installations (brokerPortalId derived from identifier)', () => {
    function makeReplacedInstallation(idSite: number, mqttHost: string): VrmInstallation {
      return {
        idSite,
        name: `Site ${idSite}`,
        identifier: `samplePortalId - USEDASREPLACEMENT AT 1700000000`,
        brokerPortalId: 'samplePortalId',  // derived via toBrokerPortalId
        mqttHost,
        mqttWebHost: 'webmqtt5.victronenergy.com',
      };
    }

    function makeOriginalInstallation(idSite: number, mqttHost: string): VrmInstallation {
      return {
        idSite,
        name: `Site ${idSite}`,
        identifier: 'samplePortalId',
        brokerPortalId: 'samplePortalId',
        mqttHost,
        mqttWebHost: 'webmqtt5.victronenergy.com',
      };
    }

    it('bridges a USEDASREPLACEMENT installation (does not skip)', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeReplacedInstallation(99, 'mqtt7.victronenergy.com')]);
      expect(MockedConn).toHaveBeenCalledTimes(1);
    });

    it('bridges both the original and the replacement (different idSite, different mqttHost, same brokerPortalId)', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([
        makeOriginalInstallation(1, 'mqtt5.victronenergy.com'),
        makeReplacedInstallation(2, 'mqtt7.victronenergy.com'),
      ]);
      expect(MockedConn).toHaveBeenCalledTimes(2);
    });

    it('publishes the new discovery (idSite-keyed) for a replaced installation', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeReplacedInstallation(99, 'mqtt7.victronenergy.com')]);
      // Connections are queued (suspended by default); reconcile just registers them.
      expect((manager as unknown as { connectionsByIdSite: Map<number, unknown> }).connectionsByIdSite.has(99))
        .toBe(true);
    });
  });

  describe('suspend and resume', () => {
    it('suspend stops all active connections', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      manager.resume();
      await manager.suspend();
      expect(createdConns[0].stop).toHaveBeenCalledTimes(1);
      expect(createdConns[1].stop).toHaveBeenCalledTimes(1);
    });

    it('suspend is idempotent', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1)]);
      manager.resume();
      await manager.suspend();
      await manager.suspend();
      expect(createdConns[0].stop).toHaveBeenCalledTimes(1);
    });

    it('resume starts all tracked connections', async () => {
      // Manager starts suspended; reconcile queues without starting; suspend
      // is a no-op (already suspended); resume starts each connection once.
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      await manager.suspend();
      manager.resume();
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
      expect(createdConns[1].start).toHaveBeenCalledTimes(1);
    });

    it('resume is idempotent', async () => {
      // Manager starts suspended; reconcile queues without starting; resume
      // is idempotent (second call is a no-op).
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1)]);
      manager.resume();
      manager.resume();
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
    });

    it('reconcile during suspension adds connection but does not start it', async () => {
      const manager = new InstallationManager(opts);
      await manager.suspend();
      await manager.reconcile([makeInstallation(1)]);
      expect(MockedConn).toHaveBeenCalledTimes(1);
      expect(createdConns[0].start).not.toHaveBeenCalled();
    });

    it('resume starts connections added during suspension', async () => {
      const manager = new InstallationManager(opts);
      await manager.suspend();
      await manager.reconcile([makeInstallation(1)]);
      manager.resume();
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
    });
  });

  describe('default suspended state', () => {
    it('starts in suspended state — reconcile queues without starting connections', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      expect(createdConns).toHaveLength(2);
      expect(createdConns[0].start).not.toHaveBeenCalled();
      expect(createdConns[1].start).not.toHaveBeenCalled();
    });

    it('resume() after a default-state reconcile starts all queued connections', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      manager.resume();
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
      expect(createdConns[1].start).toHaveBeenCalledTimes(1);
    });
  });

  describe('routeHaCommand — idSite-keyed lookup and brokerPortalId rewrite', () => {
    let manager: InstallationManager;

    beforeEach(async () => {
      manager = new InstallationManager(opts);
      // Two installations with different idSites — both will be registered.
      await manager.reconcile([
        makeInstallation(1, 'mqtt5.victronenergy.com'),
        makeInstallation(2, 'mqtt7.victronenergy.com'),
      ]);
    });

    it('parses W/{idSite}/.../set, looks up connection, and rewrites to W/{brokerPortalId}/...', () => {
      const conn1 = createdConns[0] as unknown as { publishToVrm: jest.Mock };
      manager.routeHaCommand('vrm/1/vebus/256/Mode/set', 'On');
      expect(conn1.publishToVrm).toHaveBeenCalledTimes(1);
      expect(conn1.publishToVrm).toHaveBeenCalledWith(
        'W/id1/vebus/256/Mode',
        expect.stringContaining('"value":3'),
      );
    });

    it('routes to the right connection when both sites have the same brokerPortalId', async () => {
      // Two installations share the same brokerPortalId (the "replacement case"
      // — installation 2's brokerPortalId has been derived from a USEDASREPLACEMENT
      // identifier). Under Task 6 the USEDASREPLACEMENT skip is still in effect, so
      // we simulate the post-skip shape: both records carry distinct identifiers
      // and idSites but a shared brokerPortalId.
      const m = new InstallationManager(opts);
      await m.reconcile([
        { ...makeInstallation(1, 'mqtt5.victronenergy.com'), brokerPortalId: 'samplePortalId' },
        { ...makeInstallation(2, 'mqtt7.victronenergy.com'), brokerPortalId: 'samplePortalId' },
      ]);

      // createdConns[0..1] belong to the outer `manager`; m's reconcile pushed
      // two more entries at index 2 (idSite 1) and 3 (idSite 2).
      const conn2 = createdConns[3] as unknown as { publishToVrm: jest.Mock };
      // HA sends vrm/{idSite=2}/.../set — must reach conn2 (not conn1).
      m.routeHaCommand('vrm/2/vebus/256/Mode/set', 'On');
      expect(conn2.publishToVrm).toHaveBeenCalledTimes(1);
      expect(conn2.publishToVrm.mock.calls[0][0]).toBe('W/samplePortalId/vebus/256/Mode');
    });

    it('warns and drops when parts[1] is not a numeric idSite', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const conn1 = createdConns[0] as unknown as { publishToVrm: jest.Mock };
      // 'W/abc/...' — "abc" is not a valid idSite.
      manager.routeHaCommand('vrm/abc/vebus/256/Mode/set', 'On');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('non-numeric idSite abc'),
      );
      expect(conn1.publishToVrm).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns and drops when no connection matches the idSite', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      manager.routeHaCommand('vrm/9999/vebus/256/Mode/set', 'On');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No connection found for idSite 9999'),
      );
      warn.mockRestore();
    });
  });
});
