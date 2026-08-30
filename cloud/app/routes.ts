import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("signup", "routes/signup.tsx"),
  route("onboarding", "routes/onboarding.tsx"),
  route("login", "routes/login.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("logout", "routes/logout.tsx"),
  route("sso-callback", "routes/sso-callback.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("dashboard/account", "routes/dashboard.account.tsx"),
  route("dashboard/profile-phone", "routes/dashboard.profile-phone.tsx"),
  route("dashboard/:connectionId", "routes/dashboard.$connectionId.tsx", [
    index("routes/dashboard.$connectionId._index.tsx"),
    route("bookings", "routes/dashboard.$connectionId.bookings.tsx"),
    route("bookings/:bookingId", "routes/dashboard.$connectionId.bookings.$bookingId.tsx"),
    route("waitlist", "routes/dashboard.$connectionId.waitlist.tsx"),
    route("resources", "routes/dashboard.$connectionId.resources.tsx"),
    route("resources/:resourceId", "routes/dashboard.$connectionId.resources.$resourceId.tsx"),
    route("timeoff", "routes/dashboard.$connectionId.timeoff.tsx"),
    route("services", "routes/dashboard.$connectionId.services.tsx"),
    route("services/new", "routes/dashboard.$connectionId.services.new.tsx"),
    route("services/:serviceId", "routes/dashboard.$connectionId.services.$serviceId.tsx"),
    route("customers", "routes/dashboard.$connectionId.customers.tsx"),
    route("settings", "routes/dashboard.$connectionId.settings.tsx"),
    route("account", "routes/dashboard.$connectionId.account.tsx"),
    route("support", "routes/dashboard.$connectionId.support.tsx"),
  ]),
  route("connect/shopify", "routes/connect.shopify.tsx"),
  route("connect/shopify/callback", "routes/connect.shopify.callback.tsx"),
  // Public, unauthenticated — the customer-facing booking page a merchant
  // (Shopify-connected or not) can link customers to directly. See
  // server/combined.js's CLOUD_PREFIXES, kept in sync with this file.
  route("book/:connectionId", "routes/book.$connectionId.tsx"),
  route("book/:connectionId/slots", "routes/book.$connectionId.slots.tsx"),
  route("webhooks/clerk", "routes/webhooks.clerk.tsx"),
  // Not /privacy or /terms — shopify-openslot already owns those paths (its
  // Shopify App Store submission) on the combined server. See
  // server/combined.js's CLOUD_PREFIXES, kept in sync with this file.
  route("legal/privacy", "routes/privacy.tsx"),
  route("legal/terms", "routes/terms.tsx"),
  route("support", "routes/support.tsx"),
] satisfies RouteConfig;
