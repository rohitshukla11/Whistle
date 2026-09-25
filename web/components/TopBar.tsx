"use client";

/**
 * The desktop chrome for the app screens.
 *
 * Replaces the phone tab bar above 1024px. The fixture selector lives here
 * rather than inside a screen because it changes which contracts every screen
 * reads — it is navigation, not a setting on one page.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useFixture } from "../lib/fixtures";
import { FixtureSwitcher } from "./ui";
import { Wallet } from "./Wallet";

const LINKS = [
  { href: "/fixture", label: "Fixture" },
  { href: "/agents", label: "Agents" },
  { href: "/settlement", label: "Settlement" },
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

export function TopBar() {
  const pathname = usePathname();
  const { deployment, select, all } = useFixture();

  return (
    <header className="sticky top-0 z-30 hidden h-14 border-b border-line-soft bg-panel/95 backdrop-blur lg:block">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-6 px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Whistle, home">
          <Mark />
          <span className="font-display text-[15px] font-extrabold tracking-tight">Whistle</span>
        </Link>

        <nav aria-label="Screens">
          <ul className="flex items-center gap-1">
            {LINKS.map((l) => {
              const active = pathname.startsWith(l.href);
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-[10px] px-3 py-1.5 text-[14px] transition-colors ${
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

        <div className="ml-auto flex items-center gap-3">
          <FixtureSwitcher all={all} current={deployment.fixtureId} onSelect={select} />
          <Wallet />
        </div>
      </div>
    </header>
  );
}
