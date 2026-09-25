"use client";

import type { ReactNode } from "react";

/**
 * Shared surfaces.
 *
 * Panels carry no shadow and only a hairline, because the loudest thing on any
 * screen should be a price that just moved — not the edge of a box. Labels are
 * sentence case: this app talks to people in sentences and reserves monospace for
 * what the market says.
 */

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-rule bg-sheet ${className}`}>{children}</section>;
}

export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
      <h2 className="truncate text-[14px] font-semibold tracking-tight text-chalk">{title}</h2>
      <span className="shrink-0">{right}</span>
    </header>
  );
}

export function StateBadge({ state }: { state: number | undefined }) {
  if (state === undefined) return null;
  const label = ["Pre-match", "Live", "Settled"][state] ?? "—";
  const live = state === 1;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] font-semibold ${
        live ? "text-signal" : "text-slate"
      }`}
    >
      {live && <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />}
      {label}
    </span>
  );
}

/** A labelled number. Label in sentence case, value in the market's voice. */
export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-slate">{label}</div>
      <div className="tnum truncate font-mono text-[17px] font-medium text-chalk">{value}</div>
      {sub && <div className="truncate text-[11px] text-slate">{sub}</div>}
    </div>
  );
}

/** A label/value row, used where a middle-dot meta string would otherwise creep in. */
export function Line({ label, value, tone }: { label: string; value: ReactNode; tone?: "signal" | "muted" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13px]">
      <span className="shrink-0 text-slate">{label}</span>
      <span
        className={`tnum truncate font-mono ${
          tone === "signal" ? "text-signal" : tone === "muted" ? "text-slate" : "text-chalk"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-slate">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block max-w-[62ch] text-[12px] leading-relaxed text-slate">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "tnum w-full rounded border border-rule bg-dusk px-3 py-2.5 font-mono text-[15px] text-chalk " +
  "outline-none transition-colors focus:border-signal";

export function Button({
  children,
  onClick,
  disabled,
  tone = "primary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "primary" | "danger" | "ghost";
  type?: "button" | "submit";
}) {
  const tones = {
    primary: "bg-chalk text-dusk hover:bg-white disabled:bg-rule disabled:text-slate",
    danger: "border border-away text-away hover:bg-away hover:text-chalk disabled:border-rule disabled:text-slate",
    ghost: "border border-rule text-chalk hover:border-slate disabled:text-slate",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded px-4 py-2.5 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

/**
 * A message that says what happened and what to do about it.
 *
 * `what` is the failure; `next` is the single action that resolves it. Splitting
 * them is deliberate — an error that only names the failure leaves the reader
 * stuck.
 */
export function Notice({
  kind,
  children,
  next,
}: {
  kind: "error" | "info" | "ok";
  children: ReactNode;
  next?: string;
}) {
  const tones = {
    error: "border-away/50 text-away",
    info: "border-rule text-slate",
    ok: "border-signal/50 text-signal",
  };
  return (
    <div className={`rounded border px-3 py-2.5 text-[13px] leading-relaxed ${tones[kind]}`}>
      <div className="max-w-[62ch] break-words">{children}</div>
      {next && <div className="mt-1 max-w-[62ch] text-slate">{next}</div>}
    </div>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <code className="tnum mt-1 block break-all font-mono text-[11px] text-slate" title={hash}>
      {hash}
    </code>
  );
}

// Reads each fixture's live state, so it is a client component of its own.
export { FixtureSwitcher } from "./FixtureSwitcher";
