import { InstallationManager } from '../InstallationManager';
import { VrmBrokerPool } from '../VrmBrokerPool';
import { MqttBridgeConnection } from '../MqttBridgeConnection';
import type { VrmInstallation } from '../types';

jest.mock('../VrmBrokerPool');
jest.mock('../MqttBridgeConnection');

const MockedPool = VrmBrokerPool as jest.MockedClass<typeof VrmBrokerPool>;
const MockedConn = MqttBridgeConnection as jest.MockedClass<typeof MqttBridgeConnection>;

function makeInstallation(idSite: number, mqttHost = 'mqtt5.victronenergy.com'): VrmInstallation {
  return {
    idSite,
    name: `Site ${idSite}`,
    identifier: `id${idSite}`,
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
  let connCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    createdConns = [];
    connCounter = 0;

    mockPoolInstance = {
      getOrCreate: jest.fn().mockReturnValue({}),
      destroyAll: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VrmBrokerPool>;

    MockedPool.mockImplementation(() => mockPoolInstance);

    MockedConn.mockImplementation((options) => {
      const conn = {
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
        updateName: jest.fn(),
        identifier: (options as { installation: { identifier: string } }).installation.identifier,
      } as unknown as MqttBridgeConnection;
      createdConns.push(conn as unknown as { start: jest.Mock; stop: jest.Mock; updateName: jest.Mock; identifier: string });
      connCounter++;
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

      expect(mockPublisher.publishAvailability).toHaveBeenCalledWith('id1', false);
      expect(mockPublisher.publishAvailability).toHaveBeenCalledWith('id2', false);
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
      expect(mockPublisher.removeInstallation).toHaveBeenCalledWith('id1');
    });

    it('still creates connections for non-disabled installations', async () => {
      const manager = new InstallationManager({ ...opts, disabledInstallationIds: ['id2'] });
      await manager.reconcile([makeInstallation(1), makeInstallation(2)]);
      manager.resume();
      expect(MockedConn).toHaveBeenCalledTimes(1);
      expect(createdConns[0].start).toHaveBeenCalledTimes(1);
    });
  });

  describe('replaced installations (USESREPLACEMENT marker in identifier)', () => {
    function makeReplacedInstallation(idSite: number): VrmInstallation {
      return {
        idSite,
        name: `Site ${idSite}`,
        identifier: `test-replaced-portal USEDASREPLACEMENT AT 1700000000`,
        mqttHost: 'mqtt5.victronenergy.com',
        mqttWebHost: 'webmqtt5.victronenergy.com',
      };
    }

    it('does not create a connection for a replaced installation', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeReplacedInstallation(1)]);
      expect(MockedConn).not.toHaveBeenCalled();
    });

    it('purges any retained HA discovery for a replaced installation', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeReplacedInstallation(1)]);
      expect(mockPublisher.removeInstallation).toHaveBeenCalledWith(
        'test-replaced-portal USEDASREPLACEMENT AT 1700000000',
      );
    });

    it('still bridges non-replaced installations when replaced ones are present', async () => {
      const manager = new InstallationManager(opts);
      await manager.reconcile([makeInstallation(1), makeReplacedInstallation(2)]);
      expect(MockedConn).toHaveBeenCalledTimes(1);
      expect(createdConns[0].identifier).toBe('id1');
    });

    it('treats disabled-or-replaced check independently (both purge, both skip)', async () => {
      const manager = new InstallationManager({ ...opts, disabledInstallationIds: ['id3'] });
      await manager.reconcile([makeInstallation(1), makeReplacedInstallation(2), makeInstallation(3)]);
      // Only id1 should be bridged; id2 (replaced) and id3 (disabled) skipped.
      expect(MockedConn).toHaveBeenCalledTimes(1);
      expect(mockPublisher.removeInstallation).toHaveBeenCalledWith(
        'test-replaced-portal USEDASREPLACEMENT AT 1700000000',
      );
      expect(mockPublisher.removeInstallation).toHaveBeenCalledWith('id3');
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
});
