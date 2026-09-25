import { Nav } from "../../components/Nav";
import { NetworkNote } from "../../components/NetworkNote";
import { TopBar } from "../../components/TopBar";

/**
 * The app shell.
 *
 * Desktop-first above 1024px: a 56px top bar, 1440 max width, 32px gutters. The
 * phone shell — narrow column, bottom tab bar — is kept below that breakpoint
 * because the board genuinely is a different layout on a phone, not the same one
 * squeezed.
 *
 * A route group rather than a path segment, so these stay at `/fixture`,
 * `/agents`, `/profile/[agent]` and `/settlement` while `/` keeps the landing page.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-ground text-text">
      <TopBar />
      <div
        className="mx-auto w-full max-w-[400px] px-4 pb-24 pt-[max(1rem,env(safe-area-inset-top))]
                   lg:max-w-[1440px] lg:px-8 lg:pb-12 lg:pt-6"
      >
        <NetworkNote />
        {children}
      </div>
      <Nav />
    </div>
  );
}
