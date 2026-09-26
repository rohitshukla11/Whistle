/**
 * Server-side state for World ID verification — server only.
 *
 *   pending  — one entry per attempt: the action, its payload, the PKCE
 *              verifier and nonce. TTL 5 minutes, taken exactly once.
 *   results  — what became of an attempt, for the page polling it.
 *
 * Kept on `globalThis` so every route bundle in the one `next start` process
 * shares it. Nothing here needs to survive a restart: an attempt in flight
 * when the server stops simply never completes, and nothing has changed.
 */

import { randomBytes } from "node:crypto";

export const PENDING_TTL_MS = 5 * 60_000;
const RESULT_TTL_MS = 30 * 60_000;

export type WorldAction = "create-agent" | "raise-cap";

export interface Pending {
  id: string;
  action: WorldAction;
  payload: Record<string, unknown>;
  verifier: string;
  nonce: string;
  startedAt: number;
  expiresAt: number;
  requestedBy: string;
}

export interface Result {
  id: string;
  action: WorldAction;
  status: "pending" | "approved" | "denied" | "failed";
  reason?: string;
  detail?: Record<string, unknown>;
  authorizeUrl?: string;
  at: number;
}

interface State {
  pending: Map<string, Pending>;
  results: Map<string, Result>;
}

const g = globalThis as unknown as { __whistleWorld?: State };
function state(): State {
  g.__whistleWorld ??= { pending: new Map(), results: new Map() };
  return g.__whistleWorld;
}

const token = (n = 32) => randomBytes(n).toString("base64url");

export function createPending(action: WorldAction, payload: Record<string, unknown>, requestedBy: string, now = Date.now()): Pending {
  const s = state();
  for (const [id, p] of s.pending) if (p.expiresAt < now) s.pending.delete(id);
  const p: Pending = {
    id: token(24), action, payload, verifier: token(48), nonce: token(24),
    startedAt: now, expiresAt: now + PENDING_TTL_MS, requestedBy,
  };
  s.pending.set(p.id, p);
  s.results.set(p.id, { id: p.id, action, status: "pending", at: now });
  return p;
}

/** Take a pending attempt exactly once. Replaying a callback finds nothing. */
export function takePending(id: string, now = Date.now()): Pending | { expired: true; id: string } | undefined {
  const s = state();
  const p = s.pending.get(id);
  if (!p) return undefined;
  s.pending.delete(id);
  if (p.expiresAt < now) return { expired: true, id };
  return p;
}

export function putResult(r: Result): void {
  const s = state();
  s.results.set(r.id, r);
  for (const [id, x] of s.results) if (Date.now() - x.at > RESULT_TTL_MS) s.results.delete(id);
}

export function getResult(id: string): Result | undefined {
  const r = state().results.get(id);
  if (r?.status === "pending") {
    const p = state().pending.get(id);
    if (!p) return r;
    if (p.expiresAt < Date.now()) return { ...r, status: "failed", reason: "expired" };
  }
  return r;
}
