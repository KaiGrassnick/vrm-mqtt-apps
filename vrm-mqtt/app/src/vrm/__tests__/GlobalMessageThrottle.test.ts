import { GlobalMessageThrottle } from '../GlobalMessageThrottle';

describe('GlobalMessageThrottle', () => {
  let publish: jest.Mock;
  let throttle: GlobalMessageThrottle;

  beforeEach(() => {
    jest.useFakeTimers();
    publish = jest.fn();
    throttle = new GlobalMessageThrottle(500, publish);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes directly when intervalMs is 0 (bypass mode)', () => {
    const direct = new GlobalMessageThrottle(0, publish);
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

  it('publishes distinct topics in one flush', () => {
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

  it('flush() drains the buffer immediately but leaves the timer running', () => {
    throttle.start();
    throttle.enqueue('vrm/a', '1');
    throttle.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    // Timer is still armed: subsequent enqueue + advance triggers another publish.
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
});