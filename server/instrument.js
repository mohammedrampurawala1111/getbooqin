/**
 * Phase 0 / B4 — error monitoring.
 *
 * There was none: no Sentry, no Rollbar, nothing. A booking flow could
 * break and the first anyone would hear of it is a merchant's email —
 * which, for a product about to charge money, is not a monitoring
 * strategy.
 *
 * Imported first thing in combined.js, before any application module.
 * That ordering is not cosmetic: Sentry's Node SDK instruments HTTP,
 * Express and Postgres by monkey-patching those modules as they load, so
 * anything imported before Sentry.init() is never instrumented and its
 * errors never reach a breadcrumb.
 *
 * Completely inert without SENTRY_DSN, which is what makes this safe to
 * merge before a Sentry project exists: no DSN, no init, no network
 * calls, one log line at boot.
 *
 * Setup, when you're ready:
 *   fly secrets set SENTRY_DSN=https://…@…ingest.sentry.io/…
 * Optionally SENTRY_ENVIRONMENT (defaults to NODE_ENV) and
 * SENTRY_TRACES_SAMPLE_RATE (defaults to off — turn it on deliberately;
 * on a $5/month product, tracing quota is the thing that runs out first).
 */
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    // Booking forms carry names, emails, phone numbers and free-text
    // notes — at a clinic, potentially clinical ones. Never ship request
    // bodies, headers or cookies to a third party by default; an
    // exception's own message and stack is what's actually diagnostic.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        // The query string routinely carries a booking's manage token.
        delete event.request.query_string;
      }
      return event;
    },
  });
  console.log(`[getbooqin-server] Sentry enabled (${process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development"})`);
} else {
  console.log("[getbooqin-server] SENTRY_DSN not set — error monitoring is off");
}

export { Sentry };
