/**
 * Bind agents to one fixture, before presenting it.
 *
 *   npx tsx scripts/activate-fixture.ts <fixtureId>           # does it, if needed
 *   npx tsx scripts/activate-fixture.ts <fixtureId> --check   # reports, sends nothing
 *
 * `AgentRegistry` has ONE market — the hook allowed to call `recordSpend` — and
 * `WhistleHook` calls it on every agent fill. Every fixture has its own hook,
 * and each fixture's deploy repoints the market to itself, so after deploying
 * eight fixtures agents can trade on exactly one: the last. On any other, the
 * first agent fill reverts `OnlyMarket`, and because fills are batched the whole
 * `tick` reverts with it — the queue stalls for everyone, not just the agents.
 *
 * So each presentation starts here: one `setMarket(thatFixture'sHook)` from the
 * operator (0x6834…), ~30k gas, one block. Idempotent — if the fixture is
 * already bound it says so and sends nothing. The browser panel does the same
 * from the connected wallet and will not Start until it has landed.
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { OWNER } from "./derive-keys.js";

const abi = parseAbi([
  "function market() view returns (address)",
  "function setMarket(address market_)",
  "function operator() view returns (address)",
  "function fixtures(uint256) view returns (address,uint8,uint16,uint16,uint32,uint64,uint64)",
]);
const STATE = ["PRE_MATCH", "LIVE", "SETTLED"];

async function main(): Promise<void> {
  const id = process.argv[2];
  const check = process.argv.includes("--check");
  if (!id || !/^\d+$/.test(id)) throw new Error("usage: activate-fixture.ts <fixtureId> [--check]");

  const D = JSON.parse(readFileSync(resolve(`deployments/fixture-${id}.json`), "utf8")) as Record<string, Address> & {
    label?: string;
  };
  const RPC = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL_INFURA ?? process.env.SEPOLIA_RPC_URL;
  const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });

  const [market, operator, fx] = await Promise.all([
    pc.readContract({ address: D.agentRegistry!, abi, functionName: "market" }),
    pc.readContract({ address: D.agentRegistry!, abi, functionName: "operator" }),
    pc.readContract({ address: D.matchOracle!, abi, functionName: "fixtures", args: [BigInt(id)] }),
  ]);
  const state = STATE[Number(fx[1])] ?? "?";

  console.log(`fixture   ${id}  ${D.label ?? ""}  (${state})`);
  console.log(`its hook  ${D.whistleHook}`);
  console.log(`market    ${market}`);

  if (market.toLowerCase() === D.whistleHook!.toLowerCase()) {
    console.log("\nagents bound to this fixture — nothing to do.");
    return;
  }
  console.log("\nagents are bound to ANOTHER fixture; agent fills here would revert OnlyMarket.");
  if (state !== "PRE_MATCH") console.log(`note: this fixture is ${state}.`);
  if (check) return;

  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY (the operator, 0x6834…) is not set.");
  const owner = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  if (owner.address.toLowerCase() !== OWNER.toLowerCase() || owner.address.toLowerCase() !== operator.toLowerCase()) {
    throw new Error(`the key is ${owner.address}; only the operator ${operator} can activate.`);
  }

  const wallet = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: D.agentRegistry!, abi, functionName: "setMarket", args: [D.whistleHook!], chain: sepolia, account: owner,
  });
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw new Error(`setMarket REVERTED: ${hash}`);
  const now = await pc.readContract({ address: D.agentRegistry!, abi, functionName: "market" });
  console.log(`activated: ${hash}  (block ${rc.blockNumber}, gas ${rc.gasUsed})`);
  console.log(now.toLowerCase() === D.whistleHook!.toLowerCase() ? "agents bound to this fixture." : "MISMATCH after activate — check it.");
}

void main();
