"use client";

/**
 * The landing page.
 *
 * Marketing only — it reads the chain in exactly one place (the live board
 * section) and writes nowhere. Every route it points at is the real app.
 *
 * The board rows are live or absent; see ILLUSTRATIVE. They carry a
 * caption saying so. That distinction matters more here than anywhere else on
 * the site: a made-up number next to a real one is the fastest way to lose the
 * benefit of having built the real one.
 */

import Link from "next/link";
import { useMemo } from "react";

import { PlayerCard, type Tint } from "../components/PlayerCard";
import { POSITION_NAMES, usdc } from "../lib/format";
import { useWhistle } from "../lib/useWhistle";

// --------------------------------------------------------------------- marks

function WhistleMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 24" className={className} aria-hidden focusable="false">
      <circle cx="12" cy="12" r="8.5" stroke="#8FE3B7" strokeWidth="2.2" fill="none" />
      <path d="M20.5 9.5h8a1.5 1.5 0 0 1 0 3h-8" stroke="#8FE3B7" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden focusable="false">
      <path d="M2 11l4-4 3 3 5-5" stroke="#8FE3B7" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 5h3v3" stroke="#8FE3B7" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Four line icons for "How it works". Stroked in the panel colour over a tint. */
const STEP_ICONS = {
  ticket: (
    <path d="M4 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V9z" />
  ),
  clock: <path d="M13 6v7l4 3M13 23a10 10 0 1 1 0-20 10 10 0 0 1 0 20z" />,
  playbook: <path d="M5 4h9a4 4 0 0 1 4 4v14M5 4v14a4 4 0 0 0 4 4h9M9 10h5M9 14h5" />,
  trophy: <path d="M8 4h10v6a5 5 0 0 1-10 0V4zM6 5H4v2a4 4 0 0 0 4 4M20 5h2v2a4 4 0 0 1-4 4M13 15v5M9 22h8" />,
} as const;

function StepIcon({ d, tint }: { d: keyof typeof STEP_ICONS; tint: string }) {
  return (
    <span className={`grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[14px] ${tint}`}>
      <svg viewBox="0 0 26 26" className="h-6 w-6" aria-hidden focusable="false">
        <g stroke="#1B1B1F" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round">
          {STEP_ICONS[d]}
        </g>
      </svg>
    </span>
  );
}

// --------------------------------------------------------------------- data

const HERO_CARDS = [
  {
    firstName: "Kylian", lastName: "Mbappé", number: 10,
    club: { code: "RMA", colour: "#C9CDD6" }, tint: "purple-blue" as Tint,
    pos: "left-[8px] top-[16px] -rotate-12",
  },
  {
    firstName: "Lamine", lastName: "Yamal", number: 19,
    club: { code: "BAR", colour: "#A6214B" }, tint: "green" as Tint,
    ribbon: { text: "GOAL 12' · +41%", tone: "up" as const },
    pos: "left-[76px] top-[286px] rotate-[8deg]",
  },
  {
    firstName: "Lionel", lastName: "Messi", number: 10,
    club: { code: "MIA", colour: "#F2B6D2" }, tint: "orange-pink" as Tint,
    ribbon: { text: "ASSIST 34' · +18%", tone: "up" as const },
    pos: "right-[8px] top-[16px] -rotate-[7deg]",
  },
  {
    firstName: "Erling", lastName: "Haaland", number: 9,
    club: { code: "MCI", colour: "#7FC7E8" }, tint: "yellow-green" as Tint,
    ribbon: { text: "YELLOW 58' · −6%", tone: "warn" as const },
    pos: "right-[76px] top-[286px] rotate-[11deg]",
  },
];

/**
 * A made-up board, for local work only.
 *
 * Shown when `NEXT_PUBLIC_ILLUSTRATIVE=on` and the chain cannot be read — never
 * in a production build. A landing page that quietly substitutes invented prices
 * for real ones is a landing page that lies when the RPC is down, and the ENS
 * prize asks for a demo that is "functional and not just hard-coded values".
 * Without the flag, an unreadable board says so.
 */
const ILLUSTRATIVE = process.env.NEXT_PUBLIC_ILLUSTRATIVE === "on";

