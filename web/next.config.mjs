/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `outputFileTracingRoot`: nothing here reaches outside this directory.
  // `scripts/vendor.mjs` copies the ABIs and deployments in before the build, so
  // `web/` is self-contained and can be uploaded to a host on its own.

  webpack: (config) => {
    // `wagmi/connectors` is a barrel: importing `injected` from it also drags in
    // the Coinbase and Base account SDKs, which declare optional Solana/x402 deps
    // that are not installed. This app only ever uses the injected connector, so
    // those SDKs are stubbed out wholesale rather than installed — the code paths
    // that reach them are unreachable here.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@coinbase/cdp-sdk": false,
      "@base-org/account": false,
    };
    return config;
  },
};

export default nextConfig;
