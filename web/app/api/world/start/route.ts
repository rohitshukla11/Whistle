/**
 * Start a World ID verification for a protected action.
 *
 * POST {action, payload} from the operator's own session (the same operator
 * signature the sim routes require). The server stores the pending action for
 * five minutes — the browser never gets to perform it — and returns the IdP
 * authorization URL: code + PKCE S256, scope=openid, a nonce, state = the
 * pending id, and max_age=0 + prompt=login so a new World proof is required.
 */

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { resolveFixture } from "../../../../lib/sim/deployment";
import { checkOperator } from "../../../../lib/sim/server";
import { WORLD_ON, discovery, worldConfig } from "../../../../lib/world/config";
import { planRaise } from "../../../../lib/world/actions";
import { createPending, putResult, type WorldAction } from "../../../../lib/world/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: WorldAction[] = ["create-agent", "raise-cap"];

export async function POST(req: Request) {
  if (!WORLD_ON) return NextResponse.json({ error: "World ID verification is off (NEXT_PUBLIC_WORLD_IDP)." }, { status: 404 });
  let body: { action?: string; payload?: Record<string, unknown> } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* validated below */
  }
  const action = body.action as WorldAction;
  const payload = body.payload ?? {};
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const D = resolveFixture(payload.fixtureId);
  if (!D) return NextResponse.json({ error: "Unknown fixture." }, { status: 404 });
  const auth = await checkOperator(req, D);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Only an increase is worth asking a human for; say so before sending them off.
  if (action === "raise-cap") {
    try {
      await planRaise(payload, { resolveResume: false });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message.split("\n")[0] }, { status: 400 });
    }
  }

  const cfg = worldConfig();
  const { authorization_endpoint } = await discovery();
  let p;
  try {
    p = await createPending(action, payload, auth.signer);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid",
    state: p.id,
    nonce: p.nonce,
    code_challenge: createHash("sha256").update(p.verifier).digest("base64url"),
    code_challenge_method: "S256",
    max_age: "0",
    prompt: "login",
  }).toString();
  await putResult({ id: p.id, action, status: "pending", authorizeUrl: url.toString(), expiresAt: p.expiresAt, at: p.startedAt });
  return NextResponse.json({ id: p.id, authorizeUrl: url.toString(), expiresAt: p.expiresAt });
}
