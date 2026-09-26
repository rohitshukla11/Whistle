"use client";

/**
 * One fixture, rendered by its on-chain state.
 *
 *   PRE_MATCH → the pre-match screen (mint, add an agent, Start on one page)
 *   LIVE      → the live screen, exactly as `/fixture` was
 *   SETTLED   → the settlement screen, exactly as `/settlement` was
 *
 * The state is polled (4 s), so the same URL swaps screens by itself when
 * kickoff lands and again at `postFinal`. Nothing the swap needs is held in the
 * screens: the fixture comes from the path, the operator signature and the sim
 * clock from `sessionStorage`, and the selected player from `lib/selection`.
 */

import { use } from "react";
import Link from "next/link";

import { PreMatchScreen } from "../../../../components/screens/PreMatchScreen";
import LiveScreen from "../../../../components/screens/LiveScreen";
import SettlementScreen from "../../../../components/screens/SettlementScreen";
import { ALL_FIXTURES } from "../../../../lib/fixtures";
import { useFixtureState } from "../../../../lib/useFixtureState";

export default function FixtureRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Hidden fixtures stay reachable by URL; they are only left out of lists.
  const D = ALL_FIXTURES.find((f) => f.fixtureId === id);
  const { state, error } = useFixtureState(D);

  if (!D) {
    return (
      <main className="py-16 text-center">
        <h1 className="font-display text-[22px] font-extrabold">No such fixture</h1>
        <p className="mt-2 text-[14px] text-dim">
          Fixture {id} is not deployed on this network. <Link className="text-up underline" href="/fixtures">Back to fixtures</Link>
        </p>
      </main>
    );
  }
  if (state === undefined) {
    return (
      <main className="py-16 text-center text-[14px] text-dim" aria-busy="true">
        {error ? "Could not read this fixture from the chain; retrying…" : "Reading the fixture…"}
      </main>
    );
  }
  if (state === 0) return <PreMatchScreen />;
  if (state === 1) return <LiveScreen />;
  return <SettlementScreen />;
}
