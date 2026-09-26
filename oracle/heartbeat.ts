/**
 * A line every ten seconds saying the process is alive and what it is doing.
 *
 * During a demo nobody reads a log — they glance at it. The question being
 * answered is not "what happened" but "is this still working", and silence
 * cannot answer that: a keeper that has crashed and a keeper with nothing to do
 * look identical until someone notices the board has stopped.
 *
 * So the line prints on a fixed cadence whether or not anything happened, and
 * carries a counter that must move. One line, one row, no wrapping.
 */

export interface Heartbeat {
  /** Record something worth counting. */
  bump(field: string, by?: number): void;
  /** Replace a displayed value, e.g. the match clock. */
  set(field: string, value: string | number): void;
  stop(): void;
}

const EVERY_MS = Number(process.env.WHISTLE_HEARTBEAT_MS ?? 10_000);

export function heartbeat(name: string, fields: string[] = []): Heartbeat {
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  for (const f of fields) counts.set(f, 0);
  const started = Date.now();

  const timer = setInterval(() => {
    const up = Math.round((Date.now() - started) / 1000);
    const mins = `${Math.floor(up / 60)}m${String(up % 60).padStart(2, "0")}s`;
    const parts = [
      ...[...values].map(([k, v]) => `${k} ${v}`),
      ...[...counts].map(([k, v]) => `${k} ${v}`),
    ];
    console.log(`  · ${name} up ${mins}  ${parts.join("  ")}`);
  }, EVERY_MS);

  // Never hold the process open on the heartbeat's account.
  timer.unref();

  return {
    bump(field, by = 1) {
      counts.set(field, (counts.get(field) ?? 0) + by);
    },
    set(field, value) {
      values.set(field, String(value));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
