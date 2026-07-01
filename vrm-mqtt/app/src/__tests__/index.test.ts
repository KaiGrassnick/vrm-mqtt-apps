import { jest } from '@jest/globals';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('pollInstallations overlapping-guard', () => {
  const originalEnv = process.env;
  let consoleLog: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, VRM_API_TOKEN: 't', HA_MQTT_HOST: 'h', LOG_LEVEL: 'info' };
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('skips a poll while a previous one is still running', async () => {
    let resolveFirst: (() => void) | null = null;
    const fetchMock = jest.fn().mockImplementation(() =>
      new Promise<never>((resolve): void => { resolveFirst = (): void => resolve({ ok: true, text: async () => '{"success":true,"records":[]}' } as never); }),
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

    // Kick off first poll (will hang on the fetch).
    const first = pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
    );

    // Wait a microtask so the first poll registers as "in progress".
    await flush();

    // Second poll should immediately resolve without calling fetch/getInstallations.
    await pollInstallations(
      client as never,
      manager as never,
      { id: 1, email: 'a@b.c', name: 'x' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Poll already in progress'));

    // Cleanup: resolve the hanging fetch.
    resolveFirst!();
    await first;
  });
});
