import { CounterBuckets, SampleSeries } from '../src/services/series';
import { bearingDegrees } from '../src/services/location';
import { SeenCache } from '../src/services/relay';

describe('CounterBuckets', () => {
  it('counts into the newest bucket and rolls forward with time', () => {
    let t = 0;
    const b = new CounterBuckets(4, 1000, () => t);
    b.add(2);
    expect(b.values()).toEqual([0, 0, 0, 2]);
    t = 1000;
    b.add();
    expect(b.values()).toEqual([0, 0, 2, 1]);
    t = 3000; // two more buckets elapse
    expect(b.values()).toEqual([2, 1, 0, 0]);
  });

  it('zeros everything after a gap longer than the window', () => {
    let t = 0;
    const b = new CounterBuckets(3, 1000, () => t);
    b.add(5);
    t = 10_000;
    expect(b.values()).toEqual([0, 0, 0]);
  });

  it('reports rates in events per second', () => {
    let t = 0;
    const b = new CounterBuckets(2, 4000, () => t);
    b.add(8);
    expect(b.rates()).toEqual([0, 2]);
  });
});

describe('SampleSeries', () => {
  it('keeps the newest N samples and can overwrite the last', () => {
    const s = new SampleSeries(3);
    [1, 2, 3, 4].forEach(v => s.push(v));
    expect(s.values()).toEqual([2, 3, 4]);
    s.setLast(9);
    expect(s.values()).toEqual([2, 3, 9]);
  });

  it('setLast on an empty series seeds it', () => {
    const s = new SampleSeries(3);
    s.setLast(7);
    expect(s.values()).toEqual([7]);
  });
});

describe('bearingDegrees', () => {
  const o = { lat: 0, lon: 0 };
  it('returns compass bearings clockwise from north', () => {
    expect(bearingDegrees(o, { lat: 1, lon: 0 })).toBeCloseTo(0, 3);
    expect(bearingDegrees(o, { lat: 0, lon: 1 })).toBeCloseTo(90, 3);
    expect(bearingDegrees(o, { lat: -1, lon: 0 })).toBeCloseTo(180, 3);
    expect(bearingDegrees(o, { lat: 0, lon: -1 })).toBeCloseTo(270, 3);
  });
});

describe('SeenCache eviction counter', () => {
  it('counts LRU evictions when the cap is exceeded', () => {
    const c = new SeenCache({ maxEntries: 2 });
    c.add('a'); c.add('b'); c.add('c'); c.add('d');
    expect(c.size).toBe(2);
    expect(c.evictions).toBe(2);
    expect(c.capacity).toBe(2);
  });
});
