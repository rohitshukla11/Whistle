"use client";

/**
 * The app's chrome: wordmark (→ the landing page) · Fixtures · My agents · wallet.
 *
 * On a fixture screen the first item becomes "← Fixtures" and the centre names
 * the match and its state, read from the chain — the fixture list is how you
 * change match now, so there is no switcher here. Shown at every width; below
 * 1024px the two links live in the bottom tab bar instead.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useFixture } from "../lib/fixtures";
import { STATE_LABEL, useFixtureState } from "../lib/useFixtureState";
import { TEAM_NAMES } from "../lib/squad";
import { Wallet } from "./Wallet";

const LINKS = [
  { href: "/fixtures", label: "Fixtures", match: (p: string) => p === "/fixtures" },
  { href: "/agents", label: "My agents", match: (p: string) => p.startsWith("/agents") || p.startsWith("/profile") },
];

function Mark() {
  return (
    <svg viewBox="0 0 32 24" className="h-4 w-6" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="8.5" stroke="#8FE3B7" strokeWidth="2.2" fill="none" />
      <path
        d="M20.5 9.5h8a1.5 1.5 0 0 1 0 3h-8"
        stroke="#8FE3B7" strokeWidth="2.2" fill="none" strokeLinecap="round"
      />
    </svg>
  );
}

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-up focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

function FixtureTitle() {
  const { deployment } = useFixture();
  const { state } = useFixtureState(deployment);
  const chip = `${deployment.label.toUpperCase()}${state !== undefined ? ` · ${STATE_LABEL[state]}` : ""}`;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
      <span className="hidden truncate font-display text-[13px] font-extrabold tracking-[0.12em] sm:inline">
        {TEAM_NAMES[0].toUpperCase()} <span className="text-dim">vs</span> {TEAM_NAMES[1].toUpperCase()}
      </span>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 font-display text-[10px] font-extrabold tracking-[0.12em] ${
          state === 1 ? "bg-[#1F3A2C] text-up" : state === 2 ? "bg-[#1F2E44] text-blue" : "border border-line text-muted"
        }`}
      >
        {chip}
      </span>
    </div>
  );
}

export function TopBar() {
  const pathname = usePathname() ?? "";
  const onFixture = /^\/fixtures\/\d+/.test(pathname);

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-line-soft bg-panel/95 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-3 px-4 lg:gap-6 lg:px-8">
        {onFixture ? (
          <Link href="/fixtures" className={`shrink-0 rounded-[8px] px-1 text-[14px] text-muted hover:text-text ${FOCUS}`}>
            <span aria-hidden>←</span> Fixtures
          </Link>
        ) : (
          <Link href="/" className={`flex shrink-0 items-center gap-2 rounded-[8px] ${FOCUS}`} aria-label="Whistle — home">
            <Mark />
            <span className="font-display text-[15px] font-extrabold tracking-tight">Whistle</span>
          </Link>
        )}

        <nav aria-label="Screens" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {LINKS.map((l) => {
              const active = l.match(pathname);
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-[10px] px-3 py-1.5 text-[14px] transition-colors ${FOCUS} ${
                      active ? "bg-surface font-semibold text-text" : "text-muted hover:text-text"
                    }`}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {onFixture ? <FixtureTitle /> : <div className="flex-1" />}

        <div className="flex shrink-0 items-center gap-3">
          <Wallet />
        </div>
      </div>
    </header>
  );
}
