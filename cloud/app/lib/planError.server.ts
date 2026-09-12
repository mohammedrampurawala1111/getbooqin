import { data } from "react-router";
import { isGetBooqinError } from "getbooqin-core";

/**
 * Turning a core error into an HTTP answer, in one place.
 *
 * `GetBooqinError` is a plain `Error` carrying a `status`, so React
 * Router has no way to know a 402 from a crash: an uncaught one becomes
 * a generic 500 and the merchant reads "something went wrong" when their
 * actual problem is "this is on a higher plan". That is not a
 * hypothetical — it shipped, and the browser tests caught it.
 *
 * Two shapes, because routes need different things:
 *
 * - `planError(err)` returns `{ error, code, status }` for an action
 *   whose page can render the message inline, next to the control the
 *   merchant just used. **Prefer this**: inline beats an error page
 *   every time, because it keeps the form and its values on screen.
 *
 * - `rethrowAsRouteError(err)` throws `data()`, which React Router
 *   *does* honour — correct status, and `isRouteErrorResponse` can read
 *   the message in an ErrorBoundary. For loaders and resource routes,
 *   which have nowhere to put an inline message.
 *
 * Neither is a substitute for the gate itself. Every one of these
 * errors originates in core and is enforced there; this only decides
 * how it is said.
 */
export interface PlanErrorResult {
  error: string;
  code: string;
  status: number;
}

export function planError(err: unknown): PlanErrorResult {
  if (!isGetBooqinError(err)) throw err;
  return { error: err.message, code: err.code, status: err.status };
}

export function rethrowAsRouteError(err: unknown): never {
  if (!isGetBooqinError(err)) throw err;
  throw data(err.message, { status: err.status });
}

/**
 * Wraps a loader or action so any GetBooqinError becomes a proper route
 * error instead of a 500. The safety net: a call site that forgets to
 * handle a gate degrades to a decent, correctly-statused page rather
 * than to "something went wrong".
 */
export function withPlanErrors<Args, Result>(
  fn: (args: Args) => Promise<Result>
): (args: Args) => Promise<Result> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (isGetBooqinError(err)) rethrowAsRouteError(err);
      throw err;
    }
  };
}
