import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";

// react-router's published `exports` map points every condition at its
// development build (dist/development) — there is no production path, so
// `resolve.conditions` can't reach dist/production and production bundles
// ship dev-only warning code (ENABLE_DEV_WARNINGS stays true).
// See https://github.com/remix-run/react-router/issues/14753.
// Rewrite the resolved file path to the production build instead; relative
// chunk imports inside the package then resolve within dist/production.
function reactRouterProductionBuild(): Plugin {
  let isProduction = false;
  return {
    name: "react-router-production-build",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      isProduction = config.isProduction;
    },
    async resolveId(source, importer, options) {
      if (!isProduction || !source.includes("react-router")) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      const productionId = resolved.id.replace(
        "/react-router/dist/development/",
        "/react-router/dist/production/",
      );
      if (productionId !== resolved.id && fs.existsSync(productionId)) {
        return { ...resolved, id: productionId };
      }
      return null;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), reactRouterProductionBuild()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          // react-dom/client is its own export entry; without it listed the
          // ReactDOM client internals land in the main entry chunk instead.
          'vendor-react': ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],

          'vendor-i18n': ['i18next', 'react-i18next'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
});
