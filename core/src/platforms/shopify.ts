import { createHmac, timingSafeEqual } from "node:crypto";
import { signPayload, verifySignedPayload } from "../auth/session.js";

// Standalone (non-embedded) OAuth against the same Shopify app registration
// shopify-openslot's embedded admin uses (SHOPIFY_API_KEY/SHOPIFY_API_SECRET/
// SCOPES) — this app just adds a second, non-embedded redirect URI that the
// Partner Dashboard needs allow-listed. See docs/plan/tenant-session-design.md.

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

function getApiKey(): string {
  const key = process.env.SHOPIFY_API_KEY;
  if (!key) throw new Error("SHOPIFY_API_KEY is not set");
  return key;
}

function getApiSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set");
  return secret;
}

function getScopes(): string {
  const scopes = process.env.SCOPES;
  if (!scopes) throw new Error("SCOPES is not set");
  return scopes;
}

// The connect flow's CSRF/nonce guard: signed instead of tracked server-side,
// so there's no state store to clean up. Short TTL — it only needs to live
// for the round trip through Shopify's authorize page.
export interface ShopifyOAuthState {
  userId: string;
  shop: string;
  // Carries answers collected by the pre-connection onboarding wizard
  // (cloud/app/routes/onboarding.tsx) through the OAuth round trip, since
  // there is no Connection row to attach them to until this callback runs.
  // Absent for every other caller of this flow (e.g. "+ Connect another
  // store" from Settings), which only ever signs {userId, shop}.
  onboarding?: {
    presetId?: string;
    businessName?: string;
    businessEmail?: string;
    businessPhone?: string;
    timezone?: string;
    resourceName?: string;
    remindersOn?: boolean;
  };
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function signOAuthState(state: ShopifyOAuthState): string {
  return signPayload(state, OAUTH_STATE_TTL_MS);
}

export function verifyOAuthState(token: string): ShopifyOAuthState | null {
  return verifySignedPayload<ShopifyOAuthState>(token);
}

export function buildAuthorizationUrl({
  shop,
  redirectUri,
  state,
}: {
  shop: string;
  redirectUri: string;
  state: string;
}): string {
  if (!isValidShopDomain(shop)) {
    throw new Error(`invalid shop domain: ${shop}`);
  }
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", getApiKey());
  url.searchParams.set("scope", getScopes());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// Verifies the HMAC Shopify signs onto every OAuth callback query string.
// https://shopify.dev/docs/apps/auth/oauth/getting-started#step-4-confirm-installation
export function verifyCallbackHmac(query: URLSearchParams): boolean {
  const params = new URLSearchParams(query);
  const hmac = params.get("hmac");
  if (!hmac) return false;
  params.delete("hmac");

  const message = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const digest = createHmac("sha256", getApiSecret()).update(message).digest("hex");

  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ShopifyAccessToken {
  accessToken: string;
  scope: string;
}

export async function exchangeCodeForToken({
  shop,
  code,
}: {
  shop: string;
  code: string;
}): Promise<ShopifyAccessToken> {
  if (!isValidShopDomain(shop)) {
    throw new Error(`invalid shop domain: ${shop}`);
  }
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: getApiKey(), client_secret: getApiSecret(), code }),
  });
  if (!response.ok) {
    throw new Error(`Shopify token exchange failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { access_token: string; scope: string };
  return { accessToken: data.access_token, scope: data.scope };
}
