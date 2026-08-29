import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Required by @clerk/react-router's clerkMiddleware()/rootAuthLoader() —
  // see app/root.tsx. Scoped to the root route only; no other loader needs
  // to touch middleware context.
  future: { v8_middleware: true },
} satisfies Config;
