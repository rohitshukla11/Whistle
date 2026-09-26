/**
 * Prove, from the chain, who holds every admin and ownership field.
 *
 *   npx tsx scripts/verify-ownership.ts [deployments/fixture-<id>.json ...]
 *
 * Reads each field live and compares it with what the single-owner plan says it
 * should be. Nothing is taken from a deployment file except the addresses to
 * read — the answer is always the chain's.
 *
 * Two fields are expected NOT to be the owner, by design, and are checked
 * against their real expected holder rather than skipped:
 *   - `oracle.whistle.eth` is owned by the service key, because EnsRoleAuth
 *     grants the post-event role to that name's owner and nobody else;
 *   - the root registry's admin is the AgentRegistry contract, which has to hold
 *     it to mint subnames, and whose `operator()` is the owner.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, http, keccak256, parseAbi, toBytes, type Address } from "viem";
import { sepolia } from "viem/chains";

import { OWNER } from "./derive-keys.js";

const ETH_REGISTRY: Address = "0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E";
const ROLE_REGISTRAR_ADMIN = 1n << 128n;
const ROLE_SET_SUBREGISTRY_ADMIN = (1n << 20n) << 128n;

const abi = parseAbi([
  "function operator() view returns (address)",
  "function platform() view returns (address)",
  "function market() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function minter() view returns (address)",
  "function factory() view returns (address)",
  "function roleHolder() view returns (address)",
  "function getTokenId(uint256) view returns (uint256)",
  "function getOwner(uint256) view returns (address)",
  "function getSubregistry(string) view returns (address)",
  "function hasRoles(uint256,uint256,address) view returns (bool)",
  "function userAccounts(address) view returns (address,string,uint32,bool)",
  "function agentCount() view returns (uint256)",
  "function allAgents(uint256) view returns (address)",
  "function agentInfo(address) view returns (address,address,address,uint256,uint256,uint256,uint256,string)",
]);

interface Row { field: string; holder: string; expected: string; ok: boolean }

async function main(): Promise<void> {
  const repo = resolve(import.meta.dirname ?? ".", "..");
  const derived = JSON.parse(readFileSync(resolve(repo, ".secrets/derived.json"), "utf8")) as {
    signers: Record<string, { address: string }>;
  };
  const service = derived.signers.service!.address;
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ["deployments/11155111.json"];
  const D = JSON.parse(readFileSync(resolve(repo, files[0]!), "utf8")) as Record<string, Address>;

  const RPC = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL_INFURA ?? process.env.SEPOLIA_RPC_URL;
  const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const read = <T>(address: Address, functionName: string, args: unknown[] = []) =>
    pc.readContract({ address, abi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const rows: Row[] = [];
  const add = (field: string, holder: string, expected: string, label = expected) =>
    rows.push({ field, holder, expected: label, ok: eq(holder, expected) });

  add("AgentRegistry.operator()", await read(D.agentRegistry!, "operator"), OWNER, "owner");
  add("AgentRegistry.platform()", await read(D.agentRegistry!, "platform"), OWNER, "owner");
  add("FixtureFactory.operator()", await read(D.fixtureFactory!, "operator"), OWNER, "owner");
  add("WhistleHook.operator()", await read(D.whistleHook!, "operator"), OWNER, "owner");
  add("WhistleHook.feeRecipient()", await read(D.whistleHook!, "feeRecipient"), OWNER, "owner");
  add("MMVault.operator()", await read(D.mmVault!, "operator"), OWNER, "owner");

  // whistle.eth, in the real ENSv2 .eth registry
  const whistleTid = await read<bigint>(ETH_REGISTRY, "getTokenId", [BigInt(keccak256(toBytes("whistle")))]);
  add("whistle.eth owner (.eth registry)", await read(ETH_REGISTRY, "getOwner", [whistleTid]), OWNER, "owner");
  add("whistle.eth subregistry", await read(ETH_REGISTRY, "getSubregistry", ["whistle"]), D.rootRegistry!, "new root registry");

  // the root registry's admin is the AgentRegistry contract — by design
  const agentHasAdmin =
    (await read<boolean>(D.rootRegistry!, "hasRoles", [0n, ROLE_REGISTRAR_ADMIN, D.agentRegistry!])) &&
    (await read<boolean>(D.rootRegistry!, "hasRoles", [0n, ROLE_SET_SUBREGISTRY_ADMIN, D.agentRegistry!]));
  rows.push({
    field: "root registry admin",
    holder: agentHasAdmin ? `AgentRegistry ${D.agentRegistry}` : "NOT AgentRegistry",
    expected: "AgentRegistry (operator = owner)",
    ok: agentHasAdmin,
  });

  // oracle.whistle.eth — its OWNER is the post-event role
  const oracleTid = await read<bigint>(D.rootRegistry!, "getTokenId", [BigInt(keccak256(toBytes("oracle")))]);
  add("oracle.whistle.eth owner", await read(D.rootRegistry!, "getOwner", [oracleTid]), service, "service key");
  add("EnsRoleAuth.roleHolder()", await read(D.ensRoleAuth!, "roleHolder"), service, "service key");

  // the tokyo user
  const acct = await read<readonly [Address, string, number, boolean]>(D.agentRegistry!, "userAccounts", [OWNER]);
  rows.push({
    field: "owner's user account",
    holder: acct[3] ? `${acct[1]}.whistle.eth (${acct[2]} agents)` : "none",
    expected: "tokyo.whistle.eth",
    ok: acct[3] && acct[1] === "tokyo",
  });

  // wiring, for completeness — contract to contract
  add("AgentRegistry.market()", await read(D.agentRegistry!, "market"), D.whistleHook!, "WhistleHook");

  // every mandate, on every fixture file given
  const n = await read<bigint>(D.agentRegistry!, "agentCount");
  for (let i = 0n; i < n; i++) {
    const a = await read<Address>(D.agentRegistry!, "allAgents", [i]);
    const info = await read<readonly unknown[]>(D.agentRegistry!, "agentInfo", [a]);
    add(`mandate ${String(info[7])} (fixture ${String(info[4])})`, info[0] as string, OWNER, "owner");
  }

  // per-fixture venue wiring for each file given
  for (const f of files) {
    const F = JSON.parse(readFileSync(resolve(repo, f), "utf8")) as Record<string, Address>;
    add(`SettlementPot.minter() [${F.fixtureId}]`, await read(F.settlementPot!, "minter"), F.whistleHook!, "that fixture's WhistleHook");
    add(`WhistleHook.operator() [${F.fixtureId}]`, await read(F.whistleHook!, "operator"), OWNER, "owner");
    add(`MMVault.operator() [${F.fixtureId}]`, await read(F.mmVault!, "operator"), OWNER, "owner");
  }

  const w = Math.max(...rows.map((r) => r.field.length));
  for (const r of rows) console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.field.padEnd(w)}  ${r.holder}   (expected ${r.expected})`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - bad}/${rows.length} fields as the single-owner plan says`);
  if (bad) process.exitCode = 1;
}

void main();
