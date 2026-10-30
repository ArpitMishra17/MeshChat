import { chunkBytes, MediaAssembler } from '../src/services/mediaAssembler';
import { MEDIA_CHUNK_BYTES, MAX_MEDIA_BYTES } from '../src/services/protocol';

/** Deterministic pseudo-random bytes (LCG) so failures reproduce exactly. */
function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('chunkBytes', () => {
  it('returns [] for empty input', () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });

  it('uses MEDIA_CHUNK_BYTES by default', () => {
    const bytes = pattern(MEDIA_CHUNK_BYTES * 2 + 5);
    const chunks = chunkBytes(bytes);
    expect(chunks.map(c => c.length)).toEqual([MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES, 5]);
  });

  it('leaves a short final chunk and round-trips exactly', () => {
    const bytes = pattern(1000);
    const chunks = chunkBytes(bytes, 300);
    expect(chunks.map(c => c.length)).toEqual([300, 300, 300, 100]);
    expect(concat(chunks)).toEqual(bytes);
  });

  it('gives a single chunk when the input fits', () => {
    const bytes = pattern(10);
    const chunks = chunkBytes(bytes, 64);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes);
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkBytes(pattern(4), 0)).toThrow(RangeError);
    expect(() => chunkBytes(pattern(4), 1.5)).toThrow(RangeError);
  });
});

