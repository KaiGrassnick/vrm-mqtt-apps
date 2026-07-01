import { getCurrentlyForwardedTopics, getObservedPaths } from '../observedPaths';

describe('getObservedPaths', () => {
  it('returns one entry per service present in SERVICE_ENTITY_DEFS', () => {
    const result = getObservedPaths();
    const services = result.map(s => s.service).sort();
    expect(services).toEqual(['platform', 'system', 'vebus']);
  });

  it('system and platform use instanceSegment "0"', () => {
    const result = getObservedPaths();
    expect(result.find(s => s.service === 'system')!.instanceSegment).toBe('0');
    expect(result.find(s => s.service === 'platform')!.instanceSegment).toBe('0');
  });

  it('every other service uses instanceSegment "+"', () => {
    const result = getObservedPaths();
    expect(result.find(s => s.service === 'vebus')!.instanceSegment).toBe('+');
  });

  it('system paths are sorted and deduplicated', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect([...systemPaths].sort()).toEqual(systemPaths);
    expect(new Set(systemPaths).size).toBe(systemPaths.length);
  });

  it('system paths expand {n} to 1, 2, 3 for aggregate-source templates', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Ac/Grid/L1/Power');
    expect(systemPaths).toContain('Ac/Grid/L2/Power');
    expect(systemPaths).toContain('Ac/Grid/L3/Power');
  });

  it('system paths include forward: true normal entities as literal paths', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Dc/Battery/Soc');
    expect(systemPaths).toContain('Dc/Battery/Voltage');
    expect(systemPaths).toContain('Dc/Battery/State');
  });

  it('system paths include literal aggregate sources regardless of forward flag', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).toContain('Dc/Pv/Power');
  });

  it('system paths do NOT include normal entities without forward: true that are not aggregate sources', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).not.toContain('Ac/Grid/L1/Current');
  });

  it('system paths do NOT include aggregate targets (HA-published, not bus-side)', () => {
    const systemPaths = getObservedPaths().find(s => s.service === 'system')!.paths;
    expect(systemPaths).not.toContain('Ac/Grid/Power');
    expect(systemPaths).not.toContain('Pv/Power');
  });

  it('non-system services do not fold in system aggregate sources', () => {
    // vebus has zero forward:true entities today, so its paths list is empty —
    // it must NOT inherit system's aggregate-source paths.
    const vebusPaths = getObservedPaths().find(s => s.service === 'vebus')!.paths;
    expect(vebusPaths).toEqual([]);
  });
});

describe('getCurrentlyForwardedTopics', () => {
  const ID_SITE = 42;
  const SYSTEM_PLATFORM_ONLY = new Map([
    ['system', new Set(['0'])],
    ['platform', new Set(['0'])],
  ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;

  it('always contains vrm/{idSite}/availability', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/availability`);
  });

  it('contains vrm/{idSite}/system/0/{path} for every forward: true system entity', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('currently has no forward: true template entities — template branch is code-review covered', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Ac/Grid/L1/Power`);
  });

  it('contains vrm/{idSite}/custom/aggregate/{path} for every forward: true aggregate', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Consumption/Power`);
    expect(topics).toContain(`vrm/${ID_SITE}/custom/aggregate/Ac/Grid/Power`);
  });

  it('does NOT contain forward: false / unflagged entity paths', () => {
    const topics = getCurrentlyForwardedTopics(ID_SITE, SYSTEM_PLATFORM_ONLY);
    expect(topics).not.toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Current`);
  });

  it('includes topics for a dynamically-observed service instance', () => {
    // Prove the new per-service loop actually emits topics for a non-system
    // service once observedInstances says an instance is known — even though
    // vebus has no forward:true entity today (so the set of paths is empty,
    // this at minimum must not throw and must not silently drop system's topics).
    const withVebus = new Map([
      ['system', new Set(['0'])],
      ['platform', new Set(['0'])],
      ['vebus', new Set(['0'])],
    ]) as ReadonlyMap<import('../../vrm/types').VrmServiceName, ReadonlySet<string>>;
    const topics = getCurrentlyForwardedTopics(ID_SITE, withVebus);
    expect(topics).toContain(`vrm/${ID_SITE}/system/0/Dc/Battery/Soc`);
  });

  it('returns disjoint sets for different idSite values', () => {
    const a = getCurrentlyForwardedTopics(1, SYSTEM_PLATFORM_ONLY);
    const b = getCurrentlyForwardedTopics(2, SYSTEM_PLATFORM_ONLY);
    for (const t of a) {
      expect(b).not.toContain(t);
    }
  });
});