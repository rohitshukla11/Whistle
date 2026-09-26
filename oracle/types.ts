/**
 * Shared types for the replay driver, the live adapter and the agent runtime.
 *
 * The enums here mirror the on-chain ones exactly. If `IMatchOracle.EventType` ever
 * gains a member, this file has to move with it — the numeric values are what go
 * into `postEvent`.
 */

/** Mirrors `IMatchOracle.EventType`. */
export enum EventType {
  HEARTBEAT = 0,
  GOAL = 1,
  YELLOW = 2,
  RED = 3,
  SUB = 4,
}

/** Mirrors `IMatchOracle.FixtureState`. */
export enum FixtureState {
  PRE_MATCH = 0,
  LIVE = 1,
  SETTLED = 2,
}

/** Mirrors `ScoreMath.Position`. */
export enum Position {
  GK = 0,
  DEF = 1,
  MID = 2,
  FWD = 3,
}

/** Mirrors `IMarketVenue.Side`. */
export enum Side {
  BUY = 0,
  SELL = 1,
}

/** Mirrors `IMarketVenue.CancelReason`. */
export enum CancelReason {
  PRICE_MOVED = 0,
  UNAUTHORIZED = 1,
  INSUFFICIENT_INVENTORY = 2,
  REVOKED = 3,
}

export const POSITION_BY_NAME: Record<string, Position> = {
  GK: Position.GK,
  DEF: Position.DEF,
  MID: Position.MID,
  FWD: Position.FWD,
};

export const EVENT_TYPE_BY_NAME: Record<string, EventType> = {
  HEARTBEAT: EventType.HEARTBEAT,
  GOAL: EventType.GOAL,
  YELLOW: EventType.YELLOW,
  RED: EventType.RED,
  SUB: EventType.SUB,
};

// --------------------------------------------------------------- fixture file

export interface FixturePlayerJson {
  id: number;
  name: string;
  team: 0 | 1;
  position: keyof typeof POSITION_BY_NAME;
  starter: boolean;
  /** Decimal string of points, e.g. "3.0". Converted to WAD on load. */
  expectedEventPoints: string;
  expectedMinutes: number;
  /** Decimal probability in [0,1], e.g. "0.30". Converted to WAD on load. */
  cleanSheetProb0: string;
}

export interface FixtureEventJson {
  minute: number;
  type: keyof typeof EVENT_TYPE_BY_NAME;
  players: number[];
  note?: string;
}

export interface FixtureJson {
  schema: string;
  fixtureId: number;
  metadata: Record<string, string>;
  provenance: { verified: string[]; reconstructed: string[]; note: string };
  clock: { fullMatch: number; stoppageAllowed: boolean };
  players: FixturePlayerJson[];
  events: FixtureEventJson[];
}

// ------------------------------------------------------------- loaded shapes

export interface PlayerConfig {
  id: number;
  name: string;
  team: 0 | 1;
  position: Position;
  starter: boolean;
  /** WAD */
  expectedEventPoints: bigint;
  expectedMinutes: number;
  /** WAD */
  cleanSheetProb0: bigint;
}

export interface MatchEvent {
  minute: number;
  type: EventType;
  players: number[];
  note?: string;
}

export interface Fixture {
  fixtureId: bigint;
  metadata: Record<string, string>;
  players: PlayerConfig[];
  events: MatchEvent[];
}

/**
 * A source of match events. `replay.ts` reads a JSON file; `live-adapter.ts`
 * polls a football API. Both produce the same shape, so the driver does not care
 * which one it is holding.
 */
export interface EventSource {
  /** Squad and priors, needed to create the fixture on-chain. */
  loadFixture(): Promise<Fixture>;
  /**
   * Events in match order. An async iterator so a live feed can simply not yield
   * until something happens, while a replay yields on its compressed clock.
   */
  stream(): AsyncIterable<MatchEvent>;
}

export const WAD = 10n ** 18n;
export const USDC = 10n ** 6n;

/** Parse a decimal string ("3.5", "0.30") into WAD without floating point. */
export function toWad(decimal: string): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = body.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  const value = BigInt(whole) * WAD + BigInt(padded || "0");
  return negative ? -value : value;
}

/** WAD -> a short human string, for logs. */
export function fromWad(value: bigint, places = 2): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const whole = v / WAD;
  const frac = ((v % WAD) * 10n ** BigInt(places)) / WAD;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(places, "0")}`;
}

/** USDC 6dp -> a short human string, for logs. */
export function fromUsdc(value: bigint, places = 4): string {
  const whole = value / USDC;
  const frac = ((value % USDC) * 10n ** BigInt(places)) / USDC;
  return `${whole}.${frac.toString().padStart(places, "0")}`;
}
