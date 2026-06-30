import { withTimeout } from '../withTimeout';

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves with the promise value when it settles before the timeout', async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 100);
    });
    const result = withTimeout(promise, 500, 'timed out');
    await jest.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe('done');
  });

  it('rejects with the timeout message when the promise never settles in time', async () => {
    const promise = new Promise<string>(() => {
      // never settles
    });
    const result = withTimeout(promise, 100, 'timed out after 100ms');
    // Attach the rejection handler before advancing timers — otherwise the
    // rejection that fires during advanceTimersByTimeAsync is briefly
    // unhandled, which Jest treats as a test failure even though we go on
    // to handle it a microtask later.
    const assertion = expect(result).rejects.toThrow('timed out after 100ms');
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('propagates a rejection from the inner promise before the timeout', async () => {
    const promise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('inner failure')), 50);
    });
    const result = withTimeout(promise, 500, 'timed out');
    const assertion = expect(result).rejects.toThrow('inner failure');
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('clears the timeout timer once settled, so it does not fire later', async () => {
    const promise = Promise.resolve('fast');
    const result = await withTimeout(promise, 100, 'timed out');
    expect(result).toBe('fast');
    // If the timer weren't cleared, advancing past it would still be harmless
    // here (nothing awaits it), but this documents the intent.
    expect(jest.getTimerCount()).toBe(0);
  });
});
