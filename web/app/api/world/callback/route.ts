/**
 * The World ID callback: https://localhost:3100/api/world/callback.
 *
 * Redeem the code with a fresh private_key_jwt assertion (unique jti, aud = the
 * token endpoint), validate the ID token (iss, aud, exp, nonce, state, and an
 * auth_time no older than the attempt), and only then run the pending action,
 * server-side. access_denied, expiry, a stale auth_time, a state mismatch or any
 * validation failure: no chain call; redirect back with the reason.
 */

import { NextResponse } from "next/server";

import { clientSigningKey, discovery, idpKey, worldConfig } from "../../../../lib/world/config";
import { completeCallback } from "../../../../lib/world/flow";
import { WorldError, clientAssertion } from "../../../../lib/world/jwt";
import { humanValue, runAction } from "../../../../lib/world/actions";
import { putResult, takePending } from "../../../../lib/world/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function exchange(code: string, verifier: string): Promise<{ id_token: string }> {
  const cfg = worldConfig();
  const { token_endpoint } = await discovery();
  const { key, kid } = clientSigningKey();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
      client_id: cfg.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion({ clientId: cfg.clientId, aud: token_endpoint, key, kid }),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !json.id_token) throw new WorldError(json.error ?? `token_http_${res.status}`);
  return { id_token: json.id_token };
}

export async function GET(req: Request) {
  const cfg = worldConfig();
  const u = new URL(req.url);
  const outcome = await completeCallback(
    { state: u.searchParams.get("state"), code: u.searchParams.get("code"), error: u.searchParams.get("error") },
    { take: takePending, exchange, keyFor: idpKey, issuer: cfg.issuer, clientId: cfg.clientId, run: runAction },
  );

  const p = outcome.pending;
  if (p) {
    await putResult({
      id: p.id, action: p.action, status: outcome.status,
      ...(outcome.status === "approved" ? { detail: outcome.detail } : { reason: outcome.reason }),
      at: Date.now(),
    });
  }
  const h = "human" in outcome && outcome.human ? ` human=${humanValue(outcome.human).slice(0, 12)}…` : "";
  console.log(`[world] callback ${p?.action ?? "?"} -> ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}${h}`);
  const done = new URL("/world/done", cfg.appUrl);
  done.searchParams.set("status", outcome.status);
  if (p) done.searchParams.set("id", p.id);
  if ("reason" in outcome) done.searchParams.set("reason", outcome.reason);
  return NextResponse.redirect(done, 303);
}
