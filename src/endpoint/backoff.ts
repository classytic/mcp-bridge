/**
 * Full-jitter reconnect backoff. A connection that dies within `stableMs` of
 * opening still counts as a failure — otherwise a relay that accepts and
 * immediately drops sockets causes a reconnect storm (hermes
 * `reconnect-backoff.ts`, after 55 sockets in 12 s).
 */

export interface BackoffOptions {
  /** @default 300 */
  baseMs?: number;
  /** @default 15000 */
  capMs?: number;
  /** @default 5000 */
  stableMs?: number;
  random?: () => number;
}

export function createBackoff(opts: BackoffOptions = {}) {
  const base = opts.baseMs ?? 300;
  const cap = opts.capMs ?? 15_000;
  const stableMs = opts.stableMs ?? 5000;
  const random = opts.random ?? Math.random;
  let attempt = 0;
  let openedAt: number | undefined;

  return {
    /** The connection opened (authenticated). */
    opened(now = Date.now()) {
      openedAt = now;
    },
    /** The connection ended; returns how long to wait before the next try. */
    nextDelay(now = Date.now()): number {
      if (openedAt !== undefined && now - openedAt >= stableMs) attempt = 0;
      openedAt = undefined;
      const ceiling = Math.min(cap, base * 2 ** attempt);
      attempt++;
      return Math.floor(random() * ceiling);
    },
    reset() {
      attempt = 0;
      openedAt = undefined;
    },
  };
}
