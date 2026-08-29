import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("signup", "routes/signup.tsx"),
  route("onboarding", "routes/onboarding.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("sso-callback", "routes/sso-callback.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("dashboard/account", "routes/dashboard.account.tsx"),
  route("dashboard/profile-phone", "routes/dashboard.profile-phone.tsx"),
  route("dashboard/:connectionId", "routes/dashboard.$connectionId.tsx", [
    index("routes/dashboard.$connectionId._index.tsx"),
    route("bookings", "routes/dashboard.$connectionId.bookings.tsx"),
    route("bookings/:bookingId", "routes/dashboard.$connectionId.bookings.$bookingId.tsx"),
    route("resources", "routes/dashboard.$connectionId.resources.tsx"),
    route("resources/:resourceId", "routes/dashboard.$connectionId.resources.$resourceId.tsx"),
    route("timeoff", "routes/dashboard.$connectionId.timeoff.tsx"),
    route("services", "routes/dashboard.$connectionId.services.tsx"),
    route("services/:serviceId", "routes/dashboard.$connectionId.services.$serviceId.tsx"),
    route("customers", "routes/dashboard.$connectionId.customers.tsx"),
    route("settings", "routes/dashboard.$connectionId.settings.tsx"),
  ]),
  route("connect/shopify", "routes/connect.shopify.tsx"),
  route("connect/shopify/callback", "routes/connect.shopify.callback.tsx"),
  route("webhooks/clerk", "routes/webhooks.clerk.tsx"),
] satisfies RouteConfig;
