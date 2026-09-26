/**
 * World ID (sandbox IdP) configuration — server only.
 *
 * Everything comes from the environment (.secrets/sim.env on the local server):
 * WORLD_ISSUER, WORLD_CLIENT_ID, WORLD_PRIVATE_KEY or WORLD_PRIVATE_KEY_FILE (the
 * private_key_jwt signing key, RS256), WORLD_REDIRECT_URI (the exact registered callback) and
 * NEXT_PUBLIC_APP_URL. Endpoints and signing keys are read from the IdP's own
 * discovery document, never hard-coded.
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export const WORLD_ON = process.env.NEXT_PUBLIC_WORLD_IDP === "on";

export interface WorldConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  appUrl: string;
}

export function worldConfig(): WorldConfig {
  const issuer = process.env.WORLD_ISSUER ?? "https://sandbox.auth.world.org";
  const clientId = process.env.WORLD_CLIENT_ID;
  const redirectUri = process.env.WORLD_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new Error("WORLD_CLIENT_ID and WORLD_REDIRECT_URI must be set on the server.");
  return { issuer, clientId, redirectUri, appUrl: process.env.NEXT_PUBLIC_APP_URL ?? new URL(redirectUri).origin };
}

let signingKey: { key: KeyObject; kid: string } | null = null;

/**
 * The private_key_jwt key, and the kid it was registered under (its RFC 7638
 * thumbprint). WORLD_PRIVATE_KEY holds the PEM itself (a host with no files,
 * like Vercel; literal "\n" sequences are accepted), WORLD_PRIVATE_KEY_FILE a
 * path to it (the local server).
 */
export function clientSigningKey(): { key: KeyObject; kid: string } {
  if (signingKey) return signingKey;
  const inline = process.env.WORLD_PRIVATE_KEY;
  const file = process.env.WORLD_PRIVATE_KEY_FILE;
  if (!inline && !file) throw new Error("Set WORLD_PRIVATE_KEY (the PEM) or WORLD_PRIVATE_KEY_FILE on the server.");
  const key = createPrivateKey(inline ? inline.replace(/\\n/g, "\n") : readFileSync(file!));
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { e: string; kty: string; n: string };
  const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
  signingKey = { key, kid };
  return signingKey;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { at: number; doc: Discovery } | null = null;

export async function discovery(): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 3_600_000) return discoveryCache.doc;
  const { issuer } = worldConfig();
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`World ID discovery failed: HTTP ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== issuer) throw new Error(`discovery issuer ${doc.issuer} does not match ${issuer}`);
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

let jwksCache: { at: number; keys: Map<string, KeyObject> } | null = null;

/**
 * The IdP's signing key for `kid`. Cached; an unknown kid refreshes the set at
 * most once a minute, which handles key rotation without letting a forged kid
 * turn every callback into a JWKS fetch.
 */
export async function idpKey(kid: string | undefined): Promise<KeyObject | undefined> {
  const fresh = jwksCache && Date.now() - jwksCache.at < 600_000;
  if (fresh && kid && jwksCache!.keys.has(kid)) return jwksCache!.keys.get(kid);
  if (!jwksCache || Date.now() - jwksCache.at > 60_000) {
    const { jwks_uri } = await discovery();
    const res = await fetch(jwks_uri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`World ID JWKS fetch failed: HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys: (Record<string, unknown> & { kid?: string; kty?: string; use?: string })[] };
    const map = new Map<string, KeyObject>();
    for (const k of keys) {
      if (k.kty !== "RSA" || (k.use && k.use !== "sig") || !k.kid) continue;
      map.set(k.kid, createPublicKey({ key: k as never, format: "jwk" }));
    }
    jwksCache = { at: Date.now(), keys: map };
  }
  if (!kid) return jwksCache.keys.size === 1 ? [...jwksCache.keys.values()][0] : undefined;
  return jwksCache.keys.get(kid);
}
