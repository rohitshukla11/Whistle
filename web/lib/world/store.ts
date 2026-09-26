/**
 * Server-side state for World ID verification — server only.
 *
 *   pending  — one entry per attempt: the action, its payload, the PKCE
 *              verifier and nonce. TTL 5 minutes, taken exactly once.
 *   results  — what became of an attempt, for the page polling it.
 *
 * Two backends, same semantics:
 *
 *   shared   Redis over REST (Vercel KV / Upstash: KV_REST_API_URL and
 *            KV_REST_API_TOKEN). Required on a serverless host, where the
 *            start, the callback and each status poll can land on a different
 *            instance. "Taken exactly once" is GETDEL, which is atomic.
 *   memory   `globalThis`, shared by every route in one `next start` process.
 *            Fine locally; refused on Vercel, where it would lose attempts at
 *            random rather than fail visibly.
 *
 * Nothing here needs to outlive its TTL: an attempt that never completes
 * changes nothing.
 */

import { randomBytes } from "node:crypto";

export const PENDING_TTL_MS = 5 * 60_000;
const RESULT_TTL_MS = 30 * 60_000;
/** Pending entries are kept a little past their TTL so a late callback reads "expired", not "unknown". */
const PENDING_KEEP_MS = PENDING_TTL_MS + 10 * 60_000;

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
  /** When a still-pending attempt runs out; after that it reads as failed/expired. */
  expiresAt?: number;
  at: number;
}

// ------------------------------------------------------------------ backends

interface Backend {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Read and delete in one step. */
  take(key: string): Promise<string | null>;
}

function kvConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

function restBackend({ url, token }: { url: string; token: string }): Backend {
  const cmd = async (args: (string | number)[]): Promise<unknown> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || json.error) throw new Error(`World ID store: ${json.error ?? `HTTP ${res.status}`}`);
    return json.result;
  };
  return {
    async set(key, value, ttlMs) {
      await cmd(["SET", key, value, "PX", ttlMs]);
    },
    async get(key) {
      return ((await cmd(["GET", key])) as string | null) ?? null;
    },
    async take(key) {
      return ((await cmd(["GETDEL", key])) as string | null) ?? null;
    },
  };
}

function memoryBackend(): Backend {
  const g = globalThis as unknown as { __whistleWorldMem?: Map<string, { value: string; until: number }> };
  const m = (g.__whistleWorldMem ??= new Map());
  const live = (key: string) => {
    const e = m.get(key);
    if (e && e.until < Date.now()) m.delete(key);
    return m.get(key) ?? null;
  };
  return {
    async set(key, value, ttlMs) {
      for (const [k, e] of m) if (e.until < Date.now()) m.delete(k);
      m.set(key, { value, until: Date.now() + ttlMs });
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async take(key) {
      const e = live(key);
      m.delete(key);
      return e?.value ?? null;
    },
  };
}

function backend(): Backend {
  const kv = kvConfig();
  if (kv) return restBackend(kv);
  if (process.env.VERCEL) {
    throw new Error(
      "World ID on Vercel needs a shared store: set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV or Upstash). " +
        "Without one, the callback can land on an instance that never saw the attempt.",
    );
  }
  return memoryBackend();
}

// ------------------------------------------------------------------- the API

const token = (n = 32) => randomBytes(n).toString("base64url");
const PENDING = (id: string) => `whistle:world:pending:${id}`;
const RESULT = (id: string) => `whistle:world:result:${id}`;

export async function createPending(
  action: WorldAction,
  payload: Record<string, unknown>,
  requestedBy: string,
  now = Date.now(),
): Promise<Pending> {
  const p: Pending = {
    id: token(24), action, payload, verifier: token(48), nonce: token(24),
    startedAt: now, expiresAt: now + PENDING_TTL_MS, requestedBy,
  };
  await backend().set(PENDING(p.id), JSON.stringify(p), PENDING_KEEP_MS);
  return p;
}

/** Take a pending attempt exactly once. Replaying a callback finds nothing. */
export async function takePending(id: string, now = Date.now()): Promise<Pending | { expired: true; id: string } | undefined> {
  const raw = await backend().take(PENDING(id));
  if (!raw) return undefined;
  const p = JSON.parse(raw) as Pending;
  if (p.expiresAt < now) return { expired: true, id };
  return p;
}

export async function putResult(r: Result): Promise<void> {
  await backend().set(RESULT(r.id), JSON.stringify(r), RESULT_TTL_MS);
}

export async function getResult(id: string): Promise<Result | undefined> {
  const raw = await backend().get(RESULT(id));
  if (!raw) return undefined;
  const r = JSON.parse(raw) as Result;
  if (r.status === "pending" && r.expiresAt && r.expiresAt < Date.now()) return { ...r, status: "failed", reason: "expired" };
  return r;
}
