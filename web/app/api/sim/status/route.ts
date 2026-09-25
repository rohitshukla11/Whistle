/**
 * What the chain says, and nothing else.
 *
 * The panel calls this on load. It is what makes a mid-match reload resume: the
 * clock comes back from `sessionStorage`, the match comes back from here, and
 * between them there is nothing left to remember.
 *
 * Not gated: it reads public chain state and signs nothing, and the panel needs
 * it before the operator has signed in, to say which state the match is in.
 */

import { NextResponse } from "next/server";

import { matchOracleAbi } from "../../../../vendor/oracle/abi";
import { resolveFixture } from "../../../../lib/sim/deployment";
import { EVENTS, LAST_MINUTE, describeEvent, nextEventAfter } from "../../../../lib/sim/match";
import { isProtected, publicClient } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* optional */
  }
  const D = resolveFixture(body.fixtureId);
  if (!D) return NextResponse.json({ error: `Unknown fixture ${String(body.fixtureId)}.` }, { status: 404 });

  try {
    const pc = publicClient();
    const fixture = (await pc.readContract({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "fixtures", args: [BigInt(D.fixtureId)],
    })) as readonly unknown[];
    const chainMinute = Number(fixture[2]);
    const next = nextEventAfter(chainMinute);
    return NextResponse.json({
      fixtureId: D.fixtureId,
      chainState: Number(fixture[1]),
      chainMinute,
      nextEvent: next ? { minute: next.minute, label: describeEvent(next) } : null,
      eventsPosted: EVENTS.filter((e) => e.minute <= chainMinute).length,
      eventsTotal: EVENTS.length,
      lastMinute: LAST_MINUTE,
      protected: isProtected(D.fixtureId),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Cannot read the fixture: ${(err as Error).message.split("\n")[0]}` },
      { status: 502 },
    );
  }
}
