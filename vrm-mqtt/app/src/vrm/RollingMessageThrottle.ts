export type PublishFn = (topic: string, payload: string) => void;

/**
 * Sharded, rolling message throttle for fleet-scale MQTT publish load.
 *
 * A `setTimeout` chain ticks at `max(1, ⌊intervalMs / N⌋)` milliseconds,
 * where N is the number of distinct installations that have data buffered.
 * Each tick advances a round-robin cursor and flushes one shard — the
 * latest payload per topic. The buffer is partitioned by `portalId`
 * (extracted from the `vrm/{portalId}/…` topic prefix), so a single
 * installation's timing matches the original single-buffer throttle.
 *
 * Net effect: with 100 installations the ~700 publishes that would
 * otherwise hit the broker in a single synchronous batch every 500ms
 * are spread roughly evenly across the 500ms window (one installation's
 * publishes every 5ms). For a single installation the timing is
 * byte-identical to the legacy single-buffer behaviour.
 */
export class RollingMessageThrottle {
  private readonly shards = new Map<string, Map<string, string>>();
  /** Cache of `shards.keys()` for `tick()`'s round-robin indexing. Rebuilt only
   *  when a shard is added or removed (rare), not on every tick (frequent —
   *  as low as 1ms apart for large fleets), to avoid reallocating an array
   *  just to index one entry. */
  private shardKeys: string[] = [];
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly publish: PublishFn,
  ) {}

  /** Buffer a message. Per-shard `Map.set` gives "latest value wins". */
  enqueue(topic: string, payload: string): void {
    if (this.intervalMs === 0) {
      this.publish(topic, payload);
      return;
    }
    const portalId = this.portalIdOf(topic);
    let shard = this.shards.get(portalId);
    let isNewShard = false;
    if (!shard) {
      shard = new Map();
      this.shards.set(portalId, shard);
      isNewShard = true;
      this.shardKeys = Array.from(this.shards.keys());
    }
    shard.set(topic, payload);
    // Re-arm the schedule so a newly-seen portalId is included in the
    // next tick interval calculation.
    if (isNewShard && this.running) {
      this.reschedule();
    }
  }

  /** Start (or re-arm) the rolling tick schedule. Idempotent. */
  start(): void {
    if (this.intervalMs === 0) return;
    if (this.running) return;
    this.running = true;
    this.reschedule();
  }

  /**
   * Drain all buffered topics immediately. The schedule keeps running —
   * a subsequent `enqueue` is picked up by the next tick.
   */
  flush(): void {
    this.drainAll();
  }

  /**
   * Remove a shard's map entry entirely (not just its contents). Call this
   * when an installation is torn down (removed/replaced) — `flush()`/`drainAll()`
   * empty a shard's contents but leave its key in `shards` forever, which would
   * otherwise grow unboundedly under fleet churn and skew the tick-cadence
   * calculation in `reschedule()` toward dead installations. Safe to call with
   * any key, including one with no shard.
   */
  removeShard(key: string): void {
    if (this.shards.delete(key)) {
      this.shardKeys = Array.from(this.shards.keys());
    }
  }

  /** Drain all buffered topics, clear the timer, and stop new flushes. */
  stop(): void {
    this.drainAll();
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drainAll(): void {
    for (const shard of this.shards.values()) {
      for (const [topic, payload] of shard) {
        this.publish(topic, payload);
      }
      shard.clear();
    }
  }

  private reschedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const N = this.shards.size;
    const tickMs =
      N > 0
        ? Math.max(1, Math.floor(this.intervalMs / N))
        : this.intervalMs;
    this.timer = setTimeout(() => {
      this.tick();
      this.reschedule();
    }, tickMs);
    // Don't keep the event loop alive on the throttle alone. In production
    // an MQTT client (or other ref'd handle) always outlives the timer;
    // in tests the worker can exit cleanly when nothing else holds the loop.
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.shards.size === 0) return;
    const portalIds = this.shardKeys;
    const portalId = portalIds[this.cursor % portalIds.length];
    this.cursor++;
    const shard = this.shards.get(portalId);
    if (shard && shard.size > 0) {
      for (const [topic, payload] of shard) {
        this.publish(topic, payload);
      }
      shard.clear();
    }
  }

  /**
   * Extract the installation identifier from a `vrm/{portalId}/...` topic.
   * Defensive: any topic that does not match the shape falls into a single
   * shared `_unknown` shard so the throttle never throws.
   */
  private portalIdOf(topic: string): string {
    const parts = topic.split('/');
    return parts.length >= 2 && parts[0] === 'vrm' ? parts[1] : '_unknown';
  }
}
