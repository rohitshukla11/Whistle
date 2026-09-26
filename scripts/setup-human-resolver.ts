/**
 * Give tokyo.whistle.eth a resolver Whistle can write, for World ID human records.
 *
 *   npx tsx scripts/setup-human-resolver.ts            # WHISTLE_RPC_URL / SEPOLIA_RPC_URL
 *   npx tsx scripts/setup-human-resolver.ts --probe    # fork only: also write + read a probe record
 *
 * Why: the human binding keccak256(iss ‖ sub) cannot go on an agent's own
 * resolver without a contract change — its text keys are granted one by one
 * inside `createAgent`, and only AgentRegistry holds the admin role to grant a
 * new one, with no function that does. tokyo.whistle.eth's current resolver
 * (ENS PublicResolverV2) authorises writes only for NameWrapper-wrapped names,
 * which an ENSv2-only name is not. So: deploy ENS's own PermissionedResolver
 * (the implementation AgentRegistry uses for agents) with 0x6834… holding
 * ROLE_SET_TEXT at root, and point tokyo.whistle.eth at it. Records are then
 * `human.agent-N` on tokyo.whistle.eth. No Whistle contract changes.
 *
 * Idempotent: if tokyo.whistle.eth already resolves through a resolver where the
 * owner holds root ROLE_SET_TEXT, it does nothing.
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToBytes,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const PERMISSIONED_RESOLVER_IMPL = "0x14F09Fd05d4585759e54844DC9B00147131Cf243" as Address;
const VERIFIABLE_FACTORY = "0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C" as Address;
const ROLE_SET_TEXT = 1n << 4n;
const ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128n;
const ROLE_LINK = 1n << 28n;

const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes initData) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
const resolverAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function setText(bytes name, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);
const registryAbi = parseAbi([
  "function getResolver(string label) view returns (address)",
  "function setResolver(uint256 anyId, address resolver)",
]);

export const dnsEncode = (name: string): Hex =>
  `0x${name.split(".").map((l) => Buffer.from([l.length]).toString("hex") + Buffer.from(l).toString("hex")).join("")}00` as Hex;

export async function readText(pc: { readContract: (...a: never[]) => unknown } & ReturnType<typeof createPublicClient>, resolver: Address, name: string, key: string): Promise<string> {
  const { namehash } = await import("viem/ens");
  const { decodeFunctionResult } = await import("viem");
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(name), key] });
  const out = await pc.readContract({ address: resolver, abi: resolverAbi, functionName: "resolve", args: [dnsEncode(name), data] });
  return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: out as Hex }) as string;
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const rpc = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL!;
  if (probe && !/127\.0\.0\.1|localhost/.test(rpc)) throw new Error("--probe is fork-only");
  const raw = process.env.DEPLOYER_PRIVATE_KEY!;
  const owner = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const S = JSON.parse(readFileSync(resolve("deployments/11155111.json"), "utf8")) as Record<string, Address>;
  const pc = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const w = createWalletClient({ account: owner, chain: sepolia, transport: http(rpc) });

  const current = await pc.readContract({ address: S.rootRegistry!, abi: registryAbi, functionName: "getResolver", args: ["tokyo"] });
  console.log(`tokyo.whistle.eth resolver now: ${current}`);
  const usable = await pc
    .readContract({ address: current, abi: resolverAbi, functionName: "hasRootRoles", args: [ROLE_SET_TEXT, owner.address] })
    .catch(() => false);

  let resolverAddr = current;
  if (usable) {
    console.log("already a PermissionedResolver the owner can write — nothing to do");
  } else {
    const salt = BigInt(keccak256(stringToBytes("whistle:human-resolver:tokyo.whistle.eth")));
    const initData = encodeFunctionData({
      abi: resolverAbi, functionName: "initialize",
      args: [[{ account: owner.address, roleBitmap: ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN | ROLE_LINK }], []],
    });
    const deployHash = await w.writeContract({
      address: VERIFIABLE_FACTORY, abi: factoryAbi, functionName: "deployProxy", args: [PERMISSIONED_RESOLVER_IMPL, salt, initData],
    });
    const rc = await pc.waitForTransactionReceipt({ hash: deployHash });
    if (rc.status !== "success") throw new Error(`deployProxy reverted: ${deployHash}`);
    const ev = parseEventLogs({ abi: factoryAbi, logs: rc.logs, eventName: "ProxyDeployed" })[0];
    if (!ev) throw new Error("no ProxyDeployed event");
    resolverAddr = ev.args.proxyAddress;
    console.log(`deployed PermissionedResolver ${resolverAddr} (tx ${deployHash}, gas ${rc.gasUsed})`);

    const setHash = await w.writeContract({
      address: S.rootRegistry!, abi: registryAbi, functionName: "setResolver", args: [BigInt(keccak256(toBytes("tokyo"))), resolverAddr],
    });
    const rc2 = await pc.waitForTransactionReceipt({ hash: setHash });
    if (rc2.status !== "success") throw new Error(`setResolver reverted: ${setHash}`);
    console.log(`tokyo.whistle.eth -> ${resolverAddr} (tx ${setHash}, gas ${rc2.gasUsed})`);
  }

  const now = await pc.readContract({ address: S.rootRegistry!, abi: registryAbi, functionName: "getResolver", args: ["tokyo"] });
  const canWrite = await pc.readContract({ address: now, abi: resolverAbi, functionName: "hasRootRoles", args: [ROLE_SET_TEXT, owner.address] });
  console.log(`check: resolver ${now}, owner holds root ROLE_SET_TEXT: ${canWrite}`);

  if (probe) {
    const name = dnsEncode("tokyo.whistle.eth");
    const h = await w.writeContract({ address: now, abi: resolverAbi, functionName: "setText", args: [name, "human.probe", "ok"] });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    // PermissionedResolver answers reads through ENSIP-10 `resolve(name, data)`,
    // not a direct `text(node, key)` call — the same path AgentRegistry reads with.
    const back = await readText(pc, now, "tokyo.whistle.eth", "human.probe");
    console.log(`probe setText ${rc.status}, gas ${rc.gasUsed}; read back "${back}"`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.split("\n")[0] : String(err));
  process.exit(1);
});