describe('MediaAssembler', () => {
  const SIZE = MAX_MEDIA_BYTES; // largest legal attachment
  const bytes = pattern(SIZE, 42);
  const chunks = chunkBytes(bytes);

  it('reassembles a multi-chunk payload exactly, in order', () => {
    const a = new MediaAssembler();
    a.expect('m1', chunks.length, bytes.length);
    let last: ReturnType<MediaAssembler['addChunk']> | undefined;
    chunks.forEach((c, i) => {
      last = a.addChunk('m1', i, c);
    });
    expect(last && last.done).toBe(true);
    if (last && last.done) expect(last.bytes).toEqual(bytes);
    expect(a.progress('m1')).toBeNull();
  });

  it('reassembles out-of-order chunks by index', () => {
    const a = new MediaAssembler();
    a.expect('m1', chunks.length, bytes.length);
    const order = chunks.map((_, i) => i).reverse();
    let result: ReturnType<MediaAssembler['addChunk']> | undefined;
    for (const i of order) result = a.addChunk('m1', i, chunks[i]);
    expect(result && result.done).toBe(true);
    if (result && result.done) expect(result.bytes).toEqual(bytes);
  });

  it('reports progress and ignores duplicates', () => {
    const a = new MediaAssembler();
    a.expect('m1', 3, 9);
    expect(a.addChunk('m1', 0, new Uint8Array([1, 2, 3]))).toEqual({ done: false, received: 1, total: 3 });
    expect(a.addChunk('m1', 0, new Uint8Array([9, 9, 9]))).toEqual({ done: false, received: 1, total: 3 });
    expect(a.progress('m1')).toEqual({ received: 1, total: 3 });
    a.addChunk('m1', 2, new Uint8Array([7, 8, 9]));
    const r = a.addChunk('m1', 1, new Uint8Array([4, 5, 6]));
    expect(r).toEqual({ done: true, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  });

  it('ignores out-of-range indexes', () => {
    const a = new MediaAssembler();
    a.expect('m1', 2, 2);
    expect(a.addChunk('m1', 2, new Uint8Array([1]))).toEqual({ done: false, received: 0, total: 2 });
    expect(a.addChunk('m1', -1, new Uint8Array([1]))).toEqual({ done: false, received: 0, total: 2 });
    expect(a.addChunk('m1', 1.5, new Uint8Array([1]))).toEqual({ done: false, received: 0, total: 2 });
    expect(a.progress('m1')).toEqual({ received: 0, total: 2 });
  });

  it('buffers chunks that arrive before expect() and attaches them', () => {
    const a = new MediaAssembler();
    const first = a.addChunk('m1', 0, chunks[0]);
    expect(first.done).toBe(false);
    expect(a.progress('m1')).toBeNull();
    a.addChunk('m1', 2, chunks[2]);
    a.expect('m1', chunks.length, bytes.length);
    expect(a.progress('m1')).toEqual({ received: 2, total: chunks.length });
    let result: ReturnType<MediaAssembler['addChunk']> | undefined;
    for (let i = 1; i < chunks.length; i++) {
      if (i === 2) continue;
      result = a.addChunk('m1', i, chunks[i]);
    }
    expect(result && result.done).toBe(true);
    if (result && result.done) expect(result.bytes).toEqual(bytes);
  });

  it('returns the bytes from expect() when buffered chunks already complete the transfer', () => {
    const a = new MediaAssembler();
    a.addChunk('m1', 1, new Uint8Array([4, 5]));
    a.addChunk('m1', 0, new Uint8Array([1, 2, 3]));
    const r = a.expect('m1', 2, 5);
    expect(r).toEqual({ done: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    expect(a.progress('m1')).toBeNull();
  });

  it('bounds the pre-expect buffer to 16 ids (oldest evicted)', () => {
    const a = new MediaAssembler();
    for (let i = 0; i < 17; i++) a.addChunk(`p${i}`, 0, new Uint8Array([i]));
    // p0 was evicted; announcing it now yields nothing buffered.
    a.expect('p0', 2, 2);
    expect(a.progress('p0')).toEqual({ received: 0, total: 2 });
    // p16 is still buffered.
    a.expect('p16', 2, 2);
    expect(a.progress('p16')).toEqual({ received: 1, total: 2 });
  });

  it('drops a corrupt transfer whose chunk sizes disagree with totalBytes', () => {
    const a = new MediaAssembler();
    a.expect('m1', 2, 10);
    a.addChunk('m1', 0, new Uint8Array(4));
    const r = a.addChunk('m1', 1, new Uint8Array(4));
    expect(r.done).toBe(false);
    expect(a.progress('m1')).toBeNull();
  });

  it('ignores expect() with invalid counts', () => {
    const a = new MediaAssembler();
    a.expect('m1', 0, 0);
    a.expect('m2', 1.5, 10);
    a.expect('m3', 2, -1);
    expect(a.progress('m1')).toBeNull();
    expect(a.progress('m2')).toBeNull();
    expect(a.progress('m3')).toBeNull();
  });

  it('expect() for an existing id replaces the stale entry', () => {
    const a = new MediaAssembler();
    a.expect('m1', 3, 3);
    a.addChunk('m1', 0, new Uint8Array([1]));
    a.expect('m1', 2, 2);
    expect(a.progress('m1')).toEqual({ received: 0, total: 2 });
  });

  it('expires transfers after ttl of inactivity, using the injected clock', () => {
    const c = clock();
    const a = new MediaAssembler({ ttlMs: 1000, now: c.now });
    a.expect('m1', 2, 2);
    c.advance(900);
    a.addChunk('m1', 0, new Uint8Array([1])); // activity refreshes the timer
    c.advance(900);
    expect(a.sweep()).toEqual([]);
    expect(a.progress('m1')).toEqual({ received: 1, total: 2 });
    c.advance(1001);
    expect(a.sweep()).toEqual(['m1']);
    expect(a.progress('m1')).toBeNull();
  });

  it('treats an expired transfer as gone even before sweep() runs', () => {
    const c = clock();
    const a = new MediaAssembler({ ttlMs: 1000, now: c.now });
    a.expect('m1', 2, 2);
    c.advance(1500);
    expect(a.progress('m1')).toBeNull();
    expect(a.addChunk('m1', 0, new Uint8Array([1]))).toEqual({ done: false, received: 0, total: 0 });
  });

  it('evicts the oldest transfer when over maxConcurrent', () => {
    const a = new MediaAssembler({ maxConcurrent: 2 });
    a.expect('a', 1, 1);
    a.expect('b', 1, 1);
    a.expect('c', 1, 1);
    expect(a.progress('a')).toBeNull();
    expect(a.progress('b')).toEqual({ received: 0, total: 1 });
    expect(a.progress('c')).toEqual({ received: 0, total: 1 });
  });

  it('sweep() returns the ids it dropped and leaves live transfers alone', () => {
    const c = clock();
    const a = new MediaAssembler({ ttlMs: 500, now: c.now });
    a.expect('old', 2, 2);
    c.advance(400);
    a.expect('new', 2, 2);
    c.advance(200);
    expect(a.sweep()).toEqual(['old']);
    expect(a.progress('new')).toEqual({ received: 0, total: 2 });
  });

  it('keeps a slow multi-chunk transfer alive while it makes progress', () => {
    const c = clock();
    const a = new MediaAssembler({ ttlMs: 1000, now: c.now });
    a.expect('m1', chunks.length, bytes.length);
    let result: ReturnType<MediaAssembler['addChunk']> | undefined;
    chunks.forEach((ch, i) => {
      c.advance(600); // each gap is under ttl, total time far above it
      result = a.addChunk('m1', i, ch);
    });
    expect(result && result.done).toBe(true);
  });
});
