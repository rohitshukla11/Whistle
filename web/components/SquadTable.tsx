"use client";

/**
 * The squad list beside the pitch.
 *
 * Every row ends in the one action that is actually available for that card:
 * sell what you hold, mint what has no pool, buy the rest, nothing once the
 * fixture has settled. Offering a button the contract would refuse is the same
 * mistake as printing a number the chain does not have.
 */

import { useMemo, useState } from "react";

import { shirtNumber } from "../lib/squad";
import { usdc, wad } from "../lib/format";
import { displayScore, displayPrice, statusOf, type PlayerRow } from "../lib/useWhistle";

export type RowAction = "buy" | "sell" | "mint" | "settled";
export type DotState = "on" | "bench" | "frozen" | "held";

const POSITIONS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;
type Tab = (typeof POSITIONS)[number];
type Sort = "points" | "price";

const DOT: Record<DotState, string> = {
  on: "bg-up",
  bench: "bg-[#F0A35A]",
  frozen: "bg-down",
  held: "bg-blue",
};

const ACTION: Record<RowAction, string> = {
  buy: "bg-up text-ground",
  sell: "bg-down text-ground",
  mint: "border border-line text-muted",
  settled: "border border-line-soft text-dim",
};

interface Props {
  players: PlayerRow[];
  teamNames: [string, string];
  teamColours: [string, string];
  held: Set<number>;
  settled: boolean;
  selected: number | null;
  onSelect: (id: number, action: RowAction) => void;
  /** Before kick-off every card is a pre-match mint at the fixed price, pooled or not. */
  preMatch?: boolean;
}

