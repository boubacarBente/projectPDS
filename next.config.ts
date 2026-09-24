import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  serverExternalPackages: ["@libsql/client", "libsql", "sharp"],
  outputFileTracingExcludes: {
    "/*": [
      "release/**/*",
      ".electron-app/**/*",
      ".next/standalone/**/*",
      "tmp-electron/**/*",
      "tmp-electron*.log",
      "db-error.log",
    ],
  },
  typescript: {
    // ⚠️ Dette technique assumée au lot 1 pour la vitesse (README §3.4).
    // À retirer après stabilisation : `npm run typecheck` doit alors passer.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
