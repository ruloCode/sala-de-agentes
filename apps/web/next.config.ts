import type { NextConfig } from "next";
import { resolve } from "node:path";

// apps/web corre en su propio directorio pero el `.env` vive en la RAÍZ del
// monorepo, así que lo cargamos aquí para que NEXT_PUBLIC_* llegue al cliente.
// Sin dependencias: process.loadEnvFile existe en Node 20.12+/22.
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(resolve(process.cwd(), "../../.env"));
} catch {
  /* sin .env raíz o Node antiguo: se usan los defaults del código */
}

const nextConfig: NextConfig = {
  // `next dev` y `next start` comparten .next/ y el dev lo SOBRESCRIBE: si un
  // día esto corre en producción con `next start`, levantar un dev para probar
  // dejaría al proceso sirviendo un árbol a medias, sin un solo error en los
  // logs. Por eso el dev escribe aparte.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",

  // @sala/shared se consume como TypeScript crudo (main: src/index.ts) con
  // imports ESM "./sala.js": hay que transpilarlo y mapear .js → .ts para que
  // webpack resuelva igual que tsx y tsc.
  transpilePackages: ["@sala/shared"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
