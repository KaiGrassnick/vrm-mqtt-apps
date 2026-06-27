import { MessageThrottle } from '../MessageThrottle';

describe('MessageThrottle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // ── bypass mode (intervalMs = 0) ──────────────────────────────────────────

  describe('bypass mode (intervalMs = 0)', () => {
    it('publishes synchronously on enqueue', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(0, publish);
      t.enqueue('topic/a', 'p1');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('topic/a', 'p1');
    });

    it('start and flush are no-ops', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(0, publish);
      t.start();
      t.flush();
      jest.advanceTimersByTime(10_000);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  // ── buffering ─────────────────────────────────────────────────────────────

  describe('buffering', () => {
    it('does not publish before the interval fires', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      jest.advanceTimersByTime(499);
      expect(publish).not.toHaveBeenCalled();
    });

    it('publishes after the interval fires', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('topic/a', 'p1');
    });
  });

  // ── coalescing ────────────────────────────────────────────────────────────

  describe('coalescing', () => {
    it('two enqueues for the same topic produce one publish with the later payload', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/soc', '{"value":80}');
      t.enqueue('topic/soc', '{"value":81}');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('topic/soc', '{"value":81}');
    });

    it('two enqueues for different topics produce two publishes', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'pa');
      t.enqueue('topic/b', 'pb');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(2);
    });
  });

  // ── flush() ───────────────────────────────────────────────────────────────

  describe('flush()', () => {
    it('drains the buffer immediately without waiting for the interval', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      t.flush(); // before interval fires
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('topic/a', 'p1');
    });

    it('stops the timer so advancing time further does not publish again', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      t.flush();
      publish.mockClear();
      jest.advanceTimersByTime(1_000);
      expect(publish).not.toHaveBeenCalled();
    });

    it('is a no-op on an empty buffer', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.flush();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  // ── start() re-arm ────────────────────────────────────────────────────────

  describe('start() after flush()', () => {
    it('re-establishes the interval so subsequent enqueues are flushed again', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.flush();

      t.start(); // re-arm
      t.enqueue('topic/a', 'p2');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledWith('topic/a', 'p2');
    });

    it('clearing old timer prevents double-flush when start() is called while timer is running', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      t.start(); // called again (e.g. reconnect) — should reset timer, not add a second one
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  // ── interval cadence ─────────────────────────────────────────────────────

  describe('interval cadence', () => {
    it('fires once per interval tick', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      t.enqueue('topic/a', 'p1');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(1);

      t.enqueue('topic/a', 'p2');
      jest.advanceTimersByTime(500);
      expect(publish).toHaveBeenCalledTimes(2);
    });

    it('does not publish on ticks where the buffer is empty', () => {
      const publish = jest.fn();
      const t = new MessageThrottle(500, publish);
      t.start();
      jest.advanceTimersByTime(1_500); // 3 ticks, no enqueues
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
