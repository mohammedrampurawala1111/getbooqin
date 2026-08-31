import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { GetBooqinError } from "getbooqin-core";
import { fail } from "~/lib/http.server";

/**
 * Catch-all for any /apps/getbooqin/* path that isn't one of the specific
 * routes above — a typo'd endpoint, a stale client hitting a renamed one,
 * or someone just poking at the proxy. Without this, react-router's own
 * unmatched-route handling takes over and returns the app's HTML error
 * boundary with a 200 (App Proxy requests never see a real 404 status the
 * way a normal browser navigation would), so any client doing a plain
 * `res.ok` check treats a wrong URL as success and then fails obscurely on
 * JSON.parse. Proxy-wide fix, not specific to any one feature — every route
 * in this directory benefits from a caller being able to trust a 404 here
 * means "this path doesn't exist," not "something worked."
 */
function notFound() {
  return fail(new GetBooqinError("getbooqin_not_found", "Not found.", 404));
}

export async function loader(_args: LoaderFunctionArgs) {
  return notFound();
}

export async function action(_args: ActionFunctionArgs) {
  return notFound();
}
