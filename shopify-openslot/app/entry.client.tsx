/**
 * Every client-side navigation, fetcher, and form submission React Router
 * makes goes through window.fetch — but nothing attached a Shopify session
 * token to those requests, so the server fell back to cookie-based auth for
 * them. Cookies inside a third-party (embedded admin) iframe are unreliable,
 * and that's exactly what caused the "lost connection to Shopify admin"
 * crash: a cookie miss on a client-side request made authenticate.admin()
 * throw its HTML re-embed bootstrap page, which React Router then choked on
 * trying to render as if it were normal route data.
 *
 * @shopify/shopify-app-react-router's authenticateAdmin() (server/authenticate
 * /admin/authenticate.js) only takes that bounce path when a request arrives
 * with no `authorization` header at all — getSessionTokenHeader() reads
 * `Authorization: Bearer <token>` first and, if present, authenticates the
 * request directly instead of treating it as a document load. App Bridge
 * (loaded by AppProvider in routes/app.tsx, which renders the app-bridge.js
 * script tag ahead of this module in the document) exposes exactly that
 * token via `window.shopify.idToken()`, so this patches fetch to attach a
 * fresh one to every same-origin /app request. This also makes any *other*
 * auth hiccup on those requests fail as a normal XHR 401 instead of the HTML
 * bootstrap page.
 */
import { startTransition, StrictMode } from "react";
import type { ShopifyGlobal } from "@shopify/app-bridge-types";

declare global {
  interface Window {
    shopify?: ShopifyGlobal;
  }
}

async function waitForShopify(timeoutMs = 3000): Promise<ShopifyGlobal | null> {
  const start = Date.now();
  while (!window.shopify?.idToken) {
    if (Date.now() - start > timeoutMs) {
      console.warn("[getbooqin-auth] window.shopify.idToken never became available after", timeoutMs, "ms");
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.shopify;
}

async function getIdToken(): Promise<string | null> {
  const shopify = await waitForShopify();
  if (!shopify) return null;
  try {
    return await shopify.idToken();
  } catch (err) {
    console.warn("[getbooqin-auth] shopify.idToken() threw", err);
    return null;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// React Router issues its data requests as `new Request(url, {signal})`
// (see react-router/dist/*/dom-export.mjs, callSingleFetch), so `input` here
// is as often a Request as a plain string — requestUrl() covers both, and
// this parses the real pathname rather than string-prefix-matching the raw
// URL, which would also match an unrelated path like "/apple-touch-icon.png"
// and would miss a path-less "/app?foo" query-string-only form.
function isAppPath(url: string): boolean {
  const { pathname } = new URL(url, window.location.origin);
  return pathname === "/app" || pathname.startsWith("/app/");
}

function patchFetchWithSessionToken() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (!isAppPath(url)) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) {
      const token = await getIdToken();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      } else {
        console.warn("[getbooqin-auth] no session token available, sending", url, "without Authorization");
      }
    }
    return originalFetch(input, { ...init, headers });
  };
}

// Patch fetch BEFORE react-router/dom is ever imported. A plain top-level
// `import` is hoisted and evaluated before any of this file's own code runs,
// regardless of where it's written in the file — so if React Router grabs a
// reference to fetch at module-init time (rather than reading window.fetch
// fresh on every call), patching it afterward would silently do nothing.
// Dynamic import() is deferred, which guarantees the patch below is in
// place before react-router/dom's module code ever executes.
patchFetchWithSessionToken();

Promise.all([import("react-dom/client"), import("react-router/dom")]).then(([{ hydrateRoot }, { HydratedRouter }]) => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>
    );
  });
});
