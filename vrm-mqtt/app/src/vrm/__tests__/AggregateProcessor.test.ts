import { AggregateProcessor, parseVrmValue } from '../AggregateProcessor';

// ── parseVrmValue ─────────────────────────────────────────────────────────────

describe('parseVrmValue', () => {
  it('parses a JSON object with a numeric value', () => {
    expect(parseVrmValue('{"value":42.5}')).toBe(42.5);
  });

  it('parses a negative value', () => {
    expect(parseVrmValue('{"value":-15.2}')).toBe(-15.2);
  });

  it('parses zero', () => {
    expect(parseVrmValue('{"value":0}')).toBe(0);
  });

  it('parses an integer', () => {
    expect(parseVrmValue('{"value":1500}')).toBe(1500);
  });

  it('returns null for non-JSON payload', () => {
    expect(parseVrmValue('not-json')).toBeNull();
  });

  it('returns null for JSON without a value field', () => {
    expect(parseVrmValue('{"other":1}')).toBeNull();
  });

  it('returns null for a non-numeric value field', () => {
    expect(parseVrmValue('{"value":"foo"}')).toBeNull();
  });

  it('returns null for NaN value', () => {
    // JSON.parse never produces NaN (it's not valid JSON), but JSON.parse('NaN')
    // throws, so we end up in the catch branch.
    expect(parseVrmValue('NaN')).toBeNull();
  });

  it('returns null for Infinity', () => {
    // JSON.parse never produces Infinity (it's not valid JSON), so we end up in the catch branch.
    expect(parseVrmValue('Infinity')).toBeNull();
  });

  it('returns null for null value', () => {
    expect(parseVrmValue('{"value":null}')).toBeNull();
  });

  it('returns null for boolean value', () => {
    expect(parseVrmValue('{"value":true}')).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(parseVrmValue('')).toBeNull();
  });
});

// ── AggregateProcessor — single rule ──────────────────────────────────────────

describe('AggregateProcessor (single rule)', () => {
  const gridRule = {
    targetTopic: 'vrm/42/system/0/Ac/Grid/AggPower',
    sourcePaths: ['Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power'],
  };

  it('returns [] when the path is not tracked by any rule', () => {
    const proc = new AggregateProcessor([gridRule]);
    // Ac/Genset/L1/Power is not in the gridRule.sourcePaths
    expect(proc.feedPayload('Ac/Genset/L1/Power', '{"value":500}')).toEqual([]);
  });

  it('emits a one-phase sum after the first source reports (single-phase install)', () => {
    const proc = new AggregateProcessor([gridRule]);
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":100}' },
    ]);
  });

  it('emits a two-phase sum once the second source reports', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    const messages = proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":250}' },
    ]);
  });

  it('emits a three-phase sum once the third source reports', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');
    const messages = proc.feedPayload('Ac/Grid/L3/Power', '{"value":50}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":300}' },
    ]);
  });

  it('updates the sum when an already-reported source updates', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');
    proc.feedPayload('Ac/Grid/L3/Power', '{"value":50}');
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":200}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":400}' },
    ]);
  });

  it('handles negative values (e.g. power flowing back to grid)', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":-200}');
    const messages = proc.feedPayload('Ac/Grid/L3/Power', '{"value":-50}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":-150}' },
    ]);
  });

  it('does not emit for an untracked path', () => {
    const proc = new AggregateProcessor([gridRule]);
    expect(proc.feedPayload('Ac/Genset/L1/Power', '{"value":500}')).toEqual([]);
  });

  it('does not emit for an unparseable payload', () => {
    const proc = new AggregateProcessor([gridRule]);
    expect(proc.feedPayload('Ac/Grid/L1/Power', 'not-json')).toEqual([]);
  });

  it('keeps emitting for a source that re-sends the same value', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":100}' },
    ]);
  });
});

// ── AggregateProcessor — clear() ──────────────────────────────────────────────

