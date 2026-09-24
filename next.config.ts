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
  /*
   * `typescript.ignoreBuildErrors` a été **retiré**.
   *
   * Le projet Gaz l'activait, et le README §3.4 proposait de le garder au lot 1
   * « pour la vitesse, puis de le retirer au lot 2 ». C'est fait : `tsc --noEmit`
   * passe aujourd'hui **sans aucune erreur** sur l'ensemble du projet, donc le
   * build peut redevenir une vraie barrière au lieu de laisser passer du code
   * mal typé jusqu'à la production.
   *
   * `npm run build` échoue désormais si un type est faux — c'est voulu.
   */
};

export default nextConfig;
