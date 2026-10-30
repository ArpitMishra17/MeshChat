/**
 * Pure reassembly of attachments (TYPE_MEDIA chunks) — no native imports so it
 * can be unit-tested under plain node.
 *
 * MEDIA packets can overtake the MESSAGE_EXT that announces them when the
 * mesh floods, so chunks for an id we have not been told about yet are held
 * in a small bounded buffer and attached once `expect()` is called.
 */
import { MEDIA_CHUNK_BYTES } from './protocol';

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_CONCURRENT = 8;
/** Ids we will buffer chunks for before any EXT announces them. */
const MAX_PENDING_IDS = 16;
/** Matches the router's `meta.chunks > 64` rejection; bounds per-id memory. */
const MAX_PENDING_CHUNKS = 64;
/** The wire index is 2 bytes, so no valid chunk index can exceed this. */
const MAX_INDEX = 0xffff;

export type AddChunkResult =
  | { done: false; received: number; total: number }
  | { done: true; bytes: Uint8Array };

interface Transfer {
  total: number;
  totalBytes: number;
  chunks: (Uint8Array | undefined)[];
  received: number;
  lastActivity: number;
}

interface Pending {
  chunks: Map<number, Uint8Array>;
  lastActivity: number;
}

/**
 * Split `bytes` into consecutive slices of `chunkSize` bytes (the last one may
 * be shorter). Slices are views over `bytes`, not copies. Empty input -> [].
 */
export function chunkBytes(bytes: Uint8Array, chunkSize: number = MEDIA_CHUNK_BYTES): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    out.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)));
  }
  return out;
}

export class MediaAssembler {
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  /** Insertion order doubles as age order: re-expect deletes and re-inserts. */
  private readonly transfers = new Map<string, Transfer>();
  private readonly pending = new Map<string, Pending>();

  constructor(opts: { ttlMs?: number; maxConcurrent?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Register an expected transfer (from MESSAGE_EXT). Replaces any stale entry
   * for the same id. Chunks that were buffered before this call are attached;
   * if they already complete the transfer, the result is returned here because
   * no further addChunk() call is guaranteed to arrive.
   */
  expect(messageId: string, totalChunks: number, totalBytes: number): AddChunkResult | void {
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_INDEX + 1) return;
    if (!Number.isInteger(totalBytes) || totalBytes < 0) return;

    this.transfers.delete(messageId);
    const buffered = this.pending.get(messageId);
    this.pending.delete(messageId);

    const now = this.now();
    const t: Transfer = {
      total: totalChunks,
      totalBytes,
      chunks: new Array<Uint8Array | undefined>(totalChunks),
      received: 0,
      lastActivity: now,
    };
    this.transfers.set(messageId, t);
    this.evictOverCapacity(messageId);

    if (!buffered) return;
    for (const [index, data] of buffered.chunks) {
      if (index < t.total && t.chunks[index] === undefined) {
        t.chunks[index] = data;
        t.received++;
      }
    }
    if (t.received === t.total) return this.finish(messageId, t);
  }

  /**
   * Feed one TYPE_MEDIA chunk. Duplicates and out-of-range indexes are ignored.
   * Chunks for an id with no expect() yet are buffered (bounded) and attached
   * later. When the last chunk arrives the bytes are concatenated in index
   * order; if their total length disagrees with the announced size the
   * transfer is corrupt and dropped.
   */
  addChunk(messageId: string, index: number, data: Uint8Array): AddChunkResult {
    if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
      return this.stateOf(messageId);
    }
    const now = this.now();
    const t = this.liveTransfer(messageId, now);

    if (!t) {
      this.bufferPending(messageId, index, data, now);
      return { done: false, received: 0, total: 0 };
    }

    if (index >= t.total) return this.stateOf(messageId);
    t.lastActivity = now;
    if (t.chunks[index] === undefined) {
      t.chunks[index] = new Uint8Array(data);
      t.received++;
    }
    if (t.received === t.total) return this.finish(messageId, t);
    return { done: false, received: t.received, total: t.total };
  }

  progress(messageId: string): { received: number; total: number } | null {
    const t = this.liveTransfer(messageId, this.now());
    return t ? { received: t.received, total: t.total } : null;
  }

  /** Drop expired transfers and buffers; returns the ids of expired transfers. */
  sweep(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [id, t] of this.transfers) {
      if (this.isExpired(t.lastActivity, now)) {
        this.transfers.delete(id);
        expired.push(id);
      }
    }
    for (const [id, p] of this.pending) {
      if (this.isExpired(p.lastActivity, now)) this.pending.delete(id);
    }
    return expired;
  }

  private isExpired(lastActivity: number, now: number): boolean {
    return now - lastActivity > this.ttlMs;
  }

  /** The transfer for `id` if it exists and has not expired (expired ones are removed). */
  private liveTransfer(id: string, now: number): Transfer | undefined {
    const t = this.transfers.get(id);
    if (!t) return undefined;
    if (this.isExpired(t.lastActivity, now)) {
      this.transfers.delete(id);
      return undefined;
    }
    return t;
  }

  private stateOf(id: string): AddChunkResult {
    const t = this.transfers.get(id);
    return t
      ? { done: false, received: t.received, total: t.total }
      : { done: false, received: 0, total: 0 };
  }

  private bufferPending(id: string, index: number, data: Uint8Array, now: number): void {
    let p = this.pending.get(id);
    if (!p) {
      if (this.pending.size >= MAX_PENDING_IDS) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      p = { chunks: new Map(), lastActivity: now };
      this.pending.set(id, p);
    }
    if (p.chunks.size >= MAX_PENDING_CHUNKS || p.chunks.has(index)) return;
    p.chunks.set(index, new Uint8Array(data));
    p.lastActivity = now;
  }

  private evictOverCapacity(keep: string): void {
    while (this.transfers.size > this.maxConcurrent) {
      const oldest = this.transfers.keys().next().value;
      if (oldest === undefined || oldest === keep) break;
      this.transfers.delete(oldest);
    }
  }

  /** Concatenate a complete transfer, or drop it if the sizes disagree. */
  private finish(id: string, t: Transfer): AddChunkResult {
    this.transfers.delete(id);
    let sum = 0;
    for (const c of t.chunks) sum += c ? c.length : 0;
    if (sum !== t.totalBytes) {
      return { done: false, received: 0, total: t.total };
    }
    const bytes = new Uint8Array(sum);
    let off = 0;
    for (const c of t.chunks) {
      if (!c) continue;
      bytes.set(c, off);
      off += c.length;
    }
    return { done: true, bytes };
  }
}
