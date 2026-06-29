import { getObservedPaths } from '../observedPaths';

describe('getObservedPaths', () => {
  it('returns a sorted array', () => {
    const result = getObservedPaths();
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it('contains no duplicates', () => {
    const result = getObservedPaths();
    expect(new Set(result).size).toBe(result.length);
  });

  it('expands {n} to 1, 2, 3 for normal-entity path templates', () => {
    const result = getObservedPaths();
    // Ac/Grid/L{n}/Power is the template for the per-phase power entity.
    // As an aggregate source for custom/aggregate/Ac/Grid/Power it must be in the set.
    expect(result).toContain('Ac/Grid/L1/Power');
    expect(result).toContain('Ac/Grid/L2/Power');
    expect(result).toContain('Ac/Grid/L3/Power');
  });

  it('includes forward: true normal entities as literal paths', () => {
    const result = getObservedPaths();
    // After Task 1, Dc/Battery/Soc, Voltage, State all have forward: true.
    expect(result).toContain('Dc/Battery/Soc');
    expect(result).toContain('Dc/Battery/Voltage');
    expect(result).toContain('Dc/Battery/State');
  });

  it('includes literal aggregate sources regardless of the aggregate forward flag', () => {
    const result = getObservedPaths();
    // Dc/Pv/Power is a literal source for custom/aggregate/Pv/Power.
    expect(result).toContain('Dc/Pv/Power');
  });

  it('does NOT include paths for normal entities without forward: true', () => {
    const result = getObservedPaths();
    // Ac/Grid/L{n}/Current is defined but NOT forward: true and not an aggregate source.
    expect(result).not.toContain('Ac/Grid/L1/Current');
    expect(result).not.toContain('Ac/Grid/L2/Current');
    expect(result).not.toContain('Ac/Grid/L3/Current');
  });

  it('does NOT include aggregate targets (they are HA-published topics, not bus-side paths)', () => {
    const result = getObservedPaths();
    // The aggregate targets are NOT observed paths on the bus — they are HA-published topics.
    // getObservedPaths returns bus-side paths only.
    expect(result).not.toContain('Ac/Grid/Power');
    expect(result).not.toContain('Pv/Power');
  });

  it('does not include non-system-service entities', () => {
    const result = getObservedPaths();
    // vebus / platform entities are not system/0 — they must not leak in.
    // Ac/Out/L{n}/P is a vebus entity, not a system entity.
    expect(result).not.toContain('Ac/Out/L1/P');
  });
});