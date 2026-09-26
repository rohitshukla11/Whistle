"use client";

/**
 * The app's home: every deployed fixture, one row each, with the one thing to
 * do next. Each row is read from the chain (`useFixtureSummaries`), so a demo
 * that has been used reads as used before anyone opens it.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { ClubTile } from "../../../components/agent-ui";
import { FIXTURES } from "../../../lib/fixtures";

/** Listed fixture ids: agents and totals on a hidden fixture are not counted here. */
const LISTED = new Set(FIXTURES.map((f) => f.fixtureId));
import { usdcShort } from "../../../lib/format";
import { TEAM_NAMES } from "../../../lib/squad";
import { useFixtureSummaries, type FixtureSummary } from "../../../lib/useFixtureSummaries";
import { useMyAgents } from "../../../lib/useMyAgents";

type Filter = "ALL" | "PRE-MATCH" | "LIVE" | "SETTLED";
const FILTERS: Filter[] = ["ALL", "PRE-MATCH", "LIVE", "SETTLED"];
const STATE_OF: Filter[] = ["PRE-MATCH", "LIVE", "SETTLED"];
const TEAM_COLOUR: [string, string] = ["#2F6FD0", "#A6214B"];
const code = (n: string) => n.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-up focus-visible:ring-offset-2 focus-visible:ring-offset-ground";
const REGISTRY = FIXTURES[0]?.agentRegistry;

function pctText(p: number) {
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(0)}%`;
}

function subtitle(s: FixtureSummary | undefined, agents: number): string {
  if (!s) return "Reading the chain…";
  if (s.state === 0) return "Kick-off when you press start";
  if (s.state === 1) return `${s.latest ?? "Under way"} · ${agents} agent${agents === 1 ? "" : "s"} trading`;
  const movers = [s.winner && `${s.winner.name} ${pctText(s.winner.pct)}`, s.loser && `${s.loser.name} ${pctText(s.loser.pct)}`]
    .filter(Boolean)
    .join(", ");
  return `Full time ${s.clock}'${movers ? ` · ${movers}` : ""}`;
}

function Badge({ s }: { s: FixtureSummary | undefined }) {
  if (!s) return <span className="rounded-full border border-line-soft px-2.5 py-1 font-display text-[10px] font-extrabold tracking-[0.12em] text-dim">…</span>;
  if (s.state === 1) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1F3A2C] px-2.5 py-1 font-display text-[10px] font-extrabold tracking-[0.12em] text-up">
        <span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
        LIVE · {s.clock}&apos;
      </span>
    );
  }
  if (s.state === 2) {
    return <span className="rounded-full bg-[#1F2E44] px-2.5 py-1 font-display text-[10px] font-extrabold tracking-[0.12em] text-blue">SETTLED</span>;
  }
  return <span className="rounded-full border border-line px-2.5 py-1 font-display text-[10px] font-extrabold tracking-[0.12em] text-muted">PRE-MATCH</span>;
}

