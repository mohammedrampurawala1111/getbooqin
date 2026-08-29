import { PassThrough } from "node:stream";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
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
