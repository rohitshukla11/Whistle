/**
 * Kick off, once, deliberately.
 *
 * Separate from `step` for one reason: this is the only irreversible thing the
 * simulation does. `kickoff` cannot be undone, and the fixture it runs on is the
 * one the live demo needs later — so the two guards that matter live here, on a
 * call the operator makes on purpose, rather than on a call the tab makes every
 * three seconds.
 *
 * It writes nothing down. The browser records that the match is running; the
 * chain records that it kicked off. There is no third copy to disagree.
 */

import { NextResponse } from "next/server";

import { matchOracleAbi } from "../../../../vendor/oracle/abi";
import { resolveFixture } from "../../../../lib/sim/deployment";
import { checkToken, isProtected, oracleAccount, publicClient, walletFor } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = checkToken(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* an empty body means the default fixture */
  }

  const D = resolveFixture(body.fixtureId);
  if (!D) return NextResponse.json({ error: `Unknown fixture ${String(body.fixtureId)}.` }, { status: 404 });

  const pc = publicClient();
  let fixture: readonly unknown[];
  try {
    fixture = (await pc.readContract({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "fixtures", args: [BigInt(D.fixtureId)],
    })) as readonly unknown[];
  } catch (err) {
    return NextResponse.json(
      { error: `Cannot read the fixture: ${(err as Error).message.split("\n")[0]}` },
      { status: 502 },
    );
  }

  const state = Number(fixture[1]);
  const chainMinute = Number(fixture[2]);
  if (state !== 0) {
    return NextResponse.json(
      {
        error:
          state === 1
            ? `This fixture is already live at ${chainMinute}'. Use Resume, not Start.`
            : "This fixture is settled. It cannot be started again.",
        chainState: state,
        chainMinute,
      },
      { status: 409 },
    );
  }

  if (isProtected(D.fixtureId) && body.confirm !== 1 && body.confirm !== "1") {
    return NextResponse.json(
      { error: `Fixture ${D.fixtureId} is protected. Re-send with confirm=1 if you really mean it.`, protected: true },
      { status: 409 },
    );
  }

  const oracle = oracleAccount();
  const hash = await walletFor(oracle).writeContract({
    address: D.matchOracle, abi: matchOracleAbi, functionName: "kickoff",
    args: [BigInt(D.fixtureId)], chain: null, account: oracle,
  });

  return NextResponse.json({ ok: true, hash, chainState: state, chainMinute, protected: isProtected(D.fixtureId) });
}
