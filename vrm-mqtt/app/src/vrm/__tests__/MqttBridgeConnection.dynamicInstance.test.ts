import { EventEmitter } from 'events';
import type { MqttClient } from 'mqtt';
import { MqttBridgeConnection } from '../MqttBridgeConnection';
import type { VrmInstallation } from '../types';
import type { VrmBrokerPool } from '../VrmBrokerPool';

// This suite proves the dynamic multi-instance pipeline works end-to-end
// using vebus (already wired into SERVICE_ENTITY_DEFS today, per
// entityDefs.ts) even though vebus has zero forward:true entities in
// production. It temporarily patches one vebus entity's forward flag via
// jest.mock to exercise the path a future per-entity change will hit for
// real, without touching entityDefs.ts itself (Global Constraint: no
// forward: true changes to production registries in this work).
jest.mock('../../ha/entityDefs', () => {
  const actual = jest.requireActual('../../ha/entityDefs');
  const patchedVebus = actual.SERVICE_ENTITY_DEFS.vebus.map((def: { path: string }) =>
    def.path === 'State' ? { ...def, forward: true } : def,
  );
  return {
    ...actual,
    SERVICE_ENTITY_DEFS: { ...actual.SERVICE_ENTITY_DEFS, vebus: patchedVebus },
  };
});

const installation: VrmInstallation = {
  idSite: 1,
  name: 'Test Site',
  identifier: 'test-portal-abcd1234',
  brokerPortalId: 'test-portal-abcd1234',
  mqttHost: 'mqtt5.victronenergy.com',
  mqttWebHost: 'webmqtt5.victronenergy.com',
};
const PORTAL = installation.brokerPortalId;

function makeMockClient(connected = false): EventEmitter & { connected: boolean; subscribe: jest.Mock; unsubscribe: jest.Mock; publish: jest.Mock; off: jest.Mock } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connected,
    subscribe: jest.fn((_t: string, _o: unknown, cb?: (err: Error | null) => void) => cb?.(null)),
    unsubscribe: jest.fn((_t: string, cb?: (err: Error | null) => void) => cb?.(null)),
    publish: jest.fn((_t: string, _p: string, _o: unknown, cb?: (err: Error | undefined) => void) => cb?.(undefined)),
    off: jest.fn((event: string, fn: (...args: unknown[]) => void) => emitter.removeListener(event, fn)),
  });
}
function makeMockHa(): { publish: jest.Mock } {
  return { publish: jest.fn() };
}
function makeMockPublisher(): {
  publishAvailability: jest.Mock;
  publishInstallation: jest.Mock;
  pruneRetainedTopics: jest.Mock;
  refreshInstallationDiscovery: jest.Mock;
} {
  return {
    publishAvailability: jest.fn(),
    publishInstallation: jest.fn(),
    pruneRetainedTopics: jest.fn().mockResolvedValue(undefined),
    refreshInstallationDiscovery: jest.fn(),
  };
}
function makeMockPool(client: MqttClient): { getOrCreate: jest.Mock; destroyAll: jest.Mock } {
  return { getOrCreate: jest.fn().mockReturnValue(client), destroyAll: jest.fn().mockResolvedValue(undefined) };
}
const idSiteFor = (inst: VrmInstallation) => (brokerPortalId: string): number | undefined =>
  brokerPortalId === inst.brokerPortalId ? inst.idSite : undefined;

describe('dynamic multi-instance pipeline (end-to-end, patched vebus fixture)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('subscribes to vebus with a wildcard instance segment', () => {
    const client = makeMockClient(false);
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: makeMockPublisher() as never });
    conn.start();
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith(
      expect.arrayContaining([`N/${PORTAL}/vebus/+/State`]),
      { qos: 0 },
      expect.any(Function),
    );
  });

  it('forwards a message for a previously-unseen vebus instance and records it', () => {
    const client = makeMockClient(true);
    const ha = makeMockHa();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: ha as never, publisher: makeMockPublisher() as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);

    client.emit('message', `N/${PORTAL}/vebus/3/State`, Buffer.from('{"value":9}'));
    jest.advanceTimersByTime(500);

    expect(ha.publish).toHaveBeenCalledWith(`vrm/${installation.idSite}/vebus/3/State`, '{"value":9}');
    expect(conn.observedInstancesSnapshot.get('vebus')).toEqual(new Set(['3']));
  });

  it('schedules and fires a discovery refresh + prune re-run for the newly-seen instance', async () => {
    const client = makeMockClient(true);
    const publisher = makeMockPublisher();
    const conn = new MqttBridgeConnection({ installation, pool: makeMockPool(client as unknown as MqttClient) as unknown as VrmBrokerPool, ha: makeMockHa() as never, publisher: publisher as never, getIdSite: idSiteFor(installation) });
    conn.start();
    jest.advanceTimersByTime(500);
    publisher.refreshInstallationDiscovery.mockClear();
    publisher.pruneRetainedTopics.mockClear();

    client.emit('message', `N/${PORTAL}/vebus/3/State`, Buffer.from('{"value":9}'));
    jest.advanceTimersByTime(2000);

    // onDiscoveryRefreshFire() fires refreshInstallationDiscovery synchronously
    // but runPrune() chains pruneRetainedTopics onto a promise — flush
    // microtasks before asserting on it (same pattern as the existing
    // 'pruneRetainedTopics wire-up' suite in MqttBridgeConnection.test.ts).
    await Promise.resolve();
    await Promise.resolve();

    expect(publisher.refreshInstallationDiscovery).toHaveBeenCalledTimes(1);
    const [, , observedInstancesArg] = publisher.refreshInstallationDiscovery.mock.calls[0];
    expect(observedInstancesArg.get('vebus')).toEqual(new Set(['3']));
    expect(publisher.pruneRetainedTopics).toHaveBeenCalled();
  });
});
