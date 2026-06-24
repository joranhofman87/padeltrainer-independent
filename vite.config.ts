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

          // Pre-scale audit P2: peel two stable, broadly-shared libs that were
          // already loaded EAGERLY inside the 578 kB main entry chunk into their
          // own chunks, so they cache independently of app code (they change far
          // less often than our src/) without adding anything to the first-paint
          // critical path. zod = shared form/validation schema lib;
          // tailwind-merge+clsx+cva back the cn() styling helper used everywhere.
          // NOTE: deliberately NOT bucketing the radix/@floating-ui primitives —
          // many are used only by lazy routes, so forcing them into one eager
          // vendor chunk (App.tsx's Toaster/Tooltip pull it in) measurably grew
          // first-paint bytes. Rollup's default per-route splitting is better here.
          'vendor-zod': ['zod'],
          'vendor-styling': ['tailwind-merge', 'clsx', 'class-variance-authority'],
          // Only the toast/tooltip primitives App.tsx mounts globally (Toaster /
          // Sonner / TooltipProvider) — these are already eager on every page, so
          // peeling them is first-paint-neutral but caches separately. The other
          // radix primitives stay route-split (most are lazy-only).
          'vendor-ui': [
            '@radix-ui/react-toast', '@radix-ui/react-tooltip', 'sonner',
            '@floating-ui/core', '@floating-ui/dom',
            '@floating-ui/react-dom', '@floating-ui/utils',
          ],
        },
      },
    },
  },
});