export function SquadTable({
  players, teamNames, teamColours, held, settled, selected, onSelect, preMatch = false,
}: Props) {
  const [team, setTeam] = useState<"both" | 0 | 1>("both");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("ALL");
  const [sort, setSort] = useState<Sort>("points");
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const posName = ["GK", "DEF", "MID", "FWD"];
    let out = players;
    if (team !== "both") out = out.filter((p) => p.team === team);
    if (tab !== "ALL") out = out.filter((p) => posName[p.position] === tab);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((p) => p.name.toLowerCase().includes(q));
    }
    const key = (p: PlayerRow) => (sort === "points" ? displayScore(p) : p.referencePrice);
    return [...out].sort((a, b) => {
      const d = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      return desc ? -d : d;
    });
  }, [players, team, tab, query, sort, desc]);

  const dotFor = (p: PlayerRow): DotState => {
    if (held.has(p.id)) return "held";
    const s = statusOf(p);
    if (s === "on-pitch") return "on";
    if (s === "bench") return "bench";
    return "frozen";
  };

  const actionFor = (p: PlayerRow): RowAction => {
    if (settled) return "settled";
    if (preMatch || !p.pooled) return "mint";
    return held.has(p.id) ? "sell" : "buy";
  };

  const sortBtn = (which: Sort, label: string, title?: string) => (
    <button
      type="button"
      onClick={() => (sort === which ? setDesc((d) => !d) : (setSort(which), setDesc(true)))}
      className="flex items-center gap-1 text-[11px] text-dim transition-colors hover:text-text"
      aria-label={`Sort by ${label}`}
      title={title}
    >
      {label}
      <span aria-hidden className={sort === which ? "text-text" : ""}>{sort === which && !desc ? "↑" : "↓"}</span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex gap-2">
        <label className="flex h-11 flex-1 items-center gap-2 rounded-[22px] border border-line bg-surface px-3 focus-within:border-up">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden focusable="false">
            <path d="M4 2h8l-1 4v7l-2-1-2 1V6z" fill="none" stroke="#8C8C95" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span className="sr-only">Team</span>
          <select
            value={String(team)}
            onChange={(e) => setTeam(e.target.value === "both" ? "both" : (Number(e.target.value) as 0 | 1))}
            className="w-full bg-transparent text-[14px] outline-none"
          >
            <option value="both">Both teams</option>
            <option value="0">{teamNames[0]}</option>
            <option value="1">{teamNames[1]}</option>
          </select>
        </label>
        <label className="flex h-11 flex-1 items-center gap-2 rounded-[22px] border border-line bg-surface px-3 focus-within:border-up">
          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden focusable="false">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="#8C8C95" strokeWidth="1.3" />
            <path d="M10.5 10.5 14 14" stroke="#8C8C95" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Search player</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search player"
            className="w-full bg-transparent text-[14px] outline-none placeholder:text-dim"
          />
        </label>
      </div>

      <div role="group" aria-label="Position" className="flex gap-4 border-b border-line-soft">
        {POSITIONS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`relative pb-2 font-display text-[13px] font-extrabold tracking-[0.12em] transition-colors ${
              tab === t ? "text-text" : "text-dim hover:text-muted"
            }`}
          >
            {t}
            {tab === t && <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-up" />}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 px-2 text-[11px] text-dim">
        <span className="flex-1">Name</span>
        {/*
          EXP while the match runs, PTS once it is over.
          Before full time this column is the EXPECTED final score — the number
          the price is a share of — not points already banked. Calling both
          "Points" invited the reading that a card priced at 9.01 had scored
          nothing, when in fact its minutes were still accruing.
        */}
        <span className="w-12 text-right">
          {settled
            ? sortBtn("points", "PTS", "final score")
            : sortBtn("points", "EXP", "expected final score — this drives the price")}
        </span>
        <span className="w-14 text-right">{sortBtn("price", "Price")}</span>
        <span className="w-8 text-center">Status</span>
        <span className="w-[64px]" />
      </div>

      <ul className="-mr-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {rows.map((p) => {
          const dot = dotFor(p);
          const action = actionFor(p);
          const isHeld = dot === "held";
          const off = statusOf(p) === "sent-off";
          const num = shirtNumber(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id, action)}
                aria-pressed={selected === p.id}
                className={`flex h-[50px] w-full items-center gap-3 rounded-[10px] border px-2.5 text-left
                  transition-colors ${
                    off
                      ? "border-down bg-down/10"
                      : isHeld
                        ? "border-blue bg-blue/10"
                        : selected === p.id
                          ? "border-line bg-surface"
                          : "border-line-soft bg-surface hover:border-line"
                  }`}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] font-display text-[10px] font-extrabold text-white"
                  style={{ background: teamColours[p.team] }}
                  aria-hidden
                >
                  {teamNames[p.team].replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-[12px] font-bold uppercase leading-tight">
                    {p.name}
                  </span>
                  <span className="mt-0.5 inline-block rounded-[3px] bg-warn px-1 text-[9px] font-extrabold text-ground">
                    {["GK", "DEF", "MID", "FWD"][p.position]}
                    {num !== undefined && <span className="tnum ml-1 opacity-70">{num}</span>}
                  </span>
                </span>

                <span className="tnum w-12 text-right text-[15px] font-bold">{wad(displayScore(p), 1)}</span>
                <span className="tnum w-14 text-right text-[15px] font-bold">
                  {usdc(displayPrice(p, settled) ?? 0n, 2)}
                </span>
                <span className="grid w-8 place-items-center">
                  <span className={`h-3 w-3 rounded-full ${DOT[dot]}`} aria-hidden />
                </span>
                <span
                  className={`w-[64px] rounded-[8px] px-2 py-1.5 text-center text-[11px] font-bold uppercase ${ACTION[action]}`}
                >
                  {action}
                </span>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="px-2 py-8 text-center text-[13px] leading-relaxed text-dim">
            {/* Nothing to filter and nothing survived the filter are different problems. */}
            {players.length === 0 ? (
              "No player cards in this fixture."
            ) : (
              <>
                No players match.
                <span className="mt-1 block">Clear the search, or choose ALL.</span>
              </>
            )}
          </li>
        )}
      </ul>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-dim">
        {(preMatch
          ? ([["on", "starting"], ["bench", "bench"], ["held", "you hold"]] as const)
          : ([["on", "on pitch"], ["bench", "bench"], ["frozen", "frozen · sent off or subbed"], ["held", "you hold"]] as const)
        ).map(([k, label]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${DOT[k]}`} aria-hidden />
            {label}
          </span>
        ))}
        {preMatch && <span className="text-muted">Pre-match: mint at the fixed price, no delay.</span>}
      </p>
    </div>
  );
}
