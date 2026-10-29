/**
 * Pure rolling-window helpers behind the Mesh telemetry charts. No RN / BLE
 * imports so they are unit-testable under plain node Jest, like relay.ts.
 */

/**
 * Fixed number of equal-width time buckets, newest last. `add()` counts an
 * event into the current bucket; `values()` returns per-bucket counts oldest →
 * newest, with elapsed-but-empty buckets reported as 0.
 */
export class CounterBuckets {
  private buckets: number[];
  private headStart: number; // start time (ms) of the newest bucket
  private readonly now: () => number;

  constructor(
    private readonly count: number,
    private readonly widthMs: number,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
    this.buckets = new Array(count).fill(0);
    this.headStart = now();
  }

  private advance(): void {
    const steps = Math.floor((this.now() - this.headStart) / this.widthMs);
    if (steps <= 0) return;
    if (steps >= this.count) {
      this.buckets.fill(0);
    } else {
      this.buckets = [...this.buckets.slice(steps), ...new Array(steps).fill(0)];
    }
    this.headStart += steps * this.widthMs;
  }

  add(n = 1): void {
    this.advance();
    this.buckets[this.count - 1] += n;
  }

  values(): number[] {
    this.advance();
    return [...this.buckets];
  }

  /** Per-bucket rate in events/second. */
  rates(): number[] {
    return this.values().map(v => v / (this.widthMs / 1000));
  }
}

/** Bounded list of sampled values, newest last. */
export class SampleSeries {
  private data: number[] = [];
  constructor(private readonly max: number) {}

  push(v: number): void {
    this.data.push(v);
    if (this.data.length > this.max) this.data.shift();
  }

  /** Overwrite the newest sample (keeps the chart's right edge current). */
  setLast(v: number): void {
    if (this.data.length === 0) this.data.push(v);
    else this.data[this.data.length - 1] = v;
  }

  values(): number[] {
    return [...this.data];
  }
}
