/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root: a stray lockfile above this directory makes Next
  // infer the wrong root, which breaks route serving under `next start`.
  outputFileTracingRoot: import.meta.dirname,
  // snarkjs pulls in wasm + uses node-ish globals; keep these libs out of server bundling
  // and serve circuit artifacts (.wasm/.zkey) from /public.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};
export default nextConfig;
