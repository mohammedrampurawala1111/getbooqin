import type { ReactNode } from "react";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as PolarisAppProvider, Frame } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { FeatureFlags } from "getbooqin-core";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "", chatEnabled: FeatureFlags.CHAT_ENABLED };
}

/**
 * Without this, Polaris's own Link/backAction/etc. render as plain <a>
 * tags — nothing tells Polaris this app has a client-side router at all.
 * Every one of those clicks (the "Bookings" back action included) was
 * therefore a real hard browser navigation, never a React Router SPA
 * transition — which is also why the session-token fetch patch in
 * entry.client.tsx could never have helped it: hard navigations don't go
 * through window.fetch, so there was never a request for that patch to
 * attach a token to.
 */
function PolarisLink({ url, children, ...rest }: { url: string; children?: ReactNode } & Record<string, unknown>) {
  return (
    <Link to={url} {...rest}>
      {children}
    </Link>
  );
}

export default function AppLayout() {
  const { apiKey, chatEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <PolarisAppProvider i18n={polarisTranslations} linkComponent={PolarisLink}>
        <NavMenu>
          <Link to="/app" rel="home">
            Dashboard
          </Link>
          <Link to="/app/bookings">Bookings</Link>
          <Link to="/app/calendar">Calendar</Link>
          <Link to="/app/services">Services</Link>
          <Link to="/app/addons">Add-ons</Link>
          <Link to="/app/resources">Staff</Link>
          <Link to="/app/timeoff">Time Off</Link>
          <Link to="/app/customers">Customers</Link>
          {chatEnabled && <Link to="/app/chat">Chat</Link>}
          <Link to="/app/settings">Settings</Link>
        </NavMenu>
        <Frame>
          <Outlet />
        </Frame>
      </PolarisAppProvider>
    </AppProvider>
  );
}

/**
 * When authenticate.admin() can't re-embed the app from a client-side data
 * request (a session cookie missed in the iframe, most often triggered by a
 * client-side Link/back navigation), it throws a 200 response whose body is
 * a <script> tag meant to load App Bridge and let *that* fix the embedding.
 * Two automated attempts at handling this both made it worse:
 *   1. Reloading the page just re-issued the same failing request and got
 *      the same broken response back — an infinite loop.
 *   2. Building and appending a real <script> element (so it would actually
 *      execute, unlike @shopify/shopify-app-react-router's own
 *      dangerouslySetInnerHTML rendering) hit App Bridge's own duplicate-load
 *      guard ("must be included as the first script tag") — App Bridge was
 *      already running on the page from the normal initial load, so loading
 *      a second copy was never the right move to begin with.
 * Neither client-side-JS approach is safe without understanding exactly how
 * the already-running App Bridge instance is meant to recover this session,
 * so this deliberately does nothing automatic — just a clear message and a
 * manual reload, which cannot loop or throw a duplicate-script error.
 */
function isAppBridgeBootstrapResponse(error: unknown): boolean {
  return isRouteErrorResponse(error) && typeof error.data === "string" && error.data.includes("app-bridge.js");
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isAppBridgeBootstrapResponse(error)) {
    return (
      <div style={{ padding: 40, fontFamily: "sans-serif", textAlign: "center" }}>
        <p style={{ marginBottom: 16 }}>This page lost its connection to Shopify admin. Reload to reconnect.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: "8px 20px", fontSize: 14, cursor: "pointer" }}
        >
          Reload
        </button>
      </div>
    );
  }

  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
