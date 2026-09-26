/**
 * Assign the next unused Whistle-managed agent key for a fixture and make it
 * able to trade. Shared by `/api/agents/assign` (the browser then calls
 * createAgent) and the World ID create-agent action (the server does).
 *
 * "Unused" is read from the chain (`agentInfo(address).registry == 0`), so an
 * abandoned assignment is handed out again rather than wasted.
 */

import { zeroAddress, type Address } from "viem";

import { agentRegistryAbi, matchOracleAbi, whistleHookAbi } from "../../vendor/oracle/abi";
import { prepareAgent } from "../../vendor/oracle/agent-prep";
import type { SimDeployment } from "./deployment";
import { keeperAccount, managedPool, markAssigned, publicClient, walletFor } from "./server";

/** One assignment at a time: two forms submitted together must not get the same key. */
let queue: Promise<unknown> = Promise.resolve();

export function assignManagedKey(D: SimDeployment, pc: ReturnType<typeof publicClient>) {
  const run = queue.then(() => assign(D, pc));
  queue = run.catch(() => undefined);
  return run;
}

async function assign(D: SimDeployment, pc: ReturnType<typeof publicClient>) {
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
