export { default as prisma } from "./db.js";
export * from "./auth/session.js";
export * from "./auth/encryption.js";
export * from "./platforms/shopify.js";
export * from "./connections.js";

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
export * as PaymentManager from "./booking/paymentManager.js";
export * as MeetingManager from "./booking/meetingManager.js";
export * as Mailer from "./booking/mailer.js";
export * as ChatFlow from "./booking/chatFlow.js";
export * as Settings from "./booking/settings.js";
export * as TZ from "./booking/tz.js";
export * as Metrics from "./booking/metrics.js";
export * as ServiceMetafields from "./booking/serviceMetafields.js";
export * as Presets from "./booking/presets.js";
export * as FeatureFlags from "./booking/featureFlags.js";
export { GetBooqinError, isGetBooqinError } from "./booking/errors.js";
export { boot } from "./booking/boot.js";
export * as ShopifyAdmin from "./platforms/shopifyAdmin.js";
