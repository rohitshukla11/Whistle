"use client";

import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import type { Address } from "viem";

import deployment from "../vendor/deployments/11155111.json";

/**
 * The chain the app talks to.
 *
 * A local anvil FORK of Sepolia reports chain id 11155111, so the same chain
 * object serves both the fork and the real network — only the RPC URL moves. That
 * is why there is no separate "anvil" entry here.
 */
/**
 * Default to a public Sepolia endpoint rather than localhost.
 *
 * It also has to serve wide `eth_getLogs`: Alchemy's free tier caps that at ten
 * blocks, which empties the event feed and the settlement screen's cost basis
 * without raising anything the UI can show. See `.env.example`.
 */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * True when nobody configured an endpoint and we fell back to a local node.
 *
 * Worth knowing, because the two failures look identical from the browser and
 * have opposite fixes: "your anvil is not running" and "you never set
 * `NEXT_PUBLIC_RPC_URL`, so the app is talking to a node you do not have".
 */
export const RPC_IS_DEFAULT = process.env.NEXT_PUBLIC_RPC_URL === undefined;

/** A provider URL with the key taken out, safe to put on screen. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" || u.pathname === "" ? u.host : `${u.host}/…`;
  } catch {
    return "(unparseable RPC URL)";
  }
}

/**
 * A second endpoint, used only for reading history.
 *
 * State reads and log scans want different things from an RPC and no single free
 * endpoint is good at both:
 *
 *   - Alchemy's free tier serves the fixture screen's ~200 multicalls happily,
 *     but answers `eth_getLogs` over a TEN BLOCK range and 400s anything wider.
 *   - publicnode serves a 10,000-block `eth_getLogs` without a key, but falls
 *     over on the fixture screen's read volume.
 *
 * So state goes to {@link RPC_URL} and history comes from here. Point both at the
 * same URL if you have one endpoint that does both.
 */
export const LOGS_RPC_URL =
  process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http(RPC_URL, { retryCount: 3, retryDelay: 800, batch: true }) },
  ssr: true,
});

export interface Deployment {
  chainId: number;
  matchOracle: Address;
  settlementPot: Address;
  whistleHook: Address;
  fillRouter: Address;
  mmVault: Address;
  agentRegistry: Address;
  fixtureFactory: Address;
  usdc: Address;
  fixtureId: string;
}

export const DEPLOYMENT = deployment as Deployment;

export const FIXTURE_ID = BigInt(DEPLOYMENT.fixtureId ?? "0");

/** ENSv2 Sepolia beta. PLAN.md §0. */
export const UNIVERSAL_RESOLVER: Address = "0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3";

/**
 * Nothing polls faster than this. Match events are rare; the UI is not a game.
 *
 * Raised from 4s after a rehearsal: a full refresh is eight multicalls across
 * thirty-six players, and at four seconds that sustained enough requests to earn
 * HTTP 429s from the RPC — which the app surfaced as an empty settlement screen
 * and a stale status column, neither of which looks like rate limiting.
 */
export const POLL_MS = 6_000;

export const TEMPLATES = [
  { id: 1, name: "protect", blurb: "Sells a slice of any held card whose price just dropped materially." },
  { id: 2, name: "momentum", blurb: "Buys the card that rose hardest on the last event." },
  { id: 3, name: "contrarian", blurb: "Buys the card that fell hardest, if the player is still on." },
] as const;

export function templateName(id: number | bigint): string {
  return TEMPLATES.find((t) => t.id === Number(id))?.name ?? `template ${id}`;
}
