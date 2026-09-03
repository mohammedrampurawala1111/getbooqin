/**
 * Slot engine. Ported from shopify-openslot/app/lib/availability.server.ts —
 * same logic, adapted to core's Prisma client and threaded with an explicit
 * `platform` parameter alongside `shop` (see data.ts's header for why).
 *
 * Everything is stored in UTC. Weekly schedules are expressed in the business
 * timezone (shop timezone, or the resource's own timezone when set), and
 * slots are generated in that timezone then converted to UTC. There is never
 * a second "local" copy of a timestamp in the database.
 */
import { DateTime } from "luxon";
import prisma from "../db.js";
import type { Resource } from "@prisma/client";
import type { CatalogService } from "./data.js";
import * as Data from "./data.js";
import { getSettings } from "./settings.js";
import { GetBooqinError } from "./errors.js";

/**
 * Data.saveServiceConfig now rejects a non-positive duration at write time,
 * but the slot generator is the one place a wrong duration turns directly
 * into a wrong end_utc for every slot it produces — the exact mechanism
 * that let five real services get double-booked. A loud failure here on a
 * row that somehow still has no real duration is far better than silently
 * falling back to some default and generating slots nobody actually
 * reserved the right length for.
 */
function assertDuration(service: CatalogService): void {
  if (!Number.isFinite(service.durationMin) || service.durationMin <= 0) {
    throw new GetBooqinError(
      "getbooqin_missing_duration",
      `Service "${service.name}" has no valid duration set — refusing to generate slots for it.`,
      500
    );
  }
}

export interface Slot {
  time: string; // "HH:MM" in the business timezone
  label: string;
  start_utc: string; // ISO
  end_utc: string; // ISO
  resource_id: number;
  resources: number[];
  available: boolean; // always true from slots() — only false when includeBlocked surfaces a taken slot
}

export function businessTz(shopTimezone: string, resource?: Resource | null): string {
  if (resource?.timezone) return resource.timezone;
  return shopTimezone || "UTC";
}

