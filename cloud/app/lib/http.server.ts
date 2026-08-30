import { GetBooqinError } from "getbooqin-core";

// Ported from shopify-openslot/app/lib/http.server.ts's throttle/clientIp —
// small enough, and workspace-local enough, that duplicating it here beats a
// cross-package refactor (same call this repo already makes for e.g.
// onboarding.tsx's SHOP_DOMAIN_RE). Unlike that app's App Proxy routes,
// which get Shopify's HMAC-signed proxy as a first line of defense, nothing
// backstops book.$connectionId.tsx — this throttle *is* the anti-abuse
// layer, not a supplement to one.
//
// Simple per-process, per-key rate limiter. Good enough for a single
// long-running Node instance; for a multi-instance deployment, swap the Map
// for Redis (same pre-existing limitation shopify-openslot's copy documents).
const buckets = new Map<string, { count: number; resetAt: number }>();

export function throttle(key: string, max: number, windowMs = 600_000): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (bucket.count >= max) {
    throw new GetBooqinError("getbooqin_rate_limited", "Too many requests. Please wait a moment and try again.", 429);
  }
  bucket.count += 1;
}

export function clientIp(request: Request): string {
  return (
    // Set by Fly's own edge (see fly.toml — this app is deployed there) and
    // not attacker-controllable, unlike X-Forwarded-For's first hop, which a
    // client can set to anything and have it pass straight through — for
    // the App Proxy routes that's masked by Shopify's HMAC signature, but
    // this route has no such backstop (see book.$connectionId.tsx), so a
    // spoofable IP would let a single attacker defeat throttle() entirely
    // just by sending a fresh fake header on every request.
    request.headers.get("fly-client-ip") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
