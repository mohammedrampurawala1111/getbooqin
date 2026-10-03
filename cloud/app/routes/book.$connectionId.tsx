import { useCallback, useEffect, useMemo, useState } from "react";
import { data, isRouteErrorResponse, redirect, useFetcher, useRevalidator, useRouteError, useSearchParams } from "react-router";
import type { Route } from "./+types/book.$connectionId";
import {
  Data,
  Bookings,
  Entitlements,
  WhatsAppAccounts,
  Settings as CoreSettings,
  Waitlist,
  getPublicConnection,
  isGetBooqinError,
} from "getbooqin-core";
import { formatInZone, wallClockToUtc, zoneAbbr } from "getbooqin-core/booking/tz";
// The same generator the confirmation email attaches, rather than a
// second one here: the two drifted, and this copy escaped nothing and
// folded nothing, so a service called "Cut, colour & finish" produced a
// file some calendars refused.
import { calendarLinks, icsFilename, type CalendarEvent } from "getbooqin-core/booking/calendar";
// The message type and the param that triggers it are defined once, in
// core, because the other end of this protocol is a string we hand a
// merchant to paste into a website we will never see. The two halves
// cannot be changed together, so they have to share a definition —
// see booking/embed.ts.
import { EMBED_MESSAGE_TYPE, EMBED_QUERY_PARAM } from "getbooqin-core/booking/embed";
import { vocabFor } from "~/lib/presets";
import { AlertError, Badge, ConfirmDialog, Field, FormErrorSummary, Input } from "~/components/ui";
import { LogoMark } from "~/components/onboarding";
import { throttle, clientIp } from "~/lib/http.server";
import { contactFieldErrors, isValidEmail, isValidPhone, PHONE_PATTERN } from "~/lib/validation";

export const meta: Route.MetaFunction = ({ data: loaderData }) =>
  loaderData ? [{ title: `Book with ${loaderData.businessName} · GetBooqin` }] : [{ title: "Book · GetBooqin" }];

// Only the fields the public page actually needs — never spread the raw
// Settings object into loader data. settings.admin_email and the rest of
// the business configuration are internal-only; React Router serializes
// whatever a loader returns straight to the browser, so leaking that
// object here would be a real disclosure, not just over-fetch.
function publicSettings(settings: CoreSettings.Settings, whatsappLive = false) {
  return {
    businessName: settings.business_name,
    // Business header (Defect Dossier's BQ-33 finding) — the page
    // previously showed only the name, with none of a business's already-
    // collected contact details reaching a prospective client.
    businessDescription: settings.business_description,
    businessAddress: settings.business_address,
    businessPhone: settings.business_phone,
    currencySymbol: settings.currency_symbol,
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    requireEmail: settings.require_email,
    // Drives the date picker's own min/max (GetBooqin clinic audit's PB-05
    // finding) — previously the field had a min of "tomorrow" and no max
    // at all, so a date 3 years out or inside an active minimum-notice
    // window was freely selectable and then blamed on the day itself
    // ("No open times that day") instead of being told it was out of
    // range in the first place.
    minNoticeHours: settings.min_notice_hours,
    maxAdvanceDays: settings.max_advance_days,
    intakeFields: settings.intake_fields,
    allowCancel: settings.allow_cancel,
    consentText: settings.consent_text,
    // Drives the WhatsApp opt-in checkbox. Asked of the connected
    // account rather than of the plan alone: a merchant who is entitled
    // but has not connected, or whose templates are still in review,
    // must not be collecting a consent nothing can act on.
    whatsappAvailable: whatsappLive,
    privacyNoticeUrl: settings.privacy_notice_url || "/legal/privacy",
    // Backs the "Join the waitlist" prompt on an empty-availability day —
    // the waitlist could be enabled, wired to freed slots, and have a real
    // offer window configured, and the public page still never mentioned
    // it at the one moment a patient is most willing to queue for a spot
    // (GetBooqin clinic audit's PB-04 finding).
    waitlistEnabled: settings.waitlist_enabled,
  };
}

// Schedule.dayOfWeek is 0 (Sun) - 6 (Sat); reordered to a natural Mon-first
// read for the business-hours summary.
const HOURS_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS_DAY_ABBR: Record<number, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

/**
 * "Mon–Fri 09:00–18:00, Sat 10:00–14:00" — groups consecutive open days
 * sharing the exact same hours, the same idea as the onboarding preview's
 * summarizeHours() but supporting hours that vary by day (a whole
 * business's hours are the union of possibly-different resource
 * schedules, see Data.businessHours). Closed days are omitted rather than
 * spelled out; the open days already say what's bookable.
 */
function formatBusinessHours(hours: Array<{ dayOfWeek: number; open: boolean; start: string; end: string }>): string {
  const byDay = new Map(hours.map((h) => [h.dayOfWeek, h]));
  const ordered = HOURS_DAY_ORDER.map((d) => byDay.get(d)).filter((h): h is NonNullable<typeof h> => !!h && h.open);
  if (ordered.length === 0) return "";

  const groups: { start: string; end: string; days: number[] }[] = [];
  for (const h of ordered) {
    const last = groups[groups.length - 1];
    if (last && last.start === h.start && last.end === h.end && last.days[last.days.length - 1] === HOURS_DAY_ORDER[HOURS_DAY_ORDER.indexOf(h.dayOfWeek) - 1]) {
      last.days.push(h.dayOfWeek);
    } else {
      groups.push({ start: h.start, end: h.end, days: [h.dayOfWeek] });
    }
  }

  return groups
    .map((g) => {
      const dayLabel = g.days.length > 1 ? `${HOURS_DAY_ABBR[g.days[0]]}–${HOURS_DAY_ABBR[g.days[g.days.length - 1]]}` : HOURS_DAY_ABBR[g.days[0]];
      return `${dayLabel} ${g.start}–${g.end}`;
    })
    .join(", ");
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const connection = await getPublicConnection(params.connectionId!);
  if (!connection) throw data("This booking page isn't available.", { status: 404 });

  const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
  const vocab = vocabFor(settings.terms);
  // The `no_badge` entitlement, resolved once for every branch below.
  const entitlements = await Entitlements.entitlementsFor(connection.id);
  const showBadge = !entitlements.features.has("no_badge");
  // Whether the opt-in checkbox is worth showing at all: entitled,
  // connected, and with at least the confirmation template approved by
  // Meta. Anything less and the box collects a consent that can never
  // be acted on, which teaches a customer to expect messages that never
  // arrive.
  const whatsappLive = entitlements.features.has("whatsapp")
    ? await WhatsAppAccounts.canSend(connection.id)
    : false;
  // Branding is a paid entitlement, and it is checked here rather than
  // trusted from settings: a merchant who upgraded, set a logo, then
  // downgraded still has the value stored. The page they get is the one
  // their plan pays for, not the one their settings row remembers.
  const brand = entitlements.features.has("branding")
    ? { logo: settings.brand_logo, accent: settings.brand_accent }
    : { logo: "", accent: "" };

  const search = new URL(request.url).searchParams;

  // Waitlist.claimUrl() builds this for a non-Shopify account — the
  // "claim it here" link in an offer email. The Shopify half of the
  // product has had a view for this all along (the app-proxy route at
  // /apps/getbooqin/waitlist/:token); the cloud half had the emails and
  // no page to land on, so the link went nowhere. See claimUrl().
  const claimToken = search.get("getbooqin_claim");
  if (claimToken) {
    const entry = await Waitlist.getByToken(connection.shop, claimToken);
    if (!entry) throw data("That waitlist offer couldn't be found.", { status: 404 });
    // entry.service is the raw ServiceConfig row, which has no display
    // name — the name lives in the product cache. Same lookup every other
    // branch of this loader uses.
    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, entry.serviceId),
      entry.offeredResourceId ? Data.resource(connection.shop, entry.offeredResourceId) : Promise.resolve(null),
    ]);
    return {
      mode: "claim" as const,
      showBadge,
      brand,
      businessName: settings.business_name,
      vocab,
      token: claimToken,
      offer: {
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        // Null before an offer is made; the template only renders a
        // claimable offer, and the component refuses anything else.
        when: entry.offeredStartUtc ? formatInZone(entry.offeredStartUtc, settings.timezone) : "",
        expiresAt: entry.offerExpiresAt ? formatInZone(entry.offerExpiresAt, settings.timezone) : "",
        status: entry.status,
        expired: !entry.offerExpiresAt || entry.offerExpiresAt.getTime() < Date.now(),
      },
    };
  }

  // Waitlist.manageUrl() — the "leave the waitlist" link carried by every
  // waitlist email. Same gap as the claim link above: the URL was being
  // generated correctly, and this page ignored the parameter and rendered
  // the booking wizard as though nothing had been asked.
  const waitlistUid = search.get("getbooqin_waitlist");
  if (waitlistUid) {
    const entry = await Waitlist.getByUid(connection.shop, waitlistUid);
    if (!entry) throw data("That waitlist entry couldn't be found.", { status: 404 });
    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, entry.serviceId),
      entry.resourceId ? Data.resource(connection.shop, entry.resourceId) : Promise.resolve(null),
    ]);
    return {
      mode: "waitlist" as const,
      showBadge,
      brand,
      businessName: settings.business_name,
      vocab,
      entry: {
        uid: entry.uid,
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        when: formatInZone(entry.windowStartUtc, settings.timezone),
        status: entry.status,
      },
    };
  }

  // Bookings.manageUrl() builds exactly this query param — this is the link
  // a (now-fixed) confirmation/cancel email points customers back to.
  const uid = search.get("getbooqin_booking");
  if (uid) {
    const booking = await Bookings.getByUid(connection.shop, uid);
    if (!booking) throw data("That booking couldn't be found.", { status: 404 });
    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, booking.serviceId),
      Data.resource(connection.shop, booking.resourceId),
    ]);
    return {
      mode: "manage" as const,
      showBadge,
      brand,
      businessName: settings.business_name,
      businessPhone: settings.business_phone,
      vocab,
      booking: {
        uid: booking.uid,
        status: booking.status,
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        when: formatInZone(booking.startUtc, Bookings.displayTz(booking, settings.timezone)),
        priceLabel: booking.price > 0 ? `${settings.currency_symbol}${booking.price.toFixed(2)}` : "",
      },
      // Drives the reschedule slot picker (10-01-2026 review, item 8) —
      // the same /slots resource route the booking wizard uses, which
      // needs the service and resource to compute availability against.
      // Ids only; nothing here is a disclosure the manage page doesn't
      // already make by naming both.
      serviceId: booking.serviceId,
      resourceId: booking.resourceId,
      minNoticeHours: settings.min_notice_hours,
      maxAdvanceDays: settings.max_advance_days,
      canCancel: Bookings.customerCanCancel(booking, settings),
      // Why cancellation isn't available, when it isn't — "" when it is.
      // See cancelUnavailableReason's own comment for the un-cancellable-
      // from-the-moment-it's-booked case this exists to explain (GetBooqin
      // clinic audit's PB-01 finding).
      cancelUnavailableReason: Bookings.cancelUnavailableReason(booking, settings),
    };
  }

  const [services, resources, hours] = await Promise.all([
    Data.catalogServices(connection.shop, connection.platform),
    // Practitioners only — a room is an internal scheduling detail with no
    // customer-facing picker of its own; Bookings.create() secures one
    // automatically once a practitioner and time are chosen (GetBooqin
    // clinic audit's RS-01 finding).
    Data.resources(connection.shop, connection.platform, true, "practitioner"),
    Data.businessHours(connection.shop, connection.platform),
  ]);

  return {
    mode: "book" as const,
    showBadge,
    brand,
    connectionId: connection.id,
    businessName: settings.business_name,
    businessHours: formatBusinessHours(hours),
    vocab,
    settings: publicSettings(settings, whatsappLive),
    services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price, description: s.description })),
    // title/description/avatarUrl back the "Choose who you'd like to see"
    // step (Defect Dossier's BQ-33 finding) — previously dropped down to
    // just {id, name}, so a resource's own profile never reached the page.
    resources: resources.map((r) => ({ id: r.id, name: r.name, title: r.title, description: r.description ?? "", avatarUrl: r.avatarUrl })),
  };
}

