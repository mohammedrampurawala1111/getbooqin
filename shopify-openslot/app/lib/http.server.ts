import { GetBooqinError } from "getbooqin-core";

export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function fail(err: unknown): Response {
  if (err instanceof GetBooqinError) {
    return new Response(JSON.stringify({ success: false, code: err.code, message: err.message }), {
      status: err.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  // authenticate.public.appProxy() throws a plain Response (not an Error) on
  // an invalid HMAC signature — letting it fall through to the generic 500
  // below would silently turn every rejected/forged proxy request into a
  // misleading "Something went wrong" instead of the real 400, and bury the
  // one signal (an invalid-signature attempt) that's actually worth knowing
  // came through this endpoint at all.
  if (err instanceof Response) {
    return err;
  }
  console.error(err);
  return new Response(JSON.stringify({ success: false, code: "getbooqin_error", message: "Something went wrong. Please try again." }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Simple per-process, per-key rate limiter — the equivalent of Rest::throttle()'s
 * transient-backed one. Good enough for a single long-running Node instance;
 * for a multi-instance deployment, swap the Map for Redis (see DEVELOPERS.md).
 */
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
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}
