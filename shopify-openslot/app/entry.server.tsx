import { PassThrough } from "node:stream";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import * as Sentry from "@sentry/node";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

// Renders fully before responding, instead of streaming chunked output —
// the free trycloudflare.com dev tunnel truncates longer chunked responses
// (Polaris admin pages routinely exceed whatever it can hold open), so a
// single complete response with a real Content-Length is what survives it.
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  addDocumentResponseHeaders(request, responseHeaders);

  return new Promise((resolve, reject) => {
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onAllReady() {
          const body = new PassThrough();
          const chunks: Buffer[] = [];
          body.on("data", (chunk) => chunks.push(chunk));
          body.on("end", () => {
            responseHeaders.set("Content-Type", "text/html");
            resolve(
              new Response(Buffer.concat(chunks), {
                headers: responseHeaders,
                status: didError ? 500 : responseStatusCode,
              })
            );
          });
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          didError = true;
          console.error(error);
        },
      }
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}

/**
 * Phase 0 / B4 — error monitoring.
 *
 * Every unhandled throw from a loader, action or server render. These
 * never reach Express: React Router catches them and renders an
 * ErrorBoundary instead, so `Sentry.setupExpressErrorHandler` in
 * server/combined.js sees nothing. This hook is the one that does.
 *
 * Two things are deliberately not reported. A request the client aborted
 * (the merchant navigated away mid-load) isn't a defect, and at any
 * volume it would drown everything else. Neither is a thrown `Response`
 * — that's React Router's own control flow for redirects and for
 * deliberate 404/403s, and Shopify's own auth helpers throw redirects
 * constantly.
 */
export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) || error instanceof Response) return;

  Sentry.captureException(error, { tags: { app: "shopify-openslot" } });
  console.error(error);
}
