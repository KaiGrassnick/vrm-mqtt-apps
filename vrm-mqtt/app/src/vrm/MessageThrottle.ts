export type PublishFn = (topic: string, payload: string) => void;

/**
 * Coalescing throttle for high-frequency MQTT publish calls.
 *
 * Incoming messages are buffered by topic (latest value wins). A shared
 * interval timer flushes the entire buffer at once, so a burst of hundreds
 * of messages per second results in at most one publish call per topic per
 * flush interval.
 *
 * Set intervalMs = 0 to bypass buffering entirely (publish every message
 * directly, useful for tests and for disabling the throttle via config).
 */
export class MessageThrottle {
  private readonly buffer = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly publish: PublishFn,
  ) {}

  /** Buffer a message. Overwrites any previously buffered payload for the same topic. */
  enqueue(topic: string, payload: string): void {
    if (this.intervalMs === 0) {
      this.publish(topic, payload);
      return;
    }
    this.buffer.set(topic, payload);
  }

  /** Start the flush interval. Call on connect; safe to call again on reconnect. */
  start(): void {
    if (this.intervalMs === 0) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => { this.doFlush(); }, this.intervalMs);
  }

  /** Drain the buffer immediately and stop the interval. Call on offline/stop. */
  flush(): void {
    this.doFlush();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private doFlush(): void {
    if (this.buffer.size === 0) return;
    for (const [topic, payload] of this.buffer) {
      this.publish(topic, payload);
    }
    this.buffer.clear();
  }
}
