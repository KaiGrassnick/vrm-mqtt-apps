import { DiscoveryPublisher } from '../DiscoveryPublisher';
import type { HaBrokerClient } from '../HaBrokerClient';

function makeMockHa(): jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> {
  return {
    publish: jest.fn(),
    collectRetained: jest.fn().mockResolvedValue([]),
  };
}

function publisher(ha: jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> = makeMockHa()): { pub: DiscoveryPublisher; ha: jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> } {
  return { pub: new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0'), ha };
}

const ID_SITE = 12345;
const NAME = 'Beach House';

// ── publishInstallation ───────────────────────────────────────────────────────

describe('publishInstallation', () => {
  it('publishes retained to homeassistant/device/vrm_{idSite}/config', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    expect(ha.publish).toHaveBeenCalledWith(
      `homeassistant/device/vrm_${ID_SITE}/config`,
      expect.any(String),
      true,
    );
  });

  it('payload has device, origin, availability_topic, and components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.device).toMatchObject({
      identifiers: [`vrm_${ID_SITE}`],
      name: NAME,
      manufacturer: 'Victron Energy',
    });
    expect(payload.origin).toMatchObject({ name: 'vrm-mqtt', sw_version: '1.0.0' });
    expect(payload.availability_topic).toBe(`vrm/${ID_SITE}/availability`);
    expect(payload.components).toBeDefined();
  });

  it('payload has 7 components (3 battery + 4 aggregates)', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(Object.keys(payload.components)).toHaveLength(7);
  });

  it('components use platform instead of component, and have no device field', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    for (const comp of Object.values(payload.components) as Record<string, unknown>[]) {
      expect(comp.platform).toBeDefined();
      expect(comp.component).toBeUndefined();
      expect(comp.device).toBeUndefined();
    }
  });

  it('state_topic uses full vrm path (system/0)', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    const soc = payload.components['system_0_dc_battery_soc'];
    expect(soc.state_topic).toBe(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('includes the grid aggregate component', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.components['custom_aggregate_ac_grid_power']).toBeDefined();
  });

  it('includes the remaining custom aggregate components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.components['custom_aggregate_ac_consumption_power']).toBeDefined();
    expect(payload.components['custom_aggregate_ac_genset_power']).toBeDefined();
    expect(payload.components['custom_aggregate_pv_power']).toBeDefined();
  });

  it('is idempotent: no re-publish when name unchanged', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(ID_SITE, NAME);
    expect(ha.publish).toHaveBeenCalledTimes(1);
  });

  it('re-publishes when name changes', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(ID_SITE, 'New Name');
    expect(ha.publish).toHaveBeenCalledTimes(2);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[1][1] as string);
    expect(payload.device.name).toBe('New Name');
  });
});

// ── publishAvailability ───────────────────────────────────────────────────────

describe('publishAvailability', () => {
  it('publishes "online" retained to vrm/{idSite}/availability', () => {
    const { pub, ha } = publisher();
    pub.publishAvailability(ID_SITE, true);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${ID_SITE}/availability`, 'online', true);
  });

  it('publishes "offline" retained', () => {
    const { pub, ha } = publisher();
    pub.publishAvailability(ID_SITE, false);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${ID_SITE}/availability`, 'offline', true);
  });
});

// ── removeInstallation ────────────────────────────────────────────────────────

describe('removeInstallation', () => {
  it('clears the retained discovery topic and publishes offline', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    (ha.publish as jest.Mock).mockClear();

    await pub.removeInstallation(ID_SITE);

    expect(ha.publish).toHaveBeenCalledWith(
      `homeassistant/device/vrm_${ID_SITE}/config`,
      '',
      true,
    );
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${ID_SITE}/availability`, 'offline', true);
  });

  it('does not touch other installations', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(999, 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    await pub.removeInstallation(ID_SITE);

    const calls = (ha.publish as jest.Mock).mock.calls as [string][];
    expect(calls.every(([t]) => !t.includes('vrm_999'))).toBe(true);
  });

  it('scans broker for retained topic when none tracked in memory', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockResolvedValue([
      { topic: `homeassistant/device/vrm_${ID_SITE}/config`, payload: '{"device":{}}' },
    ]);
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.removeInstallation(ID_SITE);

    expect(ha.publish).toHaveBeenCalledWith(`homeassistant/device/vrm_${ID_SITE}/config`, '', true);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${ID_SITE}/availability`, 'offline', true);
  });

  it('skips retained topics with empty payload', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockResolvedValue([
      { topic: `homeassistant/device/vrm_${ID_SITE}/config`, payload: '' },
    ]);
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.removeInstallation(ID_SITE);

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.every(([t]) => t !== `homeassistant/device/vrm_${ID_SITE}/config`)).toBe(true);
  });

  it('allows re-publish after removal', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    await pub.removeInstallation(ID_SITE);
    (ha.publish as jest.Mock).mockClear();
    pub.publishInstallation(ID_SITE, NAME);
    expect(ha.publish).toHaveBeenCalledTimes(1);
  });
});

