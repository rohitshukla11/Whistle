/**
 * The one line the operator signs to run the simulation, built identically on
 * both sides so the server can recover the signer from the signature alone.
 *
 * It names the fixture and the minute it was signed, so a signature is good for
 * one match and for {@link SIM_SESSION_HOURS}; nothing is stored server-side.
 * Client-safe: no keys, no node modules.
 */

export const SIM_SESSION_HOURS = 6;

export const simSessionMessage = (fixtureId: string, unixMinute: number): string =>
  `Whistle sim · ${fixtureId} · ${unixMinute}`;

export const SIM_AUTH_HEADER = "x-whistle-operator";

/** `<fixtureId>:<unixMinute>:<signature>` — what the client sends with every sim call. */
export interface SimSession {
  fixtureId: string;
  minute: number;
  signature: `0x${string}`;
  address: `0x${string}`;
}

export const encodeSession = (s: SimSession): string => `${s.fixtureId}:${s.minute}:${s.signature}`;