const STATIC_ROWS = [
  { code: "BAR", colour: "#A6214B", name: "Lamine Yamal", note: "Goal 12', still on", pts: "14.0", price: "9.82", move: "+41%", up: true },
  { code: "RMA", colour: "#C9CDD6", name: "Kylian Mbappé", note: "Assist 28'", pts: "11.5", price: "8.41", move: "+12%", up: true },
  { code: "MIA", colour: "#F2B6D2", name: "Lionel Messi", note: "Assist 34'", pts: "10.2", price: "7.95", move: "+18%", up: true },
  { code: "RMA", colour: "#C9CDD6", name: "Jude Bellingham", note: "On pitch 62'", pts: "8.0", price: "6.60", move: "−3%", up: false },
  { code: "MCI", colour: "#7FC7E8", name: "Erling Haaland", note: "Yellow 58'", pts: "6.4", price: "5.88", move: "−6%", up: false },
  { code: "ARS", colour: "#E56A6A", name: "Bukayo Saka", note: "Subbed 71'", pts: "5.1", price: "4.20", move: "−9%", up: false },
];

// -------------------------------------------------------------------- pieces

/**
 * One phrase of the headline, rising into place.
 *
 * `inline-block` because a transform does nothing to a plain inline element —
 * the opacity would fade and the movement would silently not happen.
 *
 * `motion-reduce:animate-none` is not decoration. With `animation-fill-mode:
 * both` the phrase starts at `opacity: 0`, so dropping the animation without
 * dropping the fill would leave the headline invisible to exactly the people who
 * asked for less motion. Removing the animation restores the element's own
 * styles, which are opaque and unmoved.
 */
function Phrase({
  delay,
  className = "",
  children,
}: {
  delay: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block animate-rise motion-reduce:animate-none ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </span>
  );
}

function GradientLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-[12px] bg-cta px-5 py-3 text-[15px]
                 font-bold text-ground transition-opacity hover:opacity-90"
    >
      {children}
    </Link>
  );
}

function OutlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-[12px] border border-line px-5 py-3
                 text-[15px] font-semibold text-text transition-colors hover:border-dim"
    >
      {children}
    </Link>
  );
}

