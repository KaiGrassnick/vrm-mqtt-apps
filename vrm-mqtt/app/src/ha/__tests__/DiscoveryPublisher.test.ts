import { DiscoveryPublisher } from '../DiscoveryPublisher';
import type { HaBrokerClient } from '../HaBrokerClient';

function makeMockHa(): jest.Mocked<Pick<HaBrokerClient, 'publish' | 'collectRetained'>> {
  return {
    publish: jest.fn(),
    collectRetained: jest.fn().mockResolvedValue([]),
  };
}

function publisher(ha = makeMockHa()) {
  return { pub: new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0'), ha };
}

const PORTAL = 'abc123';
const NAME = 'Beach House';

// ── publishInstallation ───────────────────────────────────────────────────────

describe('publishInstallation', () => {
  it('publishes retained to homeassistant/device/vrm_{portalId}/config', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    expect(ha.publish).toHaveBeenCalledWith(
      `homeassistant/device/vrm_${PORTAL}/config`,
      expect.any(String),
      true,
    );
  });

  it('payload has device, origin, availability_topic, and components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.device).toMatchObject({
      identifiers: [`vrm_${PORTAL}`],
      name: NAME,
      manufacturer: 'Victron Energy',
    });
    expect(payload.origin).toMatchObject({ name: 'vrm-mqtt', sw_version: '1.0.0' });
    expect(payload.availability_topic).toBe(`vrm/${PORTAL}/availability`);
    expect(payload.components).toBeDefined();
  });

  it('payload has 13 components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(Object.keys(payload.components)).toHaveLength(13);
  });

  it('components use platform instead of component, and have no device field', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    for (const comp of Object.values(payload.components) as Record<string, unknown>[]) {
      expect(comp.platform).toBeDefined();
      expect(comp.component).toBeUndefined();
      expect(comp.device).toBeUndefined();
    }
  });

  it('state_topic uses full vrm path (system/0)', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    const soc = payload.components['system_0_dc_battery_soc'];
    expect(soc.state_topic).toBe(`vrm/${PORTAL}/system/0/Dc/Battery/Soc`);
  });

  it('includes grid L1/L2/L3 components', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[0][1] as string);
    expect(payload.components['system_0_ac_grid_l1_power']).toBeDefined();
    expect(payload.components['system_0_ac_grid_l2_power']).toBeDefined();
    expect(payload.components['system_0_ac_grid_l3_power']).toBeDefined();
  });

  it('is idempotent: no re-publish when name unchanged', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    pub.publishInstallation(PORTAL, NAME);
    expect(ha.publish).toHaveBeenCalledTimes(1);
  });

  it('re-publishes when name changes', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    pub.publishInstallation(PORTAL, 'New Name');
    expect(ha.publish).toHaveBeenCalledTimes(2);
    const payload = JSON.parse((ha.publish as jest.Mock).mock.calls[1][1] as string);
    expect(payload.device.name).toBe('New Name');
  });
});

// ── publishAvailability ───────────────────────────────────────────────────────

describe('publishAvailability', () => {
  it('publishes "online" retained to vrm/{portalId}/availability', () => {
    const { pub, ha } = publisher();
    pub.publishAvailability(PORTAL, true);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${PORTAL}/availability`, 'online', true);
  });

  it('publishes "offline" retained', () => {
    const { pub, ha } = publisher();
    pub.publishAvailability(PORTAL, false);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${PORTAL}/availability`, 'offline', true);
  });
});

// ── removeInstallation ────────────────────────────────────────────────────────

describe('removeInstallation', () => {
  it('clears the retained discovery topic and publishes offline', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    (ha.publish as jest.Mock).mockClear();

    await pub.removeInstallation(PORTAL);

    expect(ha.publish).toHaveBeenCalledWith(
      `homeassistant/device/vrm_${PORTAL}/config`,
      '',
      true,
    );
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${PORTAL}/availability`, 'offline', true);
  });

  it('does not touch other portals', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    pub.publishInstallation('other', 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    await pub.removeInstallation(PORTAL);

    const calls = (ha.publish as jest.Mock).mock.calls as [string][];
    expect(calls.every(([t]) => !t.includes('vrm_other'))).toBe(true);
  });

  it('scans broker for retained topic when none tracked in memory', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockResolvedValue([
      { topic: `homeassistant/device/vrm_${PORTAL}/config`, payload: '{"device":{}}' },
    ]);
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.removeInstallation(PORTAL);

    expect(ha.publish).toHaveBeenCalledWith(`homeassistant/device/vrm_${PORTAL}/config`, '', true);
    expect(ha.publish).toHaveBeenCalledWith(`vrm/${PORTAL}/availability`, 'offline', true);
  });

  it('skips retained topics with empty payload', async () => {
    const ha = makeMockHa();
    ha.collectRetained.mockResolvedValue([
      { topic: `homeassistant/device/vrm_${PORTAL}/config`, payload: '' },
    ]);
    const pub = new DiscoveryPublisher(ha as unknown as HaBrokerClient, '1.0.0');

    await pub.removeInstallation(PORTAL);

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.every(([t]) => t !== `homeassistant/device/vrm_${PORTAL}/config`)).toBe(true);
  });

  it('allows re-publish after removal', async () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    await pub.removeInstallation(PORTAL);
    (ha.publish as jest.Mock).mockClear();
    pub.publishInstallation(PORTAL, NAME);
    expect(ha.publish).toHaveBeenCalledTimes(1);
  });
});

// ── onHaBirth ─────────────────────────────────────────────────────────────────

describe('onHaBirth', () => {
  it('re-publishes all stored discovery payloads retained', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    pub.publishInstallation('other', 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    pub.onHaBirth();

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string, boolean][];
    const discoveryRepublishes = calls.filter(([t]) => t.startsWith('homeassistant/device/'));
    expect(discoveryRepublishes).toHaveLength(2);
    expect(discoveryRepublishes.every(([, , retained]) => retained === true)).toBe(true);
  });

  it('re-publishes availability online for each portal', () => {
    const { pub, ha } = publisher();
    pub.publishInstallation(PORTAL, NAME);
    pub.publishInstallation('other', 'Other Site');
    (ha.publish as jest.Mock).mockClear();

    pub.onHaBirth();

    const calls = (ha.publish as jest.Mock).mock.calls as [string, string][];
    expect(calls.some(([t, p]) => t === `vrm/${PORTAL}/availability` && p === 'online')).toBe(true);
    expect(calls.some(([t, p]) => t === 'vrm/other/availability' && p === 'online')).toBe(true);
  });

  it('does nothing when nothing has been published yet', () => {
    const { pub, ha } = publisher();
    pub.onHaBirth();
    expect(ha.publish).not.toHaveBeenCalled();
  });
});
