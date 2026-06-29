import { SERVICE_ENTITY_DEFS, CUSTOM_ENTITY_DEFS } from '../entityDefs';
import type { SensorEntityDef, CustomAggregateEntityDef } from '../entityDefs';

describe('entityDefs', () => {
  describe('forward flag defaults', () => {
    it('SYSTEM_ENTITIES entities default to no forward flag (treated as false)', () => {
      const batterySoc = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Dc/Battery/Soc',
      );
      expect(batterySoc).toBeDefined();
      // Battery SOC must explicitly opt in via forward: true.
      expect((batterySoc as SensorEntityDef).forward).toBe(true);
    });

    it('per-phase L{n}/Power entities default to no forward flag', () => {
      const gridL1 = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Ac/Grid/L{n}/Power',
      );
      expect(gridL1).toBeDefined();
      expect((gridL1 as SensorEntityDef).forward).toBeUndefined();
    });

    it('Dc/Pv/Power entity has no forward flag (aggregate source only)', () => {
      const dcPv = SERVICE_ENTITY_DEFS.system?.find(
        (d) => 'path' in d && d.path === 'Dc/Pv/Power',
      );
      expect(dcPv).toBeDefined();
      expect((dcPv as SensorEntityDef).forward).toBeUndefined();
    });
  });

  describe('CUSTOM_ENTITY_DEFS', () => {
    it('contains the four expected aggregate entries', () => {
      const aggs = CUSTOM_ENTITY_DEFS.aggregate;
      const paths = aggs.map((a) => a.path).sort();
      expect(paths).toEqual([
        'Ac/Consumption/Power',
        'Ac/Genset/Power',
        'Ac/Grid/Power',
        'Pv/Power',
      ]);
    });

    it('all aggregates have aggregateFrom and forward: true', () => {
      for (const agg of CUSTOM_ENTITY_DEFS.aggregate) {
        expect(agg.aggregateFrom.length).toBeGreaterThan(0);
        expect((agg as CustomAggregateEntityDef).forward).toBe(true);
      }
    });

    it('Pv/Power combines DC PV and both AC PV sources', () => {
      const pv = CUSTOM_ENTITY_DEFS.aggregate.find(
        (a) => a.path === 'Pv/Power',
      );
      expect(pv).toBeDefined();
      expect(pv!.aggregateFrom).toEqual([
        'Dc/Pv/Power',
        'Ac/PvOnOutput/L{n}/Power',
        'Ac/PvOnGrid/L{n}/Power',
      ]);
    });

    it('no longer has Ac/PvOnOutput/AggPower or Ac/PvOnGrid/AggPower', () => {
      const aggs = CUSTOM_ENTITY_DEFS.aggregate;
      expect(aggs.find((a) => a.path === 'Ac/PvOnOutput/AggPower')).toBeUndefined();
      expect(aggs.find((a) => a.path === 'Ac/PvOnGrid/AggPower')).toBeUndefined();
    });

    it('SYSTEM_ENTITIES no longer contains any aggregate entries', () => {
      for (const def of SERVICE_ENTITY_DEFS.system ?? []) {
        expect('aggregateFrom' in def).toBe(false);
      }
    });
  });
});