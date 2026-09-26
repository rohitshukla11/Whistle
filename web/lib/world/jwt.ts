/**
 * The two JWTs the World ID flow handles, with node:crypto only.
 *
 *   clientAssertion  — private_key_jwt (RFC 7523): RS256, iss = sub = client id,
 *                      aud = the token endpoint, fresh jti, exp <= 1 hour.
 *   validateIdToken  — the IdP's RS256 ID token: signature against its JWKS,
 *                      exact iss and aud, exp, nonce, and auth_time no older
 *                      than the attempt (the step-up guide: use auth_time for
 *                      freshness, never iat).
 *
 * Every failure is a WorldError with a short machine reason; the callback turns
 * it into "no chain call, redirect back with the reason".
 */

import { randomUUID, sign, verify, type KeyObject } from "node:crypto";

export class WorldError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message ?? reason);
  }
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function clientAssertion(opts: { clientId: string; aud: string; key: KeyObject; kid: string; nowSec?: number }): string {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "RS256", typ: "JWT", kid: opts.kid });
  const body = b64url({ iss: opts.clientId, sub: opts.clientId, aud: opts.aud, iat: now, exp: now + 120, jti: randomUUID() });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
}

export interface Expectation {
  issuer: string;
  clientId: string;
  nonce: string;
  /** When this attempt started, ms. auth_time must not be earlier (minus skew). */
  startedAtMs: number;
  nowMs?: number;
  /** Clock tolerance, seconds. Small and explicit, per the step-up guide. */
  skewSec?: number;
}

export async function validateIdToken(
  token: string,
  expect: Expectation,
  keyFor: (kid: string | undefined) => Promise<KeyObject | undefined>,
): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new WorldError("malformed_id_token");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw new WorldError("malformed_id_token");
  }
  if (header.alg !== "RS256") throw new WorldError("bad_alg", `ID token alg ${header.alg}, expected RS256`);
  const key = await keyFor(header.kid);
  if (!key) throw new WorldError("unknown_signing_key");
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw new WorldError("bad_signature");

  const now = Math.floor((expect.nowMs ?? Date.now()) / 1000);
  const skew = expect.skewSec ?? 5;
  if (claims.iss !== expect.issuer) throw new WorldError("wrong_iss");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new WorldError("wrong_aud");
  if (aud.length > 1 && claims.azp !== expect.clientId) throw new WorldError("wrong_aud");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new WorldError("expired_id_token");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new WorldError("future_id_token");
  if (claims.nonce !== expect.nonce) throw new WorldError("nonce_mismatch");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new WorldError("missing_sub");
  if (typeof claims.auth_time !== "number") throw new WorldError("missing_auth_time");
  if (claims.auth_time + skew < Math.floor(expect.startedAtMs / 1000)) throw new WorldError("stale_auth_time");
  if (claims.auth_time - skew > now) throw new WorldError("future_auth_time");
  return claims;
}
