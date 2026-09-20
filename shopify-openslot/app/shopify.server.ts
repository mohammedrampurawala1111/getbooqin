import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Whether this deployment has Shopify credentials at all.
 *
 * Shopify is shipped dark — no plan grants the entitlement — so the
 * ordinary production deployment has none, and that must not be fatal.
 * It nearly is: `shopifyApp()` validates its config when this module is
 * imported, and the combined server imports it at boot to mount the
 * storefront proxy and the theme extensions, which serve every
 * merchant's booking widget. A throw here takes down the whole app, not
 * just Shopify.
 *
 * So the placeholders below exist to let construction succeed. Nothing
 * can authenticate with them — `/connect/shopify` is gated on an
 * entitlement no plan grants, and an OAuth attempt would be rejected by
 * Shopify itself — which is the correct behaviour for an integration
 * that is switched off.
 *
 * Set the real values when Shopify is turned on; the boot log names
 * what is missing until then.
 */
export const isConfigured = Boolean(
  process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET
);

const shopify = shopifyApp({
  // Deliberately not "" — the library rejects an empty apiKey as a
  // missing argument and throws, which is the failure this exists to
  // avoid. A value that is obviously not a key is safer than no value.
  apiKey: process.env.SHOPIFY_API_KEY || "shopify-not-configured",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "shopify-not-configured",
  apiVersion: ApiVersion.January26,
  scopes: (process.env.SCOPES || "read_products").split(","),
  appUrl: process.env.SHOPIFY_APP_URL || process.env.APP_URL || "http://localhost:3000",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
