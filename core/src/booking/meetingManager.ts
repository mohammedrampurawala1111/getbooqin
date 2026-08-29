/** Video meeting orchestration. Ported from shopify-openslot/app/lib/meetingManager.server.ts. */
import type { Booking } from "@prisma/client";
import prisma from "../db.js";
import { Provider, type MeetingContext } from "./meetings/provider.js";
import { JitsiProvider } from "./meetings/jitsi.js";
import { StaticLinkProvider } from "./meetings/staticLink.js";
import { ZoomProvider } from "./meetings/zoom.js";
import * as Data from "./data.js";
import { getSettings, type Settings } from "./settings.js";
import { now } from "./ids.js";
import events from "./events.js";
import * as Bookings from "./bookings.js";

const REGISTRY: Record<string, Provider> = {
  jitsi: new JitsiProvider(),
  link: new StaticLinkProvider(),
  zoom: new ZoomProvider(),
};

export function providers(): Record<string, Provider> {
  return REGISTRY;
}

export function provider(settings: Settings, id?: string | null): Provider | null {
  return REGISTRY[id || settings.video_provider] ?? null;
}

export function choices(): Array<{ value: string; label: string }> {
  return Object.entries(REGISTRY).map(([value, p]) => ({ value, label: p.label() }));
}

export async function staticLinkConfigured(shop: string, platform: string, settings: Settings): Promise<boolean> {
  if (settings.video?.link?.url) return true;
  const active = await Data.resources(shop, platform, true);
  return active.some((r) => !!r.meetingLink);
}

export function isVideoBooking(service: { locationType: string } | null): boolean {
  return !!service && service.locationType === "video";
}

/** Create the meeting for a newly booked video appointment. */
export async function provision(shop: string, platform: string, booking: Booking): Promise<void> {
  const service = await Data.catalogService(shop, booking.serviceId);
  if (!isVideoBooking(service)) return;
  if (booking.meetingUrl) return;

  const settings = await getSettings(shop, platform);
  const p = provider(settings);
  const ctx: MeetingContext = { shop, platform, settings };
  if (!p) return;

  const configured =
    p.id() === "link" ? await staticLinkConfigured(shop, platform, settings) : p.isConfigured(ctx);
  if (!configured) return;

  try {
    const meeting = await p.create(ctx, booking);
    if (!meeting.url) return;

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        meetingProvider: p.id(),
        meetingUrl: meeting.url,
        meetingId: meeting.id ?? "",
        updatedAt: now(),
      },
    });

    const fresh = await Bookings.get(shop, booking.id);
    if (fresh) events.emitEvent("meeting_created", fresh, meeting);
  } catch (err) {
    events.emitEvent("meeting_failed", booking, err instanceof Error ? err.message : String(err));
  }
}

/** Time-based providers (Zoom) need a new meeting when the slot moves. */
export async function reprovision(shop: string, platform: string, booking: Booking): Promise<void> {
  const service = await Data.catalogService(shop, booking.serviceId);
  if (!isVideoBooking(service)) return;

  const settings = await getSettings(shop, platform);
  const p = provider(settings, booking.meetingProvider || null);
  if (!p || !p.needsReprovision()) return;

  await prisma.booking.update({ where: { id: booking.id }, data: { meetingUrl: "", meetingId: "" } });
  const fresh = await Bookings.get(shop, booking.id);
  if (fresh) await provision(shop, platform, fresh);
}

/** Can the join button be shown yet? */
export function joinOpen(booking: Booking, settings: Settings): boolean {
  if (!booking.meetingUrl) return false;
  if (!["pending", "confirmed"].includes(booking.status)) return false;

  const windowMs = Math.max(0, settings.video_join_window) * 60_000;
  const start = booking.startUtc.getTime();
  const end = booking.endUtc.getTime();
  const nowMs = Date.now();

  return nowMs >= start - windowMs && nowMs <= end + 3600_000;
}

export function init() {
  // Provision late so any other listener on booking creation has already run.
  events.onEvent("booking_created", async (booking) => {
    await provision(booking.shop, booking.platform, booking);
  });
  events.onEvent("booking_rescheduled", async (booking) => {
    await reprovision(booking.shop, booking.platform, booking);
  });
}
