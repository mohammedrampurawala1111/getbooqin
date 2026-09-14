import { Form, useSearchParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/dashboard.$connectionId.orders";
import { Payments, Settings, isGetBooqinError } from "getbooqin-core";
import { money } from "getbooqin-core/booking/settingsShared";
import * as PaymentLinks from "getbooqin-core/booking/paymentLinks";
import { formatInZone } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { PageHeader, AlertError } from "~/components/ui";
import { useVocabulary } from "~/lib/presets";

/**
 * Orders — who owes what, and what has actually arrived.
 *
 * The screen exists because GetBooqin does not take the money. A
 * customer pays the merchant directly through a UPI or PayPal link, and
 * nothing tells us when that lands — so this is where a merchant
 * reconciles their own bank against their own bookings. Every piece of
 * copy here has to keep saying that rather than implying a payment
 * system that is watching.
 *
 * Built from bookings with a price, not from payments, so the most
 * important row is present: a booking nobody has asked to pay yet.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { connection } = await requireTenant(request, params.connectionId!);
  const url = new URL(request.url);
  const filter = (url.searchParams.get("show") ?? "outstanding") as "outstanding" | "paid" | "all";

  const settings = await Settings.getSettings(connection.shop, connection.platform);
  const method = PaymentLinks.availableMethod(
    { upiId: settings.upi_id, payPalMe: settings.paypal_me, payeeName: settings.business_name },
    settings.currency
  );
  const LIMIT = 100;
  const [rows, total] = await Promise.all([
    Payments.orders(connection.shop, connection.platform, { status: filter, limit: LIMIT }),
    Payments.countOrders(connection.shop, connection.platform, filter),
  ]);

  // One QR per pending request, rendered here so the page has no
  // client-side crypto and works with JavaScript off.
  const qrs: Record<number, string> = {};
  // One set of per-app links per pending UPI request, so a customer can
  // pick their app instead of Android's default handler picking for them.
  const appLinks: Record<number, { id: string; label: string; url: string }[]> = {};

  for (const row of rows) {
    for (const payment of row.payments) {
      if (payment.status !== "pending" || !payment.link) continue;
      qrs[payment.id] = await Payments.paymentQr(payment.link);
      if (payment.method === "upi") {
        appLinks[payment.id] = PaymentLinks.upiAppLinks({
          payee: { upiId: settings.upi_id, payPalMe: settings.paypal_me, payeeName: settings.business_name },
          amount: payment.amount,
          currency: payment.currency,
          reference: payment.reference,
          note: payment.reference,
        });
      }
    }
  }

  return {
    filter,
    total,
    limit: LIMIT,
    settings: { currency: settings.currency, currencySymbol: settings.currency_symbol },
    // The business's own zone. A 00:30 IST booking rendered in the
    // viewer's browser zone shows as the previous day for a merchant on
    // a laptop set to UTC — every other screen uses formatInZone.
    timezone: settings.timezone,
    // The same function the action uses, so the button and the server
    // can never disagree. This used to be `upi_id || paypal_me`, which
    // ignored currency — so a shop pricing in dollars with a UPI ID saw
    // "Request $32.00", clicked it, and got refused. UPI is INR-only by
    // definition: a `upi://` link for a dollar amount would either fail
    // or quietly ask for that many rupees.
    canRequest: !!method,
    // Why not, specifically. "Set something up" is unhelpful to a
    // merchant who already has.
    blocker: method
      ? null
      : settings.upi_id && settings.currency.toUpperCase() !== "INR"
        ? ("upi_wrong_currency" as const)
        : ("nothing_configured" as const),
    rows: rows.map((r) => ({
      ...r,
      when: r.when.toISOString(),
      payments: r.payments.map((p) => ({ ...p, paidAt: p.paidAt?.toISOString() ?? null })),
    })),
    qrs,
    appLinks,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  // "write", like every other mutating dashboard action. Without it a
  // read-only teammate could mark payments received — falsifying the
  // merchant's own reconciliation record, with their user id attached
  // as the person who confirmed it.
  const { connection, userId } = await requireTenant(request, params.connectionId!, "write");
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  const { shop, platform } = connection;

  try {
    if (intent === "request") {
      await Payments.requestPayment(shop, platform, Number(form.get("booking_id")), {
        kind: String(form.get("kind") || "deposit"),
        amount: Number(form.get("amount")) || undefined,
      });
      return { saved: true };
    }
    if (intent === "mark_paid") {
      await Payments.markPaid(shop, platform, Number(form.get("payment_id")), {
        userId,
        utr: String(form.get("utr") ?? ""),
      });
      return { saved: true };
    }
    if (intent === "cancel") {
      await Payments.cancelRequest(shop, platform, Number(form.get("payment_id")));
      return { saved: true };
    }
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message };
    throw err;
  }

  return { error: "Unknown action." };
}

const FILTERS = [
  { key: "outstanding", label: "Owed" },
  { key: "paid", label: "Settled" },
  { key: "all", label: "All" },
] as const;

export default function Orders({ loaderData, actionData, params }: Route.ComponentProps) {
  const { rows, filter, total, limit, settings, canRequest, blocker, qrs, appLinks, timezone } = loaderData;
  const v = useVocabulary();
  const [, setSearchParams] = useSearchParams();
  const cash = (amount: number) => money({ currency_symbol: settings.currencySymbol } as never, amount);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Orders"
        subtitle={`What each ${v.customerOne.toLowerCase()} owes, and what has arrived.`}
      />

      {actionData && "error" in actionData && actionData.error && <AlertError>{actionData.error}</AlertError>}

      {blocker === "nothing_configured" && (
        <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
          You haven't set up a way to be paid yet — add a UPI ID or PayPal link under{" "}
          <a href={`/dashboard/${params.connectionId}/settings?page=payments`} className="underline">
            Settings → Payments
          </a>
          .
        </div>
      )}

      {blocker === "upi_wrong_currency" && (
        // The case that produced a button which could not work: a UPI ID
        // is set, so the old check said "ready", but the shop prices in
        // something other than rupees.
        <div className="rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
          <strong>UPI can't be used while you price in {settings.currency}.</strong> UPI only settles in rupees, so
          a link for a {settings.currencySymbol} amount would ask your {v.customerOne.toLowerCase()} for the wrong
          money. Either add a PayPal.me link under{" "}
          <a href={`/dashboard/${params.connectionId}/settings?page=payments`} className="underline">
            Settings → Payments
          </a>
          , or switch your currency to INR under{" "}
          <a href={`/dashboard/${params.connectionId}/settings?page=general`} className="underline">
            Settings → General
          </a>
          .
        </div>
      )}

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setSearchParams({ show: f.key })}
            className={filter === f.key ? "btn-pri" : "btn-sec"}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card p-[18px]">
          <p className="m-0 text-body text-muted">
            {filter === "outstanding"
              ? "Nothing outstanding. Every priced booking has been paid for."
              : `No ${v.bookingMany} with a price yet.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <OrderCard
              key={row.bookingId}
              row={row}
              qrs={qrs}
              appLinks={appLinks}
              cash={cash}
              canRequest={canRequest}
              timezone={timezone}
            />
          ))}
        </div>
      )}

      {total > rows.length && (
        // Never let a page imply it is the whole list. This screen used
        // to filter the newest hundred in memory and then announce
        // "Every priced booking has been paid for" — a false statement
        // on the one screen that exists to chase money.
        <p className="m-0 text-[12px] text-subtle">
          Showing the {limit} most recent of {total}.
        </p>
      )}

      {/* Said once at the bottom rather than on every row. */}
      <p className="m-0 text-[12px] text-subtle">
        Payments arrive in your own account — GetBooqin can't see them. Check your bank, then mark them here.
      </p>
    </div>
  );
}

