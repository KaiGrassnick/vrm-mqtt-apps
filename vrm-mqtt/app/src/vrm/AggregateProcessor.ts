import type { MqttMessage } from '../ha/types';

export interface AggregateRule {
  /** HA-side state topic, e.g. 'vrm/42/system/0/Ac/Grid/AggPower' */
  targetTopic: string;
  /** Logical source paths to watch, e.g. ['Ac/Grid/L1/Power', 'Ac/Grid/L2/Power', 'Ac/Grid/L3/Power'] */
  sourcePaths: string[];
}

/**
 * Buffers the latest numeric value per source path and produces aggregate
 * messages when a source updates.
 *
 * The aggregate is the sum of values from sources that have been observed at
 * least once during this processor's lifetime. This means a single-phase
 * installation (where only L1 ever reports) emits a one-phase sum, while a
 * three-phase installation emits L1 + L2 + L3. If no source has ever been
 * fed, the processor emits nothing.
 *
 * The bridge calls `clear()` on disconnect so that a reconnect re-establishes
 * the observed-sources set from scratch — VRM re-publishes every value on
 * reconnect, so the buffer is repopulated within the first few messages.
 *
 * Between disconnects, a source that stops reporting (e.g. a phase removed
 * by a hardware reconfiguration, or a sensor going dark) but whose
 * installation otherwise stays connected would, without `sourceExpiryMs`,
 * keep contributing its last known value to the sum forever — `clear()`
 * never runs because the connection itself never drops. `computeSum` instead
 * excludes any source whose last update is older than `sourceExpiryMs`.
 */
export class AggregateProcessor {
  private readonly latest = new Map<string, number>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly observedSources = new Set<string>();
  /** Reverse index built once at construction: source path → rules that watch
   *  it. Replaces a per-message linear scan over every rule's sourcePaths
   *  with an O(1) lookup. */
  private readonly rulesBySource = new Map<string, AggregateRule[]>();

  constructor(
    rules: AggregateRule[],
    /** A source path is excluded from the sum once this long has passed since
     *  it last reported. 0 = disabled (never expire). Default 300_000 (5min),
     *  matching the connection-level staleness default. */
    private readonly sourceExpiryMs = 300_000,
  ) {
    for (const rule of rules) {
      for (const sp of rule.sourcePaths) {
        const existing = this.rulesBySource.get(sp);
        if (existing) {
          existing.push(rule);
        } else {
          this.rulesBySource.set(sp, [rule]);
        }
      }
    }
  }

  /**
   * Feed a source path value directly. Returns any aggregate messages whose
   * rules include this source. Returns [] for untracked paths.
   */
  feed(sourcePath: string, value: number): MqttMessage[] {
    const matchingRules = this.rulesBySource.get(sourcePath);
    if (!matchingRules) return [];
    this.observedSources.add(sourcePath);
    this.latest.set(sourcePath, value);
    this.lastSeenAt.set(sourcePath, Date.now());
    const out: MqttMessage[] = [];
    for (const rule of matchingRules) {
      const sum = this.computeSum(rule);
      if (sum !== null) {
        out.push({ topic: rule.targetTopic, payload: `{"value":${sum}}` });
      }
    }
    return out;
  }

  /**
   * Parse a VRM-style payload `{"value": x}` and feed the value to the
   * aggregate. Returns the aggregate messages, or [] if the payload is
   * not parseable, the value is not a finite number, or the path is not
   * tracked.
   */
  feedPayload(sourcePath: string, payload: string): MqttMessage[] {
    const value = parseVrmValue(payload);
    if (value === null) return [];
    return this.feed(sourcePath, value);
  }

  /** Reset all buffered values and the observed-sources set. */
  clear(): void {
    this.latest.clear();
    this.lastSeenAt.clear();
    this.observedSources.clear();
  }

  private computeSum(rule: AggregateRule): number | null {
    let sum = 0;
    let counted = 0;
    const now = Date.now();
    for (const sp of rule.sourcePaths) {
      if (!this.observedSources.has(sp)) continue;
      if (this.sourceExpiryMs > 0) {
        const seenAt = this.lastSeenAt.get(sp);
        if (seenAt === undefined || now - seenAt > this.sourceExpiryMs) continue;
      }
      const v = this.latest.get(sp);
      if (v === undefined) return null;
      sum += v;
      counted++;
    }
    return counted > 0 ? sum : null;
  }
}

/**
 * Parse a VRM payload of the form `{"value": <number>}` and return the
 * numeric value, or `null` if the payload is not parseable, has no `value`
 * field, or the value is not a finite number.
 */
export function parseVrmValue(payload: string): number | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as { value?: unknown }).value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}
