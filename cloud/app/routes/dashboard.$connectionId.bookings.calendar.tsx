import type { Route } from "./+types/dashboard.$connectionId.bookings.calendar";
import { Bookings, Data, Settings } from "getbooqin-core";
import { wallClockToUtc, zoneDateAndMinutes } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { PageHeader } from "~/components/ui";
import { DayCalendar, WeekCalendar, ModeToggle, type CalendarBooking, type CalendarColumn, type WeekBooking } from "~/components/calendar";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";
import { shiftDate, mondayOf, dayOfWeekFromIso } from "~/lib/calendarDate";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `Calendar · ${vocabFor(dashboardPreset(matches)).bookingTitle} · GetBooqin` },
];

// A booking market completed/no-show the moment staff close it out
// shouldn't vanish from today's grid the instant it happens — occupyingBetween's
// default OCCUPYING filter is right for conflict-checking but not for "what
// should render on a calendar." Matches the list view's own "Active" default
// (everything except cancelled/declined).
const CALENDAR_STATUSES = [...Bookings.OCCUPYING, "completed", "no_show"];

function fullName(c: { firstName: string; lastName: string }): string {
  return `${c.firstName} ${c.lastName}`.trim();
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const settings = await Settings.getSettings(shop, platform);
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "week" ? "week" : "day";
  const todayIso = zoneDateAndMinutes(new Date(), settings.timezone).date;
  const rawDate = url.searchParams.get("date");
  const date = Bookings.validDate(rawDate) ? rawDate : todayIso;

  if (mode === "week") {
    const weekStart = mondayOf(date);
    const weekEnd = shiftDate(weekStart, 7);
    const startUtc = wallClockToUtc(`${weekStart}T00:00`, settings.timezone);
    const endUtc = wallClockToUtc(`${weekEnd}T00:00`, settings.timezone);
    const rows = await Bookings.occupyingBetween(shop, platform, 0, startUtc, endUtc, { statusIn: CALENDAR_STATUSES });
    const withNames = await Data.attachServiceNames(shop, rows);

    const bookings: WeekBooking[] = withNames.map((b) => {
      const start = zoneDateAndMinutes(b.startUtc, settings.timezone);
      return {
        id: b.id,
        date: start.date,
        startMin: start.minutes,
        status: b.status,
        resourceName: b.resource.name,
        serviceName: b.serviceName,
        serviceColor: b.service.color,
        customerName: fullName(b.customer),
      };
    });

    return { mode: "week" as const, date, weekStart, todayIso, bookings };
  }

  const activePractitioners = await Data.resources(shop, platform, true, "practitioner");
  const dayStartUtc = wallClockToUtc(`${date}T00:00`, settings.timezone);
  const dayEndUtc = wallClockToUtc(`${shiftDate(date, 1)}T00:00`, settings.timezone);
  const rawBookings = await Bookings.occupyingBetween(shop, platform, 0, dayStartUtc, dayEndUtc, { statusIn: CALENDAR_STATUSES });
  const withNames = await Data.attachServiceNames(shop, rawBookings);

  // A practitioner deactivated mid-week who still has a booking tomorrow
  // must still get a column — a feature pitched as "see the shape of
  // tomorrow" must not silently drop a real, still-occupying appointment.
  const activeIds = new Set(activePractitioners.map((r) => r.id));
  const orphanIds = [...new Set(withNames.map((b) => b.resourceId).filter((id) => !activeIds.has(id)))];
  const orphanResources = (await Promise.all(orphanIds.map((id) => Data.resource(shop, id)))).filter((r): r is NonNullable<typeof r> => !!r);

  const resourceList = [...activePractitioners.map((r) => ({ ...r, inactive: false })), ...orphanResources.map((r) => ({ ...r, inactive: true }))];
  const resourceIds = resourceList.map((r) => r.id);
  const resourceById = new Map(resourceList.map((r) => [r.id, r]));

  const [scheduleRows, timeOffRows] = await Promise.all([
    Data.schedulesForResources(shop, resourceIds),
    Data.timeoffBetween(shop, resourceIds, dayStartUtc, dayEndUtc),
  ]);

  const dow = dayOfWeekFromIso(date);
  const schedulesByResource = new Map<number, typeof scheduleRows>();
  for (const row of scheduleRows) {
    if (row.dayOfWeek !== dow) continue;
    const list = schedulesByResource.get(row.resourceId) ?? [];
    list.push(row);
    schedulesByResource.set(row.resourceId, list);
  }

  const columns: CalendarColumn[] = resourceList.map((resource) => {
    const openWindows = (schedulesByResource.get(resource.id) ?? []).map((row) => {
      // Schedule rows are naive "HH:MM" strings in the resource's own
      // timezone (empty string means "inherits the shop's") — converting
      // through a real UTC instant and back keeps this correct even for the
      // rare resource with its own explicit timezone override.
      const resourceTz = resource.timezone || settings.timezone;
      const startUtc = wallClockToUtc(`${date}T${row.startTime}`, resourceTz);
      const endUtc = wallClockToUtc(`${date}T${row.endTime}`, resourceTz);
      const start = zoneDateAndMinutes(startUtc, settings.timezone);
      const end = zoneDateAndMinutes(endUtc, settings.timezone);
      return {
        startMin: Math.max(0, Math.min(1440, start.date === date ? start.minutes : start.date < date ? 0 : 1440)),
        endMin: Math.max(0, Math.min(1440, end.date === date ? end.minutes : end.date < date ? 0 : 1440)),
      };
    });

    const timeOff = timeOffRows
      .filter((t) => t.resourceId === resource.id || t.resourceId === 0)
      .map((t) => {
        const start = zoneDateAndMinutes(t.startUtc, settings.timezone);
        const end = zoneDateAndMinutes(t.endUtc, settings.timezone);
        return {
          id: t.id,
          startMin: start.date === date ? start.minutes : start.date < date ? 0 : 1440,
          endMin: end.date === date ? end.minutes : end.date > date ? 1440 : 0,
          reason: t.reason,
        };
      })
      .filter((t) => t.endMin > t.startMin);

    return { resourceId: resource.id, resourceName: resource.name, inactive: (resource as { inactive: boolean }).inactive, openWindows, timeOff };
  });

  const bookings: CalendarBooking[] = withNames.map((b) => {
    const start = zoneDateAndMinutes(b.startUtc, settings.timezone);
    const end = zoneDateAndMinutes(b.endUtc, settings.timezone);
    const startMin = start.date === date ? start.minutes : 0;
    const endMin = end.date === date ? end.minutes : 1440;
    const resource = resourceById.get(b.resourceId);
    return {
      id: b.id,
      status: b.status,
      startMin,
      endMin,
      resourceId: b.resourceId,
      resourceName: resource?.name ?? b.resource.name,
      serviceName: b.serviceName,
      serviceColor: b.service.color,
      customerName: fullName(b.customer),
      draggable: start.date === date,
    };
  });

  const boundaries = [
    ...columns.flatMap((c) => c.openWindows.flatMap((w) => [w.startMin, w.endMin])),
    ...columns.flatMap((c) => c.timeOff.flatMap((t) => [t.startMin, t.endMin])),
    ...bookings.flatMap((b) => [b.startMin, b.endMin]),
  ];

  let visibleStartMin = 540;
  let visibleEndMin = 1020;
  const noHoursToday = boundaries.length === 0;
  if (!noHoursToday) {
    const min = Math.max(0, Math.floor((Math.min(...boundaries) - 30) / 30) * 30);
    const max = Math.min(1440, Math.ceil((Math.max(...boundaries) + 30) / 30) * 30);
    visibleStartMin = min;
    visibleEndMin = Math.max(max, min + 60);
  }

  return {
    mode: "day" as const,
    date,
    todayIso,
    slotInterval: settings.slot_interval,
    visibleStartMin,
    visibleEndMin,
    columns,
    bookings,
    noHoursToday,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId, "write");
  const form = await request.formData();
  if (String(form.get("_action") ?? "") !== "reschedule_drag") {
    return { ok: false as const, error: "Unknown request." };
  }
  try {
    const settings = await Settings.getSettings(shop, platform);
    await Bookings.reschedule(
      shop,
      platform,
      settings.timezone,
      Number(form.get("booking_id") || 0),
      String(form.get("date") || ""),
      String(form.get("time") || ""),
      Number(form.get("resource_id") || 0)
    );
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export default function BookingsCalendar({ loaderData, params }: Route.ComponentProps) {
  const v = useVocabulary();
  const base = `/dashboard/${params.connectionId}`;
  const calendarBase = `${base}/bookings/calendar`;
  const detailBase = `${base}/bookings`;

  const isWeek = loaderData.mode === "week";
  const prevHref = isWeek
    ? `${calendarBase}?mode=week&date=${shiftDate(loaderData.weekStart, -7)}`
    : `${calendarBase}?mode=day&date=${shiftDate(loaderData.date, -1)}`;
  const nextHref = isWeek
    ? `${calendarBase}?mode=week&date=${shiftDate(loaderData.weekStart, 7)}`
    : `${calendarBase}?mode=day&date=${shiftDate(loaderData.date, 1)}`;
  const todayHref = isWeek ? `${calendarBase}?mode=week&date=${mondayOf(loaderData.todayIso)}` : `${calendarBase}?mode=day&date=${loaderData.todayIso}`;
  const toggleDate = isWeek ? loaderData.weekStart : loaderData.date;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title={v.bookingTitle}
        actions={
          <a href={detailBase} className="btn-sec">
            List
          </a>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <a href={prevHref} className="btn-sec px-[10px]" aria-label="Previous">
            ‹
          </a>
          <a href={todayHref} className="btn-sec">
            Today
          </a>
          <a href={nextHref} className="btn-sec px-[10px]" aria-label="Next">
            ›
          </a>
          <span className="num ml-1 text-[14px] font-medium text-ink-2">
            {isWeek ? `${loaderData.weekStart} – ${shiftDate(loaderData.weekStart, 6)}` : loaderData.date}
          </span>
        </div>
        <ModeToggle mode={loaderData.mode} base={calendarBase} date={toggleDate} />
      </div>

      {isWeek ? (
        <WeekCalendar
          weekStart={loaderData.weekStart}
          todayIso={loaderData.todayIso}
          bookings={loaderData.bookings}
          detailBase={detailBase}
          calendarBase={calendarBase}
        />
      ) : (
        <DayCalendar
          date={loaderData.date}
          slotInterval={loaderData.slotInterval}
          visibleStartMin={loaderData.visibleStartMin}
          visibleEndMin={loaderData.visibleEndMin}
          columns={loaderData.columns}
          bookings={loaderData.bookings}
          detailBase={detailBase}
          emptyNote={loaderData.noHoursToday ? `No ${v.resourceOne || "practitioner"} has hours set for this day.` : undefined}
        />
      )}
    </div>
  );
}
