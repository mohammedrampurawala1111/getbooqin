import { PassThrough } from "node:stream";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import { isRouteErrorResponse } from "react-router";
import * as Sentry from "@sentry/node";

/**
 * Phase 0 / B4 — error monitoring.
 *
 * This file exists for `handleError` below. Cloud had no entry.server at
 * all and used React Router's default, which is fine for rendering but
 * gives nowhere to observe a failure from: a loader or action that
 * throws is caught by the framework and turned into an ErrorBoundary
 * render, so it never reaches Express and never reaches Sentry's express
 * handler. `handleError` is the hook that sees those.
 *
 * The `handleRequest` default below is React Router's standard streaming
 * implementation, unchanged — it's only here because exporting
 * `handleError` means owning the whole module.
 */

export const streamTimeout = 5000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  return new Promise((resolve, reject) => {
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onShellReady() {
          const body = new PassThrough();
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(body as unknown as BodyInit, {
              headers: responseHeaders,
              status: didError ? 500 : responseStatusCode,
            })
          );
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
 * Every unhandled throw from a loader, action or server render.
 *
 * Two things are deliberately *not* reported. A request the client
 * aborted (the user navigated away mid-load) isn't a defect, and at any
 * volume it would drown everything else. Neither is a thrown
 * `Response` — that's React Router's own control flow for redirects and
 * for deliberate 404/403 responses, not an error.
 */
export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) || error instanceof Response) return;

  Sentry.captureException(error, { tags: { app: "cloud" } });
  console.error(error);
}