export async function slots(
  shop: string,
  platform: string,
  shopTimezone: string,
  serviceId: number,
  resourceId: number,
  date: string,
  excludeBookingId = 0,
  extraDurationMin = 0,
  // Only ever honored when resourceId resolves to exactly one candidate —
  // "any available resource" has no single well-defined "blocked" answer
  // (busy for resource A, free for resource B is legitimately just an
  // available slot), so this silently behaves as false in that case rather
  // than guessing. Blocked entries carry available:false; every entry
  // slots() would already have returned still carries available:true, so
  // existing callers see byte-identical data plus this one new field.
  includeBlocked = false
): Promise<Slot[]> {
  const service = await Data.catalogService(shop, serviceId);
  if (!service || !service.status) return [];
  assertDuration(service);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

  const settings = await getSettings(shop, platform);
  const interval = Math.max(5, settings.slot_interval);
  const now = DateTime.utc();
  const earliest = now.plus({ hours: Math.max(0, settings.min_notice_hours) });
  const latest = now.plus({ days: Math.max(1, settings.max_advance_days) });

  const candidateResources = resourceId
    ? [await Data.resource(shop, resourceId)].filter((r): r is Resource => !!r)
    : await Data.resourcesForService(shop, platform, serviceId);

  const found = new Map<string, Slot>();
  const canShowBlocked = includeBlocked && candidateResources.length === 1;

  for (const resource of candidateResources) {
    if (!resource || !resource.status) continue;

    const tz = businessTz(shopTimezone, resource);
    const dayStart = DateTime.fromISO(`${date}T00:00:00`, { zone: tz });
    if (!dayStart.isValid) continue;
    const dow = dayStart.weekday % 7; // luxon: 1=Mon..7=Sun -> convert to 0=Sun..6=Sat

    const windows = await windowsForDay(shop, resource.id, dow);
    if (!windows.length) continue;

    // Fetch this resource's bookings/time-off for the whole day once, instead
    // of re-querying per candidate slot.
    const { timeOffRows, bookingRows } = await busyRowsForDay(
      shop,
      resource.id,
      dayStart,
      service,
      excludeBookingId
    );

    generateSlots(
      date,
      tz,
      windows,
      service,
      interval,
      earliest,
      latest,
      timeOffRows,
      bookingRows,
      extraDurationMin,
      resource.id,
      found,
      canShowBlocked
    );
  }

  return Array.from(found.values())
    .filter((slot) => slot.available || canShowBlocked)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * The actual slot-time math (walk each open window in `interval` steps,
 * keep the ones that clear notice/advance bounds and aren't blocked by an
 * existing booking or time off) — pulled out of slots() so daysInMonth can
 * reuse it against data it already fetched, without each call re-querying
 * the DB. Mutates `found` in place since both callers just want it filled.
 */
function generateSlots(
  date: string,
  tz: string,
  windows: Array<{ start: string; end: string }>,
  service: CatalogService,
  interval: number,
  earliest: DateTime,
  latest: DateTime,
  timeOffRows: BusyRow[],
  bookingRows: BusyRow[],
  extraDurationMin: number,
  resourceId: number,
  found: Map<string, Slot>,
  // Only ever passed true from slots() when there's exactly one candidate
  // resource — see that function's comment on why "any resource" has no
  // single coherent "blocked" answer. daysInMonth() never passes this, so
  // its day counts stay exactly what they always were (available slots
  // only).
  includeUnavailable = false
): void {
  for (const window of windows) {
    let cursor = DateTime.fromISO(`${date}T${window.start}:00`, { zone: tz });
    const stop = DateTime.fromISO(`${date}T${window.end}:00`, { zone: tz });
    if (!cursor.isValid || !stop.isValid) continue;
    const windowStart = cursor;

    while (true) {
      const slotEnd = cursor.plus({ minutes: service.durationMin + extraDurationMin });
      // The slot's *occupied* span — including both buffers, exactly like
      // isFreeLocal's own busyStart/busyEnd below — must fit inside the
      // working window, not just the appointment itself. Buffer-after was
      // never checked against closing time and buffer-before never against
      // opening time, so a 30-min service with a 30-min buffer-after could
      // still be offered at 17:30 on an 18:00 close, needing the resource
      // until 18:30 (Defect Dossier's BQ-06 finding).
      const bufferedEnd = slotEnd.plus({ minutes: service.bufferAfterMin });
      if (bufferedEnd > stop) break;
      const bufferedStart = cursor.minus({ minutes: service.bufferBeforeMin });
      if (bufferedStart < windowStart) {
        cursor = cursor.plus({ minutes: interval });
        continue;
      }

      const startUtc = cursor.toUTC();
      const endUtc = slotEnd.toUTC();
      const inRange = startUtc >= earliest && startUtc <= latest;
      const available = inRange && isFreeLocal(startUtc, endUtc, service, timeOffRows, bookingRows);

      if (available || (includeUnavailable && inRange)) {
        const key = cursor.toFormat("HH:mm");
        const existing = found.get(key);
        if (!existing) {
          found.set(key, {
            time: key,
            // 24-hour, matching the rest of the app's convention (Time off,
            // the dashboard's reschedule/add-booking time inputs) — used to
            // be "h:mm a" (12-hour), which sat directly under a dd/mm date
            // field and read as two different locale conventions on one
            // screen (UX audit's #10 finding).
            label: cursor.toFormat("HH:mm"),
            start_utc: startUtc.toISO()!,
            end_utc: endUtc.toISO()!,
            resource_id: resourceId,
            resources: [resourceId],
            available,
          });
        } else {
          existing.resources.push(resourceId);
          existing.available = existing.available || available;
        }
      }

      cursor = cursor.plus({ minutes: interval });
    }
  }
}

/**
 * Zero candidate resources — as opposed to zero *open* slots — means the
 * public page's "no openings" empty state is lying: nobody will ever be
 * assigned, no amount of "try again later" will help, and the right
 * message is "call us," not "check back" (Defect Dossier's R2-04 finding,
 * item 4). Mirrors the same candidate-resolution slots() itself uses so
 * the two never disagree.
 */
export async function isServiceBookable(shop: string, platform: string, serviceId: number, resourceId: number): Promise<boolean> {
  if (resourceId) {
    const resource = await Data.resource(shop, resourceId);
    return !!resource?.status;
  }
  const candidates = await Data.resourcesForService(shop, platform, serviceId);
  return candidates.length > 0;
}

export async function nextAvailableDays(
  shop: string,
  platform: string,
  shopTimezone: string,
  serviceId: number,
  resourceId: number,
  limit = 7,
  scanDays = 45,
  extraDurationMin = 0
): Promise<Array<{ date: string; label: string; count: number }>> {
  const out: Array<{ date: string; label: string; count: number }> = [];
  const resource = resourceId ? await Data.resource(shop, resourceId) : null;
  const tz = businessTz(shopTimezone, resource);
  const day = DateTime.now().setZone(tz);

  for (let i = 0; i < scanDays && out.length < limit; i++) {
    const date = day.plus({ days: i }).toFormat("yyyy-MM-dd");
    const daySlots = await slots(shop, platform, shopTimezone, serviceId, resourceId, date, 0, extraDurationMin);
    if (daySlots.length) {
      out.push({
        date,
        label: DateTime.fromISO(date, { zone: tz }).toFormat("ccc, LLL d"),
        count: daySlots.length,
      });
    }
  }
  return out;
}

/**
 * A day's status is more than its slot count: 0 means one of three
 * completely different things — the studio doesn't work this day at all
 * ("closed"), it works but every slot is taken ("full"), or the date is
 * past the booking horizon and was never open to begin with
 * ("out_of_range"). A bare count can't tell these apart, which is exactly
 * what let a fully-booked calendar month and a permanently-closed weekday
 * render identically to a customer (and, before Task 1's join()
 * validation, let a waitlist join succeed for either).
 */
export type DayState = "open" | "full" | "closed" | "out_of_range" | "past";

/**
 * Every day in one calendar month with its slot count (0 for unavailable —
 * unlike nextAvailableDays, which silently skips those) and why.
 */
export async function daysInMonth(
  shop: string,
  platform: string,
  shopTimezone: string,
  serviceId: number,
  resourceId: number,
  year: number,
  month: number, // 1-12
  extraDurationMin = 0
): Promise<Array<{ date: string; count: number; state: DayState }>> {
  const service = await Data.catalogService(shop, serviceId);
  const monthStart = DateTime.fromObject({ year, month, day: 1 }, { zone: shopTimezone || "UTC" });
  const daysInThisMonth = monthStart.daysInMonth ?? 30;
  const today = DateTime.now().setZone(shopTimezone || "UTC").startOf("day");
  const emptyMonth = (): Array<{ date: string; count: number; state: DayState }> =>
    Array.from({ length: daysInThisMonth }, (_, i) => {
      const day = monthStart.plus({ days: i });
      return { date: day.toFormat("yyyy-MM-dd"), count: 0, state: day < today ? "past" : "closed" };
    });

  if (!service || !service.status) return emptyMonth();
  assertDuration(service);

  const settings = await getSettings(shop, platform);
  const interval = Math.max(5, settings.slot_interval);
  const now = DateTime.utc();
  const earliest = now.plus({ hours: Math.max(0, settings.min_notice_hours) });
  const latest = now.plus({ days: Math.max(1, settings.max_advance_days) });

  const candidateResources = (
    resourceId
      ? [await Data.resource(shop, resourceId)].filter((r): r is Resource => !!r)
      : await Data.resourcesForService(shop, platform, serviceId)
  ).filter((r) => r.status);
  if (!candidateResources.length) return emptyMonth();

  const perResource = await Promise.all(
    candidateResources.map(async (resource) => {
      const tz = businessTz(shopTimezone, resource);
      const scheduleRows = await prisma.schedule.findMany({ where: { shop, resourceId: resource.id } });
      const windowsByDow = new Map<number, Array<{ start: string; end: string }>>();
      for (const row of scheduleRows) {
        const list = windowsByDow.get(row.dayOfWeek) ?? [];
        list.push({ start: row.startTime, end: row.endTime });
        windowsByDow.set(row.dayOfWeek, list);
      }

      const rangeStart = DateTime.fromObject({ year, month, day: 1 }, { zone: tz })
        .minus({ minutes: service.bufferBeforeMin })
        .toUTC()
        .toJSDate();
      const rangeEnd = DateTime.fromObject({ year, month, day: daysInThisMonth }, { zone: tz })
        .plus({ days: 1, minutes: service.bufferAfterMin })
        .toUTC()
        .toJSDate();

      const [timeOffRows, bookingRows] = await Promise.all([
        prisma.timeOff.findMany({
          where: { shop, OR: [{ resourceId: resource.id }, { resourceId: 0 }], startUtc: { lt: rangeEnd }, endUtc: { gt: rangeStart } },
          select: { startUtc: true, endUtc: true },
        }),
        prisma.booking.findMany({
          where: { shop, resourceId: resource.id, status: { in: ["pending", "confirmed"] }, startUtc: { lt: rangeEnd }, endUtc: { gt: rangeStart } },
          select: { serviceId: true, startUtc: true, endUtc: true },
        }),
      ]);

      return {
        resource,
        tz,
        windowsByDow,
        timeOffRows: timeOffRows.map((row) => ({ serviceId: 0, startUtc: row.startUtc, endUtc: row.endUtc })),
        bookingRows,
      };
    })
  );

  const out: Array<{ date: string; count: number; state: DayState }> = [];
  for (let i = 0; i < daysInThisMonth; i++) {
    const day = monthStart.plus({ days: i });
    const date = day.toFormat("yyyy-MM-dd");
    if (day < today) {
      out.push({ date, count: 0, state: "past" });
      continue;
    }
    // Past the booking horizon entirely — the studio was never "full" here,
    // there's simply nothing to book yet at any resource. Checked ahead of
    // the schedule so a weekday that's normally open but currently beyond
    // max_advance_days reads as out_of_range, not full.
    if (day.toUTC() > latest) {
      out.push({ date, count: 0, state: "out_of_range" });
      continue;
    }

    const found = new Map<string, Slot>();
    let anyWindowToday = false;
    for (const { resource, tz, windowsByDow, timeOffRows, bookingRows } of perResource) {
      const dayStart = DateTime.fromISO(`${date}T00:00:00`, { zone: tz });
      if (!dayStart.isValid) continue;
      const dow = dayStart.weekday % 7;
      const windows = windowsByDow.get(dow) ?? [];
      if (!windows.length) continue;
      anyWindowToday = true;

      generateSlots(date, tz, windows, service, interval, earliest, latest, timeOffRows, bookingRows, extraDurationMin, resource.id, found);
    }
    // "closed" only when none of the candidate resources work this weekday
    // at all — with multiple resources for a service, one being off a given
    // day shouldn't read as the whole day being shut.
    const state: DayState = !anyWindowToday ? "closed" : found.size > 0 ? "open" : "full";
    out.push({ date, count: found.size, state });
  }

  return out;
}

async function windowsForDay(shop: string, resourceId: number, dow: number) {
  const rows = await prisma.schedule.findMany({
    where: { shop, resourceId, dayOfWeek: dow },
    orderBy: { startTime: "asc" },
  });
  return rows.map((row) => ({ start: row.startTime, end: row.endTime }));
}

interface BusyRow {
  serviceId: number;
  startUtc: Date;
  endUtc: Date;
}

/** Bookings and time-off for one resource, covering every slot `slots()` could generate for `dayStart`'s date. */
async function busyRowsForDay(
  shop: string,
  resourceId: number,
  dayStart: DateTime,
  service: CatalogService,
  excludeBookingId: number
): Promise<{ timeOffRows: BusyRow[]; bookingRows: BusyRow[] }> {
  const fetchStart = dayStart.toUTC().minus({ minutes: service.bufferBeforeMin }).toJSDate();
  const fetchEnd = dayStart
    .plus({ days: 1 })
    .toUTC()
    .plus({ minutes: service.bufferAfterMin })
    .toJSDate();

  const [timeOffRows, bookingRows] = await Promise.all([
    prisma.timeOff.findMany({
      where: {
        shop,
        OR: [{ resourceId }, { resourceId: 0 }],
        startUtc: { lt: fetchEnd },
        endUtc: { gt: fetchStart },
      },
      select: { startUtc: true, endUtc: true },
    }),
    prisma.booking.findMany({
      where: {
        shop,
        resourceId,
        status: { in: ["pending", "confirmed"] },
        startUtc: { lt: fetchEnd },
        endUtc: { gt: fetchStart },
        id: { not: excludeBookingId },
      },
      select: { serviceId: true, startUtc: true, endUtc: true },
    }),
  ]);

  return {
    timeOffRows: timeOffRows.map((t) => ({ serviceId: 0, startUtc: t.startUtc, endUtc: t.endUtc })),
    bookingRows: bookingRows,
  };
}

/** Same rules as `isFree`, checked against rows already fetched for the day instead of querying per slot. */
function isFreeLocal(
  startUtc: DateTime,
  endUtc: DateTime,
  service: CatalogService,
  timeOffRows: BusyRow[],
  bookingRows: BusyRow[]
): boolean {
  const busyStart = startUtc.minus({ minutes: service.bufferBeforeMin }).toMillis();
  const busyEnd = endUtc.plus({ minutes: service.bufferAfterMin }).toMillis();

  const blocked = timeOffRows.some(
    (t) => t.startUtc.getTime() < busyEnd && t.endUtc.getTime() > busyStart
  );
  if (blocked) return false;

  const capacity = Math.max(1, service.capacity);

  if (capacity > 1) {
    const startMs = startUtc.toMillis();
    const taken = bookingRows.filter(
      (b) => b.serviceId === service.id && b.startUtc.getTime() === startMs
    ).length;
    return taken < capacity;
  }

  const overlap = bookingRows.some(
    (b) => b.startUtc.getTime() < busyEnd && b.endUtc.getTime() > busyStart
  );
  return !overlap;
}

/** Is this range inside a time-off block for the resource (or the whole business, resourceId 0)? Applies service buffers. */
export async function isBlockedByTimeOff(
  shop: string,
  resourceId: number,
  startUtc: DateTime,
  endUtc: DateTime,
  service: CatalogService
): Promise<boolean> {
  const busyStart = startUtc.minus({ minutes: service.bufferBeforeMin }).toJSDate();
  const busyEnd = endUtc.plus({ minutes: service.bufferAfterMin }).toJSDate();

  const blocked = await prisma.timeOff.count({
    where: {
      shop,
      OR: [{ resourceId }, { resourceId: 0 }],
      startUtc: { lt: busyEnd },
      endUtc: { gt: busyStart },
    },
  });
  return blocked > 0;
}

/** Does this range collide with another booking on the resource? Applies service buffers and capacity. */
export async function hasBookingConflict(
  shop: string,
  resourceId: number,
  startUtc: DateTime,
  endUtc: DateTime,
  service: CatalogService,
  excludeBookingId = 0
): Promise<boolean> {
  const busyStart = startUtc.minus({ minutes: service.bufferBeforeMin }).toJSDate();
  const busyEnd = endUtc.plus({ minutes: service.bufferAfterMin }).toJSDate();

  const capacity = Math.max(1, service.capacity);

  if (capacity > 1) {
    const taken = await prisma.booking.count({
      where: {
        shop,
        resourceId,
        serviceId: service.id,
        startUtc: startUtc.toJSDate(),
        status: { in: ["pending", "confirmed"] },
        id: { not: excludeBookingId },
      },
    });
    return taken >= capacity;
  }

  const overlap = await prisma.booking.count({
    where: {
      shop,
      resourceId,
      status: { in: ["pending", "confirmed"] },
      startUtc: { lt: busyEnd },
      endUtc: { gt: busyStart },
      id: { not: excludeBookingId },
    },
  });

  return overlap > 0;
}

/**
 * Is the resource free for this range? Applies service buffers, existing
 * bookings, capacity and time-off. Composes isBlockedByTimeOff/
 * hasBookingConflict — kept as one call for the many existing callers that
 * only need a plain yes/no, not which of the two reasons it failed for.
 */
export async function isFree(
  shop: string,
  resourceId: number,
  startUtc: DateTime,
  endUtc: DateTime,
  service: CatalogService,
  excludeBookingId = 0
): Promise<boolean> {
  if (await isBlockedByTimeOff(shop, resourceId, startUtc, endUtc, service)) return false;
  return !(await hasBookingConflict(shop, resourceId, startUtc, endUtc, service, excludeBookingId));
}
