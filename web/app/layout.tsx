import type { Metadata, Viewport } from "next";
import { DM_Sans, Unbounded } from "next/font/google";

import "./globals.css";
import { Providers } from "./providers";

/**
 * Two faces, two jobs — the same split the app screens make between what the
 * product says and what the market says, carried onto the landing page.
 *
 * Unbounded is the display voice: headlines, prices, card numbers. DM Sans is
 * everything you read as a sentence.
 */
const display = Unbounded({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

const body = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Whistle — trade the match live",
  description:
    "Live fantasy-football player cards, priced off a match clock. Hand a bounded agent your playbook and watch the game.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * The root layout carries only the document, the fonts and the providers.
 *
 * The phone-width shell and the bottom tab bar belong to the app screens, not to
 * the landing page, so they live in `(app)/layout.tsx` instead.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-dvh overflow-x-hidden bg-ground font-sans text-text antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
