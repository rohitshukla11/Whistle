import type { Config } from "tailwindcss";

/**
 * Two palettes, deliberately separate.
 *
 * The app screens (`dusk`…`sheet`) are a floodlit evening kick-off: one bold
 * colour, spent on a price that has just moved. See ../docs/design.md.
 *
 * The landing page (`ground`…`blue`) is a darker, flatter set built for a
 * marketing surface rather than a live board — no amber, because nothing on it
 * is changing in front of you, and a wider range of tints because the player
 * cards are the illustration.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ---------------------------------------------------------- the app
        dusk: "#11151a",
        chalk: "#e9edf1",
        slate: "#7f8b98",
        signal: "#f2a33c",
        home: "#4a7fd4",
        away: "#b35566",
        rule: "#222b34",
        sheet: "#161b21",

        // ------------------------------------------------- the landing page
        ground: "#101012",
        panel: "#1B1B1F",
        surface: "#232328",
        line: "#34343B",
        "line-soft": "#2A2A30",
        text: "#F3F3F5",
        muted: "#C2C2C8",
        dim: "#8C8C95",
        up: "#8FE3B7",
        down: "#FF7B72",
        warn: "#F5E663",
        blue: "#56A7E0",
      },
      fontFamily: {
        // Wired up in app/layout.tsx via next/font/google.
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        panel: "36px",
        card: "24px",
      },
      backgroundImage: {
        // One CTA gradient, and one tint per card. Keys match PlayerCard's `tint`.
        cta: "linear-gradient(90deg, #6FCF97, #56A7E0)",
        "tint-purple-blue": "linear-gradient(160deg, #7C5CE0, #4C9BE8)",
        "tint-green": "linear-gradient(160deg, #6FCF97, #2E9B5A)",
        "tint-orange-pink": "linear-gradient(160deg, #F0A35A, #E0578A)",
        "tint-yellow-green": "linear-gradient(160deg, #F5E663, #6FCF97)",
        "tint-purple-pink": "linear-gradient(160deg, #7C5CE0, #E0578A)",
      },
      keyframes: {
        // One beat of amber when a price changes. Nothing else in the app animates
        // without a user action or a match event.
        moved: {
          "0%": { color: "#f2a33c" },
          "100%": { color: "#e9edf1" },
        },
        // The board's one motion: a price that just changed, for 600ms.
        flash: {
          "0%": { opacity: "0.45" },
          "100%": { opacity: "1" },
        },
        /**
         * The landing headline, one phrase at a time.
         *
         * Marketing surface, not the board — the app's "nothing moves without a
         * match event" rule is about not inventing motion where a number is the
         * news. Here the headline IS the news, and it arrives once.
         *
         * Rises by a fraction of its own size rather than a fixed distance, so
         * it travels the same visual amount at 34px and at 64px.
         */
        rise: {
          "0%": { opacity: "0", transform: "translateY(0.32em)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        /**
         * The scroll cue under the hero.
         *
         * Small travel and a slow cycle: this runs forever, and anything larger
         * or faster becomes the loudest thing on a page whose headline is the
         * point. It brightens as it falls so the eye reads direction, not just
         * movement.
         */
        nudge: {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.5" },
          "50%": { transform: "translateY(5px)", opacity: "1" },
        },
      },
      animation: {
        moved: "moved 1.6s ease-out",
        flash: "flash 600ms ease-out",
        // `both` matters: each phrase is staggered, so without a backwards fill
        // they would all flash into view before their delay had elapsed.
        rise: "rise 620ms cubic-bezier(0.22, 1, 0.36, 1) both",
        nudge: "nudge 1.9s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
