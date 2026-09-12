export { default as prisma } from "./db.js";
export * from "./auth/session.js";
export * from "./auth/encryption.js";
export * from "./platforms/shopify.js";
export * from "./connections.js";
// Multi-user team management (roles/membership/invites) for a Connection —
// see core/src/team.ts's header comment and docs/team-management-spec.md.
export * as Team from "./team.js";
// Re-exported at the top level (not just Team.Role) so call sites like
// cloud's tenant.server.ts can write `minRole: Role = "read"` without
// referencing a type through the `Team` namespace value import.
export type { Role } from "./team.js";

// Booking-workflow business logic, ported from shopify-openslot/app/lib —
// see docs/plan/tenant-session-design.md's Prompt 4 section for why this
// lives here now instead of only in the embedded app. Namespaced (not
// flattened) to match the `import * as Data from "..."` convention
// shopify-openslot's own routes already use, so cloud's routes read the same
// way.
export * as Data from "./booking/data.js";
export * as Bookings from "./booking/bookings.js";
// DB-free subset of bookings.js — safe for client components to import
// without pulling Prisma (and core/db.js's `global.prismaGlobal`) into the
// browser bundle. See bookingsShared.ts's header comment.
export * as BookingsShared from "./booking/bookingsShared.js";
export * as Availability from "./booking/availability.js";
export * as Waitlist from "./booking/waitlist.js";
// DB-free subset of waitlist.js — see waitlistShared.ts's header comment.
export * as WaitlistShared from "./booking/waitlistShared.js";
export * as Mailer from "./booking/mailer.js";
export * as Settings from "./booking/settings.js";
export * as TZ from "./booking/tz.js";
export * as Metrics from "./booking/metrics.js";
export * as ServiceMetafields from "./booking/serviceMetafields.js";
export * as Presets from "./booking/presets.js";
export { GetBooqinError, isGetBooqinError } from "./booking/errors.js";
export { boot } from "./booking/boot.js";
// Scheduled-job bookkeeping — see src/jobs.ts on why a cron that never
// runs has to be observable rather than assumed (Phase 0's B1).
export * as Jobs from "./jobs.js";

// Billing (§W7). `Plans` is a pure data table with zero imports and is
// also exposed at the ./billing/plans subpath, so the pricing page and
// the Billing screen can render from the exact table the server
// enforces without pulling Prisma into a client bundle.
export * as Plans from "./billing/plans.js";
export * as Entitlements from "./billing/entitlements.js";
export * as Subscriptions from "./billing/subscriptions.js";
export * as Billing from "./billing/enforcement.js";
export * as BillingWebhooks from "./billing/webhooks.js";
export { RazorpayProvider, providerPlanId } from "./billing/providers/razorpay.js";
export type { BillingProvider, NormalisedEvent, BillingEventType } from "./billing/providers/provider.js";
export * as ShopifyAdmin from "./platforms/shopifyAdmin.js";
