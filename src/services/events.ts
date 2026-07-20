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
