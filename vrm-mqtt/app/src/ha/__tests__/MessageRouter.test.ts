import { parseVrmTopic, routeFromVrm, routeFromHa } from '../MessageRouter';

// ── parseVrmTopic ─────────────────────────────────────────────────────────────

describe('parseVrmTopic', () => {
  it('parses a simple single-segment path', () => {
    expect(parseVrmTopic('N/abc123/battery/279/Soc')).toEqual({
      portalId: 'abc123',
      service: 'battery',
      instance: '279',
      path: 'Soc',
    });
  });

  it('parses a multi-segment path', () => {
    expect(parseVrmTopic('N/abc123/battery/279/Dc/0/Voltage')).toEqual({
      portalId: 'abc123',
      service: 'battery',
      instance: '279',
      path: 'Dc/0/Voltage',
    });
  });

  it('parses an L-phase path', () => {
    expect(parseVrmTopic('N/abc123/grid/40/Ac/L1/Power')).toMatchObject({ path: 'Ac/L1/Power' });
  });

  it('returns null for non-N prefix', () => {
    expect(parseVrmTopic('R/abc123/battery/279/Soc')).toBeNull();
    expect(parseVrmTopic('W/abc123/battery/279/Soc')).toBeNull();
  });

  it('returns null when fewer than 5 segments', () => {
    expect(parseVrmTopic('N/abc123/battery/279')).toBeNull();
    expect(parseVrmTopic('N/abc123/battery')).toBeNull();
    expect(parseVrmTopic('N')).toBeNull();
  });

  it('returns null for unrelated topics', () => {
    expect(parseVrmTopic('homeassistant/status')).toBeNull();
    expect(parseVrmTopic('')).toBeNull();
  });
});

// ── routeFromVrm ──────────────────────────────────────────────────────────────

describe('routeFromVrm', () => {
  const idSiteFor = (brokerPortalId: string): number | undefined =>
    brokerPortalId === 'abc123' ? 42 : undefined;

  it('rewrites N/… to vrm/…, payload unchanged', () => {
    const result = routeFromVrm('N/abc123/battery/279/Soc', '{"value":87.4}', idSiteFor);
    expect(result).toEqual([{ topic: 'vrm/42/battery/279/Soc', payload: '{"value":87.4}' }]);
  });

  it('preserves multi-segment paths', () => {
    const [msg] = routeFromVrm('N/abc123/battery/279/Dc/0/Voltage', '{"value":25.87}', idSiteFor);
    expect(msg.topic).toBe('vrm/42/battery/279/Dc/0/Voltage');
  });

  it('returns [] for non-VRM topics', () => {
    expect(routeFromVrm('R/abc123/keepalive', '', idSiteFor)).toEqual([]);
    expect(routeFromVrm('homeassistant/status', 'online', idSiteFor)).toEqual([]);
  });

  it('returns [] for malformed topics', () => {
    expect(routeFromVrm('N/abc123/battery/279', '{"value":1}', idSiteFor)).toEqual([]);
  });

  it('returns [] for empty payload (VRM device-gone signal)', () => {
    // dbus-flashmq publishes zero-byte payloads when a device disappears.
    // Forwarding those to HA causes value_json to be undefined and every
    // value_template referencing value_json.value to error. Drop them here
    // so HA's availability_topic can mark the device unavailable instead.
    expect(routeFromVrm('N/abc123/battery/279/Soc', '', idSiteFor)).toEqual([]);
    expect(routeFromVrm('N/abc123/solarcharger/277/Dc/0/Voltage', '', idSiteFor)).toEqual([]);
  });

  it('returns [] when the broker portalId is unknown to the caller', () => {
    const lookup: (brokerPortalId: string) => number | undefined = () => undefined;
    expect(routeFromVrm('N/abc123/battery/279/Soc', '{"value":1}', lookup)).toEqual([]);
  });
});

// ── routeFromHa ───────────────────────────────────────────────────────────────

describe('routeFromHa', () => {
  // parts[1] is now the HA-side numeric idSite — the translation back to
  // brokerPortalId for the W/… topic happens in InstallationManager.routeHaCommand.
  const idSiteNum = '42';

  // ── topic routing ────────────────────────────────────────────────────────

  it('rewrites vrm/…/set to W/…, removing the /set suffix', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/battery/279/Relay/0/State/set`, '1');
    expect(msg.topic).toBe(`W/${idSiteNum}/battery/279/Relay/0/State`);
  });

  it('preserves multi-segment paths', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/vebus/256/Ac/ActiveIn/CurrentLimit/set`, '16');
    expect(msg.topic).toBe(`W/${idSiteNum}/vebus/256/Ac/ActiveIn/CurrentLimit`);
  });

  it('returns [] for topics not starting with vrm/', () => {
    expect(routeFromHa('homeassistant/switch/foo/set', '1')).toEqual([]);
  });

  it('returns [] for topics not ending with /set', () => {
    expect(routeFromHa(`vrm/${idSiteNum}/battery/279/Relay/0/State`, '1')).toEqual([]);
  });

  it('returns [] for topics with too few segments', () => {
    expect(routeFromHa(`vrm/${idSiteNum}/battery/279/set`, '1')).toEqual([]);
  });

  it('returns [] for empty payload', () => {
    expect(routeFromHa(`vrm/${idSiteNum}/battery/279/Relay/0/State/set`, '')).toEqual([]);
  });

  // ── payload wrapping ─────────────────────────────────────────────────────

  it('coerces integer string payload to number', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/battery/279/Relay/0/State/set`, '1');
    expect(msg.payload).toBe('{"value":1}');
  });

  it('coerces "0" to number 0, not string', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/battery/279/Relay/0/State/set`, '0');
    expect(msg.payload).toBe('{"value":0}');
  });

  it('coerces decimal string to number', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/vebus/256/Ac/ActiveIn/CurrentLimit/set`, '25.5');
    expect(msg.payload).toBe('{"value":25.5}');
  });

  it('coerces negative number', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/vebus/256/Ac/ActiveIn/CurrentLimit/set`, '-10');
    expect(msg.payload).toBe('{"value":-10}');
  });

  it('wraps non-numeric payload as a JSON string', () => {
    const [msg] = routeFromHa(`vrm/${idSiteNum}/unknown/0/SomePath/set`, 'hello');
    expect(msg.payload).toBe('{"value":"hello"}');
  });

  // ── select entities ──────────────────────────────────────────────────────

  it('resolves vebus Mode options', () => {
    expect(routeFromHa(`vrm/${idSiteNum}/vebus/256/Mode/set`, 'Charger Only')[0].payload).toBe('{"value":1}');
    expect(routeFromHa(`vrm/${idSiteNum}/vebus/256/Mode/set`, 'Inverter Only')[0].payload).toBe('{"value":2}');
    expect(routeFromHa(`vrm/${idSiteNum}/vebus/256/Mode/set`, 'On')[0].payload).toBe('{"value":3}');
    expect(routeFromHa(`vrm/${idSiteNum}/vebus/256/Mode/set`, 'Off')[0].payload).toBe('{"value":4}');
  });
});
