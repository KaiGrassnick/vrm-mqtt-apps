import type { PublishFn } from './MessageThrottle';

/**
 * Shared coalescing throttle for ALL VRM installations.
 *
 * A single global buffer collects messages from all MqttBridgeConnections.
 * The flush interval publishes the latest value per topic across ALL
 * installations — providing true cross-installation coalescing and
 * replacing 100+ independent per-connection throttle timers with one.
 */
export class GlobalMessageThrottle {
  private readonly buffer = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly publish: PublishFn,
  ) {}

  /** Buffer a message from any installation. Latest value per topic wins. */
  enqueue(topic: string, payload: string): void {
    if (this.intervalMs === 0) {
      this.publish(topic, payload);
      return;
    }
    this.buffer.set(topic, payload);
  }

  /** Start the global flush interval. Called once when the first connection starts. */
  start(): void {
    if (this.intervalMs === 0) return;
    if (this.timer !== null) return;
    this.timer = setInterval(() => { this.doFlush(); }, this.intervalMs);
  }

  /** Drain the buffer immediately. */
  flush(): void {
    this.doFlush();
  }

  /** Stop the interval and drain the buffer. Called on final shutdown. */
  stop(): void {
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
