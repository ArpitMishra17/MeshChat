import { bleService, type IncomingPacket } from './ble';
import { messageRouter, type RouteLogEntry } from './messageRouter';
import { getOutboxCount } from '../db/database';
import { bytesToHex } from './ids';
import { Emitter } from './events';
import { CounterBuckets, SampleSeries } from './series';
import { HEADER_SIZE } from './protocol';

/**
 * Live instrumentation behind the Mesh and Wire screens. Everything here is
 * observed, never synthesized: packets come from `bleService.packetReceived`,
 * routing outcomes from `messageRouter.routingLog`, queue depth from SQLite.
 *
 * History is in-memory only — it starts when the app starts and resets on
 * relaunch (the DB keeps messages and the outbox, not time series).
 */

/** Throughput window: 30 buckets × 4 s = 2 minutes. */
export const THROUGHPUT_BUCKETS = 30;
export const THROUGHPUT_BUCKET_MS = 4_000;
/** Outbox depth: one sample a minute, 30 samples = 30 minutes. */
export const DEPTH_SAMPLES = 30;
const DEPTH_SAMPLE_MS = 60_000;
/** How many captured packets the wire inspector keeps. */
const CAPTURE_MAX = 30;
/** UI refresh coalescing — packets can arrive in bursts. */
const EMIT_MIN_MS = 500;

/** One received packet, copied out of the BLE layer so it is safe to keep. */
export interface CapturedPacket {
  seq: number;
  at: number;
  type: number;
  flags: number;
  ttl: number;
  payloadLen: number;
  packetLen: number;
  /** The raw 30-byte header, copied. */
  header: Uint8Array;
  /** The raw payload, copied. */
  payload: Uint8Array;
  msgIdHex: string;
  srcHex: string;
  dstHex: string;
  arrivalFingerprintHex: string | null;
}

class Telemetry {
  /** Fires (throttled) whenever any captured number changes. */
  readonly changed = new Emitter();

  private readonly throughput = new CounterBuckets(THROUGHPUT_BUCKETS, THROUGHPUT_BUCKET_MS);
  private readonly depth = new SampleSeries(DEPTH_SAMPLES);
  private packets: CapturedPacket[] = [];
  private seq = 0;
  private total = 0;
  private lastDrop: RouteLogEntry | null = null;

  private started = false;
  private unsubs: Array<() => void> = [];
  private depthTimer: ReturnType<typeof setInterval> | null = null;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;

    this.sampleDepth(true);
    this.depthTimer = setInterval(() => this.sampleDepth(true), DEPTH_SAMPLE_MS);

    this.unsubs.push(
      bleService.packetReceived.subscribe(p => this.onPacket(p)),
      messageRouter.routingLog.subscribe(e => {
        if (e.strategy === 'drop') {
          this.lastDrop = e;
          this.scheduleEmit();
        }
      }),
      // Keep the right edge of the depth chart current between samples.
      messageRouter.messagesChanged.subscribe(() => this.sampleDepth(false)),
    );
  }

  private onPacket(p: IncomingPacket): void {
    this.total += 1;
    this.throughput.add();
    this.packets.unshift({
      seq: ++this.seq,
      at: Date.now(),
      type: p.header.type,
      flags: p.header.flags,
      ttl: p.header.ttl,
      payloadLen: p.header.payloadLen,
      packetLen: p.packetBytes.length,
      header: p.headerBytes.slice(0, HEADER_SIZE),
      payload: p.payloadBytes.slice(),
      msgIdHex: bytesToHex(p.header.msgId),
      srcHex: bytesToHex(p.header.src),
      dstHex: bytesToHex(p.header.dst),
      arrivalFingerprintHex: p.arrivalFingerprintHex,
    });
    if (this.packets.length > CAPTURE_MAX) this.packets.length = CAPTURE_MAX;
    this.scheduleEmit();
  }

  private sampleDepth(push: boolean): void {
    try {
      const n = getOutboxCount();
      if (push) this.depth.push(n);
      else this.depth.setLast(n);
      this.scheduleEmit();
    } catch {
      // DB not ready yet — the next tick will catch up.
    }
  }

  private scheduleEmit(): void {
    const wait = EMIT_MIN_MS - (Date.now() - this.lastEmit);
    if (wait <= 0) {
      this.lastEmit = Date.now();
      this.changed.emit();
    } else if (this.emitTimer === null) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmit = Date.now();
        this.changed.emit();
      }, wait);
    }
  }

  /** packets/second per 4 s bucket, oldest → newest. */
  getThroughput(): number[] { return this.throughput.rates(); }
  /** Outbox depth samples, oldest → newest. */
  getDepth(): number[] { return this.depth.values(); }
  /** Captured packets, newest first. */
  getPackets(): CapturedPacket[] { return this.packets; }
  /** All packets received since launch. */
  getTotalPackets(): number { return this.total; }
  /** The most recent routing drop (TTL exhausted), if any. */
  getLastDrop(): RouteLogEntry | null { return this.lastDrop; }
}

export const telemetry = new Telemetry();
