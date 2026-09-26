/**
 * The callback, as a pure function of its inputs — so it can be unit-tested.
 *
 * Order matters and is the whole point: the pending action runs only after the
 * state is found (once), the code has been redeemed, and the ID token has passed
 * every check. Any other outcome returns before `run` is called — no chain call.
 */

import type { KeyObject } from "node:crypto";

import { WorldError, validateIdToken, type IdTokenClaims } from "./jwt";
import type { Pending } from "./store";

export interface Human {
  iss: string;
  sub: string;
  authTime: number;
  acr?: string;
}

export interface CallbackDeps {
  take(state: string): Promise<Pending | { expired: true; id: string } | undefined> | Pending | { expired: true; id: string } | undefined;
  /** Redeem the code with a fresh client assertion; throws WorldError on an OAuth error. */
  exchange(code: string, verifier: string): Promise<{ id_token: string }>;
  keyFor(kid: string | undefined): Promise<KeyObject | undefined>;
  issuer: string;
  clientId: string;
  run(p: Pending, human: Human): Promise<Record<string, unknown>>;
  now?: () => number;
}

export type CallbackOutcome =
  | { status: "approved"; pending: Pending; human: Human; detail: Record<string, unknown> }
  | { status: "denied"; pending?: Pending; reason: string }
  | { status: "failed"; pending?: Pending; reason: string; human?: Human };

export async function completeCallback(
  q: { state?: string | null; code?: string | null; error?: string | null },
  deps: CallbackDeps,
): Promise<CallbackOutcome> {
  if (!q.state) return { status: "failed", reason: "missing_state" };
  const taken = await deps.take(q.state);
  // Unknown state: never issued, already used (a replayed callback), or forged.
  if (!taken) return { status: "failed", reason: "state_mismatch" };
  if ("expired" in taken) return { status: "failed", reason: "expired" };
  const pending = taken;

  if (q.error) {
    return q.error === "access_denied"
      ? { status: "denied", pending, reason: "access_denied" }
      : { status: "failed", pending, reason: q.error };
  }
  if (!q.code) return { status: "failed", pending, reason: "missing_code" };

  let claims: IdTokenClaims;
  try {
    const tokens = await deps.exchange(q.code, pending.verifier);
    claims = await validateIdToken(
      tokens.id_token,
      { issuer: deps.issuer, clientId: deps.clientId, nonce: pending.nonce, startedAtMs: pending.startedAt, nowMs: deps.now?.() },
      deps.keyFor,
    );
  } catch (err) {
    return { status: "failed", pending, reason: err instanceof WorldError ? err.reason : "token_exchange_failed" };
  }

  const human: Human = { iss: claims.iss, sub: claims.sub, authTime: claims.auth_time, ...(claims.acr ? { acr: claims.acr } : {}) };
  try {
    const detail = await deps.run(pending, human);
    return { status: "approved", pending, human, detail };
  } catch (err) {
    // A valid proof, but the action itself refused (e.g. a different World ID).
    return { status: "failed", pending, human, reason: `action_failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}