function Chip({ title, body, tone = "line" }: { title: React.ReactNode; body: string; tone?: "line" | "down" }) {
  return (
    <div
      className={`rounded-[12px] border bg-surface px-3.5 py-2.5 ${
        tone === "down" ? "border-down/60" : "border-line"
      }`}
    >
      <p className="text-[13px] font-semibold text-text">{title}</p>
      <p className="mt-0.5 text-[12px] text-dim">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------- page

export default function LandingPage() {
  const { players, header } = useWhistle();

  /**
   * Live rows, or null when no fixture answers.
   *
   * "Answers" means players loaded and at least one carries a price — a
   * deployment that is unreachable, or a fixture with no pools, yields null
   * rather than a table of zeroes.
   */
  const live = useMemo(() => {
    const priced = players.filter((p) => p.pooled && p.referencePrice > 0n);
    if (priced.length < 6) return null;
    return [...priced]
      .sort((a, b) => Number(b.referencePrice - a.referencePrice))
      .slice(0, 6)
      .map((p) => {
        // Move since kick-off, which is the only comparison available on load —
        // there is no earlier price to diff against until an event lands.
        const base = p.preMatchPrice;
        const bps = base > 0n ? Number(((p.referencePrice - base) * 10_000n) / base) : 0;
        return {
          // The chain knows positions, not clubs: the symbol is `W26`-style and
          // slicing it produces a code that means nothing. Position is real.
          code: POSITION_NAMES[p.position] ?? "—",
          colour: p.team === 0 ? "#7FC7E8" : "#E56A6A",
          name: p.name,
          note: p.onPitch ? `On pitch ${p.minutes}'` : p.frozen ? `Off ${p.minutes}'` : "Bench",
          pts: (Number(p.expectedScore) / 1e18).toFixed(1),
          price: usdc(p.referencePrice, 2),
          move: bps === 0 ? "—" : `${bps > 0 ? "+" : "−"}${Math.abs(bps / 100).toFixed(1)}%`,
          up: bps >= 0,
        };
      });
  }, [players]);

  // Real rows, or the dev-only stand-ins, or nothing at all.
  const rows = live ?? (ILLUSTRATIVE ? STATIC_ROWS : null);

  /**
   * One surface, edge to edge.
   *
   * This used to be a rounded `bg-panel` card floating inside a `bg-ground`
   * page, which read as two different darks with a visible seam between them and
   * kept every section boxed in from the viewport edge. The app screens are a
   * single `bg-ground` surface with panels only where something is genuinely a
   * panel, so the landing page now matches: full bleed, one colour, and the
   * section dividers doing the work the card border used to do.
   */
  return (
    <div className="min-h-dvh bg-ground">
      <div className="mx-auto w-full max-w-[1440px]">
        {/* ------------------------------------------------------------ nav */}
        <header className="flex h-[72px] items-center justify-between px-5 sm:h-[92px] sm:px-10 lg:px-20">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Whistle, home">
            <WhistleMark className="h-5 w-7" />
            <span className="font-display text-[19px] font-extrabold tracking-tight">Whistle</span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-6">
            <ul className="hidden items-center gap-6 text-[14px] text-muted md:flex">
              <li><a href="#how" className="transition-colors hover:text-text">How it works</a></li>
              <li><a href="#agents" className="transition-colors hover:text-text">Agents</a></li>
              <li><a href="#board" className="transition-colors hover:text-text">Live board</a></li>
            </ul>
            <GradientLink href="/fixtures">Launch app</GradientLink>
          </nav>
        </header>

        {/*
          ----------------------------------------------------------- hero

          Every vertical number here is measured against the cards, which never
          move: they are absolutely positioned against the section's padding box,
          whose top edge padding does not shift.

          `pt-[125px]` puts the headline's centre line on the centre of the upper
          pair (Mbappé, Messi). The paragraph's own `lg:mt` then puts the
          paragraph-and-button block on the centre of the lower pair (Yamal,
          Haaland) — so the two margins are a pair and changing one alone slides
          the other block off its cards.

          `min-h` sets where the next section starts. The lower cards end at
          598px, so 760 leaves them clear air rather than butting the divider.
        */}
        <section className="relative px-5 pb-16 pt-6 sm:px-10 sm:pb-20 lg:min-h-[760px] lg:px-20 lg:pt-[125px]">
          {/* Small screens: the cards sit above the headline as a scrollable row. */}
          <div className="mb-8 flex gap-3 overflow-x-auto pb-2 lg:hidden" aria-hidden>
            {HERO_CARDS.slice(0, 2).map((c) => (
              <PlayerCard key={c.lastName} {...c} size="sm" />
            ))}
          </div>

          {/* Desktop: four rotated cards behind the type. */}
          <div className="pointer-events-none absolute inset-x-20 top-16 hidden lg:block" aria-hidden>
            {HERO_CARDS.map((c) => (
              <PlayerCard key={c.lastName} {...c} size="md" className={`absolute ${c.pos}`} />
            ))}
          </div>

          <div className="relative mx-auto max-w-[940px] text-center">
            <h1
              className="font-display text-[34px] font-black leading-[1.08] tracking-tight sm:text-[48px] lg:text-[64px]"
              style={{ textShadow: "0 2px 18px #1B1B1F, 0 0 34px #1B1B1F" }}
            >
              {/* Staggered by phrase, not by word: "Trade the" arriving a letter
                  at a time would be a typing effect, which is a different and
                  much louder promise than a headline settling into place. */}
              <Phrase delay={0}>Trade the</Phrase>{" "}
              <Phrase delay={90} className="text-up">
                match
              </Phrase>{" "}
              <Phrase delay={180}>live.</Phrase>
              <br />
              <Phrase delay={270}>Let your</Phrase>{" "}
              <Phrase delay={360} className="text-blue">
                agent
              </Phrase>{" "}
              <Phrase delay={450}>play it.</Phrase>
            </h1>
            {/*
              Measured: this margin drops the paragraph-and-button block onto the
              centre line of the two lower cards. It absorbs whatever the section
              pads above — raising the headline by 28px meant adding 28px here,
              or the block would have risen with it and left its cards.

              Desktop only: below `lg` there are no side cards to align to, and
              a gap this size under the headline would just be a hole.
            */}
            <p className="relative z-10 mx-auto mt-6 max-w-[560px] text-[16px] leading-relaxed text-muted sm:text-[19px] lg:mt-[116px]">
              Buy player cards before kick-off or during the match. Prices move with every
              goal, card and substitution. Hand a bounded agent your playbook and just watch
              the game.
            </p>

            {/* Just the button. The panel that used to hold it repeated a card
                already on screen and a caption the sections below make properly. */}
            <div className="relative z-10 mt-9 flex justify-center">
              <GradientLink href="/fixtures">Launch app</GradientLink>
            </div>

            {/*
              The cue that there is a page below this one.

              A link rather than an ornament: on a screen where the hero fills the
              viewport, the thing telling you to scroll may as well scroll you.
              `scroll-mt-24` on the target keeps the heading clear of the top.

              Desktop only. Below `lg` the hero is content-height and the next
              section already peeks into view, so a "there's more" cue would be
              telling you something you can already see.
            */}
            <div className="relative z-10 mt-10 hidden justify-center lg:flex">
              <a
                href="#agents"
                aria-label="Scroll to what is below"
                className="grid h-10 w-10 place-items-center rounded-full border border-line-soft
                           text-dim transition-colors hover:border-line hover:text-text
                           focus-visible:border-line focus-visible:text-text focus-visible:outline-none"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4 animate-nudge motion-reduce:animate-none"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  focusable="false"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </a>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- agents */}
        <section id="agents" className="scroll-mt-24 border-t border-line-soft px-5 py-16 sm:px-10 sm:py-20 lg:px-20">
          <div className="flex flex-col gap-12 lg:flex-row lg:items-start lg:gap-16">
            <div className="lg:w-[520px] lg:shrink-0">
              <h2 className="font-display text-[26px] font-black uppercase leading-[1.1] tracking-tight sm:text-[40px]">
                Hand your agent the playbook and watch the game
              </h2>
              <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted sm:text-[16px]">
                <p>
                  Pick a playbook — Protect trims a holding when the news is bad, Momentum
                  chases what just rose, Contrarian buys the fall if the player is still on
                  the pitch. The agent trades from its own key, never yours.
                </p>
                <p>
                  Every mandate is an ENS name with a spend cap, a slippage limit and an
                  expiry written into its records. The agent may write its own trade log
                  there; only you may change the cap.
                </p>
                <p>
                  Revoke is a single transaction that unregisters the name. The next order
                  the agent tries reverts, because the permission it needs is simply no
                  longer there to read.
                </p>
              </div>
              <div className="mt-8">
                <OutlineLink href="/agents">See the agents</OutlineLink>
              </div>
            </div>

            <div className="relative flex-1">
              <div
                className="pointer-events-none absolute left-[12%] top-[8%] h-[220px] w-[220px] rounded-full bg-up/25 blur-[44px]"
                aria-hidden
              />
              <div className="relative flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:justify-center">
                <PlayerCard
                  firstName="Agent" lastName="One" number={1}
                  club={{ code: "ENS", colour: "#6FCF97" }} tint="green" size="lg"
                  bandLabel="agent-1.you.whistle.eth"
                  bandIcon={<TrendIcon />}
                />
                <div className="grid w-full max-w-[280px] gap-3">
                  <Chip title={<span className="tnum">Spend cap 100.00</span>} body="63.20 used" />
                  <Chip title="Playbook Protect" body="sells on red cards" />
                  <Chip title={<span className="tnum text-up">Live P&amp;L +3.42</span>} body="expires FT + 5'" />
                  <Chip title="You can always Revoke" body="next trade reverts" tone="down" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- board */}
        <section id="board" className="scroll-mt-24 border-t border-line-soft px-5 py-16 sm:px-10 sm:py-20 lg:px-20">
          <div className="flex flex-col gap-12 lg:flex-row-reverse lg:items-start lg:gap-16">
            <div className="lg:w-[520px] lg:shrink-0">
              <h2 className="font-display text-[26px] font-black uppercase leading-[1.1] tracking-tight sm:text-[40px]">
                Every goal moves the whole board
              </h2>
              <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted sm:text-[16px]">
                <p>
                  A card&apos;s price is its share of one pot, so a goal does not only lift the
                  scorer — it lowers everyone else, because their share of a fixed pot just
                  got smaller. There is no curve to walk and no liquidity to drain.
                </p>
                <p>
                  Orders wait thirty seconds before they fill. That window is what stops a
                  trade racing the goal that caused it.
                </p>
                <p>
                  When the window closes, everything queued for a card clears at one price:
                  buyers and sellers in the same batch get the same number, whoever arrived
                  first.
                </p>
              </div>
              <div className="mt-8">
                <OutlineLink href="/fixtures">Open the live board</OutlineLink>
              </div>
            </div>

            <div className="relative min-w-0 flex-1">
              <div
                className="pointer-events-none absolute right-[10%] top-[10%] h-[240px] w-[240px] rounded-full bg-blue/20 blur-[48px]"
                aria-hidden
              />
              {rows === null ? (
                /*
                  Nothing invented. One line saying the board could not be read,
                  and the way in — which still works, because `/fixture` reads the
                  chain directly and will say for itself if it cannot.
                */
                <div className="relative rounded-[18px] border border-line-soft bg-surface px-6 py-10 text-center">
                  <p className="text-[15px] text-muted">Live board unavailable.</p>
                  <div className="mt-5 flex justify-center">
                    <GradientLink href="/fixtures">Launch app</GradientLink>
                  </div>
                </div>
              ) : (
              <div className="relative overflow-hidden rounded-[18px] border border-line-soft bg-surface">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-line-soft text-[12px] uppercase tracking-wide text-dim">
                        <th scope="col" className="px-4 py-3 font-medium">Player</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">Pts</th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">Price</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">Move</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.name} className="border-b border-line-soft/60 bg-panel last:border-0">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <span
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-[10px] font-bold text-ground"
                                style={{ background: r.colour }}
                                aria-hidden
                              >
                                {r.code}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-[14px] font-semibold text-text">{r.name}</span>
                                <span className="block truncate text-[12px] text-dim">{r.note}</span>
                              </span>
                            </div>
                          </td>
                          <td className="tnum px-3 py-3 text-right text-[14px] text-muted">{r.pts}</td>
                          <td className="tnum px-3 py-3 text-right font-display text-[16px] font-extrabold">
                            {r.price}
                          </td>
                          <td className={`tnum px-4 py-3 text-right text-[14px] font-semibold ${r.up ? "text-up" : "text-down"}`}>
                            {r.move || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              )}
              <p className="mt-3 text-[12px] text-dim">
                {live
                  ? `Live prices from Sepolia${header?.state === 1 ? ", match in play" : ""}. Move is since kick-off; price is each card's share of the pot.`
                  : rows === null
                    ? "The board reads from Sepolia. It could not be reached just now — the app reads it directly."
                    : "Illustrative prices, shown because NEXT_PUBLIC_ILLUSTRATIVE is on. Not live data."}
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ how it works */}
        <section id="how" className="scroll-mt-24 border-t border-line-soft px-5 py-16 sm:px-10 sm:py-20 lg:px-20">
          <h2 className="font-display text-[26px] font-black uppercase tracking-tight sm:text-[40px]">
            How it works
          </h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: "ticket" as const, tint: "bg-tint-purple-blue", title: "Mint before kick-off",
                body: "Every card starts at a price set by the player's expected points, not by whoever bought first. Your money joins the pot.",
              },
              {
                icon: "clock" as const, tint: "bg-tint-green", title: "Or mint during the match",
                body: "At the live price plus 2%. New money grows the pot, so nobody else's price moves, and the order fills after the thirty-second delay like every other.",
              },
              {
                icon: "playbook" as const, tint: "bg-tint-orange-pink", title: "Delegate a playbook",
                body: "Grant an agent a spend cap, a slippage limit and an expiry. It trades from its own key and writes what it did to its own ENS name.",
              },
              {
                icon: "trophy" as const, tint: "bg-tint-yellow-green", title: "Redeem at full time",
                body: "Final scores settle on chain and every card is redeemable for its share of the pot. What is left over is rounding, not float.",
              },
            ].map((s) => (
              <div key={s.title} className="rounded-[18px] border border-line-soft bg-surface p-5">
                <StepIcon d={s.icon} tint={s.tint} />
                <h3 className="mt-4 text-[16px] font-bold text-text">{s.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-dim">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* --------------------------------------------------------- footer */}
        <footer className="border-t border-line-soft px-5 py-8 sm:px-10 lg:px-20">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-dim">
              <span className="font-display font-extrabold text-text">Whistle</span>
              <span>Built on ENSv2 and Uniswap v4 · Sepolia</span>
              <span>ETHGlobal Tokyo 2026</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <a
                href="https://sepolia.etherscan.io/address/0x38E67Af1161ce02AFaC03f2A6002661AeB5aCa2a"
                target="_blank" rel="noreferrer"
                className="text-muted transition-colors hover:text-text"
              >
                Contracts
              </a>
              <a
                href="https://github.com/whistle-eth/whistle"
                target="_blank" rel="noreferrer"
                className="text-muted transition-colors hover:text-text"
              >
                Source
              </a>
            </div>
          </div>
          <p className="mt-4 text-[12px] text-dim">
            Testnet only. Fantasy assets, not securities.
          </p>
        </footer>
      </div>
    </div>
  );
}
