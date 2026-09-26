"use client";

/**
 * Where the World ID callback lands. The action has already run (or not) on the
 * server; this tab only says which. The tab that started it updates by itself.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

const REASONS: Record<string, string> = {
  access_denied: "You chose Deny sign-in on the World ID page. Nothing was changed.",
  expired: "The verification took longer than five minutes. Nothing was changed; start again.",
  state_mismatch: "This verification link was already used or was not started here. Nothing was changed.",
  stale_auth_time: "World ID returned an older sign-in instead of a fresh proof. Nothing was changed.",
};

export default function WorldDone() {
  const [q, setQ] = useState<{ status: string; reason: string }>({ status: "", reason: "" });
  useEffect(() => {
    const u = new URL(window.location.href);
    setQ({ status: u.searchParams.get("status") ?? "", reason: u.searchParams.get("reason") ?? "" });
  }, []);
  const ok = q.status === "approved";
  return (
    <main className="mx-auto max-w-[560px] py-16 text-center">
      <h1 className="font-display text-[26px] font-black">
        {ok ? "Verified with World ID" : q.status === "denied" ? "Verification denied" : q.status ? "Verification failed" : "…"}
      </h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted" role="status">
        {ok
          ? "The action has been carried out. You can close this tab — the Whistle tab that asked will update by itself."
          : (REASONS[q.reason] ?? (q.reason ? `Nothing was changed (${q.reason}).` : ""))}
      </p>
      <Link href="/fixtures" className="mt-6 inline-block text-[13px] text-up underline underline-offset-2">
        Back to fixtures
      </Link>
    </main>
  );
}
