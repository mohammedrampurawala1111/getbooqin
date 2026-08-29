import type { ReactNode } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";

function Document({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <title>{title}</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <Document title="GetBooqin">
      <Outlet />
    </Document>
  );
}

// Root-level fallback for anything that isn't handled closer to where it
// happened (app.tsx has its own, more specific one for a lost embedded-admin
// session) — most commonly an unknown URL. Previously there was no
// ErrorBoundary here at all, so React Router's own bare-bones default
// rendered instead: unbranded "404 Not Found" text with no link home, and a
// document title of "Unhandled Thrown Response!" — a framework internal
// that leaked into the browser tab, history and search results (UX audit's
// R6 finding). Deliberately plain inline styles rather than Polaris — this
// can render before AppProvider/PolarisAppProvider ever mount (an error at
// the root itself), so nothing here can depend on them being present.
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const isNotFound = status === 404;

  return (
    <Document title={isNotFound ? "Page not found · GetBooqin" : "Something went wrong · GetBooqin"}>
      <div
        style={{
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 40,
          textAlign: "center",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          color: "#1a1620",
        }}
      >
        <img src="/favicon.png" alt="" width={40} height={40} style={{ borderRadius: 8 }} />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
          {isNotFound ? "Page not found" : "Something went wrong"}
        </h1>
        <p style={{ margin: 0, maxWidth: 380, color: "#545b68", fontSize: 14 }}>
          {isNotFound
            ? "The page you're looking for doesn't exist or may have moved."
            : "An unexpected error occurred. Try reloading, or head back to the dashboard."}
        </p>
        <a
          href="/"
          style={{
            marginTop: 8,
            padding: "9px 16px",
            borderRadius: 8,
            background: "#8f3aa9",
            color: "white",
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Back to home
        </a>
      </div>
    </Document>
  );
}
