"use client";

/**
 * The vocabulary the agent and settlement screens share.
 *
 * Kept in one file because between them these encode a single idea: who did a
 * thing, and what happened to it. A badge, a result chip and a writer tag are the
 * whole language those screens speak, and splitting them up would hide that they
 * are a set.
 */

import type { ReactNode } from "react";

export type Playbook = "protect" | "momentum" | "contrarian";
export type AgentState = "active" | "paused" | "revoked";
export type Result = "filled" | "re-queued" | "cancelled" | "reverted";
export type Writer = "you" | "agent" | "whistle";

export const PLAYBOOKS: Playbook[] = ["protect", "momentum", "contrarian"];

export const PLAYBOOK_ID: Record<Playbook, number> = { protect: 1, momentum: 2, contrarian: 3 };

export const PLAYBOOK_TINT: Record<Playbook, string> = {
  protect: "bg-tint-green",
  momentum: "bg-tint-purple-blue",
  contrarian: "bg-tint-yellow-green",
};

/** The dot beside a playbook's name. Green, blue, yellow — in that order. */
export const PLAYBOOK_DOT: Record<Playbook, string> = {
  protect: "#6FCF97",
  momentum: "#56A7E0",
  contrarian: "#F5E663",
};

/**
 * What each playbook actually does.
 *
 * Copied from the thresholds in `agent/templates/*.ts` rather than written for
 * the screen. A mandate page that describes behaviour the runtime does not have
 * is worse than one that says nothing: the whole point of it is that what you
 * grant is what runs.
 */
export const PLAYBOOK_RULE: Record<Playbook, string> = {
  protect: "sell 40% of a held card when it drops 1.5%",
  momentum: "buy the card that rose hardest, from 1% up",
  contrarian: "buy the hardest faller who is still on",
};

export const PLAYBOOK_BLURB: Record<Playbook, string> = {
  protect:
    "Sells 40% of any held card whose reference price just fell 1.5% or more. A red card for a held player is an immediate sell. Never buys, never acts on a heartbeat.",
  momentum:
    "Buys the card that rose hardest on the last event, once the move is at least 1%. Up to 250 USDC an order, and never a frozen line.",
  contrarian:
    "Buys the card that fell hardest, but only while that player is still on the pitch — a frozen line cannot rebound. Up to 200 USDC an order.",
};

export function playbookOf(templateId: number | bigint): Playbook {
  return Number(templateId) === 2 ? "momentum" : Number(templateId) === 3 ? "contrarian" : "protect";
}

// --------------------------------------------------------------------- cards

/**
 * The little card that stands in for an agent.
 *
 * Tinted by playbook so a list of mandates is scannable by colour before it is
 * readable by name. The silhouette is deliberately faceless: an agent is a key,
 * not a personality.
 */
export function MiniCard({ playbook, large }: { playbook: Playbook; large?: boolean }) {
  const size = large ? "h-[116px] w-[96px]" : "h-[68px] w-[56px]";
  return (
    <span
      className={`${size} ${PLAYBOOK_TINT[playbook]} relative block shrink-0 overflow-hidden rounded-[10px] border border-white/10`}
      aria-hidden
    >
      <span
        className={`absolute left-1.5 top-1.5 font-display font-black tracking-[0.16em] text-ground/70 ${
          large ? "text-[8px]" : "text-[6px]"
        }`}
      >
        WHISTLE
      </span>
      <svg viewBox="0 0 100 120" className="absolute inset-x-0 bottom-0 mx-auto h-[68%] w-[60%]" aria-hidden>
        <circle cx="50" cy="44" r="22" fill="#101012" opacity="0.8" />
        <path d="M12 120c0-23 17-38 38-38s38 15 38 38z" fill="#101012" opacity="0.8" />
      </svg>
    </span>
  );
}

// --------------------------------------------------------------------- chips

const CHIP =
  "inline-block shrink-0 rounded-[6px] px-2 py-0.5 font-display text-[9px] font-extrabold uppercase tracking-[0.1em]";

const STATE_STYLE: Record<AgentState, string> = {
  active: "bg-[#1F3A2C] text-up",
  paused: "bg-[#3A3520] text-warn",
  revoked: "bg-[#3A1F22] text-down",
};

export function StateBadge({ state }: { state: AgentState }) {
  return <span className={`${CHIP} ${STATE_STYLE[state]}`}>{state}</span>;
}

