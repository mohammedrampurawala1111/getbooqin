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
// Asking a customer for a deposit, and recording that it arrived.
// GetBooqin never holds the money — see src/booking/payments.ts.
export * as Payments from "./booking/payments.js";
// The connected-gateway rail (payments_gateway entitlement). Separate
// from Payments above, which is the merchant-direct UPI/PayPal.me flow
// that works with no provider at all — see payments/gateway.ts.
export * as PaymentGateway from "./payments/gateway.js";
// QR images — the printable booking-link code, and the payment one.
export * as Qr from "./booking/qr.js";
// Onboarding's "send yourself a test booking" — a real booking through
// the real path. See src/booking/testBooking.ts.
export * as TestBooking from "./booking/testBooking.js";
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

// The paste-into-your-website snippet, and the counterpart the public
// booking page runs so the frame can size itself. See booking/embed.ts.
export * as Embed from "./booking/embed.js";

// One mailbox, many spellings — Gmail ignores dots and everything after
// a "+". Used to stop one person accidentally holding two accounts and
// two trials. See auth/emailIdentity.ts.
export { emailKey, sameMailbox } from "./auth/emailIdentity.js";

// WhatsApp Business, connected per merchant through Meta's Embedded
// Signup. The merchant owns the WABA and pays Meta directly, so this
// costs us nothing per message — see whatsapp/templates.ts for why
// every message is a pre-approved template rather than free text.
export * as WhatsApp from "./whatsapp/notify.js";
export * as WhatsAppAccounts from "./whatsapp/accounts.js";
export * as WhatsAppTemplates from "./whatsapp/templateSync.js";
export * as WhatsAppWebhook from "./whatsapp/webhook.js";
export * as WhatsAppApply from "./whatsapp/apply.js";
export * as WhatsAppSignup from "./whatsapp/embeddedSignup.js";
export { GetBooqinError, isGetBooqinError } from "./booking/errors.js";
export { boot } from "./booking/boot.js";
// Scheduled-job bookkeeping — see src/jobs.ts on why a cron that never
// runs has to be observable rather than assumed (Phase 0's B1).
export * as Jobs from "./jobs.js";
// What this deployment needs, and what it loses without it. Checked at
// boot by server/combined.js. See src/env.ts.
export * as Env from "./env.js";

// Billing (§W7). `Plans` is a pure data table with zero imports and is
// also exposed at the ./billing/plans subpath, so the pricing page and
// the Billing screen can render from the exact table the server
// enforces without pulling Prisma into a client bundle.
export * as Plans from "./billing/plans.js";
export * as Entitlements from "./billing/entitlements.js";
export * as Subscriptions from "./billing/subscriptions.js";
export * as Billing from "./billing/enforcement.js";
export * as BillingWebhooks from "./billing/webhooks.js";
export { providerFor, providerForNewSubscription, providerForSubscription } from "./billing/providers/index.js";
export * as Checkout from "./billing/checkout.js";
// Pulling the provider's own state when a webhook never arrived. See
// src/billing/reconcile.ts.
export * as BillingReconcile from "./billing/reconcile.js";
// Tax invoices — issuing, rendering and delivering them. See
// src/billing/invoices.ts.
export * as Invoices from "./billing/invoices.js";
export * as InvoiceDelivery from "./billing/invoiceDelivery.js";
export * as InvoicePdf from "./billing/invoicePdf.js";
export * as Seller from "./billing/seller.js";
export * as BillingEmails from "./billing/emails.js";
// Welcome / first-booking / trial-nudge emails. See src/lifecycle.ts.
export * as Lifecycle from "./lifecycle.js";
export * as Tax from "./billing/tax.js";

// Platform admin console (§W8) — internal-only, above all accounts.
// Never renders tenant booking data; see admin/accounts.ts.
export * as AdminAccounts from "./admin/accounts.js";
export * as AdminActions from "./admin/actions.js";
export * as AdminAudit from "./admin/audit.js";
export * as AdminAccess from "./admin/access.js";

// Account and business deletion (right to erasure, B5). Irreversible by
// design — see account/deletion.ts on why a soft delete would not be
// erasure at all.
export * as AccountDeletion from "./account/deletion.js";
export { RazorpayProvider, providerPlanId } from "./billing/providers/razorpay.js";
export { PayPalProvider } from "./billing/providers/paypal.js";
export type { BillingProvider, NormalisedEvent, BillingEventType } from "./billing/providers/provider.js";
export * as ShopifyAdmin from "./platforms/shopifyAdmin.js";
