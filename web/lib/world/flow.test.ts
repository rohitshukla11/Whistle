/**
 * Token-validation failures never reach the chain.
 *
 *   npx tsx --test lib/world/flow.test.ts
 *
 * A test IdP key signs ID tokens; `exchange` is a stub token endpoint that
 * burns each code on first use (like the real one); `run` stands in for the
 * chain call and counts how often it is reached. Every failure case must leave
 * that count at zero; the one good case must reach it exactly once.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";

import { completeCallback, type CallbackDeps } from "./flow";
import { WorldError } from "./jwt";
import type { Pending } from "./store";

const ISSUER = "https://sandbox.auth.world.org";
const CLIENT = "18520dd7-b7f4-4660-96ba-8e286e75c4e1";
const idp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostor = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "idp-key-1";

function idToken(claims: Record<string, unknown>, key: KeyObject = idp.privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

function harness(tokenFor: (p: Pending) => string, pendingOverrides: Partial<Pending> = {}) {
  const started = Date.now() - 20_000;
  const pending: Pending = {
    id: "state-1", action: "create-agent", payload: {}, verifier: "v".repeat(43), nonce: "nonce-1",
    startedAt: started, expiresAt: started + 300_000, requestedBy: "0x6834", ...pendingOverrides,
  };
  const store = new Map([[pending.id, pending]]);
  const used = new Set<string>();
  let chainCalls = 0;
  const deps: CallbackDeps = {
    take: (s) => {
      const p = store.get(s);
      store.delete(s);
      return p;
    },
    exchange: async (code) => {
      if (used.has(code)) throw new WorldError("invalid_grant");
      used.add(code);
      return { id_token: tokenFor(pending) };
    },
    keyFor: async (kid) => (kid === KID ? idp.publicKey : undefined),
    issuer: ISSUER,
    clientId: CLIENT,
    run: async () => {
      chainCalls++;
      return { ok: true };
    },
  };
  return { deps, pending, store, chainCalls: () => chainCalls };
}

const good = (p: Pending, over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, sub: "pairwise-sub-1", aud: CLIENT, exp: now + 300, iat: now, auth_time: now - 5, nonce: p.nonce, acr: "https://world.org/oidc/acr/orb-v3", ...over };
};

test("a valid token runs the action exactly once", async () => {
  const h = harness((p) => idToken(good(p)));
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.equal(out.status, "approved");
  assert.equal(h.chainCalls(), 1);
});

test("bad signature: no chain call", async () => {
  const h = harness((p) => idToken(good(p), impostor.privateKey));
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "bad_signature"]);
  assert.equal(h.chainCalls(), 0);
});

test("wrong aud: no chain call", async () => {
  const h = harness((p) => idToken(good(p, { aud: "some-other-client" })));
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "wrong_aud"]);
  assert.equal(h.chainCalls(), 0);
});

test("stale auth_time (an old session, not a fresh proof): no chain call", async () => {
  const h = harness((p) => idToken(good(p, { auth_time: Math.floor(p.startedAt / 1000) - 600 })));
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "stale_auth_time"]);
  assert.equal(h.chainCalls(), 0);
});

test("state mismatch: no chain call, and the code is never redeemed", async () => {
  const h = harness((p) => idToken(good(p)));
  let redeemed = false;
  const exchange = h.deps.exchange;
  h.deps.exchange = async (c, v) => {
    redeemed = true;
    return exchange(c, v);
  };
  const out = await completeCallback({ state: "not-the-state", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "state_mismatch"]);
  assert.equal(redeemed, false);
  assert.equal(h.chainCalls(), 0);
});

test("replayed code: the second redemption fails and does not call the chain again", async () => {
  const h = harness((p) => idToken(good(p)));
  const first = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.equal(first.status, "approved");
  // A second attempt (fresh state) carrying the same, already-redeemed code.
  const second: Pending = { ...h.pending, id: "state-2" };
  h.store.set("state-2", second);
  const out = await completeCallback({ state: "state-2", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "invalid_grant"]);
  assert.equal(h.chainCalls(), 1, "only the first, valid redemption reached the chain");
});

test("replayed callback URL (same state twice): no second chain call", async () => {
  const h = harness((p) => idToken(good(p)));
  await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "state_mismatch"]);
  assert.equal(h.chainCalls(), 1);
});

test("access_denied from the IdP: denied, no chain call", async () => {
  const h = harness((p) => idToken(good(p)));
  const out = await completeCallback({ state: "state-1", error: "access_denied" }, h.deps);
  assert.equal(out.status, "denied");
  assert.equal(h.chainCalls(), 0);
});

test("expired attempt: no chain call", async () => {
  const h = harness((p) => idToken(good(p)));
  h.deps.take = () => ({ expired: true, id: "state-1" });
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "expired"]);
  assert.equal(h.chainCalls(), 0);
});

test("nonce mismatch: no chain call", async () => {
  const h = harness((p) => idToken(good(p, { nonce: "someone-elses-nonce" })));
  const out = await completeCallback({ state: "state-1", code: "code-1" }, h.deps);
  assert.deepEqual([out.status, "reason" in out && out.reason], ["failed", "nonce_mismatch"]);
  assert.equal(h.chainCalls(), 0);
});
