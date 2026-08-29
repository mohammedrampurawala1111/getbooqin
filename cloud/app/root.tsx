import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { ClerkProvider } from "@clerk/react-router";
import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
  },
];

// Populates the request context that rootAuthLoader below reads. This is
// the only route that needs to know about Clerk's middleware — every other
// loader keeps using session.server.ts's request-based getUserSession, not
// getAuth(context).
export const middleware: Route.MiddlewareFunction[] = [clerkMiddleware()];

export async function loader(args: Route.LoaderArgs) {
  return rootAuthLoader(args);
}

// Fallback only — every route below is expected to export its own `meta`
// (see signup.tsx etc.) so browser tabs/history/bookmarks are
// distinguishable (UX audit's P1 finding: every page used to share this
// one title with no description at all).
export const meta: Route.MetaFunction = () => [
  { title: "GetBooqin Cloud" },
  { name: "description", content: "Bookings, staff schedules and payments for every store you connect." },
];

export default function Root({ loaderData }: Route.ComponentProps) {
  return (
    <ClerkProvider loaderData={loaderData}>
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <Meta />
          <Links />
        </head>
        <body>
          <a href="#main" className="skip-link">Skip to content</a>
          {/* Single <main> landmark for the whole app — every nested
              route's chrome (sidebar, headers) renders inside it. One
              landmark covering everything beats the zero the axe scan
              found (UX audit's A3 finding); splitting nav out into its
              own <nav> per layout is a further improvement, not required
              to clear that violation. */}
          <main id="main">
            <Outlet />
          </main>
          <ScrollRestoration />
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}
