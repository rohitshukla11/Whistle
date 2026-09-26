/** Display helpers. All arithmetic stays in bigint; only the output is a string. */

export const WAD = 10n ** 18n;
export const USDC = 10n ** 6n;

/** USDC 6dp -> "12.3456". */
export function usdc(value: bigint | undefined, places = 4): string {
  if (value === undefined) return "—";
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / USDC;
  const sign = negative ? "-" : "";
  // Zero places means whole USDC, not "1,234.0" — a decimal point with nothing
  // after it reads as a truncation rather than a rounding.
  if (places === 0) return `${sign}${whole.toLocaleString("en-US")}`;
  const frac = ((v % USDC) * 10n ** BigInt(places)) / USDC;
  return `${sign}${whole.toLocaleString("en-US")}.${frac.toString().padStart(places, "0")}`;
}

/** WAD -> "12.34". */
export function wad(value: bigint | undefined, places = 2): string {
  if (value === undefined) return "—";
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / WAD;
  const frac = ((v % WAD) * 10n ** BigInt(places)) / WAD;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(places, "0")}`;
}

/**
 * USDC at a glance: `1.63M`, `12.4k`, `948`.
 *
 * The board's stat cells are fixed width and a 1,629,043 USDC pot rendered as
 * "1,629,0…" — a number truncated mid-digit, which is worse than a rounded one
 * because it reads as a different number rather than an approximate one.
 */
export function usdcShort(value: bigint | undefined): string {
  if (value === undefined) return "—";
  const negative = value < 0n;
  const whole = (negative ? -value : value) / USDC;
  const sign = negative ? "-" : "";
  if (whole >= 1_000_000n) return `${sign}${(Number(whole) / 1_000_000).toFixed(2)}M`;
  if (whole >= 10_000n) return `${sign}${(Number(whole) / 1_000).toFixed(1)}k`;
  if (whole >= 1_000n) return `${sign}${(Number(whole) / 1_000).toFixed(2)}k`;
  return `${sign}${whole.toLocaleString("en-US")}`;
}

/** Card units are 18dp but always read as whole cards in the UI. */
export function units(value: bigint | undefined): string {
  if (value === undefined) return "—";
  return wad(value, 2);
}

export function short(address: string | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function bps(value: number | bigint | undefined): string {
  if (value === undefined) return "—";
  return `${(Number(value) / 100).toFixed(2)}%`;
}

/** Signed basis-point move, for the price deltas in the card table. */
export function moveBps(now: bigint, before: bigint): number {
  if (before === 0n) return 0;
  return Number(((now - before) * 10_000n) / before);
}

export function seconds(remaining: number): string {
  if (remaining <= 0) return "ready";
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export const EVENT_NAMES = ["HEARTBEAT", "GOAL", "YELLOW", "RED", "SUB"] as const;
export const STATE_NAMES = ["PRE_MATCH", "LIVE", "SETTLED"] as const;
export const POSITION_NAMES = ["GK", "DEF", "MID", "FWD"] as const;
export const SIDE_NAMES = ["BUY", "SELL"] as const;
export const CANCEL_REASONS = [
  "PRICE_MOVED",
  "UNAUTHORIZED",
  "INSUFFICIENT_INVENTORY",
  "REVOKED",
] as const;
