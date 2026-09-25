"use client";

/**
 * "Your wallet is on the wrong chain."
 *
 * Without this the failure is silent and expensive-looking: every read comes
 * from the app's own Sepolia transport and looks fine, so the board fills in
 * normally — and then the first write pops a wallet dialog for a contract that
 * does not exist at that address on whatever chain the wallet is actually on.
 * The app knows the answer the whole time; it just never said it.
 *
 * Rendered by the app shell so it sits above every screen, and it renders
 * nothing at all until there is something wrong to say.
 */

import { useAccount, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";

export function NetworkNote() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === undefined || chainId === sepolia.id) return null;

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-warn/50
                 bg-warn/5 px-4 py-3 text-[13px] leading-relaxed text-text"
    >
      <span className="min-w-0 flex-1">
        Your wallet is on chain {chainId}. Whistle runs on Sepolia, so prices will read but
        nothing will sign.
      </span>
      <button
        type="button"
        disabled={isPending}
        onClick={() => switchChain({ chainId: sepolia.id })}
        className="shrink-0 rounded-[8px] border border-warn/60 px-3 py-1.5 font-display text-[11px]
                   font-extrabold uppercase tracking-[0.08em] text-warn transition-colors
                   hover:bg-warn/10 disabled:opacity-50"
      >
        {isPending ? "Switching…" : "Switch to Sepolia"}
      </button>
    </div>
  );
}
