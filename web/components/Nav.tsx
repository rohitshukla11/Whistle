"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The phone tab bar: the same two destinations as the desktop top bar. A
 * fixture is reached from the list, and a profile from the agent it belongs to.
 */
const TABS = [
  { href: "/fixtures", label: "Fixtures", match: (p: string) => p.startsWith("/fixtures") },
  { href: "/agents", label: "My agents", match: (p: string) => p.startsWith("/agents") || p.startsWith("/profile") },
];

export function Nav() {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="Screens"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line-soft bg-panel/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto flex w-full max-w-[400px]">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex-1 px-2 py-3 text-center text-[13px] font-medium outline-none transition-colors
                          focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-up ${
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
