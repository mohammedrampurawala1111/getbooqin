import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("signup", "routes/signup.tsx"),
  route("onboarding", "routes/onboarding.tsx"),
  route("login", "routes/login.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("logout", "routes/logout.tsx"),
  route("sso-callback", "routes/sso-callback.tsx"),
  // Team invite accept screen — no dashboard nav chrome, mirrors signup.tsx/
  // login.tsx's own two-column shell. See core/src/team.ts (inviteMember/
  // acceptInvite) and docs/team-ui-spec.md §2 for the screen states this
  // renders.
  route("invite/:token", "routes/invite.$token.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("dashboard/account", "routes/dashboard.account.tsx"),
  route("dashboard/profile-phone", "routes/dashboard.profile-phone.tsx"),
  route("dashboard/:connectionId", "routes/dashboard.$connectionId.tsx", [
    index("routes/dashboard.$connectionId._index.tsx"),
    route("bookings", "routes/dashboard.$connectionId.bookings.tsx"),
    route("bookings/calendar", "routes/dashboard.$connectionId.bookings.calendar.tsx"),
    route("bookings/:bookingId", "routes/dashboard.$connectionId.bookings.$bookingId.tsx"),
    route("bookings/export.csv", "routes/dashboard.$connectionId.bookings.export.tsx"),
    route("waitlist", "routes/dashboard.$connectionId.waitlist.tsx"),
    route("resources", "routes/dashboard.$connectionId.resources.tsx"),
    route("resources/:resourceId", "routes/dashboard.$connectionId.resources.$resourceId.tsx"),
    route("timeoff", "routes/dashboard.$connectionId.timeoff.tsx"),
    route("services", "routes/dashboard.$connectionId.services.tsx"),
    route("services/new", "routes/dashboard.$connectionId.services.new.tsx"),
    route("services/:serviceId", "routes/dashboard.$connectionId.services.$serviceId.tsx"),
    route("customers", "routes/dashboard.$connectionId.customers.tsx"),
    route("customers/:customerId", "routes/dashboard.$connectionId.customers.$customerId.tsx"),
    route("settings", "routes/dashboard.$connectionId.settings.tsx"),
    route("account", "routes/dashboard.$connectionId.account.tsx"),
    route("support", "routes/dashboard.$connectionId.support.tsx"),
    // Catch-all so a bad nested URL is a *matched* child whose loader
    // throws 404 — without this, React Router finds no route to render
    // under the layout at all and treats it as "nothing matched anywhere,"
    // which only the root-level boundary catches (ejecting the sidebar,
    // Defect Dossier's BQ-37 finding), instead of this layout's own
    // ErrorBoundary. Must stay last: React Router already prefers a more
    // specific sibling over a splat regardless of registration order, but
    // this keeps the intent obvious.
    route("*", "routes/dashboard.$connectionId.$.tsx"),
  ]),
  // Platform admin console (§W8) — deliberately outside the tenant
  // layout and the tenant middleware: it has no connectionId, is not
  // scoped to a business, and must inherit none of requireTenant's
  // assumptions. Its guard 404s (never 403s) for everyone else. Keep in
  // sync with server/combined.js's CLOUD_PREFIXES.
  route("admin", "routes/admin.tsx", [
    index("routes/admin._index.tsx"),
    route("accounts/:id", "routes/admin.accounts.$id.tsx"),
    route("features", "routes/admin.features.tsx"),
    route("audit", "routes/admin.audit.tsx"),
  ]),
  route("connect/shopify", "routes/connect.shopify.tsx"),
  route("connect/shopify/callback", "routes/connect.shopify.callback.tsx"),
  // Public, unauthenticated — the customer-facing booking page a merchant
  // (Shopify-connected or not) can link customers to directly. See
  // server/combined.js's CLOUD_PREFIXES, kept in sync with this file.
  route("book/:connectionId", "routes/book.$connectionId.tsx"),
  route("book/:connectionId/slots", "routes/book.$connectionId.slots.tsx"),
  route("webhooks/clerk", "routes/webhooks.clerk.tsx"),
  // Razorpay subscription events — see the route's own header comment,
  // and keep in sync with server/combined.js's CLOUD_PREFIXES.
  route("webhooks/razorpay", "routes/webhooks.razorpay.tsx"),
  // Not /privacy or /terms — shopify-openslot already owns those paths (its
  // Shopify App Store submission) on the combined server. See
  // server/combined.js's CLOUD_PREFIXES, kept in sync with this file.
  route("legal/privacy", "routes/privacy.tsx"),
  route("legal/terms", "routes/terms.tsx"),
  route("support", "routes/support.tsx"),
] satisfies RouteConfig;
