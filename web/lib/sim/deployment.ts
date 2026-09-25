/**
 * Which set of addresses a simulation is driving.
 *
 * Whistle deploys a venue per fixture, so "which match" is a set of contracts,
 * not an id — and the shared `deployments/11155111.json` does not carry a
 * fixture id at all, which is how the first version of these routes came to
 * throw `Cannot convert undefined to a BigInt` at build time.
 *
 * So the fixture travels with the request. The panel already knows which match
 * it is showing; it says so, and the server resolves it here against the same
 * generated index the client uses.
 */

import allFixtures from "../../vendor/fixtures.json";

export interface SimDeployment {
  chainId: number;
  fixtureId: string;
  label: string;
  settled: boolean;
  matchOracle: `0x${string}`;
  settlementPot: `0x${string}`;
  whistleHook: `0x${string}`;
  mmVault: `0x${string}`;
  agentRegistry: `0x${string}`;
  usdc: `0x${string}`;
}

export const FIXTURES = allFixtures as unknown as SimDeployment[];

/** The match a demo means when it does not say: the newest unsettled one. */
export const DEFAULT_FIXTURE = FIXTURES.find((f) => !f.settled) ?? FIXTURES[0];

export function resolveFixture(id: unknown): SimDeployment | null {
  if (id === undefined || id === null || id === "") return DEFAULT_FIXTURE ?? null;
  return FIXTURES.find((f) => f.fixtureId === String(id)) ?? null;
}
