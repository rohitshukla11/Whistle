/**
 * Make a managed-pool agent key ready to trade, from the terminal.
 *
 *   npx tsx scripts/prepare-agent.ts <fixtureId> [n]     # n defaults to 4
 *
 * The same steps `/api/agents/assign` takes (`oracle/agent-prep.ts`): gas from
 * the service key if the agent is low, the agent mints its own MockUSDC, and
 * approves the hook for USDC and every registered card. It also marks the key
 * assigned in `.secrets/derived.json`, so the step runner and
 * `agent/runtime.ts --fixture-id` drive it. Prints the address only; paste it
 * into "Advanced: bring your own agent address" if the form cannot reach the
 * assign route.
 */

import "dotenv/config";

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { matchOracleAbi, whistleHookAbi } from "../oracle/abi.js";
import { prepareAgent } from "../oracle/agent-prep.js";
import { DERIVED_FILE, derivedServiceKey, type DerivedAgent } from "../oracle/derived.js";

async function main(): Promise<void> {
  const id = process.argv[2];
  const n = Number(process.argv[3] ?? 4);
  if (!id || !/^\d+$/.test(id)) throw new Error("usage: prepare-agent.ts <fixtureId> [n]");

  const doc = JSON.parse(readFileSync(DERIVED_FILE, "utf8")) as { fixtures: Record<string, DerivedAgent[]> };
  const entry = doc.fixtures[id]?.find((a) => a.n === n);
  if (!entry) throw new Error(`no derived agent ${n} for fixture ${id}; run scripts/derive-keys.ts`);
  const serviceKey = derivedServiceKey();
  if (!serviceKey) throw new Error("no service key in the derived file");

  const D = JSON.parse(readFileSync(resolve(`deployments/fixture-${id}.json`), "utf8")) as Record<string, Address>;
  const rpc = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
  const pc = createPublicClient({ chain: sepolia, transport: http(rpc) }) as PublicClient;
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: sepolia, transport: http(rpc) });

  const FIXTURE = BigInt(id);
  const count = Number(await pc.readContract({ address: D.matchOracle!, abi: matchOracleAbi, functionName: "playerCount", args: [FIXTURE] }));
  const cards: Address[] = [];
  for (let p = 0; p < count; p++) {
    const card = await pc.readContract({ address: D.matchOracle!, abi: matchOracleAbi, functionName: "cardOf", args: [FIXTURE, p] });
    const info = await pc.readContract({ address: D.whistleHook!, abi: whistleHookAbi, functionName: "cardInfo", args: [card] });
    if ((info as { registered: boolean }).registered) cards.push(card);
  }

  const r = await prepareAgent(pc, wallet(serviceKey), wallet(entry.key), { usdc: D.usdc!, whistleHook: D.whistleHook!, cards });
  entry.assigned ??= new Date().toISOString();
  writeFileSync(DERIVED_FILE, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  chmodSync(DERIVED_FILE, 0o600);

  console.log(`agent ${n} for fixture ${id}: ${entry.address}`);
  console.log(`  gas ${r.funded ? "sent" : "already enough"}, USDC ${r.minted ? "minted" : "already held"}, ${r.approvals.length} approvals, marked assigned`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
