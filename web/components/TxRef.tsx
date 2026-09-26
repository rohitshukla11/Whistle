"use client";

import { EXPLORER_LIVE, txUrl } from "../lib/explorer";
import { short } from "../lib/format";

/** A transaction hash: an explorer link on a live network, the bare hash on a fork. */
export function TxRef({ hash }: { hash: string }) {
  if (!EXPLORER_LIVE) return <code className="tnum break-all text-[11px] text-dim">{hash}</code>;
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="tnum break-all text-[11px] underline underline-offset-2"
    >
      {short(hash)}
    </a>
  );
}
