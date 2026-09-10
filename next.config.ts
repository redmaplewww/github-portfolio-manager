import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  distDir: process.env.NEXUS_NEXT_DIST_DIR ?? ".next",
  // Pi is a Node-only SDK with dynamic provider/resource loading. Keep it out of
  // the Server Components bundle and let the dedicated Runner own its runtime.
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-client",
    "@earendil-works/pi-protocol",
    "@earendil-works/pi-tui",
  ],
  // The in-app browser reaches the dev server through 127.0.0.1 while Next
  // advertises localhost. Allow both loopback aliases for development assets.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
