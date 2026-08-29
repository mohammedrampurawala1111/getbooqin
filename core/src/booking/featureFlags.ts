/**
 * Ported from shopify-openslot/app/lib/featureFlags.server.ts. Kept as
 * simple env-gated booleans rather than per-shop settings since they gate
 * whole feature surfaces, not merchant preferences.
 */
export const PAYMENTS_ENABLED = process.env.ENABLE_PAYMENTS === "true";
export const CHAT_ENABLED = process.env.ENABLE_CHAT === "true";
