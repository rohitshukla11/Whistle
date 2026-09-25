/**
 * The compressed clock, computed the same way on both sides.
 *
 * The browser owns this — it is the thing that knows whether the operator has
 * pressed Pause — and it sends the origin with every step so the server reaches
 * the same answer without storing anything. Two copies of one formula would be
 * two clocks; one module imported by both is one clock.
 */

/** 90 minutes, matching `FULL_MATCH` in the terminal driver. */
export const FULL_MATCH = 90;

/** The two speeds the panel offers: the whole match in 3 or 6 real minutes. */
export type Speed = 3 | 6;

export interface Clock {
  running: boolean;
  speed: Speed;
  /** Wall-clock ms at which the match was at `originMinute`. */
  originMs: number;
  originMinute: number;
  /** Pull the clock forward to here, if it is not already past it. */
  skipTo?: number;
}

export function minuteOf(c: Clock, now = Date.now()): number {
  const base = c.running ? c.originMinute + (now - c.originMs) / ((c.speed * 60_000) / FULL_MATCH) : c.originMinute;
  return c.skipTo !== undefined && c.skipTo > base ? c.skipTo : base;
}

/** Seconds until `minute` arrives, for the status line. */
export function etaSeconds(c: Clock, minute: number, now = Date.now()): number {
  const msPerMinute = (c.speed * 60_000) / FULL_MATCH;
  return Math.max(0, Math.round(((minute - minuteOf(c, now)) * msPerMinute) / 1000));
}