type Row = Awaited<ReturnType<typeof loader>>["rows"][number];

function OrderCard({
  row, qrs, appLinks, cash, canRequest, timezone,
}: {
  row: Row;
  qrs: Record<number, string>;
  appLinks: Record<number, { id: string; label: string; url: string }[]>;
  cash: (amount: number) => string;
  canRequest: boolean;
  /** The business's own zone — never the viewer's. */
  timezone: string;
}) {
  const [showQr, setShowQr] = useState<number | null>(null);
  const [showApps, setShowApps] = useState<number | null>(null);
  const pending = row.payments.filter((p) => p.status === "pending");
  const settled = row.outstanding === 0;

  return (
    <div className="card p-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-body font-medium">{row.customerName || "—"}</span>
          {/* The contact details, right here. Chasing a payment means
              phoning somebody, and making that a second click to the
              customer record is the kind of friction that means it
              doesn't happen. */}
          <span className="text-meta text-muted">
            {row.serviceName} · {formatInZone(new Date(row.when), timezone)}
          </span>
          <span className="min-w-0 truncate text-[12px] text-subtle">
            {row.customerEmail && (
              <a href={`mailto:${row.customerEmail}`} className="text-brand-600 underline">
                {row.customerEmail}
              </a>
            )}
            {row.customerEmail && row.customerPhone ? " · " : ""}
            {row.customerPhone && (
              <a href={`tel:${row.customerPhone.replace(/[\s()-]/g, "")}`} className="text-brand-600 underline">
                {row.customerPhone}
              </a>
            )}
          </span>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-[3px]">
          <span className="num text-[15px] font-medium">{cash(row.price)}</span>
          <span className={`text-meta ${settled ? "text-ok" : "text-warn"}`}>
            {settled ? "Settled" : `${cash(row.outstanding)} owed`}
          </span>
          {row.paid > 0 && !settled && <span className="text-[12px] text-subtle">{cash(row.paid)} received</span>}
        </div>
      </div>

      {row.payments.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-row pt-3">
          {row.payments.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className="num shrink-0">{cash(p.amount)}</span>
                <span className="text-subtle">{p.kind}</span>
                <span className={p.status === "paid" ? "text-ok" : p.status === "cancelled" ? "text-subtle" : "text-warn"}>
                  {p.status}
                </span>
                {p.utr && <span className="num text-[11.5px] text-subtle">UTR {p.utr}</span>}
              </span>

              {p.status === "pending" && (
                <span className="flex shrink-0 flex-wrap items-center gap-2">
                  {p.link && (
                    <>
                      <a href={p.link} className="btn-link text-brand-600" target="_blank" rel="noreferrer">
                        Open link
                      </a>
                      {p.method === "upi" && (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => setShowApps(showApps === p.id ? null : p.id)}
                        >
                          {showApps === p.id ? "Hide apps" : "Pay with…"}
                        </button>
                      )}
                      <button type="button" className="btn-link" onClick={() => setShowQr(showQr === p.id ? null : p.id)}>
                        {showQr === p.id ? "Hide QR" : "Show QR"}
                      </button>
                    </>
                  )}
                  <MarkPaidForm paymentId={p.id} />
                  <Form method="post" className="contents">
                    <input type="hidden" name="_intent" value="cancel" />
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button type="submit" className="btn-link text-danger">Cancel</button>
                  </Form>
                </span>
              )}
            </div>
          ))}

          {showApps && appLinks[showApps]?.length > 0 && (
            // Named apps, because a bare upi:// link goes wherever
            // Android's default handler says — and WhatsApp registers as
            // one, so a customer could be taken to WhatsApp Pay with no
            // chooser and no way to use the app they actually have money in.
            <div className="flex flex-col gap-2 rounded-[9px] border border-line bg-canvas-alt p-3">
              <span className="text-[12px] text-subtle">Open this payment in:</span>
              <div className="flex flex-wrap gap-2">
                {appLinks[showApps].map((app) => (
                  <a
                    key={app.id}
                    href={app.url}
                    className="btn-sec no-underline hover:no-underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {app.label}
                  </a>
                ))}
              </div>
              <span className="text-[12px] text-subtle">
                Or send the QR — scanning from inside any UPI app always works.
              </span>
            </div>
          )}

          {showQr && qrs[showQr] && (
            <div className="flex flex-col items-center gap-2 rounded-[9px] border border-line bg-canvas-alt p-3">
              <img src={qrs[showQr]} alt="Payment QR code" className="h-[200px] w-[200px]" />
              <span className="text-[12px] text-subtle">Show this to {row.customerName || "your customer"} to scan.</span>
            </div>
          )}
        </div>
      )}

      {pending.length === 0 && !settled && canRequest && (
        <Form method="post" className="mt-3 border-t border-row pt-3">
          <input type="hidden" name="_intent" value="request" />
          <input type="hidden" name="booking_id" value={row.bookingId} />
          <input type="hidden" name="amount" value={row.outstanding} />
          {/* Labelled for what it is. Defaulting every request to
              "deposit" made a row for the full remaining balance read
              "₹1,500.00 deposit". */}
          <input type="hidden" name="kind" value={row.paid > 0 ? "balance" : "full"} />
          <button type="submit" className="btn-sec">Request {cash(row.outstanding)}</button>
        </Form>
      )}
    </div>
  );
}

/**
 * Marking a payment received.
 *
 * The UTR field is optional and deliberately not called "proof" — it is
 * the reference the customer's app showed them, and its only job is to
 * give the merchant something to search their bank statement for.
 */
function MarkPaidForm({ paymentId }: { paymentId: number }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn-sec" onClick={() => setOpen(true)}>
        Mark paid
      </button>
    );
  }

  return (
    <Form method="post" className="flex items-center gap-2">
      <input type="hidden" name="_intent" value="mark_paid" />
      <input type="hidden" name="payment_id" value={paymentId} />
      <input
        className="input w-[150px]"
        name="utr"
        placeholder="UTR (optional)"
        aria-label="UTR or reference"
        maxLength={40}
      />
      <button type="submit" className="btn-pri">Confirm</button>
      <button type="button" className="btn-link" onClick={() => setOpen(false)}>Cancel</button>
    </Form>
  );
}