describe('AggregateProcessor.clear', () => {
  const gridRule = {
    targetTopic: 'vrm/42/system/0/Ac/Grid/AggPower',
    sourcePaths: ['Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power'],
  };

  it('forgets all buffered values', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":200}');
    proc.clear();
    // After clear, the next feed should not know about L2 — L1-only sum.
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":100}' },
    ]);
  });

  it('produces no messages after clear when no source has been fed', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.clear();
    expect(proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}')).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":100}' },
    ]);
  });
});

// ── AggregateProcessor — source expiry ────────────────────────────────────────

describe('AggregateProcessor source expiry', () => {
  const gridRule = {
    targetTopic: 'vrm/42/system/0/Ac/Grid/AggPower',
    sourcePaths: ['Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power'],
  };
  const EXPIRY = 1000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drops a source from the sum once it has not reported for longer than sourceExpiryMs', () => {
    const proc = new AggregateProcessor([gridRule], EXPIRY);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');
    proc.feedPayload('Ac/Grid/L3/Power', '{"value":50}');

    // L2/L3 go quiet (e.g. reconfigured to single-phase) but the connection
    // never drops, so clear() never runs. Only L1 keeps reporting.
    jest.advanceTimersByTime(EXPIRY + 1);
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":120}');

    // Without expiry this would be 120+150+50=320 — the stale L2/L3 values
    // forever inflating the sum. With expiry, only the live L1 counts.
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":120}' },
    ]);
  });

  it('keeps a source in the sum if it reports again before expiring', () => {
    const proc = new AggregateProcessor([gridRule], EXPIRY);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');

    jest.advanceTimersByTime(EXPIRY - 1);
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":160}'); // refreshes L2's timer

    jest.advanceTimersByTime(EXPIRY - 1);
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":110}');

    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":270}' },
    ]);
  });

  it('re-includes a source once it reports again after expiring', () => {
    const proc = new AggregateProcessor([gridRule], EXPIRY);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');

    jest.advanceTimersByTime(EXPIRY + 1); // L2 expires
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');

    const messages = proc.feedPayload('Ac/Grid/L2/Power', '{"value":200}'); // L2 reports again

    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":300}' },
    ]);
  });

  it('sourceExpiryMs=0 disables expiry — a quiet source stays in the sum forever', () => {
    const proc = new AggregateProcessor([gridRule], 0);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');

    jest.advanceTimersByTime(10 * 365 * 24 * 60 * 60 * 1000); // 10 years
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":120}');

    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":270}' },
    ]);
  });

  it('defaults to a 300_000ms expiry when not specified', () => {
    const proc = new AggregateProcessor([gridRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Grid/L2/Power', '{"value":150}');

    jest.advanceTimersByTime(300_001);
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":120}');

    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":120}' },
    ]);
  });
});

// ── AggregateProcessor — multiple rules ───────────────────────────────────────

describe('AggregateProcessor (multiple rules)', () => {
  const gridRule = {
    targetTopic: 'vrm/42/system/0/Ac/Grid/AggPower',
    sourcePaths: ['Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power'],
  };
  const consumptionRule = {
    targetTopic: 'vrm/42/system/0/Ac/Consumption/AggPower',
    sourcePaths: ['Ac/Consumption/L1/Power', 'Ac/Consumption/L2/Power', 'Ac/Consumption/L3/Power'],
  };
  const gensetRule = {
    targetTopic: 'vrm/42/system/0/Ac/Genset/AggPower',
    sourcePaths: ['Ac/Genset/L1/Power', 'Ac/Genset/L2/Power', 'Ac/Genset/L3/Power'],
  };

  it('emits only the rules that include the fed path', () => {
    const proc = new AggregateProcessor([gridRule, consumptionRule, gensetRule]);
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":100}' },
    ]);
  });

  it('keeps separate buffers per source path', () => {
    const proc = new AggregateProcessor([gridRule, consumptionRule]);
    proc.feedPayload('Ac/Grid/L1/Power', '{"value":100}');
    proc.feedPayload('Ac/Consumption/L1/Power', '{"value":200}');
    const messages = proc.feedPayload('Ac/Grid/L1/Power', '{"value":150}');
    expect(messages).toEqual([
      { topic: 'vrm/42/system/0/Ac/Grid/AggPower', payload: '{"value":150}' },
    ]);
  });
});
