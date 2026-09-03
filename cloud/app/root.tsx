import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation, useRouteError, isRouteErrorResponse } from "react-router";
import { ClerkProvider } from "@clerk/react-router";
import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import type { Route } from "./+types/root";
import "./app.css";

// Previously missing entirely — blank browser-tab glyph, a generic
// screenshot for "Add to Home Screen" (exactly what a shop owner does with
// a tool like this), and default-grey browser chrome instead of the brand
// colour (UX audit's M10 finding).
export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
  },
  { rel: "icon", href: "/favicon.png", type: "image/png" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
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

// The inline bootstrap script below only runs once, on the initial
// document load — it can't fire again for a client-side navigation, since
// <head>'s script tags don't re-execute when only the <Outlet> content
// changes. Pass 7's audit found /timeoff specifically rendering light with
// data-theme unset after navigating there from another (dark) page, then
// reverting back to dark on navigating away — that pattern points at
// something transiently clearing or racing the attribute for that one
// route's transition, not a route that never had it applied in the first
// place (this component wraps every route identically; nothing here is
// /timeoff-specific). Re-asserting the stored theme on every navigation,
// not just the first one, closes that gap regardless of what's causing it.
function ThemeSync() {
  const location = useLocation();
  useEffect(() => {
    try {
      const stored = localStorage.getItem("gb-theme");
      if (stored === "light" || stored === "dark") {
        document.documentElement.setAttribute("data-theme", stored);
      }
    } catch {
      // Private browsing etc. — nothing to resync from.
    }
  }, [location.key]);
  return null;
}

// Every route in the app threw straight through to React Router's own
// bare, unstyled default error page — no title, no chrome, no way back
// into the app (UX audit's #6 finding). This is the one catch-all boundary
// that reaches every route below it, so both a 404 (isRouteErrorResponse
// with status 404) and any other unhandled error land on a branded page
// with a link home instead.
export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  if (import.meta.env.DEV && !notFound) {
    console.error(error);
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{notFound ? "Page not found" : "Something went wrong"} · GetBooqin</title>
        <Links />
      </head>
      <body>
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
          <h1 className="page-title">{notFound ? "Page not found" : "Something went wrong"}</h1>
          <p className="m-0 max-w-[360px] text-body text-muted">
            {notFound
              ? "The page you're looking for doesn't exist or may have moved."
              : "An unexpected error occurred. Try again, or head back to the dashboard."}
          </p>
          <a href="/" className="btn-pri mt-2 no-underline hover:no-underline">
            Back to home
          </a>
        </div>
        <Scripts />
      </body>
    </html>
  );
}

export default function Root({ loaderData }: Route.ComponentProps) {
  return (
    <ClerkProvider loaderData={loaderData}>
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#131118" />
          {/* Sets data-theme on <html> before first paint, straight from
              localStorage — a stored choice would otherwise only apply
              after ThemeToggle's own useEffect runs post-hydration, which
              means every page load flashed the OS-default theme first
              whenever that choice disagreed with it. Deliberately outside
              React's render tree (this <html> tag never declares
              data-theme itself) so this plain DOM mutation can't collide
              with hydration. */}
          <script
            dangerouslySetInnerHTML={{
              __html: `try{var t=localStorage.getItem("gb-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}`,
            }}
          />
          <Meta />
          <Links />
        </head>
        <body>
          <ThemeSync />
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
