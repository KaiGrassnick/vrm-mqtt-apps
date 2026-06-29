import { jest } from '@jest/globals';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('pollInstallations overlapping-guard', () => {
  const originalEnv = process.env;
  let consoleLog: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, VRM_API_TOKEN: 't', HA_MQTT_HOST: 'h' };
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('skips a poll while a previous one is still running', async () => {
    let resolveFirst: (() => void) | null = null;
    const fetchMock = jest.fn().mockImplementation(() =>
      new Promise<never>((resolve) => { resolveFirst = () => resolve({ ok: true, text: async () => '{"success":true,"records":[]}' } as never); }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { pollInstallations } = await import('../index');
    fetchMock.mockClear();
    const manager = { reconcile: jest.fn() } as unknown as { reconcile: jest.Mock };
    const client = {
      getInstallations: jest.fn(async (id: number) => {
        const res = await fetch(`https://example.com/installations?user=${id}`);
        const text = await res.text();
        return JSON.parse(text).records;
      }),
    } as unknown as { getInstallations: jest.Mock };
    const publisher = {
      purgeLegacyDiscovery: jest.fn(async () => undefined),
    } as unknown as { purgeLegacyDiscovery: jest.Mock };

    // Kick off first poll (will hang on the fetch).
    const first = pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
      publisher as never,
    );

    // Wait a microtask so the first poll registers as "in progress".
    await flush();

    // Second poll should immediately resolve without calling fetch/getInstallations.
    await pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
      publisher as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Poll already in progress'));

    // Cleanup: resolve the hanging fetch.
    resolveFirst!();
    await first;
  });
});

describe('pollInstallations legacy-purge-once guard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, VRM_API_TOKEN: 't', HA_MQTT_HOST: 'h' };
    // Silence the noisy main()-side startup logs that the import side-effect
    // emits; we don't assert on them in this suite.
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('calls purgeLegacyDiscovery on the first poll only', async () => {
    // Match the existing overlapping-guard test's strategy: a fetch that never
    // resolves keeps main()'s getMe call stuck before it sets up an MQTT
    // connection or a recurring pollTimer, isolating the test from side
    // effects.
    global.fetch = jest.fn(() => new Promise<never>(() => {
      /* never resolves */
    })) as unknown as typeof fetch;

    const { pollInstallations } = await import('../index');
    const manager = { reconcile: jest.fn() } as unknown as { reconcile: jest.Mock };
    const client = {
      getInstallations: jest.fn(async () => []),
    } as unknown as { getInstallations: jest.Mock };
    const publisher = {
      purgeLegacyDiscovery: jest.fn(async () => undefined),
    } as unknown as { purgeLegacyDiscovery: jest.Mock };

    await pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
      publisher as never,
    );
    await pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
      publisher as never,
    );
    await pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
      publisher as never,
    );

    expect(publisher.purgeLegacyDiscovery).toHaveBeenCalledTimes(1);
  });
});