function Cell({ label, value, tone = "text-text", className = "" }: { label: string; value: string; tone?: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">{label}</p>
      <p className={`tnum mt-1 truncate text-[15px] font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

export default function FixturesPage() {
  const { address } = useAccount();
  const { rows, loaded } = useFixtureSummaries();
  const { agents: allAgents, loaded: agentsLoaded } = useMyAgents(REGISTRY!);
  const agents = useMemo(() => allAgents.filter((a) => LISTED.has(String(a.fixtureId))), [allAgents]);
  const [filter, setFilter] = useState<Filter>("ALL");

  const list = FIXTURES.filter((D) => {
    if (filter === "ALL") return true;
    const s = rows.get(D.fixtureId);
    return s ? STATE_OF[s.state] === filter : false;
  });

  const summary = useMemo(() => {
    let hold = 0n;
    let redeem = 0n;
    for (const s of rows.values()) {
      hold += s.youHold;
      redeem += s.toRedeem;
    }
    const split = { active: 0, paused: 0, revoked: 0 };
    for (const a of agents) split[a.state]++;
    const live = [...rows.values()].find((s) => s.state !== 2) ?? [...rows.values()][0];
    return { hold, redeem, split, L: live?.orderDelayL };
  }, [rows, agents]);

  return (
    <main className="space-y-6">
      <header className="space-y-4">
        <div>
          <h1 className="font-display text-[34px] font-black leading-tight tracking-tight">Fixtures</h1>
          <p className="mt-1 max-w-[68ch] text-[14px] text-muted">
            Pick a match. Mint players before kick-off, hand an agent your playbook, watch it trade.
          </p>
        </div>
        <div role="group" aria-label="Filter fixtures" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-[9px] border px-3 py-1.5 font-display text-[11px] font-extrabold tracking-[0.1em] transition-colors ${FOCUS} ${
                filter === f ? "border-line bg-surface text-text" : "border-line-soft text-dim hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      {/* ------------------------------------------------ the wallet strip */}
      <section aria-label="Your summary" className="grid grid-cols-2 overflow-hidden rounded-[14px] border border-line bg-surface lg:grid-cols-4">
        <div className="p-4">
          <p className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">YOU HOLD</p>
          <p className="tnum mt-1 font-display text-[22px] font-extrabold text-up">{address ? usdcShort(summary.hold) : "—"}</p>
          <p className="text-[11px] text-dim">USDC across fixtures still in play</p>
        </div>
        <div className="border-l border-line p-4">
          <p className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">YOUR AGENTS</p>
          <p className="tnum mt-1 font-display text-[22px] font-extrabold">{address ? (agentsLoaded ? agents.length : "…") : "—"}</p>
          <p className="text-[11px] text-dim">
            {summary.split.active} active · {summary.split.paused} paused · {summary.split.revoked} revoked
          </p>
        </div>
        <div className="border-t border-line p-4 lg:border-l lg:border-t-0">
          <p className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">TO REDEEM</p>
          <p className="tnum mt-1 font-display text-[22px] font-extrabold text-blue">{address ? usdcShort(summary.redeem) : "—"}</p>
          <p className="text-[11px] text-dim">USDC owed across settled fixtures</p>
        </div>
        <div className="border-l border-t border-line p-4 lg:border-t-0">
          <p className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">NETWORK</p>
          <p className="mt-1 font-display text-[22px] font-extrabold">Sepolia</p>
          <p className="text-[11px] text-dim">order delay {summary.L !== undefined ? `${summary.L} s` : "—"}</p>
        </div>
      </section>

      {/* ---------------------------------------------------------- rows */}
      <section aria-label="Fixtures">
        <h2 className="sr-only">Fixtures</h2>
        {list.length === 0 && (
          <p className="rounded-[14px] border border-line-soft px-4 py-8 text-center text-[13px] text-dim">
            {loaded ? "No fixture in this state." : "Reading the chain…"}
          </p>
        )}
        <ul className="space-y-3">
          {list.map((D) => {
            const s = rows.get(D.fixtureId);
            const mine = agents.filter((a) => String(a.fixtureId) === D.fixtureId);
            const live = s?.state === 1;
            const scoreText = s && s.state !== 0 && s.score ? `${s.score.home} – ${s.score.away}` : "v";
            const context =
              !s ? "—" : s.state === 0 ? `${s.pooled} pooled` : s.state === 1 ? "tick every 5 s" : address ? usdcShort(s.toRedeem) : "—";
            const cta =
              !s || s.state === 0
                ? { label: "JOIN", cls: "bg-cta text-ground hover:brightness-110" }
                : s.state === 1
                  ? { label: "WATCH", cls: "bg-surface text-up hover:bg-line-soft" }
                  : s.toRedeem > 0n
                    ? { label: "REDEEM", cls: "border border-blue/70 text-blue hover:bg-blue/10" }
                    : { label: "VIEW", cls: "border border-line text-text hover:border-muted" };
            return (
              <li
                key={D.fixtureId}
                className={`grid items-center gap-4 rounded-[16px] border bg-panel p-4 lg:grid-cols-[150px_minmax(0,1fr)_110px_110px_110px_130px_150px] ${
                  live ? "border-up/70" : "border-line-soft"
                }`}
              >
                <div className="flex flex-row items-center gap-3 lg:flex-col lg:items-start lg:gap-1.5">
                  <Badge s={s} />
                  <span className="text-[12px] text-muted">{D.label}</span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <ClubTile code={code(TEAM_NAMES[0])} colour={TEAM_COLOUR[0]} />
                    <ClubTile code={code(TEAM_NAMES[1])} colour={TEAM_COLOUR[1]} />
                    <p className="min-w-0 truncate font-display text-[15px] font-extrabold tracking-tight">
                      {TEAM_NAMES[0].toUpperCase()} <span className={scoreText === "v" ? "text-dim" : "tnum text-text"}>{scoreText}</span>{" "}
                      {TEAM_NAMES[1].toUpperCase()}
                    </p>
                  </div>
                  <p className="mt-1.5 truncate text-[12px] text-dim">{subtitle(s, mine.length)}</p>
                </div>

                <Cell label="POT" value={s ? usdcShort(s.pot) : "—"} tone="text-blue" />
                <Cell label="YOU HOLD" value={address && s ? usdcShort(s.state === 2 ? s.toRedeem : s.youHold) : "—"} tone="text-up" />
                <Cell label="YOUR AGENTS" value={address ? (agentsLoaded ? String(mine.length) : "…") : "—"} />
                <Cell label={!s ? "" : s.state === 0 ? "POOLED" : s.state === 1 ? "NEXT TICK" : "TO REDEEM"} value={context} />

                <Link
                  href={`/fixtures/${D.fixtureId}`}
                  aria-label={`${cta.label} — ${D.label}`}
                  className={`rounded-[10px] px-4 py-2.5 text-center font-display text-[12px] font-extrabold tracking-[0.1em] transition-colors ${FOCUS} ${cta.cls}`}
                >
                  {cta.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="rounded-[14px] border border-dashed border-line px-4 py-3 text-[12px] leading-relaxed text-dim">
        Every fixture is its own market: its own pot, pools and hook. Agents are yours across fixtures; a mandate is per
        match.
      </p>
    </main>
  );
}
