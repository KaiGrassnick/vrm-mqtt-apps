import { DiscoveryPublisher } from '../DiscoveryPublisher';
import type { HaBrokerClient } from '../HaBrokerClient';
import type { VrmInstallation } from '../../vrm/types';

function makeMockHa(): jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> {
  return {
    publish: jest.fn(),
    collectRetained: jest.fn().mockResolvedValue([]),
  };
}

function publisher(ha = makeMockHa()) {
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

  it('payload has 13 components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(Object.keys(payload.components)).toHaveLength(13);
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

  it('includes grid L1/L2/L3 components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.components['system_0_ac_grid_l1_power']).toBeDefined();
    expect(payload.components['system_0_ac_grid_l2_power']).toBeDefined();
    expect(payload.components['system_0_ac_grid_l3_power']).toBeDefined();
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

  it('re-publishes availability online for each installation', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(ID_SITE, NAME);
    pub.publishInstallation(999, 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    pub.onHaBirth();

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.some(([t, p]) => t === `vrm/${ID_SITE}/availability` && p === 'online')).toBe(true);
    expect(calls.some(([t, p]) => t === 'vrm/999/availability' && p === 'online')).toBe(true);
  });

  it('does nothing when nothing has been published yet', () => {
    const { pub, ha } = publisher();
    pub.onHaBirth();
    expect(ha.publish).not.toHaveBeenCalled();
  });
});

// ── purgeLegacyDiscovery ──────────────────────────────────────────────────────

describe('purgeLegacyDiscovery', () => {
  const installations: VrmInstallation[] = [
    { idSite: 1, name: 'A', identifier: 'abc', brokerPortalId: 'abc', mqttHost: 'h', mqttWebHost: 'h' },
    { idSite: 2, name: 'B', identifier: 'c0619ab417b5 - USEDASREPLACEMENT AT 1719937767', brokerPortalId: 'c0619ab417b5', mqttHost: 'h', mqttWebHost: 'h' },
  ];

  it('publishes empty retained directly to each legacy topic (no broker subscription)', async () => {
    const { pub, ha } = publisher();
    await pub.purgeLegacyDiscovery(installations);
    // 2 legacy topics × 2 installations = 4 publishes total.
    expect(ha.publish).toHaveBeenCalledWith('homeassistant/device/vrm_abc/config', '', true);
    expect(ha.publish).toHaveBeenCalledWith('vrm/abc/availability', '', true);
    expect(ha.publish).toHaveBeenCalledWith(
      'homeassistant/device/vrm_c0619ab417b5 - USEDASREPLACEMENT AT 1719937767/config',
      '',
      true,
    );
    expect(ha.publish).toHaveBeenCalledWith(
      'vrm/c0619ab417b5 - USEDASREPLACEMENT AT 1719937767/availability',
      '',
      true,
    );
    expect(ha.publish).toHaveBeenCalledTimes(4);
  });

  it('does not call collectRetained (the read-then-publish 300 ms latency ladder is gone)', async () => {
    const { pub, ha } = publisher();
    await pub.purgeLegacyDiscovery(installations);
    expect(ha.collectRetained).not.toHaveBeenCalled();
  });
});