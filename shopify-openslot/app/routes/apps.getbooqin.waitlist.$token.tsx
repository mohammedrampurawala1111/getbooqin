import { DateTime } from "luxon";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, Form } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { throttle, clientIp } from "~/lib/http.server";
import { Waitlist, Data, Bookings, isGetBooqinError } from "getbooqin-core";

/**
 * Public claim page for a waitlist offer — reached by clicking the link in
 * the "a spot opened up" email (mailer.ts's waitlist_offered template), not
 * through the storefront booking widget. There's no widget view for this
 * yet (see waitlist.ts's header comment), so this is a small standalone
 * page: Shopify's App Proxy passes a non-`application/liquid` response
 * straight through rather than wrapping it in the shop's theme, and
 * root.tsx's Document shell is intentionally bare (no Polaris/App Bridge —
 * those only load inside app.tsx's embedded-admin layout), so plain inline
 * styles are the right call here, same reasoning as root.tsx's own
 * ErrorBoundary.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  const settings = await getSettings(shop);
  const entry = await Waitlist.getByToken(shop, params.token || "");
  const url = new URL(request.url);
  const errorMessage = url.searchParams.get("error");

  if (!entry) {
    return { businessName: settings.business_name, entry: null, booking: null, errorMessage };
  }

  const service = await Data.catalogService(shop, entry.serviceId);
  const isExpired = entry.status === "expired" || (entry.status === "offered" && !!entry.offerExpiresAt && entry.offerExpiresAt.getTime() < Date.now());

  let booking: { date: string; time: string; manageUrl: string } | null = null;
  if (entry.status === "claimed" && entry.resultingBookingId) {
    const b = await Bookings.get(shop, entry.resultingBookingId);
    if (b) {
      booking = {
        date: Bookings.localDate(b, settings.timezone),
        time: Bookings.localTime(b, settings.timezone),
        manageUrl: Bookings.manageUrl(b, settings),
      };
    }
  }

  return {
    businessName: settings.business_name,
    errorMessage,
    entry: {
      status: isExpired && entry.status === "offered" ? "expired" : entry.status,
      service: service?.name ?? "",
      date: entry.offeredStartUtc ? DateTime.fromJSDate(entry.offeredStartUtc, { zone: "utc" }).setZone(settings.timezone).toFormat("DDD") : "",
      time: entry.offeredStartUtc ? DateTime.fromJSDate(entry.offeredStartUtc, { zone: "utc" }).setZone(settings.timezone).toFormat("h:mm a") : "",
      expiresAt: entry.offerExpiresAt ? DateTime.fromJSDate(entry.offerExpiresAt, { zone: "utc" }).setZone(settings.timezone).toFormat("h:mm a") : "",
    },
    booking,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const url = new URL(request.url);
  try {
    const shop = await proxyShop(request);
    throttle(`waitlist-claim:${shop}:${clientIp(request)}`, 10);
    const settings = await getSettings(shop);
    await Waitlist.claim(shop, "shopify", settings.timezone, params.token || "");
    return redirect(url.pathname);
  } catch (err) {
    const message = isGetBooqinError(err) ? err.message : "Something went wrong. Please try again.";
    url.searchParams.set("error", message);
    return redirect(url.pathname + url.search);
  }
}

const page: React.CSSProperties = {
  display: "flex",
  minHeight: "100vh",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: 40,
  textAlign: "center",
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  color: "#1a1620",
};
const card: React.CSSProperties = { maxWidth: 420, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" };
const button: React.CSSProperties = {
  marginTop: 8,
  padding: "11px 22px",
  borderRadius: 8,
  background: "#8f3aa9",
  color: "white",
  fontSize: 14,
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const errorBanner: React.CSSProperties = {
  background: "#fbe9e7",
  color: "#9a3b2f",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 13,
  maxWidth: 420,
};

export default function WaitlistClaimPage() {
  const { businessName, entry, booking, errorMessage } = useLoaderData<typeof loader>();

  return (
    <div style={page}>
      {errorMessage && <div style={errorBanner}>{errorMessage}</div>}
      <div style={card}>
        {!entry ? (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>This link isn't valid</h1>
            <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>
              Please contact {businessName} directly if you're still looking for a time.
            </p>
          </>
        ) : entry.status === "claimed" ? (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>You're all set!</h1>
            {booking && (
              <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>
                {entry.service} on {booking.date} at {booking.time}.
              </p>
            )}
            {booking && (
              <a href={booking.manageUrl} style={{ ...button, textDecoration: "none", display: "inline-block" }}>
                Manage your booking
              </a>
            )}
          </>
        ) : entry.status === "expired" ? (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>This offer has expired</h1>
            <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>
              It's already been offered to the next person on the list. Please contact {businessName} if you'd still like to book.
            </p>
          </>
        ) : entry.status === "cancelled" ? (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>You're no longer on the waitlist</h1>
            <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>Contact {businessName} if you'd like to rejoin.</p>
          </>
        ) : (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>A spot opened up!</h1>
            <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>
              {entry.service} on {entry.date} at {entry.time}.
              <br />
              This offer expires at {entry.expiresAt} — first come, first served.
            </p>
            <Form method="post">
              <button type="submit" style={button}>
                Claim this spot
              </button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