const RESULT_STYLE: Record<Result, string> = {
  filled: "bg-[#1F3A2C] text-up",
  "re-queued": "border border-line text-muted",
  cancelled: "bg-[#3A1F22] text-down",
  reverted: "bg-[#3A1F22] text-down",
};

export function ResultChip({ result }: { result: Result }) {
  return <span className={`${CHIP} ${RESULT_STYLE[result]}`}>{result}</span>;
}

const WRITER_STYLE: Record<Writer, string> = {
  you: "bg-[#1F3A2C] text-up",
  agent: "bg-[#1F2E44] text-blue",
  whistle: "border border-line text-text",
};

/**
 * Who holds the key that may write a record.
 *
 * The point of the profile screen in one component: three parties, three sets of
 * keys, and none of them able to write another's records.
 */
export function WriterChip({ writer }: { writer: Writer }) {
  return <span className={`${CHIP} ${WRITER_STYLE[writer]}`}>{writer}</span>;
}

export function PositionTag({ position }: { position: string }) {
  return (
    <span className="inline-block shrink-0 rounded-[3px] bg-warn px-1 font-display text-[9px] font-extrabold leading-[14px] text-ground">
      {position}
    </span>
  );
}

export function ClubTile({ code, colour }: { code: string; colour: string }) {
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] font-display text-[10px] font-extrabold text-white"
      style={{ background: colour }}
      aria-hidden
    >
      {code}
    </span>
  );
}

// ------------------------------------------------------------------ surfaces

export function Card({
  children,
  className = "",
  testId,
}: {
  children: ReactNode;
  className?: string;
  /** So a driver can find one card among a dozen without guessing at classes. */
  testId?: string;
}) {
  return (
    <section
      {...(testId ? { "data-testid": testId } : {})}
      className={`rounded-[20px] border border-line-soft bg-panel ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHead({ title, right, hint }: { title: string; right?: ReactNode; hint?: string }) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-soft px-5 py-3.5">
      <h2 className="font-display text-[12px] font-extrabold uppercase tracking-[0.18em]">{title}</h2>
      {hint && <p className="min-w-0 flex-1 text-[12px] text-dim">{hint}</p>}
      {right && <span className="shrink-0">{right}</span>}
    </header>
  );
}

/** A labelled number in the board's voice: tiny caps label, loud figure. */
export function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <dt className="font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{label}</dt>
      <dd className={`tnum mt-0.5 truncate font-display text-[20px] font-extrabold ${tone ?? ""}`}>{value}</dd>
      {sub && <dd className="mt-0.5 truncate text-[11px] text-dim">{sub}</dd>}
    </div>
  );
}

/** How much of a spend cap is gone. Amber past three quarters, red at the cap. */
export function SpendBar({ spent, cap }: { spent: bigint; cap: bigint }) {
  const pct = cap > 0n ? Math.min(100, Number((spent * 100n) / cap)) : 0;
  const tone = pct >= 100 ? "bg-down" : pct >= 75 ? "bg-warn" : "bg-up";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface" role="presentation">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  tone = "ghost",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "cta" | "ghost" | "danger";
  className?: string;
  type?: "button" | "submit";
}) {
  const tones = {
    cta: "bg-cta text-ground hover:brightness-110 disabled:bg-none disabled:bg-surface disabled:text-dim",
    ghost: "border border-line text-text hover:border-muted disabled:border-line-soft disabled:text-dim",
    danger:
      "border border-down/60 text-down hover:bg-down hover:text-ground disabled:border-line-soft disabled:text-dim",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[10px] px-4 py-2 font-display text-[12px] font-extrabold uppercase tracking-[0.1em]
                  transition-colors disabled:cursor-not-allowed ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Note({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: ReactNode }) {
  const tones = {
    info: "border-line-soft text-dim",
    error: "border-down/50 text-down",
    ok: "border-up/50 text-up",
  };
  return (
    // Tagged so a driver can read what the operator was told. A rendered note is
    // a result — "the click did nothing" and "the click said why it failed" are
    // different outcomes and a test that cannot tell them apart is not a test.
    <p
      data-testid="note"
      data-kind={kind}
      className={`rounded-[12px] border px-3.5 py-2.5 text-[13px] leading-relaxed ${tones[kind]}`}
    >
      {children}
    </p>
  );
}
