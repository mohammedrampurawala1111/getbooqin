import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@react-router/dev/vite" {
  interface FutureConfig {
    v3_singleFetch: true;
  }
}

// The CLI injects the tunnel URL as HOST, not SHOPIFY_APP_URL. Normalize it
// early so both this file and app/shopify.server.ts see the same value.
// https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 };
} else {
  hmrConfig = { protocol: "wss", host, port: Number(process.env.FRONTEND_PORT) || 8002, clientPort: 443 };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react", "@shopify/polaris"],
  },
});