// ── onHaBirth ─────────────────────────────────────────────────────────────────

describe('onHaBirth', () => {
  it('re-publishes all stored discovery payloads retained', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(999, 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    pub.onHaBirth();

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string, boolean][];
    const discoveryRepublishes = calls.filter(([t]) => t.startsWith('homeassistant/device/'));
    expect(discoveryRepublishes).toHaveLength(2);
    expect(discoveryRepublishes.every(([, , retained]) => retained === true)).toBe(true);
  });

  it('does NOT touch availability — real online/offline state belongs to MqttBridgeConnection staleness tracking', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(999, 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    pub.onHaBirth();

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.some(([t]) => t.endsWith('/availability'))).toBe(false);
  });

  it('does nothing when nothing has been published yet', () => {
    const { pub, ha } = publisher();
    pub.onHaBirth();
    expect(ha.publish).not.toHaveBeenCalled();
  });
});

// ── pruneRetainedTopics ──────────────────────────────────────────────────────

describe('pruneRetainedTopics', () => {
  const KEEP_TOPIC = `vrm/${ID_SITE}/system/0/Dc/Battery/Soc`;
  const STALE_TOPIC = `vrm/${ID_SITE}/system/0/Ac/Sample`;
  const AVAIL_TOPIC = `vrm/${ID_SITE}/availability`;
  const SET_TOPIC = `vrm/${ID_SITE}/system/0/Dc/Battery/Soc/set`;
  const SIBLING_TOPIC = `vrm/${ID_SITE + 1}/system/0/Dc/Battery/Soc`;

  function seedRetained(
    ha: jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>>,
    topics: string[],
  ): void {
    ha.collectRetained.mockResolvedValueOnce(
      topics.map(t => ({ topic: t, payload: '{"value":42}' })),
    );
  }

  it('clears only the stale retained topics (not in keep set)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [KEEP_TOPIC, STALE_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).toHaveBeenCalledTimes(1);
    expect(ha.publish).toHaveBeenCalledWith(STALE_TOPIC, '', true);
  });

  it('skips the availability topic even when the broker surfaces it', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [AVAIL_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('skips /set topics (live command writes during collect window)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [SET_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('skips topics that belong to a different idSite (defensive)', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [SIBLING_TOPIC]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('clears every stale topic when there are many', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, [
      KEEP_TOPIC,
      `vrm/${ID_SITE}/system/0/Ac/Whatever`,
      `vrm/${ID_SITE}/system/0/Old/Removed/Path`,
    ]);
    await pub.pruneRetainedTopics(ID_SITE);

    const cleared = (ha.publish as jest.Mock).mock.calls.map(([t]: [string]) => t);
    expect(cleared).toEqual([
      `vrm/${ID_SITE}/system/0/Ac/Whatever`,
      `vrm/${ID_SITE}/system/0/Old/Removed/Path`,
    ]);
  });

  it('is a no-op when the broker returns no retained topics', async () => {
    const { pub, ha } = publisher();
    seedRetained(ha, []);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(ha.publish).not.toHaveBeenCalled();
  });

  it('logs the number of pruned topics', async () => {
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const { pub, ha } = publisher();
    seedRetained(ha, [`vrm/${ID_SITE}/system/0/A`, `vrm/${ID_SITE}/system/0/B`]);
    await pub.pruneRetainedTopics(ID_SITE);

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/Pruned 2 stale retained topic\(s\) under vrm\/12345\//),
    );
    spy.mockRestore();
  });
});