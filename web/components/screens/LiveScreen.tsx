"use client";

/**
 * The board, as a pitch.
 *
 * Two panes: the squad, and the match. The pitch is the default because the
 * question people actually ask during a game is "who is on, and what are they
 * worth" — a table answers the second half, a pitch answers both at once. The
 * card grid is still there behind a toggle.
 *
 * Everything reads from `useWhistle`. Three things are not on chain and say so
 * where they appear: the keeper cadence (a client constant, shown as "next
 * tick"), the score (counted from `MatchEvent` logs, because the oracle stores
 * points rather than goals), and shirt numbers and formations (from the match
 * file, vendored at build time).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAccount, usePublicClient } from "wagmi";

import { STOP_NOTE } from "../CapControls";
import { WORLD_ON } from "../WorldVerify";
import { AgentRow } from "./PreMatchScreen";
import { CompactPlayerCard, type CardState, type Tint } from "../PlayerCard";
import { Pitch, type PitchPlayer } from "../Pitch";
import { QueueOrder } from "../QueueOrder";
import { SquadTable, type RowAction } from "../SquadTable";
import type { Address } from "viem";

import type { ShirtState } from "../Shirt";
import { useFixture } from "../../lib/fixtures";
import { useSelectedPlayer } from "../../lib/selection";
import { useMyAgents } from "../../lib/useMyAgents";
import { POSITION_NAMES, usdc, usdcShort, wad, WAD } from "../../lib/format";
import { scoreFrom } from "../../lib/score";
import { shirtNumber, TEAM_NAMES } from "../../lib/squad";
import {
  agentRegistryAbi,
  displayScore,
  displayPrice,
  playerCardAbi,
  statusOf,
  useWhistle,
  type PlayerRow,
} from "../../lib/useWhistle";

/** The keeper's cadence in `replay.ts`. Not on chain — see the file header. */
const KEEPER_SECONDS = 5;

const TEAM_TINT: [Tint, Tint] = ["purple-blue", "orange-pink"];
const TEAM_COLOUR: [string, string] = ["#2F6FD0", "#A6214B"];

/**
 * The in-page match driver, and whether this build has one.
 *
 * A literal so the flag is visible to the bundler, and loaded on demand so that
 * with the flag off the chunk is built but never fetched. The panel can sign
 * nothing by itself — every button is a request to a server route that holds the
 * keys — but it is still an operator control, not a visitor feature, so it does
 * not ship switched on.
 */
const SIM_ON = process.env.NEXT_PUBLIC_SIM === "on";
const SimPanel = SIM_ON
  ? dynamic(() => import("../SimPanel").then((m) => m.SimPanel))
  : null;

/**
 * Why MY CARDS is showing you nothing.
 *
 * There are two reasons and they need different actions — no wallet is not the
 * same as an empty wallet — so the panel says which one it is.
 */
function NothingHeld({ connected, className = "" }: { connected: boolean; className?: string }) {
  return (
    <p className={`text-center text-[13px] leading-relaxed text-muted ${className}`}>
      {connected ? (
        <>
          You hold no cards in this fixture.
          <span className="mt-1 block text-dim">Buy or mint one from the squad list.</span>
        </>
      ) : (
        <>
          No wallet connected, so Whistle cannot tell which cards are yours.
          <span className="mt-1 block text-dim">Connect one to light up your shirts.</span>
        </>
      )}
    </p>
  );
}

type View = "pitch" | "cards";
type Pane = "lineups" | "mine" | "events";

// ------------------------------------------------------------------- helpers

function moveBps(p: PlayerRow, baseline: Map<number, bigint>): number {
  const base = baseline.get(p.id);
  if (base === undefined || base === 0n) return 0;
  return Number(((p.referencePrice - base) * 10_000n) / base);
}

function pct(bps: number): string {
  if (bps === 0) return "—";
  return `${bps > 0 ? "+" : "−"}${Math.abs(bps / 100).toFixed(1)}%`;
}

