"use client";

/**
 * Links out to Etherscan — but only when they would land somewhere.
 *
 * A local anvil fork reports chain id 11155111 and mines transactions that
 * Sepolia has never heard of, so a link to Etherscan from a fork is a 404 dressed
 * up as a citation. Against a fork the hash is shown as text instead.
 */

import { RPC_URL } from "./config";

const BASE = "https://sepolia.etherscan.io";

export const EXPLORER_LIVE = !/127\.0\.0\.1|localhost|\[::1\]/.test(RPC_URL);

export function txUrl(hash: string): string {
  return `${BASE}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${BASE}/address/${address}`;
}
