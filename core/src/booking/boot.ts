/**
 * Wires up the cross-module event listeners once per server process.
 * Ported from shopify-openslot/app/lib/boot.server.ts.
 */
import * as PaymentManager from "./paymentManager.js";
import * as MeetingManager from "./meetingManager.js";
import * as Mailer from "./mailer.js";
import * as Waitlist from "./waitlist.js";

declare global {
  // eslint-disable-next-line no-var
  var getbooqinBooted: boolean | undefined;
}

export function boot() {
  // globalThis, not the Node-only `global` — see core/src/db.ts's comment;
  // this module can end up evaluated in a browser bundle via the barrel
  // index.ts, where `global` throws ReferenceError.
  if (globalThis.getbooqinBooted) return;
  globalThis.getbooqinBooted = true;

  PaymentManager.init();
  MeetingManager.init();
  Mailer.init();
  Waitlist.init();
}

boot();
