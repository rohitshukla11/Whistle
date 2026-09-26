/**
 * Hand the New agent form a Whistle-managed agent address for this fixture.
 *
 * The form used to ask for an agent key, which on stage meant pasting a hex
 * address from a terminal. Now it asks here: the server takes the lowest key in
 * the fixture's managed pool (`whistle:agent:<fixtureId>:<n>`, n ≥ 4, pre-derived
 * into `.secrets/derived.json`) that has never held a mandate, makes it able to
 * trade — gas from the service key, its own USDC, the hook's approvals — marks it
 * assigned so the step runner drives it, and returns the address. The key never
 * leaves the server. The browser then calls `createAgent` with that address from
 * the operator's own wallet, exactly as before.
 *
 * "Unused" is read from the chain (`agentInfo(address).registry == 0`), not from
 * the file: a form that was abandoned after assignment leaves the key assigned
 * but unregistered, and the next request hands out the same one again.
 *
 * Operator-signed, like the sim routes. Local-server only: `.secrets/` is not
 * deployed.
 */

import { NextResponse } from "next/server";

import { resolveFixture } from "../../../../lib/sim/deployment";
import { assignManagedKey } from "../../../../lib/sim/assign";
import { checkOperator, publicClient } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* optional */
  }
  const D = resolveFixture(body.fixtureId);
  if (!D) return NextResponse.json({ error: `Unknown fixture ${String(body.fixtureId)}.` }, { status: 404 });
  const pc = publicClient();
  const auth = await checkOperator(req, D, pc);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    return NextResponse.json(await assignManagedKey(D, pc));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status });
  }
}