function cardState(p: PlayerRow, conceded: boolean): CardState {
  const status = statusOf(p);
  if (status === "sent-off") return { kind: "sent-off", minute: p.minutes };
  if (status === "subbed") return { kind: "subbed", minute: p.minutes };
  if (p.banked >= 4n * 10n ** 18n) return { kind: "goal", minute: p.minutes };
  if (conceded && p.position <= 1 && p.onPitch) return { kind: "conceded", minute: p.minutes };
  return { kind: "none" };
}

/** One sentence on what an event did to the board. */
function effectOf(label: string, detail: string, away: string, L: number): string {
  const who = detail.split(" → ")[0]?.trim() || "A player";
  if (/RED/.test(label)) {
    return `${away} to ten. ${who} frozen. All 36 cards re-anchored. Tick in ${L} s.`;
  }
  if (/GOAL/.test(label)) {
    return `${who}'s share of the pot grows; every other card's share shrinks.`;
  }
  if (/SUB/.test(label)) {
    return "One line frozen, one started. Minutes stop accruing for the player off.";
  }
  return "Clock advanced. Every expected score re-derived and all 36 cards re-anchored.";
}

// -------------------------------------------------------------------- pieces

function Stat({
  label,
  value,
  tone,
  className = "",
}: {
  label: string;
  value: string;
  tone?: string;
  /** Which edges this cell draws, which differs between the 2x2 and the row. */
  className?: string;
}) {
  return (
    <div className={`min-w-0 flex-1 px-3 py-2.5 ${className}`}>
      <dt className="font-display text-[10px] font-bold tracking-[0.18em] text-muted">{label}</dt>
      <dd className={`tnum truncate font-display text-[22px] font-extrabold ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------- page

export default function FixturePage() {
  const { players, header, feed, feedComplete, kickoffPrices, error, loading, refresh } = useWhistle();
  const { deployment, fixtureId } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [view, setView] = useState<View>("pitch");
  const [pane, setPane] = useState<Pane>("lineups");
  // Shared with the pre-match screen, so kickoff does not drop the player you picked.
  const [selected, setSelected] = useSelectedPlayer(deployment.fixtureId);
  const [tick, setTick] = useState(0);
  const [held, setHeld] = useState<Map<number, bigint>>(new Map());
  /**
   * Whether this wallet has any standing in the match, for the Start button.
   *
   * Starting a match is not destructive but it is not reversible either, and the
   * demo is only worth watching if the person driving it owns something that
   * moves. Holding a card or having minted an agent both count; neither is
   * checked on the server, which requires the operator's signature instead — this is a
   * guard against a misclick, not against an attacker.
   */
  const [hasAgent, setHasAgent] = useState<boolean | null>(null);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  /** What this wallet holds, so rows and shirts can say so. */
  useEffect(() => {
    if (!publicClient || !address || players.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const balances = (await publicClient.multicall({
          contracts: players.map((p) => ({
            address: p.card, abi: playerCardAbi, functionName: "balanceOf" as const, args: [address] as const,
          })),
          allowFailure: true,
        })) as { status: string; result?: bigint }[];
        if (cancelled) return;
        const out = new Map<number, bigint>();
        players.forEach((p, i) => {
          const r = balances[i];
          if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) out.set(p.id, r.result);
        });
        setHeld(out);
      } catch {
        /* holdings are a nicety; the board reads fine without them */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address, players]);

  /** Has this wallet ever minted an agent? Only asked when the panel exists. */
  useEffect(() => {
    if (!SIM_ON || !publicClient || !address) {
      setHasAgent(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const account = (await publicClient.readContract({
          address: deployment.agentRegistry,
          abi: agentRegistryAbi,
          functionName: "userAccounts",
          args: [address],
        })) as readonly [Address, string, number, boolean];
        if (!cancelled) setHasAgent(Boolean(account[3]) && Number(account[2]) > 0);
      } catch {
        // Unreadable is not "no": leave it null so the button explains itself
        // as unknown rather than asserting the wallet has nothing.
        if (!cancelled) setHasAgent(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address, deployment.agentRegistry]);

  /*
   * Only block on a positive "no".
   *
   * `hasAgent` is null while the read is in flight or if it failed, and on a
   * cold fork that read is slow enough that treating null as "no" left Start
   * disabled for the first ten seconds of every page load — with a message
   * asserting the wallet held nothing, which nobody had established. The server
   * requires the operator's signature; this is a guard against a misclick, so when it
   * cannot tell, it gets out of the way.
   */
  const simBlockedReason = !address
    ? "Connect a wallet to drive the match."
    : held.size === 0 && hasAgent === false
      ? "Mint a card or create an agent first — the simulation is only worth watching if you hold something that moves."
      : null;

  /** Session fallback baseline, used only if the kick-off read failed. */
  const firstSeen = useRef<Map<number, bigint>>(new Map());
  useEffect(() => {
    for (const p of players) {
      if (!firstSeen.current.has(p.id) && p.referencePrice > 0n) {
        firstSeen.current.set(p.id, p.referencePrice);
      }
    }
  }, [players]);

  const prevPrices = useRef<Map<number, bigint>>(new Map());
  const [flash, setFlash] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    const next = new Map(flash);
    let changed = false;
    for (const p of players) {
      const was = prevPrices.current.get(p.id);
      if (was !== undefined && was !== p.referencePrice) {
        next.set(p.id, (next.get(p.id) ?? 0) + 1);
        changed = true;
      }
      prevPrices.current.set(p.id, p.referencePrice);
    }
    if (changed) setFlash(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players]);

  const settled = header?.settled ?? false;
  const state = header?.state ?? 0;
  const clock = header?.clock ?? 0;
  const L = header?.orderDelayL ?? 30;
  const nextTick = KEEPER_SECONDS - (tick % KEEPER_SECONDS);
  const sinceKickoff = kickoffPrices.size > 0;
  const base = sinceKickoff ? kickoffPrices : firstSeen.current;

  const score = useMemo(
    () => scoreFrom(feed, players, feedComplete, header?.clock),
    [feed, players, feedComplete, header?.clock],
  );

  const sentOff = useMemo(() => {
    const out: [boolean, boolean] = [false, false];
    for (const p of players) if (statusOf(p) === "sent-off") out[p.team] = true;
    return out;
  }, [players]);

  const youHold = useMemo(() => {
    let total = 0n;
    for (const p of players) {
      const units = held.get(p.id);
      if (units) total += (p.referencePrice * units) / WAD;
    }
    return total;
  }, [players, held]);

  const selectedPlayer =
    players.find((p) => p.id === selected) ??
    [...players].filter((p) => p.pooled).sort((a, b) => Math.abs(moveBps(b, base)) - Math.abs(moveBps(a, base)))[0];

  const shirtState = (p: PlayerRow): ShirtState => {
    const s = statusOf(p);
    if (s === "sent-off") return "sent-off";
    if (s === "subbed") return "subbed";
    if (held.has(p.id)) return "held";
    return "on";
  };

  const pitchMap = (t: 0 | 1) => {
    const m = new Map<number, PitchPlayer>();
    for (const p of players) {
      if (p.team !== t) continue;
      const price = displayPrice(p, settled);
      const n = shirtNumber(p.id);
      const f = flash.get(p.id);
      m.set(p.id, {
        id: p.id,
        surname: p.name.split(" ").slice(-1)[0] ?? p.name,
        ...(n !== undefined ? { number: n } : {}),
        price: price === undefined ? "—" : usdc(price, 2),
        state: shirtState(p),
        ...(f !== undefined ? { flashKey: f } : {}),
      });
    }
    return m;
  };

  const half = clock === 0 ? "" : clock <= 45 ? " · FIRST HALF" : " · SECOND HALF";
  const clockLabel = state === 0 ? "KICK-OFF IN" : state === 2 ? "FULL TIME" : `MATCH CLOCK${half}`;
  const big = state === 0 ? "—" : state === 2 ? "FT" : `${clock}'`;
  const codeOf = (n: string) => n.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();

  function pick(id: number, _action: RowAction) {
    setSelected(id);
  }

  /*
   * `min-h`, not `h`, on the shell below.
   *
   * The desktop layout used to be pinned to exactly one viewport and never
   * scroll, which was right until the simulation panel took the headroom: the
   * pitch pane was then shorter than a 780x480 pitch needs, so the pitch was
   * either squashed (capped by `max-h-full`) or clipped through the middle.
   * Letting the column grow and the page scroll keeps the pitch's proportions
   * honest, which is the thing on screen that has to be right.
   */
  return (
    <main className="lg:min-h-[calc(100dvh-3.5rem-3rem)]">
      <h1 className="sr-only">{deployment.label} — Chelsea v Barcelona</h1>

      {error && (
        <p className="mb-3 rounded-[12px] border border-down/50 px-3 py-2.5 text-[13px] text-down">{error}</p>
      )}

      {/*
        Two ways this fixture can be up but not ready, both of which otherwise
        render as a screen that looks broken rather than unfinished.
      */}
      {!error && !loading && players.length === 0 && (
        <p className="mb-3 rounded-[12px] border border-line px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          This fixture has no player cards yet.
          <span className="mt-1 block text-dim">
            Pick another match from the fixture list, or run the deploy to mint its squad.
          </span>
        </p>
      )}

      {!error && players.length > 0 && players.every((p) => !p.pooled) && (
        <p className="mb-3 rounded-[12px] border border-line px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          No card in this fixture has a pool yet, so every card is mint-only — there is nothing to
          trade against.
          <span className="mt-1 block text-dim">Seed the fixture, or pick a match that is already live.</span>
        </p>
      )}

      <div className="flex flex-col overflow-hidden rounded-[24px] border border-line-soft bg-panel lg:min-h-full lg:flex-row">
        {/* --------------------------------------------------------- match */}
        <section
          className="order-1 flex min-w-0 flex-1 flex-col gap-4 border-line-soft p-5 lg:order-2 lg:border-l lg:p-6"
          style={{ background: "#16161A" }}
        >
          <div className="text-center">
            <p className="font-display text-[12px] font-bold tracking-[0.24em] text-muted">{clockLabel}</p>
            <div className="mt-1 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-2">
              <span className="tnum font-display text-[40px] font-black leading-none text-up xl:text-[54px]">
                {big}
              </span>
              <span className="tnum font-display text-[18px] font-bold">
                {codeOf(TEAM_NAMES[0])} {score.known ? `${score.home} – ${score.away}` : "–"}{" "}
                {codeOf(TEAM_NAMES[1])}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  state === 1 ? "bg-up text-ground" : "border border-line text-dim"
                }`}
              >
                {state === 1 && <span className="h-1.5 w-1.5 rounded-full bg-ground" aria-hidden />}
                {state === 0 ? "PRE-MATCH" : state === 2 ? "FULL TIME" : "LIVE"}
              </span>
            </div>

            {/*
              A dash where a scoreline belongs looks like a broken component. Say
              which number is missing and why.

              The two cases are different and were being conflated: with no
              header at all nothing has loaded yet, and `state` defaults to 0 —
              which used to suppress this caption at exactly the moment the
              screen was emptiest. With a header, the state reads fine and only
              the match history is missing, which leaves prices unaffected.
            */}
            {header === null ? (
              <p className="mt-1.5 text-[11px] text-dim">Reading the fixture…</p>
            ) : (
              !score.known &&
              state !== 0 && (
                <p className="mt-1.5 text-[11px] text-warn">
                  Score unavailable — this endpoint would not serve the match history. Prices and points
                  below are read from contract state and are unaffected.
                </p>
              )
            )}
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full bg-up"
                style={{ width: `${Math.min(100, (clock / 90) * 100)}%` }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/*
              Two by two on a phone, one row from `sm` up.
              Four 22px figures across 360px left the labels touching each other;
              the dividers are drawn per cell because a grid has no `divide-x`.
              Full width down here too, so the Cards/Pitch toggle wraps underneath
              rather than squeezing the pot into an ellipsis.
            */}
            <dl
              className="grid w-full min-w-0 grid-cols-2 rounded-[12px] border border-line bg-surface
                         sm:flex sm:w-auto sm:flex-1"
            >
              <Stat label="POT" value={usdcShort(header?.potBalance)} tone="text-blue" />
              <Stat
                label="YOU HOLD"
                value={address ? usdc(youHold, 2) : "—"}
                tone="text-up"
                className="border-l border-line"
              />
              <Stat
                label="ORDER DELAY"
                value={`${L} S`}
                className="border-t border-line sm:border-l sm:border-t-0"
              />
              <Stat
                label="NEXT TICK"
                value={state === 1 ? `${nextTick} S` : "—"}
                className="border-l border-t border-line sm:border-t-0"
              />
            </dl>
            <div
              className="flex shrink-0 gap-1 rounded-[10px] border border-line bg-surface p-1"
              role="group"
              aria-label="View"
            >
              {(["cards", "pitch"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`rounded-[7px] px-3 py-1.5 text-[12px] font-semibold capitalize transition-colors ${
                    view === v ? "bg-panel text-text" : "text-dim hover:text-text"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Overlay">
            {(
              [
                ["lineups", "BOTH LINEUPS"],
                ["mine", "MY CARDS"],
                ["events", "EVENTS"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setPane(k)}
                aria-pressed={pane === k}
                className={`rounded-[9px] border px-3 py-1.5 font-display text-[11px] font-extrabold tracking-[0.1em] transition-colors ${
                  pane === k ? "border-line bg-surface text-text" : "border-line-soft text-dim hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            {view === "pitch" ? (
              <>
                <Pitch
                  home={pitchMap(0)}
                  away={pitchMap(1)}
                  colours={TEAM_COLOUR}
                  names={[codeOf(TEAM_NAMES[0]), codeOf(TEAM_NAMES[1])]}
                  reduced={sentOff}
                  selected={selected}
                  onlyHeld={pane === "mine"}
                  onSelect={setSelected}
                />
                {/*
                  MY CARDS dims every shirt you do not hold. With no wallet, or
                  none of these cards, that dims all twenty-two and reads as a
                  rendering fault rather than an answer.
                */}
                {pane === "mine" && held.size === 0 && (
                  <NothingHeld
                    connected={Boolean(address)}
                    className="absolute inset-x-6 bottom-6 rounded-[10px] border border-line-soft
                               bg-panel/95 px-4 py-3 backdrop-blur"
                  />
                )}

                {pane === "events" && (
                  <ul className="absolute inset-x-0 bottom-0 max-h-[46%] overflow-y-auto rounded-b-[12px] border-t border-line-soft bg-panel/95 backdrop-blur">
                    {feed.length === 0 && (
                      <li className="px-4 py-6 text-center text-[13px] text-dim">Nothing yet.</li>
                    )}
                    {feed.slice(0, 20).map((f) => {
                      const minute = /^(\d+)'/.exec(f.label)?.[1] ?? "";
                      const red = /RED/.test(f.label);
                      const goal = /GOAL/.test(f.label);
                      return (
                        <li key={f.key} className="flex gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                          <span
                            className={`w-1.5 shrink-0 rounded-full ${red ? "bg-down" : goal ? "bg-up" : "bg-line"}`}
                            aria-hidden
                          />
                          <span className="tnum w-8 shrink-0 font-display text-[22px] font-extrabold leading-none">
                            {minute}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold">
                              {f.label.replace(/^\d+'\s*/, "")} {f.detail}
                            </span>
                            <span className="block text-[12px] leading-relaxed text-dim">
                              {effectOf(f.label, f.detail, TEAM_NAMES[1], L)}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : (
              <div className="flex max-h-full flex-wrap gap-3 overflow-y-auto">
                {/* Same answer as the pitch overlay: an empty grid is not one. */}
                {pane === "mine" && held.size === 0 && (
                  <NothingHeld connected={Boolean(address)} className="w-full py-10" />
                )}
                {players
                  .filter((p) => pane !== "mine" || held.has(p.id))
                  .sort((a, b) => Math.abs(moveBps(b, base)) - Math.abs(moveBps(a, base)))
                  .map((p) => {
                    const bps = moveBps(p, base);
                    const price = displayPrice(p, settled);
                    const n = shirtNumber(p.id);
                    const f = flash.get(p.id);
                    return (
                      <CompactPlayerCard
                        key={p.id}
                        name={p.name}
                        surname={p.name.split(" ").slice(-1)[0] ?? p.name}
                        {...(n !== undefined ? { number: n } : {})}
                        position={POSITION_NAMES[p.position] ?? "—"}
                        club={{ code: codeOf(TEAM_NAMES[p.team]), colour: TEAM_COLOUR[p.team] }}
                        tint={TEAM_TINT[p.team]}
                        price={price === undefined ? "—" : usdc(price, 2)}
                        minutes={p.minutes}
                        points={wad(displayScore(p), 1)}
                        move={pct(bps)}
                        moveUp={bps >= 0}
                        state={cardState(p, (p.team === 0 ? score.away : score.home) > 0)}
                        mintOnly={!p.pooled}
                        settled={settled}
                        {...(f !== undefined ? { flashKey: f } : {})}
                        onBuy={() => setSelected(p.id)}
                        onSell={() => setSelected(p.id)}
                      />
                    );
                  })}
              </div>
            )}
          </div>

          {/* ------------------------------------------------- order bar */}
          <div className="rounded-[14px] border border-line bg-surface p-3">
            <QueueOrder
              player={selectedPlayer}
              state={state}
              orderDelayL={L}
              fixtureId={fixtureId}
              horizontal
              {...(selectedPlayer && held.get(selectedPlayer.id) !== undefined
                ? { holding: held.get(selectedPlayer.id) }
                : {})}
              addresses={{
                usdc: deployment.usdc,
                settlementPot: deployment.settlementPot,
                whistleHook: deployment.whistleHook,
              }}
              onDone={refresh}
            />
          </div>

          {WORLD_ON && <LiveAgents />}

          {SimPanel && (
            <SimPanel
              fixtureId={deployment.fixtureId}
              agentRegistry={deployment.agentRegistry}
              whistleHook={deployment.whistleHook}
              blockedReason={simBlockedReason}
              onStepped={refresh}
            />
          )}

          <p className="text-[11px] leading-relaxed text-dim">
            Prices move {sinceKickoff ? "against the price at kick-off" : "against the price when this page loaded"}.
            Shirt numbers and formations come from the match file; the chain stores points, not goals.
          </p>
        </section>

        {/* --------------------------------------------------------- squad */}
        {/*
          The squad column keeps the viewport height it always had, and scrolls
          inside it; only the match column is allowed to grow. Un-pinning both
          let all 36 rows set the row height, and the pitch pane — which centres
          its pitch — put the pitch about a thousand pixels below the fold. The
          divider lives on the match column now, because that is the side that
          reaches the bottom.
        */}
        <section className="order-2 flex min-h-0 flex-col p-5 lg:order-1 lg:h-[calc(100dvh-3.5rem-3rem)] lg:w-[560px] lg:shrink-0 lg:self-start lg:p-6">
          <h2 className="sr-only">Squad</h2>
          {loading && players.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-dim">Reading the fixture…</p>
          ) : (
            <SquadTable
              players={players}
              teamNames={TEAM_NAMES}
              teamColours={TEAM_COLOUR}
              held={new Set(held.keys())}
              settled={settled}
              selected={selected}
              onSelect={pick}
            />
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * My agents on this match, with their cap controls — World ID on. Raising a cap
 * (or resuming) is a human decision made with a fresh proof; lowering, pausing
 * and revoking are one click, mid-match, like any other stop.
 */
function LiveAgents() {
  const { deployment, fixtureId } = useFixture();
  const { agents, refresh } = useMyAgents(deployment.agentRegistry);
  const mine = agents.filter((a) => a.fixtureId === fixtureId);
  if (mine.length === 0) return null;
  return (
    <section aria-label="My agents on this match" className="rounded-[14px] border border-line bg-surface p-3">
      <h2 className="mb-2 font-display text-[11px] font-extrabold tracking-[0.14em] text-muted">
        MY AGENTS ON THIS MATCH · {mine.length}
      </h2>
      <ul className="space-y-2">
        {mine.map((a) => (
          <AgentRow key={a.address} a={a} onRevoked={() => void refresh()} />
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-dim">{STOP_NOTE}</p>
    </section>
  );
}
