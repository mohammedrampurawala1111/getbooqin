import { DateTime } from "luxon";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, Form } from "react-router";
import { proxyShop, getSettings, waitlistPayload } from "~/lib/proxy.server";
import { throttle, clientIp, ok, fail } from "~/lib/http.server";
import { Waitlist, Data, Bookings, GetBooqinError, isGetBooqinError } from "getbooqin-core";

/**
 * Two things share this one route, both reached by an entry's own
 * identifier: the "a spot opened up" claim link from mailer.ts's
 * waitlist_offered email (keyed by the entry's secret offerToken) and the
 * widget's manage/leave card fetch (keyed by the entry's public uid, sent
 * with Accept: application/json — see booking.js's api()). They can't be
 * separate route files: React Router's file-based routing treats
 * `waitlist.$token` and a hypothetical `waitlist.$uid` as the identical
 * `/apps/getbooqin/waitlist/:id` pattern, so a second single-segment
 * dynamic file here would just collide. A plain browser GET (no JSON
 * Accept header) always gets this page's own bare-styled HTML — Shopify's
 * App Proxy passes a non-`application/liquid` response straight through
 * rather than wrapping it in the shop's theme, and root.tsx's Document
 * shell is intentionally bare (no Polaris/App Bridge — those only load
 * inside app.tsx's embedded-admin layout), so plain inline styles are the
 * right call here, same reasoning as root.tsx's own ErrorBoundary.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  const settings = await getSettings(shop);
  const id = params.token || "";
  const entry = (await Waitlist.getByToken(shop, id)) ?? (await Waitlist.getByUid(shop, id));
  const wantsJson = (request.headers.get("accept") || "").includes("application/json");

  if (wantsJson) {
    if (!entry) return fail(new GetBooqinError("getbooqin_not_found", "Waitlist entry not found.", 404));
    return ok(await waitlistPayload(shop, settings, entry));
  }

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

  // Reached via uid (the widget's manage/leave link, no offer yet) as well
  // as via offerToken (the "spot opened up" email) — offeredStartUtc only
  // exists in the latter case, so fall back to the requested window.
  const startUtc = entry.offeredStartUtc ?? entry.windowStartUtc;

  return {
    businessName: settings.business_name,
    errorMessage,
    entry: {
      uid: entry.uid,
      status: isExpired && entry.status === "offered" ? "expired" : entry.status,
      service: service?.name ?? "",
      date: startUtc ? DateTime.fromJSDate(startUtc, { zone: "utc" }).setZone(settings.timezone).toFormat("DDD") : "",
      time: startUtc ? DateTime.fromJSDate(startUtc, { zone: "utc" }).setZone(settings.timezone).toFormat("h:mm a") : "",
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
const ghostButton: React.CSSProperties = {
  marginTop: 8,
  padding: "10px 20px",
  borderRadius: 8,
  background: "transparent",
  color: "#545b68",
  fontSize: 13,
  fontWeight: 600,
  border: "1px solid #d8dbe0",
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
        ) : entry.status === "waiting" ? (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>You're on the waitlist</h1>
            <p style={{ margin: 0, color: "#545b68", fontSize: 14 }}>
              {entry.service}{entry.date ? ` on ${entry.date}` : ""}{entry.time ? ` at ${entry.time}` : ""}.
              <br />
              We'll email you the moment a spot opens up.
            </p>
            <Form method="post" action={`/apps/getbooqin/waitlist/${entry.uid}/leave`}>
              <button type="submit" style={ghostButton}>
                Leave the waitlist
              </button>
            </Form>
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
            <Form method="post" action={`/apps/getbooqin/waitlist/${entry.uid}/leave`}>
              <button type="submit" style={ghostButton}>
                Leave the waitlist
              </button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
