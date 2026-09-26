/**
 * Serve the built app over HTTPS on https://localhost:3100.
 *
 *   node scripts/serve-https.mjs          # after `pnpm build`
 *
 * The World ID sandbox accepts only HTTPS callbacks, and the registered one is
 * https://localhost:3100/api/world/callback. So `next start` runs on
 * 127.0.0.1:3101 (loopback only) and this process terminates TLS on :3100 with a
 * mkcert certificate and forwards every request to it, marking it
 * `x-forwarded-proto: https` so the app builds https URLs.
 *
 * Certificate: TLS_CERT / TLS_KEY, default ../.secrets/tls/localhost{,-key}.pem
 * (see docs/run-local.md: `mkcert -install` once, then issue the cert).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const CERT = process.env.TLS_CERT ?? resolve(web, "../.secrets/tls/localhost.pem");
const KEY = process.env.TLS_KEY ?? resolve(web, "../.secrets/tls/localhost-key.pem");
const PUBLIC_PORT = Number(process.env.PORT ?? 3100);
const APP_PORT = Number(process.env.APP_PORT ?? 3101);

const next = spawn(resolve(web, "node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(APP_PORT)], {
  cwd: web, stdio: "inherit", env: process.env,
});
next.on("exit", (code) => {
  console.error(`[https] next exited (${code}); stopping`);
  process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { next.kill(sig); process.exit(0); });

const server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, (req, res) => {
  const upstream = request(
    {
      host: "127.0.0.1",
      port: APP_PORT,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        "x-forwarded-proto": "https",
        "x-forwarded-host": req.headers.host ?? `localhost:${PUBLIC_PORT}`,
        "x-forwarded-for": req.socket.remoteAddress ?? "",
      },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream unavailable: ${err.message}`);
  });
  req.pipe(upstream);
});

// '::' with dual-stack covers both localhost resolutions (::1 and 127.0.0.1).
server.listen({ port: PUBLIC_PORT, host: "::", ipv6Only: false }, () => {
  console.log(`[https] https://localhost:${PUBLIC_PORT} -> http://127.0.0.1:${APP_PORT}`);
});
