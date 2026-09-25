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
import { zeroAddress, type Address } from "viem";

import { agentRegistryAbi, matchOracleAbi, whistleHookAbi } from "../../../../vendor/oracle/abi";
import { prepareAgent } from "../../../../vendor/oracle/agent-prep";
import { resolveFixture } from "../../../../lib/sim/deployment";
import { checkOperator, keeperAccount, managedPool, markAssigned, publicClient, walletFor } from "../../../../lib/sim/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** One assignment at a time: two forms submitted together must not get the same key. */
let queue: Promise<unknown> = Promise.resolve();

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

  const run = queue.then(() => assign(D, pc));
  queue = run.catch(() => undefined);
  try {
    return NextResponse.json(await run);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status });
  }
}

async function assign(D: NonNullable<ReturnType<typeof resolveFixture>>, pc: ReturnType<typeof publicClient>) {
  const pool = managedPool(D.fixtureId);
  if (pool.length === 0) {
    throw Object.assign(new Error("This server has no managed agent keys for this fixture. Use Advanced to bring your own address."), { status: 503 });
  }

  const infos = (await pc.multicall({
    contracts: pool.map((p) => ({
      address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo" as const, args: [p.account.address] as const,
    })),
    allowFailure: false,
  })) as unknown as readonly (readonly unknown[])[];
  const pick = pool.find((_, i) => infos[i]![1] === zeroAddress);
  if (!pick) {
    throw Object.assign(new Error("Every managed agent key for this fixture already has a mandate. Use Advanced to bring your own address."), { status: 409 });
  }

  // Every card the hook has registered for this fixture: those are the ones an agent can be told to trade.
  const FIXTURE = BigInt(D.fixtureId);
  const count = Number(
    await pc.readContract({ address: D.matchOracle, abi: matchOracleAbi, functionName: "playerCount", args: [FIXTURE] }),
  );
  const cards = (await pc.multicall({
    contracts: Array.from({ length: count }, (_, id) => ({
      address: D.matchOracle, abi: matchOracleAbi, functionName: "cardOf" as const, args: [FIXTURE, id] as const,
    })),
    allowFailure: false,
  })) as Address[];
  const registered = (await pc.multicall({
    contracts: cards.map((c) => ({
      address: D.whistleHook, abi: whistleHookAbi, functionName: "cardInfo" as const, args: [c] as const,
    })),
    allowFailure: true,
  })) as { status: string; result?: { registered: boolean } }[];
  const tradable = cards.filter((_, i) => registered[i]?.status === "success" && registered[i]?.result?.registered);

  const prep = await prepareAgent(pc as never, walletFor(keeperAccount()), walletFor(pick.account), {
    usdc: D.usdc, whistleHook: D.whistleHook, cards: tradable,
  });
  markAssigned(D.fixtureId, pick.account.address);

  return {
    address: pick.account.address,
    n: pick.n,
    funded: prep.funded !== null,
    setupTransactions: (prep.funded ? 1 : 0) + (prep.minted ? 1 : 0) + prep.approvals.length,
  };
}
