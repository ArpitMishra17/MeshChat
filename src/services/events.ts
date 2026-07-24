/**
 * P0.1 — Minimal synchronous event emitter so screens can refresh when the
 * MessageRouter mutates the DB (incoming message, ACK status flip, new peer).
 * The router is the only writer; screens are read-only subscribers.
 *
 * Kept deliberately tiny — no payloads, just a "something changed" signal.
 * Screens re-query the DB on emit. This avoids stale-closure bugs that come
 * with passing data through the emitter.
 */
export type ChangeListener = () => void;

export class Emitter {
  private listeners = new Set<ChangeListener>();

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(): void {
    // Copy to a list first — a listener may unsubscribe during iteration.
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try {
        fn();
      } catch (e) {
        console.warn('[Emitter] listener threw:', e);
      }
    }
  }
}

/**
 * Typed emitter that carries a payload to its listeners. A tiny wrapper
 * around the payload-less `Emitter` above, for cases where passing the
 * changed value through the emitter is more convenient than re-querying
 * (e.g. scan results, incoming packets, routing-log entries). Used by
 * ble.ts and messageRouter.ts.
 */
export class PayloadEmitter<T> {
  private listeners = new Set<(payload: T) => void>();
  subscribe(fn: (payload: T) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  emit(payload: T): void {
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try { fn(payload); } catch (e) { console.warn('[PayloadEmitter] listener threw:', e); }
    }
  }
}
