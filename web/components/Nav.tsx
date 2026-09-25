"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * No Profile tab: a profile is always *an agent's*, reached from the agent it
 * belongs to. A bare `/profile` had nothing to show and now redirects to the list.
 */
const TABS = [
  { href: "/fixture", label: "Fixture" },
  { href: "/agents", label: "Agents" },
  { href: "/settlement", label: "Settle" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line-soft bg-panel/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto flex w-full max-w-[400px]">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex-1 px-2 py-3 text-center text-[13px] font-medium transition-colors ${
                active ? "text-text" : "text-dim hover:text-text"
              }`}
            >
              <span className="relative inline-block">
                {tab.label}
                {active && <span className="absolute -bottom-1.5 left-0 h-0.5 w-full bg-up" />}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
