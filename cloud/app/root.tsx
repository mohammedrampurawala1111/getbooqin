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

export default function Root({ loaderData }: Route.ComponentProps) {
  return (
    <ClerkProvider loaderData={loaderData}>
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>GetBooqin Cloud</title>
          <Meta />
          <Links />
        </head>
        <body>
          <Outlet />
          <ScrollRestoration />
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}
