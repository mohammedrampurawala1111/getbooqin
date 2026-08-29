import "dotenv/config";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@react-router/dev/vite" {
  interface FutureConfig {
    v3_singleFetch: true;
  }
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 3100),
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
});
