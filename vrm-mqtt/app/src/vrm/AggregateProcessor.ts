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
 */
export class AggregateProcessor {
  private readonly rules: ReadonlyArray<AggregateRule>;
  private readonly latest = new Map<string, number>();
  private readonly observedSources = new Set<string>();

  constructor(rules: AggregateRule[]) {
    this.rules = rules;
  }

  /**
   * Feed a source path value directly. Returns any aggregate messages whose
   * rules include this source. Returns [] for untracked paths.
   */
  feed(sourcePath: string, value: number): MqttMessage[] {
    if (!this.isTracked(sourcePath)) return [];
    this.observedSources.add(sourcePath);
    this.latest.set(sourcePath, value);
    return this.recompute(sourcePath);
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
    this.observedSources.clear();
  }

  private isTracked(sourcePath: string): boolean {
    return this.rules.some(r => r.sourcePaths.includes(sourcePath));
  }

  private recompute(changedPath: string): MqttMessage[] {
    const out: MqttMessage[] = [];
    for (const rule of this.rules) {
      if (!rule.sourcePaths.includes(changedPath)) continue;
      const sum = this.computeSum(rule);
      if (sum !== null) {
        out.push({ topic: rule.targetTopic, payload: `{"value":${sum}}` });
      }
    }
    return out;
  }

  private computeSum(rule: AggregateRule): number | null {
    let sum = 0;
    let counted = 0;
    for (const sp of rule.sourcePaths) {
      if (!this.observedSources.has(sp)) continue;
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
