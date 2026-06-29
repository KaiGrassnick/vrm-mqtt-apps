import { RollingMessageThrottle } from '../RollingMessageThrottle';

describe('RollingMessageThrottle', () => {
  let publish: jest.Mock;
  let throttle: RollingMessageThrottle;

  beforeEach(() => {
    jest.useFakeTimers();
    publish = jest.fn();
    throttle = new RollingMessageThrottle(500, publish);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── preserved semantics (must match the old GlobalMessageThrottle) ────────

  it('publishes directly when intervalMs is 0 (bypass mode)', () => {
    const direct = new RollingMessageThrottle(0, publish);
    direct.enqueue('vrm/x', 'a');
    expect(publish).toHaveBeenCalledWith('vrm/x', 'a');
  });

  it('coalesces messages with the same topic (latest wins)', () => {
    throttle.start();
    throttle.enqueue('vrm/x', 'a');
    throttle.enqueue('vrm/x', 'b');
    throttle.enqueue('vrm/x', 'c');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('vrm/x', 'c');
  });

  it('publishes one topic per shard within the interval (2 installations, 2 ticks per cycle)', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith('vrm/a', '1');
    expect(publish).toHaveBeenCalledWith('vrm/b', '2');
  });

  it('start() is idempotent — does not double-arm the timer', () => {
    throttle.start();
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('flush() drains the buffer immediately and re-arms the schedule', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    // The throttle is still alive: a fresh enqueue is picked up by the next tick.
    // After flush, the timer is rescheduled by the new-shard path with N=2
    // and tickMs=250; advancing 500ms fires both ticks (one empty, one for 'vrm/b').
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith('vrm/b', '2');
  });

  it('stop() drains and clears the timer', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.stop();
    expect(publish).toHaveBeenCalledTimes(1);
    // After stop(), advancing timers must NOT publish.
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an empty flush', () => {
    throttle.start();
    jest.advanceTimersByTime(500);
    expect(publish).not.toHaveBeenCalled();
  });

  // ── new rolling behavior ──────────────────────────────────────────────────

  it('publishes from all N installations within one interval', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    throttle.enqueue('vrm/c', '3');
    // N=3 → tickMs = floor(500/3) = 166. Expect 3 publishes within 500ms.
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('spreads publishes across the interval, not at the end', () => {
    // 3 installations, intervalMs=300, tickMs=100.
    // Publishes land at t=100, 200, 300 — not all clustered at the boundary.
    const t = new RollingMessageThrottle(300, publish);
    const callTimes: number[] = [];
    publish.mockImplementation(() => {
      callTimes.push(jest.now());
    });
    jest.setSystemTime(0);
    t.start();
    t.enqueue('vrm/a', '1');
    t.enqueue('vrm/b', '2');
    t.enqueue('vrm/c', '3');
    jest.advanceTimersByTime(300);
    expect(callTimes).toHaveLength(3);
    expect(new Set(callTimes).size).toBe(3);
    // Span: at least 150ms between first and last publish.
    expect(Math.max(...callTimes) - Math.min(...callTimes)).toBeGreaterThanOrEqual(150);
  });

  it('publishes a newly-added installation in a subsequent cycle', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.enqueue('vrm/b', '2');
    jest.advanceTimersByTime(500); // cycle 1: 'vrm/a' then 'vrm/b'
    expect(publish).toHaveBeenCalledTimes(2);
    // A third installation appears after cycle 1.
    throttle.enqueue('vrm/c', '3');
    // Cycle 2: N=3, tickMs=166. 'vrm/c' lands at its slot in cycle 2.
    jest.advanceTimersByTime(500);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith('vrm/c', '3');
  });

  it('floors tickMs at 1ms for very large fleets (per-installation latency grows linearly)', () => {
    // 1000 installations, intervalMs=500. Without the floor, tickMs would be 0.
    // With the floor, tickMs=1 and a full cycle takes 1000ms.
    const t = new RollingMessageThrottle(500, publish);
    t.start();
    for (let i = 0; i < 1000; i++) {
      t.enqueue(`vrm/site${i}/x`, `${i}`);
    }
    jest.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1000);
  });
});
