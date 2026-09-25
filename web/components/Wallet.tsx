"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

import { short } from "../lib/format";

export function Wallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        className="tnum rounded-[9px] border border-line px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-text"
        title={address}
      >
        {short(address)}
      </button>
    );
  }

  const injected = connectors[0];
  return (
    <button
      type="button"
      disabled={!injected || isPending}
      onClick={() => injected && connect({ connector: injected })}
      className="rounded-[9px] bg-cta px-3 py-1.5 font-display text-[11px] font-extrabold uppercase tracking-[0.1em]
                 text-ground transition-[filter] hover:brightness-110 disabled:bg-none disabled:bg-surface disabled:text-dim"
    >
      {isPending ? "Connecting…" : "Connect"}
    </button>
  );
}