function sanitizeCustomFields(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === "string" && (typeof value === "string" || typeof value === "number")) {
      out[key] = String(value).slice(0, 2000);
    }
  }
  return out;
}

async function handleBook(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  // Honeypot: real customers never fill this in — named so browser autofill
  // never volunteers a value into it, same convention as the Shopify widget's
  // App Proxy route. Silently "succeeds" from the caller's point of view
  // rather than surfacing an error a bot would learn from.
  if (String(form.get("hp_company") || "").trim() !== "") {
    return { spam: true };
  }

  try {
    throttle(`book:${connectionId}:${clientIp(request)}`, 8);

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    const intakeValues: Record<string, string> = {};
    for (const field of settings.intake_fields) {
      intakeValues[field.key] = String(form.get(`intake_${field.key}`) || "");
    }

    // Mirrors the client-side check in DetailsForm — required-phone is
    // business configuration, so a request that skips (or defeats) the
    // client check must still be rejected server-side with the same
    // field-level shape the form knows how to render (Defect Dossier's
    // BQ-24 finding, item 4).
    const fieldErrors = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.require_phone,
      // require_email, not just require_phone. contactFieldErrors
      // defaults requireEmail to true, so omitting it meant a shop that
      // had turned the email requirement *off* still rejected a booking
      // with no email — on a field the page itself rendered as optional.
      // A walk-in customer without an address had no way through.
      settings.require_email
    );
    for (const field of settings.intake_fields) {
      if (field.required && !intakeValues[field.key]?.trim()) {
        fieldErrors[`intake_${field.key}`] = `Enter ${field.label.toLowerCase()}.`;
      }
    }
    // The consent checkbox is new UI (TS-01) with no server-side twin to
    // bypass it before this — same defense-in-depth as require_phone's own
    // mirrored client/server check just above.
    if (form.get("consent") !== "on") {
      fieldErrors.consent = "Please agree to the privacy notice to continue.";
    }
    if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

    const booking = await Bookings.create(connection.shop, connection.platform, settings.timezone, {
      service_id: Number(form.get("service_id") || 0),
      resource_id: Number(form.get("resource_id") || 0) || undefined,
      date: String(form.get("date") || ""),
      time: String(form.get("time") || ""),
      first_name: String(form.get("first_name") || ""),
      last_name: String(form.get("last_name") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      notes: String(form.get("notes") || ""),
      custom_fields: sanitizeCustomFields(intakeValues),
      // Re-asked here rather than trusted from the submitted form: the
      // same defence-in-depth the consent checkbox above gets. A ticked
      // box on a page whose merchant cannot send is not consent to
      // anything, and `undefined` — not `false` — is what "this surface
      // never asked" has to mean, so a decline nobody made is never
      // recorded over an earlier yes.
      whatsapp_opt_in: (await WhatsAppAccounts.canSend(connection.id))
        ? form.get("whatsapp_opt_in") === "on"
        : undefined,
      whatsapp_opt_in_source: "booking_form",
      source: "form",
    });

    // The merchant's own thank-you page, when they have configured one
    // (10-01-2026 review, item 9). Only for a booking that is actually
    // on: a pending request still needs our panel to say so, and sending
    // someone to a page that reads "thanks, you're booked" when they are
    // not is worse than not redirecting at all.
    //
    // Re-checked here even though it was validated at write time — a row
    // written before that validation existed, or edited around it, must
    // not become an open redirect on the public page. Cheap, and this is
    // the boundary that actually matters.
    //
    // Never when embedded. The page runs inside an iframe on the
    // merchant's own site (see EMBED_QUERY_PARAM and useEmbedHeight), and
    // redirecting there would load their whole thank-you page into a
    // widget-sized frame — their site inside their site. Breaking out
    // isn't available either: window.top is cross-origin here. So an
    // embedded booking keeps the built-in panel, which is the thing
    // actually designed to render at that size.
    const embedded = new URL(request.url).searchParams.get(EMBED_QUERY_PARAM) === "1";
    if (!embedded && booking.status === "confirmed" && settings.thank_you_url && CoreSettings.isSafeRedirectUrl(settings.thank_you_url)) {
      const target = new URL(settings.thank_you_url);
      // So the merchant's page can acknowledge the specific booking —
      // and so conversion tracking has something to deduplicate on.
      target.searchParams.set("ref", booking.uid);
      throw redirect(target.toString());
    }

    const [service, resource] = await Promise.all([
      Data.catalogService(connection.shop, booking.serviceId),
      Data.resource(connection.shop, booking.resourceId),
    ]);

    return {
      booking: {
        uid: booking.uid,
        status: booking.status,
        serviceName: service?.name ?? "",
        resourceName: resource?.name ?? "",
        when: formatInZone(booking.startUtc, Bookings.displayTz(booking, settings.timezone)),
        startIso: booking.startUtc.toISOString(),
        endIso: booking.endUtc.toISOString(),
        // The confirmation used to say "confirmed" and "a confirmation has
        // been sent" regardless of actual status, and gave a customer whose
        // settings allow cancelling no way to act on it — no reference, no
        // manage link, no cutoff, no calendar file (Defect Dossier's BQ-28
        // finding).
        canCancel: Bookings.customerCanCancel(booking, settings),
        cancelCutoffHours: settings.cancel_cutoff_hours,
        // Surfaced immediately on the confirmation screen rather than only
        // discovered later on the manage page — a booking made inside the
        // cancellation window is un-cancellable from this exact moment
        // (GetBooqin clinic audit's PB-01 finding), and the sooner a
        // patient knows that, the sooner they can call instead of assuming
        // the "View or cancel" link will work when they need it.
        cancelUnavailableReason: Bookings.cancelUnavailableReason(booking, settings),
        businessPhone: settings.business_phone,
      },
    };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

/**
 * Public "Join the waitlist" — the waitlist backend (Waitlist.join, freed-
 * slot offers, the offer window) was already fully wired, but only staff
 * could add someone to it; the public booking page never mentioned it even
 * on its own empty-availability screen (GetBooqin clinic audit's PB-04
 * finding). Same throttle bucket convention as handleBook/handleCancel.
 */
async function handleJoinWaitlist(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  if (String(form.get("hp_company") || "").trim() !== "") {
    return { spam: true };
  }

  try {
    throttle(`waitlist:${connectionId}:${clientIp(request)}`, 8);
    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    if (!settings.waitlist_enabled) return { error: "The waitlist isn't available for this business." };

    const fieldErrors = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.require_phone,
      settings.require_email
    );
    if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

    await Waitlist.join(connection.shop, connection.platform, settings.timezone, {
      service_id: Number(form.get("service_id") || 0),
      resource_id: Number(form.get("resource_id") || 0) || undefined,
      window_start: String(form.get("date") || ""),
      first_name: String(form.get("first_name") || ""),
      last_name: String(form.get("last_name") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      notes: String(form.get("notes") || ""),
    });
    return { waitlisted: true };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

async function handleCancel(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  try {
    throttle(`manage:${connectionId}:${clientIp(request)}`, 8);

    const uid = String(form.get("uid") || "");
    const booking = await Bookings.getByUid(connection.shop, uid);
    if (!booking) return { error: "That booking couldn't be found." };

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    if (!Bookings.customerCanCancel(booking, settings)) {
      return { error: "This booking can no longer be cancelled here — please contact the business directly." };
    }

    await Bookings.setStatus(connection.shop, booking.id, "cancelled", "cancelled by customer");
    return { cancelled: true };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

/**
 * Public "Reschedule" — item 8 of the 10-01-2026 review.
 *
 * Bookings.reschedule() has existed for a long time: it re-runs the full
 * availability check, respects the slot lattice, and fires the
 * booking_rescheduled event the mailer already listens for. The only
 * thing missing was a way for a customer to reach it — the manage page
 * said "Need to change the time instead? Contact the business directly",
 * which is a human doing by hand what the server could already do.
 *
 * Gated on customerCanCancel(), deliberately. Moving an appointment and
 * cancelling it are the same decision from the business's side — the slot
 * is given up either way — so a customer who is inside the cancellation
 * cutoff must not be able to reschedule out of it instead. One policy,
 * not two that can disagree.
 *
 * No `override`: that escape hatch is for staff, who can see the whole
 * diary and take responsibility for a double-booking. A customer gets
 * the published slots and nothing else.
 */
async function handleReschedule(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  try {
    // Same bucket as cancel: both are "act on an existing booking you
    // hold the uid for", and a reschedule loop is the cheaper way to
    // probe the diary of the two.
    throttle(`manage:${connectionId}:${clientIp(request)}`, 8);

    const uid = String(form.get("uid") || "");
    const booking = await Bookings.getByUid(connection.shop, uid);
    if (!booking) return { error: "That booking couldn't be found." };

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    if (!Bookings.customerCanCancel(booking, settings)) {
      return { error: "This booking can no longer be changed here — please contact the business directly." };
    }

    const date = String(form.get("date") || "");
    const time = String(form.get("time") || "");
    if (!date || !time) return { error: "Choose a new date and time first." };

    await Bookings.reschedule(
      connection.shop,
      connection.platform,
      settings.timezone,
      booking.id,
      date,
      time,
      // Same resource. A customer changing their time has not asked to
      // change who they are seeing, and silently reassigning them would
      // be a different appointment wearing the same reference.
      booking.resourceId
    );
    return { rescheduled: true };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

/**
 * Accept a waitlist offer. The counterpart to the claim view's one
 * button — Waitlist.claim() does the real work (re-checks the offer is
 * still `offered`, still inside its expiry, and turns it into a real
 * Booking), and this is the public entry point the cloud product never
 * had.
 */
async function handleClaimWaitlist(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  try {
    throttle(`manage:${connectionId}:${clientIp(request)}`, 8);
    const token = String(form.get("token") || "");
    if (!token) return { error: "That offer link is incomplete." };

    const settings = await CoreSettings.getSettings(connection.shop, connection.platform);
    const booking = await Waitlist.claim(connection.shop, connection.platform, settings.timezone, token);
    return { claimed: true, bookingUid: booking.uid };
  } catch (err) {
    // claim() throws a precise, already-customer-readable message for
    // every losing case — already claimed, withdrawn, expired — and
    // those are the common paths here, not the exceptional ones.
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

/** Leave the waitlist, from the link in every waitlist email. */
async function handleLeaveWaitlist(connectionId: string, request: Request, form: FormData) {
  const connection = await getPublicConnection(connectionId);
  if (!connection) return { error: "This booking page isn't available." };

  try {
    throttle(`manage:${connectionId}:${clientIp(request)}`, 8);
    const uid = String(form.get("uid") || "");
    if (!uid) return { error: "That link is incomplete." };
    // Idempotent by construction (updateMany over waiting|offered), so a
    // double-click or a re-opened email is not an error.
    await Waitlist.leaveByUid(connection.shop, uid);
    return { left: true };
  } catch (err) {
    if (isGetBooqinError(err)) return { error: err.message, code: err.code };
    throw err;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return { error: "Method not allowed." };
  const form = await request.formData();
  const intent = String(form.get("_intent") || "");
  const connectionId = params.connectionId!;

  if (intent === "book") return handleBook(connectionId, request, form);
  if (intent === "cancel") return handleCancel(connectionId, request, form);
  if (intent === "reschedule") return handleReschedule(connectionId, request, form);
  if (intent === "claim_waitlist") return handleClaimWaitlist(connectionId, request, form);
  if (intent === "leave_waitlist") return handleLeaveWaitlist(connectionId, request, form);
  if (intent === "join_waitlist") return handleJoinWaitlist(connectionId, request, form);
  return { error: "Unknown request." };
}

/* ================================================================== */

/**
 * `showBadge` is the `no_badge` entitlement, inverted.
 *
 * This is the thing Starter is actually sold on — "$5 takes the badge
 * off" — and until now the badge rendered for everyone regardless of
 * plan, which made the cheapest paid tier's headline benefit a promise
 * the product didn't keep.
 *
 * Defaults to showing it: a page that can't work out the plan (a
 * connection mid-setup, a failed lookup) should look like the free
 * product, not silently hand out a paid one.
 */
/**
 * `?embed=1` — the same page, framed inside someone else's website.
 *
 * Read from the URL here rather than threaded through as a prop,
 * because every caller of Shell would have to pass it and none of them
 * has an opinion about it: whether this page is inside an iframe is a
 * fact about the request, not about the booking flow.
 *
 * Two differences, both about not competing with the host page. The
 * business's own name and logo come off — the site it is embedded in
 * has said who it is already, at the top of the page, usually larger.
 * And the full-viewport height and page background come off, because
 * inside an iframe "the viewport" is the iframe, and a fixed 100dvh
 * would guarantee the scrollbar-inside-a-scrollbar that makes embedded
 * widgets feel cheap.
 *
 * The GetBooqin badge stays exactly as it is — it is the `no_badge`
 * entitlement that decides that, and an iframe is not a way around a
 * paid plan.
 */
function Shell({
  businessName, showBadge = true, brand, children,
}: {
  businessName: string;
  showBadge?: boolean;
  /** Paid branding, already resolved against the account's entitlements by the loader. */
  brand?: { logo: string; accent: string };
  children: React.ReactNode;
}) {
  const [searchParams] = useSearchParams();
  const embedded = searchParams.get(EMBED_QUERY_PARAM) === "1";

  useEmbedHeight(embedded);

  // The accent drives the existing brand custom properties rather than
  // any new styling, so one value re-skins every button, focus ring and
  // selected state on the page without a second design to maintain.
  const accent = brand?.accent;
  const style = accent
    ? ({ "--color-brand-500": accent, "--color-brand-600": accent } as React.CSSProperties)
    : undefined;

  return (
    <div
      style={style}
      className={
        embedded
          ? "flex flex-col items-center px-3 py-4"
          : "flex min-h-dvh flex-col items-center bg-canvas px-4 py-8 sm:px-8"
      }
    >
      <div className="flex w-full max-w-[480px] flex-col gap-5">
        {!embedded && (
          <div className="flex items-center gap-[10px]">
            {/* The merchant's mark replaces ours entirely when they have
                one — a paid booking page should not carry two logos, and
                the one it carries should be theirs. */}
            {brand?.logo ? (
              <img
                src={brand.logo}
                alt=""
                className="h-[26px] w-auto max-w-[140px] object-contain"
              />
            ) : (
              <LogoMark size={26} />
            )}
            <span className="min-w-0 truncate text-[15px] font-semibold">{businessName}</span>
          </div>
        )}
        {children}
        {showBadge && (
          <p className="mt-2 text-center text-[11.5px] text-subtle">Booking powered by GetBooqin</p>
        )}
      </div>
    </div>
  );
}

/**
 * Tells the host page how tall this content is, so the iframe can grow
 * with it instead of scrolling inside itself.
 *
 * The alternative is a fixed iframe height, which is wrong at every
 * step of the flow: a date picker and a confirmation screen are
 * nowhere near the same size, and picking one number means clipping one
 * of them or leaving a hole under the other.
 *
 * `targetOrigin` is "*" deliberately — the whole point is that this is
 * embedded on a site whose domain we do not know, and the message
 * carries nothing but a number. Nothing is ever read back *from* the
 * host: a listener here would be an opening onto a page we do not
 * control, for no gain.
 */
function useEmbedHeight(embedded: boolean) {
  useEffect(() => {
    if (!embedded || typeof window === "undefined") return;

    let last = 0;
    const report = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (height === last) return;
      last = height;
      // targetOrigin "*" is the correct call rather than a lapse: we do
      // not know which site has embedded us, and the payload is a number
      // describing our own layout. The receiving end is the half that
      // verifies — the snippet checks origin *and* frame identity before
      // believing anything.
      window.parent.postMessage({ type: EMBED_MESSAGE_TYPE, height }, "*");
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [embedded]);
}

/**
 * Keeps a failure inside the booking page.
 *
 * Without this, any throw from the loader — or from the sibling slots
 * resource route a fetcher calls — propagated to the root boundary and
 * replaced the whole document with "Something went wrong · Back to
 * home", mid-flow, with the customer's service, date and time
 * selections gone. The likeliest trigger is mundane: the slots
 * endpoint is throttled per IP, and a waiting room, a clinic's wifi or
 * any carrier NAT shares one. Several customers comparing dates at once
 * would eject all of them to the marketing site.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  const message =
    status === 404
      ? "We couldn't find that booking page."
      : status === 429
        ? "That was a lot of requests at once. Give it a moment and try again."
        : "Something went wrong loading this page.";

  return (
    <div className="flex min-h-dvh flex-col items-center bg-canvas px-4 py-8 sm:px-8">
      <div className="flex w-full max-w-[480px] flex-col gap-5">
        <div className="card flex flex-col items-center gap-3 p-[18px] text-center">
          <h1 className="ob-h1 m-0">{message}</h1>
          <p className="m-0 text-body text-muted">
            Your details haven't been sent anywhere. Reloading usually fixes it.
          </p>
          <button type="button" className="btn-pri" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BookingPage({ loaderData, params }: Route.ComponentProps) {
  if (loaderData.mode === "claim") {
    return (
      <ClaimOffer
        businessName={loaderData.businessName}
        showBadge={loaderData.showBadge}
        brand={loaderData.brand}
        vocab={loaderData.vocab}
        token={loaderData.token}
        offer={loaderData.offer}
      />
    );
  }
  if (loaderData.mode === "waitlist") {
    return (
      <WaitlistEntryView
        businessName={loaderData.businessName}
        showBadge={loaderData.showBadge}
        brand={loaderData.brand}
        vocab={loaderData.vocab}
        entry={loaderData.entry}
      />
    );
  }
  if (loaderData.mode === "manage") {
    return (
      <ManageBooking
        connectionId={params.connectionId!}
        businessName={loaderData.businessName}
        businessPhone={loaderData.businessPhone}
        showBadge={loaderData.showBadge}
        brand={loaderData.brand}
        vocab={loaderData.vocab}
        initial={loaderData.booking}
        serviceId={loaderData.serviceId}
        resourceId={loaderData.resourceId}
        minNoticeHours={loaderData.minNoticeHours}
        maxAdvanceDays={loaderData.maxAdvanceDays}
        canCancelInitial={loaderData.canCancel}
        cancelUnavailableReason={loaderData.cancelUnavailableReason}
      />
    );
  }
  return <BookingFlow loaderData={loaderData} />;
}

/* ----------------------------------------------------------- Claim view */

/**
 * "A spot opened up — claim it." The landing page for a waitlist offer
 * email's claim link on a non-Shopify account.
 *
 * The whole flow behind this already existed — matchAndOffer() makes the
 * offer when a booking is cancelled, the email goes out, expireStaleOffers()
 * cascades it to the next person if nobody takes it. What did not exist
 * was anywhere for a cloud merchant's customer to land, because the link
 * pointed at a Shopify app-proxy path built from the internal shop key.
 * See Waitlist.claimUrl().
 *
 * First come, first served with a hard expiry, so this is deliberately
 * one button and no form: every field we would ask for, we already have
 * from when they joined the waitlist, and the time spent typing is time
 * the offer can expire in.
 */
function ClaimOffer({
  businessName, showBadge, brand, vocab, token, offer,
}: {
  businessName: string;
  showBadge: boolean;
  brand: { logo: string; accent: string };
  vocab: ReturnType<typeof vocabFor>;
  token: string;
  offer: { serviceName: string; resourceName: string; when: string; expiresAt: string; status: string; expired: boolean };
}) {
  const fetcher = useFetcher<{ claimed?: boolean; bookingUid?: string; error?: string }>();
  const submitting = fetcher.state !== "idle";

  if (fetcher.data?.claimed) {
    return (
      <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
        <div className="card p-[18px] text-center">
          <h1 className="ob-h1 mb-1">It's yours</h1>
          <p className="m-0 text-body text-muted">
            {offer.serviceName} on {offer.when} is confirmed. We've emailed you the details.
          </p>
        </div>
      </Shell>
    );
  }

  // Claimable only while the offer is actually live. Rendering the button
  // for an expired or already-taken offer would be inviting a click whose
  // only possible outcome is a refusal.
  const claimable = offer.status === "offered" && !offer.expired;

  return (
    <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
      <div className="card p-[18px]">
        <h1 className="ob-h1 mb-1">A {vocab.bookingOne} opened up</h1>
        {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
        <div className="flex flex-col gap-[6px] text-body">
          <span className="font-medium">{offer.serviceName}</span>
          {offer.resourceName && <span className="text-muted">with {offer.resourceName}</span>}
          <span className="text-muted">{offer.when}</span>
        </div>

        {claimable ? (
          <>
            <p className="mt-3 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
              First come, first served — this offer is held until {offer.expiresAt}.
            </p>
            <fetcher.Form method="post" className="mt-3">
              <input type="hidden" name="_intent" value="claim_waitlist" />
              <input type="hidden" name="token" value={token} />
              <button type="submit" className="btn-pri w-full justify-center" disabled={submitting}>
                {submitting ? "Claiming…" : `Claim this ${vocab.bookingOne}`}
              </button>
            </fetcher.Form>
          </>
        ) : (
          <p className="mt-3 rounded-[8px] bg-canvas-alt px-3 py-2 text-[12.5px] text-muted">
            {offer.status === "claimed"
              ? "This offer has already been claimed."
              : offer.expired
                ? "This offer has expired — we've passed it to the next person on the list."
                : "This offer is no longer available."}{" "}
            You're still on the waitlist if another time opens up.
          </p>
        )}
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------- Waitlist view */

/**
 * The "leave the waitlist" landing page. Waitlist.manageUrl() has been
 * putting this link in every waitlist email all along; this page used to
 * ignore the parameter entirely and render the booking wizard, so the
 * link silently did nothing.
 */
function WaitlistEntryView({
  businessName, showBadge, brand, vocab, entry,
}: {
  businessName: string;
  showBadge: boolean;
  brand: { logo: string; accent: string };
  vocab: ReturnType<typeof vocabFor>;
  entry: { uid: string; serviceName: string; resourceName: string; when: string; status: string };
}) {
  const fetcher = useFetcher<{ left?: boolean; error?: string }>();
  const submitting = fetcher.state !== "idle";
  const gone = fetcher.data?.left || entry.status === "cancelled";

  return (
    <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
      <div className="card p-[18px]">
        <h1 className="ob-h1 mb-1">Your waitlist place</h1>
        {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
        <div className="flex flex-col gap-[6px] text-body">
          <span className="font-medium">{entry.serviceName}</span>
          {entry.resourceName && <span className="text-muted">with {entry.resourceName}</span>}
          <span className="text-muted">Hoping for {entry.when}</span>
          <span className="mt-1 w-fit">
            <Badge
              status={gone ? "cancelled" : "pending"}
              label={gone ? "Left the waitlist" : entry.status === "offered" ? "Offer sent" : "Waiting"}
            />
          </span>
        </div>

        {!gone && (
          <fetcher.Form method="post" className="mt-4">
            <input type="hidden" name="_intent" value="leave_waitlist" />
            <input type="hidden" name="uid" value={entry.uid} />
            <button type="submit" className="btn-sec w-full justify-center" disabled={submitting}>
              {submitting ? "Leaving…" : "Leave the waitlist"}
            </button>
          </fetcher.Form>
        )}
        {gone && (
          <p className="mt-4 m-0 text-[12.5px] text-muted">
            You're off the list — we won't email you about this {vocab.bookingOne} again.
          </p>
        )}
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------- Manage view */

function ManageBooking({
  connectionId, businessName, businessPhone, showBadge, brand, vocab, initial,
  serviceId, resourceId, minNoticeHours, maxAdvanceDays, canCancelInitial, cancelUnavailableReason,
}: {
  connectionId: string;
  serviceId: number;
  resourceId: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  businessName: string;
  showBadge: boolean;
  /** Paid branding, already checked against entitlements in the loader. */
  brand: { logo: string; accent: string };
  businessPhone: string;
  vocab: ReturnType<typeof vocabFor>;
  initial: { uid: string; status: string; serviceName: string; resourceName: string; when: string; priceLabel: string };
  canCancelInitial: boolean;
  cancelUnavailableReason: string;
}) {
  const fetcher = useFetcher<{ cancelled?: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const cancelled = fetcher.data?.cancelled || initial.status === "cancelled";
  const canCancel = canCancelInitial && !cancelled;
  // A reschedule rewrites the very row this page is rendering — the new
  // time, and possibly a new answer to "can this still be cancelled?".
  // Revalidating is what makes the page show the booking that now exists
  // rather than the one that did a moment ago.
  const onRescheduled = useCallback(() => revalidator.revalidate(), [revalidator]);

  return (
    <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
      <div className="card p-[18px]">
        <h1 className="ob-h1 mb-1">Your {vocab.bookingOne}</h1>
        {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
        <div className="flex flex-col gap-[6px] text-body">
          <span className="font-medium">{initial.serviceName}</span>
          {initial.resourceName && <span className="text-muted">with {initial.resourceName}</span>}
          <span className="text-muted">{initial.when}</span>
          {initial.priceLabel && <span className="text-muted">{initial.priceLabel}</span>}
          {/* Shares the dashboard's own Badge/status colour map instead of
              a bespoke chip here — the bespoke one only ever distinguished
              cancelled-vs-not, so "Pending confirmation" rendered in the
              same green as "Confirmed" (Defect Dossier's R2-06 finding). */}
          <span className="mt-1 w-fit">
            <Badge status={cancelled ? "cancelled" : (initial.status as "pending" | "confirmed")} label={cancelled ? "Cancelled" : initial.status === "pending" ? "Pending confirmation" : "Confirmed"} />
          </span>
        </div>
        {canCancel && (
          <>
            {/* Reschedule above cancel: moving an appointment is the
                outcome the business would rather have, and a customer
                who came to cancel because they could not find a way to
                move it is the exact failure this closes. */}
            <div className="mt-4">
              <ReschedulePanel
                connectionId={connectionId}
                uid={initial.uid}
                serviceId={serviceId}
                resourceId={resourceId}
                minNoticeHours={minNoticeHours}
                maxAdvanceDays={maxAdvanceDays}
                vocab={vocab}
                onDone={onRescheduled}
              />
            </div>
            <button
              type="button"
              className="btn-sec mt-2 w-full justify-center"
              onClick={() => (document.getElementById("cancel-booking") as HTMLDialogElement | null)?.showModal()}
            >
              Cancel this {vocab.bookingOne}
            </button>
          </>
        )}
        {/* Previously this dead-ended silently: no cancel control, no
            message, no mention of *why* — a customer booked 9h50m ahead
            under a 4-hour minimum-notice rule sat against a 24-hour
            cancellation cutoff with zero way to act and zero explanation
            (GetBooqin clinic audit's PB-01 finding). Only shown once
            (not alongside the button above), and never for an
            already-cancelled booking, which has its own status badge. */}
        {!canCancel && !cancelled && cancelUnavailableReason && (
          <p className="mt-4 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">{cancelUnavailableReason}</p>
        )}
      </div>
      {/* This used to read "Need to change the time instead? Contact
          {business} directly." — a human doing by hand what
          Bookings.reschedule() could already do, which is what the
          10-01-2026 review reported as item 8. The phone number stays as
          the fallback for a booking that is past the cutoff, where
          calling genuinely is the only route left. */}
      {!cancelled && businessPhone && (
        <p className="text-center text-body text-muted">
          Need something else? Call {businessName} at{" "}
          <a href={`tel:${businessPhone.replace(/[\s()-]/g, "")}`} className="text-brand-600 underline">{businessPhone}</a>.
        </p>
      )}

      {canCancel && (
        <ConfirmDialog
          id="cancel-booking"
          title={`Cancel your ${initial.serviceName} on ${initial.when}?`}
          body="This can't be undone. We'll let the business know."
          confirmLabel={`Cancel ${vocab.bookingOne}`}
          cancelLabel={`Keep ${vocab.bookingOne}`}
        >
          <fetcher.Form method="post" id="cancel-booking-form">
            <input type="hidden" name="_intent" value="cancel" />
            <input type="hidden" name="uid" value={initial.uid} />
          </fetcher.Form>
        </ConfirmDialog>
      )}
    </Shell>
  );
}

/**
 * Reschedule, on the manage page — item 8 of the 10-01-2026 review.
 *
 * Collapsed to a single button until clicked, same shape as
 * WaitlistJoinPrompt and AddToCalendar: a customer who came here to
 * cancel should not have to scroll past a date picker to find the cancel
 * button.
 *
 * Reuses the wizard's own /slots resource route and SlotGrid rather than
 * computing anything itself, so a time offered here is a time the booking
 * flow would have offered — the server re-checks it regardless
 * (Bookings.reschedule runs the full availability assertion), but
 * offering a slot that will then be refused is its own bug.
 */
function ReschedulePanel({
  connectionId, uid, serviceId, resourceId, minNoticeHours, maxAdvanceDays, vocab, onDone,
}: {
  connectionId: string;
  uid: string;
  serviceId: number;
  resourceId: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  vocab: ReturnType<typeof vocabFor>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const slotsFetcher = useFetcher<{ mode: "slots"; slots: { time: string; label: string }[] }>();
  const fetcher = useFetcher<{ rescheduled?: boolean; error?: string }>();
  const submitting = fetcher.state !== "idle";

  // Same bounds the booking wizard applies, for the same reason: a date
  // inside the notice window or past the advance window is not pickable
  // rather than pickable-then-refused (PB-05).
  const [dateMin, setDateMin] = useState<string | undefined>(undefined);
  const [dateMax, setDateMax] = useState<string | undefined>(undefined);
  useEffect(() => {
    const toValue = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    setDateMin(toValue(new Date(now.getTime() + minNoticeHours * 3600_000)));
    setDateMax(toValue(new Date(now.getTime() + maxAdvanceDays * 86_400_000)));
  }, [minNoticeHours, maxAdvanceDays]);

  // Load the chosen day's slots. Keyed on the date alone — service and
  // resource are fixed for the life of this panel.
  useEffect(() => {
    if (!date) return;
    setTime("");
    slotsFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}&date=${date}`);
    // slotsFetcher is a stable fetcher instance; including it loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, connectionId, serviceId, resourceId]);

  useEffect(() => {
    if (fetcher.data?.rescheduled) onDone();
  }, [fetcher.data?.rescheduled, onDone]);

  if (!open) {
    return (
      <button type="button" className="btn-sec mt-2 w-full justify-center" onClick={() => setOpen(true)}>
        Reschedule
      </button>
    );
  }

  const slots = slotsFetcher.data?.mode === "slots" ? slotsFetcher.data.slots : [];
  const loading = slotsFetcher.state !== "idle";

  return (
    <fetcher.Form method="post" className="mt-3 flex flex-col gap-3 rounded-[10px] border border-line p-3">
      <input type="hidden" name="_intent" value="reschedule" />
      <input type="hidden" name="uid" value={uid} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="time" value={time} />

      {fetcher.data?.error && <span className="text-[12px] text-danger">{fetcher.data.error}</span>}

      <Field label="New date">
        <Input type="date" value={date} min={dateMin} max={dateMax} onChange={(e) => setDate(e.target.value)} />
      </Field>

      {date && loading && <p className="m-0 text-[12.5px] text-muted">Checking what's open…</p>}
      {date && !loading && slots.length === 0 && (
        <p className="m-0 text-[12.5px] text-muted">No open times that day — try another date.</p>
      )}
      {slots.length > 0 && <SlotGrid slots={slots} time={time} onPick={setTime} />}

      <div className="flex gap-2">
        <button type="button" className="btn-sec flex-1 justify-center" onClick={() => setOpen(false)} disabled={submitting}>
          Keep current time
        </button>
        <button type="submit" className="btn-pri flex-1 justify-center" disabled={!date || !time || submitting}>
          {submitting ? "Moving…" : `Move ${vocab.bookingOne}`}
        </button>
      </div>
    </fetcher.Form>
  );
}

/* ----------------------------------------------------------- Booking flow */

type BookLoaderData = Extract<Route.ComponentProps["loaderData"], { mode: "book" }>;

type Step = "service" | "resource" | "time" | "details" | "confirm";

// Persistent "what you're booking" line, shown from the moment a service
// is picked through the details step — previously nothing named the
// service until the very last ("Choose a time") or success screen, and
// the "Your details" step named neither service, date nor time at all (UX
// audit's #10 finding). Doubles as the review-before-submit summary when
// it renders at the top of the details form.
function SummaryBar({
  service, date, time, timezone,
}: { service: { name: string; durationMin: number } | null; date: string; time: string; timezone: string }) {
  if (!service) return null;
  // Used to have its own bespoke date/zone-abbreviation formatting here,
  // duplicating (and, for the zone abbreviation, less carefully than) the
  // one true formatInZone used everywhere else — including the same
  // locale-dependent "GMT+2" vs "CEST" bug, now fixed at the source
  // (Defect Dossier's BQ-10 finding). date/time are the wall-clock values
  // the customer just picked in the business's own zone, so they round-trip
  // through wallClockToUtc first to get a real instant formatInZone can work
  // from.
  const when = date && time ? formatInZone(wallClockToUtc(`${date}T${time}`, timezone), timezone, "EEE d LLL yyyy, HH:mm") : null;
  return (
    <p className="mb-3 text-[12.5px] font-medium text-subtle">
      {service.name} · {service.durationMin} min{when ? ` · ${when}` : ""}
    </p>
  );
}

// Relative, not exact — "39 open" on an empty diary reads as a scarcity
// signal running the wrong way for a business (GetBooqin clinic audit's
// PB-06 finding). Thresholds are deliberately coarse; the point is never
// to let a customer back-calculate how quiet a day actually is.
function availabilityLabel(count: number): string {
  if (count <= 0) return "Full";
  if (count <= 2) return "Few left";
  if (count <= 6) return "Some open";
  return "Open";
}

function partOfDay(time: string): "Morning" | "Afternoon" | "Evening" {
  const hour = Number(time.slice(0, 2));
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

const PART_OF_DAY_ORDER = ["Morning", "Afternoon", "Evening"] as const;

/**
 * A ten-hour, 15-minute-interval day is 39 undifferentiated buttons in
 * three columns with nothing to orient a customer scanning for "sometime
 * after work" — grouped by part of day instead (GetBooqin clinic audit's
 * PB-06 finding).
 */
/**
 * Records "they asked for this day and it had nothing" as a side effect
 * of that state being rendered.
 *
 * A render-phase setState would be a loop and an effect in the parent
 * would need the empty-slots condition duplicated there, so this is a
 * zero-output component mounted exactly where that condition is already
 * expressed. Deliberately not remembering an out-of-range date: a day
 * past the booking window is not a day the business could ever offer,
 * so there is nothing to waitlist for.
 */
function RememberPreferredDate({
  date, outOfRange, onLearn,
}: { date: string; outOfRange: boolean; onLearn: (date: string) => void }) {
  useEffect(() => {
    if (!date || outOfRange) return;
    // First wins — see preferredDate's own comment.
    onLearn(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, outOfRange]);
  return null;
}

function SlotGrid({
  slots, time, onPick,
}: { slots: { time: string; label: string }[]; time: string; onPick: (time: string) => void }) {
  const groups: Partial<Record<(typeof PART_OF_DAY_ORDER)[number], typeof slots>> = {};
  for (const s of slots) {
    const group = partOfDay(s.time);
    (groups[group] ??= []).push(s);
  }
  return (
    <div className="flex flex-col gap-3">
      {PART_OF_DAY_ORDER.filter((g) => groups[g]?.length).map((g) => (
        <div key={g}>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-subtle">{g}</span>
          <div className="grid grid-cols-3 gap-2">
            {groups[g]!.map((s) => (
              <button
                key={s.time}
                type="button"
                className={`tile justify-center ${time === s.time ? "tile-on" : ""}`}
                onClick={() => onPick(s.time)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Inline "Join the waitlist" — collapsed to a single button until clicked,
 * then a small self-contained form on its own fetcher so it can't get
 * tangled up with the page's main booking fetcher. The waitlist backend
 * (freed-slot offers, the offer window) was already fully built; only
 * staff could ever add someone to it, and the public page never mentioned
 * it — including on its own empty-availability screen, the one moment a
 * customer is most willing to queue for a spot (GetBooqin clinic audit's
 * PB-04 finding).
 */
function WaitlistJoinPrompt({
  serviceId, resourceId, vocab, settings, preferredDate, ctaLabel,
}: {
  serviceId: number;
  resourceId: number;
  vocab: ReturnType<typeof vocabFor>;
  settings: BookLoaderData["settings"];
  /**
   * The day they actually want.
   *
   * This form never sent one. handleJoinWaitlist reads `date` off the
   * form and passes it to Waitlist.join() as window_start — and join()
   * falls back to *today* when it is absent, so every customer who used
   * the empty-availability prompt was queued for the wrong day and then
   * never offered the slot they had asked about. Silent, because
   * joining still "worked".
   */
  preferredDate: string;
  ctaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ waitlisted?: boolean; error?: string; fieldErrors?: Record<string, string> }>();
  const submitting = fetcher.state !== "idle";

  if (fetcher.data?.waitlisted) {
    return (
      <p className="m-0 rounded-[8px] bg-ok-bg px-3 py-2 text-[12.5px] font-medium text-ok">
        You're on the waitlist — we'll let you know the moment a {vocab.bookingOne} opens up.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn-sec w-full justify-center" onClick={() => setOpen(true)}>
        {ctaLabel ?? "Join the waitlist instead"}
      </button>
    );
  }

  return (
    <fetcher.Form method="post" className="flex flex-col gap-[10px] rounded-[10px] border border-line p-3">
      <input type="hidden" name="_intent" value="join_waitlist" />
      <input type="hidden" name="service_id" value={serviceId} />
      <input type="hidden" name="resource_id" value={resourceId} />
      {/* The day being queued for. Absent, Waitlist.join() silently uses
          today — see preferredDate above. */}
      <input type="hidden" name="date" value={preferredDate} />
      {/* Honeypot — same convention as the main booking form below. */}
      <input type="text" name="hp_company" tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden="true" />
      <p className="m-0 text-[12.5px] text-muted">We'll reach out the moment a spot frees up.</p>
      {fetcher.data?.error && <span className="text-[12px] text-danger">{fetcher.data.error}</span>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="First name" required error={fetcher.data?.fieldErrors?.first_name}>
          <Input name="first_name" required autoComplete="given-name" />
        </Field>
        <Field label="Last name">
          <Input name="last_name" autoComplete="family-name" />
        </Field>
      </div>
      <Field label="Email" required={settings.requireEmail} error={fetcher.data?.fieldErrors?.email}>
        <Input type="email" name="email" required={settings.requireEmail} autoComplete="email" />
      </Field>
      <Field label="Phone" required={settings.requirePhone} error={fetcher.data?.fieldErrors?.phone}>
        <Input type="tel" name="phone" required={settings.requirePhone} autoComplete="tel" />
      </Field>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-sec" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn-pri" disabled={submitting}>
          {submitting ? "Joining…" : "Join waitlist"}
        </button>
      </div>
    </fetcher.Form>
  );
}

function BookingFlow({ loaderData }: { loaderData: BookLoaderData }) {
  const { connectionId, businessName, businessHours, showBadge, brand, vocab, settings, services, resources } = loaderData;
  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [resourceId, setResourceId] = useState<number>(0);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  // Computed post-mount, not during render — the server has no idea what
  // timezone the visitor is in, so an SSR-computed "today" (in the server's
  // own timezone) could disagree with the visitor's actual local date and
  // wrongly block them from picking it. `Bookings.create`'s own
  // min_notice_hours/max_advance_days checks are what actually enforce this
  // server-side; this is only ever a picker hint. Previously this only set
  // a min of "today" and no max at all — a date years past the advance
  // window, or one that fell inside an active minimum-notice period, was
  // freely pickable and then reported as "No open times that day" instead
  // of "outside our booking window" (GetBooqin clinic audit's PB-05
  // finding).
  const [dateMin, setDateMin] = useState<string | undefined>(undefined);
  const [dateMax, setDateMax] = useState<string | undefined>(undefined);
  const toDateInputValue = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  useEffect(() => {
    const now = new Date();
    const earliest = new Date(now.getTime() + settings.minNoticeHours * 3600_000);
    const latest = new Date(now.getTime() + settings.maxAdvanceDays * 86_400_000);
    setDateMin(toDateInputValue(earliest));
    setDateMax(toDateInputValue(latest));
  }, [settings.minNoticeHours, settings.maxAdvanceDays]);
  const dateOutOfRange = !!date && !!dateMin && !!dateMax && (date < dateMin || date > dateMax);

  // The date the customer actually wanted, when it turned out to have
  // nothing on it (10-01-2026 review, item 10). The waitlist prompt on
  // the empty-day screen only helps someone willing to leave with
  // nothing booked; the far more common path is "Monday is full, fine,
  // I'll take Tuesday" — and that customer would have taken Monday, and
  // we never ask. Remembered here so the confirmation screen can.
  //
  // First one only: if they shop around three full days before booking a
  // fourth, the first is the one they came for.
  const [preferredDate, setPreferredDate] = useState("");

  const daysFetcher = useFetcher<{ mode: "days"; days: { date: string; label: string; count: number }[]; unbookable: boolean }>();
  const slotsFetcher = useFetcher<{ mode: "slots"; slots: { time: string; label: string }[] }>();
  const bookFetcher = useFetcher<{
    error?: string;
    code?: string;
    spam?: boolean;
    fieldErrors?: Record<string, string>;
    booking?: {
      uid: string;
      status: string;
      serviceName: string;
      resourceName: string;
      when: string;
      startIso: string;
      endIso: string;
      canCancel: boolean;
      cancelCutoffHours: number;
      cancelUnavailableReason: string;
      businessPhone: string;
    };
  }>();

  const service = services.find((s) => s.id === serviceId) ?? null;

  function pickService(id: number) {
    setServiceId(id);
    setResourceId(0);
    setDate("");
    setTime("");
    setStep(resources.length <= 1 ? "time" : "resource");
  }

  function pickResource(id: number) {
    setResourceId(id);
    setDate("");
    setTime("");
    setStep("time");
  }

  // Entering the time step with no date yet: ask which of the next few days
  // actually have openings, so the page doesn't default to "today" and show
  // an empty list for a business that's closed today.
  useEffect(() => {
    if (step !== "time" || date || !serviceId) return;
    daysFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, resourceId]);

  useEffect(() => {
    if (!date || !serviceId) return;
    slotsFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}&date=${date}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, serviceId, resourceId]);

  // The one error real customers actually hit in normal use (two people
  // booking near-simultaneously) — re-pull the slot list for the date
  // they're on instead of leaving a now-stale "available" button up.
  useEffect(() => {
    if (bookFetcher.data?.code === "getbooqin_slot_taken" && date && serviceId) {
      setTime("");
      slotsFetcher.load(`/book/${connectionId}/slots?service_id=${serviceId}&resource_id=${resourceId}&date=${date}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookFetcher.data]);

  if (bookFetcher.data?.booking) {
    return (
      <Confirmation
        connectionId={connectionId}
        businessName={businessName}
        businessAddress={settings.businessAddress}
        showBadge={showBadge}
        brand={brand}
        vocab={vocab}
        booking={bookFetcher.data.booking}
        // Only when they settled for a different day than the one they
        // asked for first, and only if this business runs a waitlist at
        // all. Both false for the ordinary "booked the day I wanted"
        // path, which must stay a clean confirmation with nothing extra
        // asked of it.
        waitlist={
          // serviceId is non-null by the time a booking exists — you
          // cannot reach the confirmation without having picked one —
          // but the state is typed nullable for the first step, so the
          // narrowing has to be explicit.
          settings.waitlistEnabled && serviceId !== null && preferredDate && preferredDate !== date
            ? { serviceId, resourceId, preferredDate, settings }
            : null
        }
      />
    );
  }

  return (
    <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
      {step === "service" && (
        <div className="card p-[18px]">
          {/* Business header — name, one-line description, address, phone,
              opening hours. The page previously showed only the name and a
              bare list of service durations, none of this already-
              collected business context (Defect Dossier's BQ-33 finding). */}
          <h1 className="ob-h1 mb-1">Book with {businessName}</h1>
          {settings.businessDescription && <p className="m-0 mb-2 text-body text-muted">{settings.businessDescription}</p>}
          {(settings.businessAddress || settings.businessPhone || businessHours) && (
            <div className="mb-3 flex flex-col gap-[2px] text-[12.5px] text-subtle">
              {settings.businessAddress && <span>{settings.businessAddress}</span>}
              {settings.businessPhone && <span>{settings.businessPhone}</span>}
              {businessHours && <span>{businessHours}</span>}
            </div>
          )}
          <div className="flex flex-col gap-2">
            {services.length === 0 && <p className="text-body text-muted">No {vocab.services.toLowerCase()} are available to book right now.</p>}
            {services.map((s) => (
              <button key={s.id} type="button" className="tile flex-col items-stretch gap-[2px] text-left" onClick={() => pickService(s.id)}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-body font-medium">{s.name}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-subtle">
                    {s.durationMin} min{s.price > 0 ? ` · ${settings.currencySymbol}${s.price.toFixed(2)}` : ""}
                  </span>
                </div>
                {s.description && <span className="text-[12px] font-normal text-subtle">{s.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "resource" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-1">Choose who you'd like to see</h1>
          <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
          <div className="flex flex-col gap-2">
            <button type="button" className="tile justify-between text-left" onClick={() => pickResource(0)}>
              <span className="text-body font-medium">Any {vocab.resourceOne}</span>
            </button>
            {/* Name, title, photo and description — this used to be a bare
                name button, with a resource's own profile (already
                collected on their own record) never reaching the page
                (Defect Dossier's BQ-33 finding). */}
            {resources.map((r) => (
              <button key={r.id} type="button" className="tile items-start gap-3 text-left" onClick={() => pickResource(r.id)}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-[13px] font-semibold text-brand-600">
                  {r.avatarUrl ? (
                    <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    r.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium">
                    {r.name}
                    {r.title ? <span className="font-normal text-subtle"> · {r.title}</span> : null}
                  </span>
                  {r.description && <span className="text-[12px] text-subtle">{r.description}</span>}
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={() => setStep("service")}>&larr; Back</button>
        </div>
      )}

      {step === "time" && service && (
        <div className="card p-[18px]">
          <h1 className="ob-h1 mb-1">Choose a time</h1>
          <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
          {service.description && <p className="mb-3 mt-[-6px] text-[12.5px] text-muted">{service.description}</p>}

          {/* Kept visible after a date is chosen instead of disappearing —
              a client picking one date had no way back to the quick-pick
              list except starting the step over (Defect Dossier's BQ-33
              finding, item 4). The picked day stays highlighted among the
              others. */}
          <span className="field-label mb-2 block">Next available</span>
          <div className="flex flex-col gap-2">
            {daysFetcher.data?.mode === "days" && daysFetcher.data.days.length === 0 && (
              <p className="text-body text-muted">
                {daysFetcher.data.unbookable
                  ? // Zero candidate resources, not zero open slots — no
                    // amount of "check back later" would ever help here
                    // (Defect Dossier's R2-04 finding, item 4).
                    `This isn't bookable online right now — please call us${settings.businessPhone ? ` at ${settings.businessPhone}` : ""}.`
                  : "No openings in the next few weeks — try again later."}
              </p>
            )}
            {daysFetcher.data?.mode === "days" &&
              daysFetcher.data.days.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  className={`tile justify-between text-left ${date === d.date ? "tile-on" : ""}`}
                  onClick={() => { setDate(d.date); setTime(""); }}
                >
                  <span className="text-body font-medium">{d.label}</span>
                  {/* An exact count ("39 open") broadcasts an empty diary as
                      a scarcity signal running the wrong way for a business
                      — most booking products show relative availability, or
                      nothing at all (GetBooqin clinic audit's PB-06
                      finding). */}
                  <span className="ml-auto text-[12px] text-subtle">{availabilityLabel(d.count)}</span>
                </button>
              ))}
          </div>

          <Field label="Or pick a specific date">
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(""); }} min={dateMin} max={dateMax} />
          </Field>

          {date && (
            <div className="mt-3 flex flex-col gap-2">
              {/* Timezone shown on the slot grid itself, not just the final
                  summary — a client on the other side of the world from
                  the business had no signal these times weren't already
                  theirs (Defect Dossier's BQ-33 finding, item 5 / BQ-10). */}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length > 0 && (
                <span className="text-[11.5px] text-subtle">Times shown in {zoneAbbr(new Date(), settings.timezone)}</span>
              )}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length === 0 && (
                <RememberPreferredDate
                  date={date}
                  outOfRange={dateOutOfRange}
                  // Functional, so "first wins" is actually true — a plain
                  // set would overwrite with whichever empty day they
                  // looked at last.
                  onLearn={(d) => setPreferredDate((prev) => prev || d)}
                />
              )}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length === 0 && (
                // "Outside our booking window" (a date the calendar was
                // never open on) used to render identically to "fully
                // booked" (a date that is open but every slot is taken) —
                // both just said "No open times that day", which taught a
                // customer stuck past the max-advance ceiling to keep
                // trying other dates that could never work either
                // (GetBooqin clinic audit's PB-05 finding).
                <p className="text-body text-muted">
                  {dateOutOfRange
                    ? `We only take ${vocab.bookingMany} between ${dateMin} and ${dateMax} — try a date in that range.`
                    : "No open times that day — try another date."}
                </p>
              )}
              {slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length > 0 && (
                <SlotGrid slots={slotsFetcher.data.slots} time={time} onPick={setTime} />
              )}
              {/* The one moment a customer is most willing to join a queue
                  is the one moment they aren't asked — enabled, wired to
                  freed slots, and never mentioned here (GetBooqin clinic
                  audit's PB-04 finding). */}
              {settings.waitlistEnabled && slotsFetcher.data?.mode === "slots" && slotsFetcher.data.slots.length === 0 && !dateOutOfRange && (
                <WaitlistJoinPrompt serviceId={service.id} resourceId={resourceId} vocab={vocab} settings={settings} preferredDate={date} />
              )}
            </div>
          )}

          {daysFetcher.data?.mode === "days" && daysFetcher.data.days.length === 0 && !daysFetcher.data.unbookable && settings.waitlistEnabled && (
            // No specific day was asked for here — nothing in the next
            // week has anything — so `date` is whatever they last typed,
            // possibly nothing. Passing it through either way: an empty
            // value lands on join()'s own "from today" default, which is
            // the honest reading of "I'll take the first thing going".
            <WaitlistJoinPrompt serviceId={service.id} resourceId={resourceId} vocab={vocab} settings={settings} preferredDate={date} />
          )}

          {/* Sticky on mobile: a ten-hour, 15-minute-interval day renders as
              dozens of buttons, leaving Continue several screens below the
              fold once a time is picked (GetBooqin clinic audit's PB-06
              finding). Desktop is unaffected — the bar only detaches from
              normal flow below the sm breakpoint. */}
          <div className="sticky bottom-0 -mx-[18px] -mb-[18px] mt-4 flex justify-between border-t border-line bg-surface px-[18px] py-3 max-sm:shadow-[0_-4px_10px_rgba(16,24,40,.08)] sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
            <button type="button" className="btn-ghost" onClick={() => setStep(resources.length <= 1 ? "service" : "resource")}>&larr; Back</button>
            <button type="button" className="btn-pri" disabled={!time} onClick={() => setStep("details")}>Continue</button>
          </div>
        </div>
      )}

      {step === "details" && service && (
        <DetailsForm
          connectionId={connectionId}
          businessName={businessName}
          vocab={vocab}
          settings={settings}
          service={service}
          resourceId={resourceId}
          date={date}
          time={time}
          fetcher={bookFetcher}
          onBack={() => setStep("time")}
        />
      )}
    </Shell>
  );
}

function DetailsForm({
  connectionId, businessName, vocab, settings, service, resourceId, date, time, fetcher, onBack,
}: {
  connectionId: string;
  businessName: string;
  vocab: ReturnType<typeof vocabFor>;
  settings: BookLoaderData["settings"];
  service: { id: number; name: string; durationMin: number };
  resourceId: number;
  date: string;
  time: string;
  fetcher: ReturnType<typeof useFetcher<{ error?: string; spam?: boolean; fieldErrors?: Record<string, string> }>>;
  onBack: () => void;
}) {
  const submitting = fetcher.state !== "idle";
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The server mirrors the same checks (required-phone is business
  // configuration a bypassed client check could miss), so a submit that
  // reaches it and comes back with fieldErrors still needs to render them.
  useEffect(() => {
    if (fetcher.data?.fieldErrors) setErrors(fetcher.data.fieldErrors);
  }, [fetcher.data]);

  function clearError(name: string) {
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  /**
   * Validate one contact field as the customer leaves it.
   *
   * handleSubmit below already refuses an invalid phone, and handleBook
   * mirrors that server-side — so "the form accepts invalid text"
   * (10-01-2026 review, item 5) was never true of the submit. What was
   * true is that nothing said so until the customer had filled in the
   * whole form and pressed Confirm, so a field they had already moved on
   * from looked accepted. Onboarding's phone field shows its error as you
   * type; this one stayed silent. Blur rather than change, so the message
   * doesn't flash while a half-typed number is still legitimately invalid.
   */
  function validateOnBlur(name: "email" | "phone", value: string) {
    // Deliberately not contactFieldErrors(): that function also enforces
    // the cross-field "give us one of the two" rule, which would fire on
    // blurring an empty optional phone field and tell the customer off
    // for a field they have not reached yet. One field at a time here;
    // the full check still runs on submit.
    const trimmed = value.trim();
    let message = "";
    if (trimmed) {
      const valid = name === "phone" ? isValidPhone(trimmed) : isValidEmail(trimmed);
      if (!valid) message = name === "phone" ? "Enter a valid phone number." : "Enter a valid email address.";
    }
    setErrors((prev) => {
      if (!message) {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: message };
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const next = contactFieldErrors(
      {
        first_name: String(form.get("first_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
      },
      settings.requirePhone,
      settings.requireEmail
    );
    for (const f of settings.intakeFields) {
      if (f.required && !String(form.get(`intake_${f.key}`) || "").trim()) {
        next[`intake_${f.key}`] = `Enter ${f.label.toLowerCase()}.`;
      }
    }
    // Mirrors the server-side check in handleBook (GetBooqin clinic
    // audit's TS-01 finding) — the booking form collected a name, email,
    // phone and free-text notes patients routinely type symptoms into,
    // with no consent checkbox, no privacy notice and no statement of what
    // was stored or for how long, anywhere.
    if (form.get("consent") !== "on") {
      next.consent = "Please agree to the privacy notice to continue.";
    }
    if (Object.keys(next).length > 0) {
      event.preventDefault();
      setErrors(next);
    }
  }

  return (
    <div className="card p-[18px]">
      <h1 className="ob-h1 mb-1">Your details</h1>
      <SummaryBar service={service} date={date} time={time} timezone={settings.timezone} />
      {fetcher.data?.error && <AlertError className="mb-3">{fetcher.data.error}</AlertError>}
      <div className="mb-3"><FormErrorSummary errors={errors} /></div>
      <fetcher.Form method="post" className="flex flex-col gap-[14px]" onSubmit={handleSubmit} noValidate>
        <input type="hidden" name="_intent" value="book" />
        <input type="hidden" name="service_id" value={service.id} />
        <input type="hidden" name="resource_id" value={resourceId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="time" value={time} />
        {/* Honeypot — real customers never see or fill this in. */}
        <input type="text" name="hp_company" tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden="true" />

        <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
          <Field label="First name" required error={errors.first_name}>
            <Input id="first_name" name="first_name" required autoComplete="given-name" onChange={() => clearError("first_name")} />
          </Field>
          <Field label="Last name">
            <Input id="last_name" name="last_name" autoComplete="family-name" />
          </Field>
        </div>
        <Field label="Email" required={settings.requireEmail} error={errors.email}>
          <Input id="email" type="email" name="email" required={settings.requireEmail} autoComplete="email" onChange={() => clearError("email")} onBlur={(e) => validateOnBlur("email", e.target.value)} />
        </Field>
        <Field label="Phone" required={settings.requirePhone} error={errors.phone}>
          <Input id="phone" type="tel" inputMode="tel" pattern={PHONE_PATTERN} name="phone" required={settings.requirePhone} autoComplete="tel" onChange={() => clearError("phone")} onBlur={(e) => validateOnBlur("phone", e.target.value)} />
        </Field>
        {settings.intakeFields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required} error={errors[`intake_${f.key}`]}>
            {f.type === "textarea" ? (
              <textarea
                id={`intake_${f.key}`}
                name={`intake_${f.key}`}
                required={f.required}
                className="input min-h-[80px]"
                onChange={() => clearError(`intake_${f.key}`)}
              />
            ) : (
              <Input
                id={`intake_${f.key}`}
                type={f.type === "phone" ? "tel" : f.type}
                required={f.required}
                name={`intake_${f.key}`}
                onChange={() => clearError(`intake_${f.key}`)}
              />
            )}
          </Field>
        ))}
        <Field label="Notes"><textarea name="notes" className="input min-h-[70px]" /></Field>

        {settings.consentText && <p className="m-0 text-[11.5px] text-subtle">{settings.consentText}</p>}

        {/* No consent checkbox, privacy notice link or statement of what's
            stored existed anywhere on this form before — patients routinely
            type symptoms into the Notes field above with zero notice given
            (GetBooqin clinic audit's TS-01 finding; India's DPDP Act 2023
            requires notice and consent at the point of collection). Not
            legal advice — a business should have its own counsel confirm
            this wording and its own privacy notice meet the law it
            actually operates under. */}
        <label className={`flex items-start gap-[10px] text-[12.5px] ${errors.consent ? "text-danger" : "text-muted"}`}>
          <input
            type="checkbox"
            name="consent"
            required
            className="mt-[2px]"
            onChange={() => clearError("consent")}
          />
          <span>
            I agree to {businessName} storing my contact and {vocab.bookingOne} details to manage this {vocab.bookingOne}, per
            their{" "}
            <a href={settings.privacyNoticeUrl} target="_blank" rel="noreferrer" className="underline">
              privacy notice
            </a>
            .
          </span>
        </label>
        {errors.consent && <p className="m-0 text-[12px] text-danger">{errors.consent}</p>}

        {/* Only when the business actually has WhatsApp connected and
            approved — offering it otherwise collects a consent nothing
            can act on, and teaches a customer to expect messages that
            never arrive.

            Separate from the privacy consent above, and unticked by
            default. Meta requires *demonstrable* opt-in, and a
            pre-ticked box is not consent under that rule or under the
            GDPR one this form already answers to. Unticked also means
            the customer's answer is an answer rather than an
            oversight. */}
        {settings.whatsappAvailable && (
          <label className="flex items-start gap-[10px] text-[12.5px] text-muted">
            <input type="checkbox" name="whatsapp_opt_in" className="mt-[2px]" />
            <span>
              Also send me {vocab.bookingOne} updates on WhatsApp, at the number above.
            </span>
          </label>
        )}

        <div className="mt-1 flex justify-between">
          <button type="button" className="btn-ghost" onClick={onBack} disabled={submitting}>&larr; Back</button>
          <button type="submit" className="btn-pri" disabled={submitting}>
            {submitting ? "Booking…" : `Confirm ${vocab.bookingOne}`}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

/**
 * "+ Add to calendar" — a chooser, not a download.
 *
 * This was a single <a download> pointing at an .ics data URL. On Apple
 * Calendar and Outlook desktop that is exactly right. On Android and in
 * Chrome — which is what the 10-01-2026 review tested (item 6) — the file
 * lands in Downloads as "standard-appointment.ics" and nothing opens it,
 * so the button looked broken.
 *
 * Collapsed to the same single link until clicked, so the common case
 * costs one tap and the panel keeps its shape; the three destinations
 * only appear once the customer has said they want them.
 *
 * The .ics stays as the third option rather than being replaced: it is
 * still the only one that works for Apple Calendar, and it is the only
 * one that works offline.
 */
function AddToCalendar({ event, filename }: { event: CalendarEvent; filename: string }) {
  const [open, setOpen] = useState(false);
  // Recomputed only when the booking changes, not on every render — each
  // call builds two URLs and serialises a whole .ics into a data: URL.
  const links = useMemo(() => calendarLinks(event), [event.uid, event.start, event.end, event.title]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-link text-brand-600">
        + Add to calendar
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      {/* rel=noopener on the two that leave the page: these open a logged-in
          calendar account, and the opener reference is not something to
          hand to another origin. */}
      <a href={links.google} target="_blank" rel="noopener noreferrer" className="btn-link text-brand-600">
        Google
      </a>
      <a href={links.outlook} target="_blank" rel="noopener noreferrer" className="btn-link text-brand-600">
        Outlook
      </a>
      <a href={links.ics} download={filename} className="btn-link text-brand-600">
        Apple / other (.ics)
      </a>
    </div>
  );
}

function Confirmation({
  connectionId, businessName, businessAddress, showBadge, brand, vocab, booking, waitlist,
}: {
  connectionId: string;
  businessName: string;
  businessAddress: string;
  showBadge: boolean;
  brand: { logo: string; accent: string };
  vocab: ReturnType<typeof vocabFor>;
  /** Non-null only when they settled for a different day — see item 10. */
  waitlist: {
    serviceId: number;
    resourceId: number;
    preferredDate: string;
    settings: BookLoaderData["settings"];
  } | null;
  booking: {
    uid: string;
    status: string;
    serviceName: string;
    resourceName: string;
    when: string;
    startIso: string;
    endIso: string;
    canCancel: boolean;
    cancelCutoffHours: number;
    cancelUnavailableReason: string;
    businessPhone: string;
  };
}) {
  const bookingRef = booking.uid.slice(-6).toUpperCase();
  const manageUrl = `/book/${connectionId}?getbooqin_booking=${booking.uid}`;
  return (
    <Shell businessName={businessName} showBadge={showBadge} brand={brand}>
      <div className="card p-[18px] text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-ok-bg text-[20px] text-ok">✓</span>
        <h1 className="ob-h1 mb-1">
          {booking.status === "pending" ? `Request sent` : `You're booked!`}
        </h1>
        <p className="m-0 text-body text-muted">
          {booking.serviceName}{booking.resourceName ? ` with ${booking.resourceName}` : ""} — {booking.when}
        </p>
        {/* Address and a tappable phone number — this screen used to give a
            patient nowhere to go: a reference code and a manage link, but
            nothing about where the business actually is or how to reach it
            (GetBooqin clinic audit's PB-07 finding). Only ever renders what
            the business has actually filled in on Settings > General. */}
        {(businessAddress || booking.businessPhone) && (
          <p className="mt-1 text-[12.5px] text-subtle">
            {businessAddress}
            {businessAddress && booking.businessPhone ? " · " : ""}
            {booking.businessPhone && (
              <a href={`tel:${booking.businessPhone.replace(/[\s()-]/g, "")}`} className="text-brand-600 underline">
                {booking.businessPhone}
              </a>
            )}
          </p>
        )}
        <p className="mt-1 text-[12px] text-subtle">Reference #{bookingRef}</p>
        {booking.status === "pending" && (
          <p className="mt-2 text-body text-muted">{businessName} will confirm this {vocab.bookingOne} shortly.</p>
        )}
        {/* Nothing is actually confirmed yet on a pending request — the
            copy used to claim a confirmation had been sent regardless of
            status (Defect Dossier's BQ-28 finding, item 1). */}
        <p className="mt-3 text-[12px] text-subtle">
          {booking.status === "pending"
            ? "We've emailed you a copy of this request."
            : "A confirmation has been sent to your email."}
        </p>

        <div className="mt-4 flex flex-col items-center gap-2 border-t border-line pt-4">
          {/* The manage page only ever offered Cancel — no self-service
              reschedule exists yet — so this promised more than the page
              could deliver (Defect Dossier's R2-06 finding). */}
          <a href={manageUrl} className="btn-sec no-underline hover:no-underline">
            View or cancel this {vocab.bookingOne}
          </a>
          {booking.canCancel && (
            <p className="m-0 text-[12px] text-subtle">
              You can cancel up to {booking.cancelCutoffHours}h before.
            </p>
          )}
          {/* Told immediately, not just discovered later on the manage page
              — a booking made inside the cancellation cutoff is
              un-cancellable from this exact moment (GetBooqin clinic audit's
              PB-01 finding). */}
          {!booking.canCancel && booking.cancelUnavailableReason && (
            <p className="m-0 max-w-[340px] text-[12px] text-warn">
              {booking.cancelUnavailableReason}
              {booking.businessPhone && (
                <>
                  {" "}Call <a href={`tel:${booking.businessPhone.replace(/[\s()-]/g, "")}`} className="underline">{booking.businessPhone}</a> if you need to change it.
                </>
              )}
            </p>
          )}
          {/* Only once there is something to put in a diary — a pending
              request is not an appointment yet. */}
          {booking.status !== "pending" && (
            <AddToCalendar
              event={{
                uid: booking.uid,
                start: new Date(booking.startIso),
                end: new Date(booking.endIso),
                title: `${booking.serviceName}${booking.resourceName ? ` with ${booking.resourceName}` : ""}`,
                description: `Booked with ${businessName}`,
                location: businessAddress || undefined,
                url: `${typeof window === "undefined" ? "" : window.location.origin}${manageUrl}`,
              }}
              filename={icsFilename(booking.serviceName || vocab.bookingOne)}
            />
          )}
        </div>
      </div>

      {/* "You're booked for Tuesday. You wanted Monday — want us to tell
          you if Monday opens up?" (10-01-2026 review, item 10.)
          
          The waitlist engine behind this is complete and has been for a
          while: a cancellation frees a slot, matchAndOffer() offers it to
          the first matching entry, and an unclaimed offer cascades to the
          next. What was missing was anyone to offer it to — the only way
          onto the list was an empty-availability day, i.e. a customer
          willing to leave with nothing booked. The customer who took
          Tuesday but wanted Monday is both more common and more likely to
          say yes, and nobody was asking them.

          Below the confirmation, never instead of it: the booking they
          just made is the thing they came for. */}
      {waitlist && (
        <div className="card p-[18px]">
          <p className="m-0 mb-2 text-body">
            You were looking at <strong>{formatPreferredDate(waitlist.preferredDate)}</strong>. Want us to let you
            know if something opens up then?
          </p>
          <WaitlistJoinPrompt
            serviceId={waitlist.serviceId}
            resourceId={waitlist.resourceId}
            vocab={vocab}
            settings={waitlist.settings}
            preferredDate={waitlist.preferredDate}
            ctaLabel={`Tell me if ${formatPreferredDate(waitlist.preferredDate)} opens up`}
          />
        </div>
      )}
    </Shell>
  );
}

/**
 * "Mon 5 Oct" from a yyyy-mm-dd the customer picked.
 *
 * Parsed as local parts rather than `new Date("2026-10-05")`, which is
 * parsed as UTC midnight and renders as the day before for anyone west
 * of Greenwich.
 */
function formatPreferredDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}
