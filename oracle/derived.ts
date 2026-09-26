/**
 * Keys for a fixture, from the owner-derived key file — never from `.env`.
 *
 * The single-owner deployment has eight fixtures, each with three agents of its
 * own, plus one service key for the oracle and the keeper. `.secrets/derived.json`
 * (written by `scripts/derive-keys.ts`) holds all of them, and the terminal
 * drivers read from it by fixture id, so switching presentations is a flag on
 * the command line, not an edit to `.env`.
 *
 * Why not `.env`: it still carries the PREVIOUS deployment's `ORACLE_PRIVATE_KEY`
 * and `AGENT_PRIVATE_KEYS`. A fallback that silently picked those up would post
 * every event from a key that no longer owns `oracle.whistle.eth`, and every one
 * would revert — on stage, as the backup plan.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Hex } from "viem";

interface Derived {
  owner: string;
  signers: Record<string, { address: string; key: Hex }>;
  fixtures?: Record<string, DerivedAgent[]>;
}

/** One derived agent. `assigned` (an ISO time) marks a managed-pool key handed out by `/api/agents/assign`. */
export interface DerivedAgent {
  n: number;
  address: string;
  key: Hex;
  assigned?: string;
}

/** The seed pre-creates agents 1..3; 4 and up are the managed pool. */
export const PREMADE_AGENTS = 3;

/** Agents a driver should run: the pre-created three, plus any pool key already handed out. */
export const isActiveAgent = (a: DerivedAgent): boolean => a.n <= PREMADE_AGENTS || Boolean(a.assigned);

export const DERIVED_FILE = resolve(process.env.WHISTLE_DERIVED_FILE ?? ".secrets/derived.json");

function load(): Derived | null {
  if (!existsSync(DERIVED_FILE)) return null;
  return JSON.parse(readFileSync(DERIVED_FILE, "utf8")) as Derived;
}

/** The one service key (oracle + keeper), or null if there is no derived file. */
export function derivedServiceKey(): Hex | null {
  return load()?.signers.service?.key ?? null;
}

/** The fixture's active agent keys (see `isActiveAgent`), or [] if the file does not list it. */
export function derivedAgentKeys(fixtureId: string | bigint): Hex[] {
  return (load()?.fixtures?.[String(fixtureId)] ?? []).filter(isActiveAgent).map((a) => a.key);
}
