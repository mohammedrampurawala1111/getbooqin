import { DateTime } from "luxon";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { Page, Card, InlineStack, BlockStack, Text, Button, ButtonGroup, TextField, Select, EmptyState } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Data } from "getbooqin-core";
import { Bookings } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

const STATUS_COLOR: Record<string, { bg: string; border: string }> = {
  confirmed: { bg: "#e3f5e9", border: "#1f9254" },
  pending: { bg: "#fdf3d8", border: "#b98900" },
  completed: { bg: "#e4ecfb", border: "#3050a0" },
  no_show: { bg: "#fbe3e3", border: "#c0392b" },
  cancelled: { bg: "#f1f1f1", border: "#8c9196" },
  declined: { bg: "#f1f1f1", border: "#8c9196" },
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

const PX_PER_HOUR = 56;
const GRID_MAX_HEIGHT = "60vh"; // caps the scrollable grid body so the toolbar/legend never scroll off-screen
const DEFAULT_RANGE = { startMin: 8 * 60, endMin: 18 * 60 }; // 8:00–18:00 fallback when nothing else defines the visible range
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface GridBooking {
  id: number;
  status: string;
  service: string;
  subtitle?: string;
  customer: string;
  timeLabel: string;
  startMin: number;
  durationMin: number;
}

interface GridColumn {
  id: number | string;
  name: string;
  bookings: GridBooking[];
}

function bookingToGridItem(
  b: { id: number; status: string; serviceName: string; resource: { name: string } | null; customer: { firstName: string; lastName: string } | null; startUtc: Date; endUtc: Date },
  tz: string,
  dayMidnight: DateTime,
  showResource: boolean
): GridBooking {
  const startLocal = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tz);
  const endLocal = DateTime.fromJSDate(b.endUtc, { zone: "utc" }).setZone(tz);
  return {
    id: b.id,
    status: b.status,
    service: b.serviceName,
    subtitle: showResource ? b.resource?.name || "Anyone available" : undefined,
    customer: b.customer ? `${b.customer.firstName} ${b.customer.lastName}`.trim() : "Guest",
    timeLabel: `${startLocal.toFormat("h:mm a")}–${endLocal.toFormat("h:mm a")}`,
    startMin: startLocal.diff(dayMidnight, "minutes").minutes,
    durationMin: Math.max(15, endLocal.diff(startLocal, "minutes").minutes),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const tz = settings.timezone || "UTC";

  const url = new URL(request.url);
  const viewParam = url.searchParams.get("view");
  const view = viewParam === "day" ? "day" : viewParam === "week" ? "week" : "month";
  const dateParam = url.searchParams.get("date") || "";
  const resourceIdParam = Number(url.searchParams.get("resource_id") || 0);
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
    ? DateTime.fromISO(dateParam, { zone: tz })
    : DateTime.now().setZone(tz).startOf("day");
  const date = selected.toFormat("yyyy-MM-dd");
  const todayDate = DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");

  const allResources = await Data.resources(shop, "shopify", true);
  const resourceOptions = allResources.map((r) => ({ id: r.id, name: r.name }));

  const shared = {
    settings,
    date,
    todayDate,
    resourceId: resourceIdParam,
    resourceOptions,
  };

  if (view === "day") {
    const dayOfWeek = selected.weekday % 7; // luxon: 1=Mon..7=Sun -> 0=Sun..6=Sat, matching Schedule.dayOfWeek
    const dayStartUtc = selected.startOf("day").toUTC().toJSDate();
    const dayEndUtc = selected.endOf("day").toUTC().toJSDate();

    const [dayBookingsRaw, scheduleRows] = await Promise.all([
      Bookings.query(shop, "shopify", { from: dayStartUtc, to: dayEndUtc, limit: 500, order: "asc" }),
      prisma.schedule.findMany({ where: { shop, dayOfWeek } }),
    ]);
    const dayBookings = await Data.attachServiceNames(shop, dayBookingsRaw);

    const resources = resourceIdParam ? allResources.filter((r) => r.id === resourceIdParam) : allResources;
    const filteredScheduleRows = resourceIdParam ? scheduleRows.filter((r) => r.resourceId === resourceIdParam) : scheduleRows;
    // Bookings with no specific staff assigned ("Anyone available") only make
    // sense in the all-staff view — once a merchant picks one team member,
    // there's no "Unassigned" column to put them in.
    const filteredBookings = resourceIdParam ? dayBookings.filter((b) => b.resourceId === resourceIdParam) : dayBookings;

    const scheduleByResource = new Map<number, { startMin: number; endMin: number }[]>();
    for (const row of filteredScheduleRows) {
      const list = scheduleByResource.get(row.resourceId) ?? [];
      list.push({ startMin: toMinutes(row.startTime), endMin: toMinutes(row.endTime) });
      scheduleByResource.set(row.resourceId, list);
    }

    const bookingsByResource = new Map<number, typeof dayBookings>();
    for (const b of filteredBookings) {
      const list = bookingsByResource.get(b.resourceId) ?? [];
      list.push(b);
      bookingsByResource.set(b.resourceId, list);
    }

    // The grid's visible range has to cover every schedule window and every
    // booking that day — a booking created outside normal hours (or a
    // schedule change after the fact) would otherwise get silently clipped
    // off the top or bottom instead of just being visible where it is.
    let rangeStart = DEFAULT_RANGE.startMin;
    let rangeEnd = DEFAULT_RANGE.endMin;
    let sawAny = false;
    for (const windows of scheduleByResource.values()) {
      for (const w of windows) {
        rangeStart = sawAny ? Math.min(rangeStart, w.startMin) : w.startMin;
        rangeEnd = sawAny ? Math.max(rangeEnd, w.endMin) : w.endMin;
        sawAny = true;
      }
    }
    for (const b of filteredBookings) {
      const tzForBooking = Bookings.displayTz(b, tz);
      const startMin = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tzForBooking).diff(selected, "minutes").minutes;
      const endMin = DateTime.fromJSDate(b.endUtc, { zone: "utc" }).setZone(tzForBooking).diff(selected, "minutes").minutes;
      rangeStart = sawAny ? Math.min(rangeStart, startMin) : startMin;
      rangeEnd = sawAny ? Math.max(rangeEnd, endMin) : endMin;
      sawAny = true;
    }
    rangeStart = Math.max(0, Math.floor(rangeStart / 60) * 60);
    rangeEnd = Math.min(24 * 60, Math.ceil(rangeEnd / 60) * 60);
    if (rangeEnd <= rangeStart) {
      rangeStart = DEFAULT_RANGE.startMin;
      rangeEnd = DEFAULT_RANGE.endMin;
    }

    const columns: GridColumn[] = resources.map((r) => ({
      id: r.id,
      name: r.name,
      bookings: (bookingsByResource.get(r.id) ?? []).map((b) => bookingToGridItem(b, Bookings.displayTz(b, tz), selected, false)),
    }));

    const unassigned = (bookingsByResource.get(0) ?? []).map((b) => bookingToGridItem(b, Bookings.displayTz(b, tz), selected, false));
    if (unassigned.length) columns.push({ id: 0, name: "Unassigned", bookings: unassigned });

    return {
      ...shared,
      view: "day" as const,
      prevDate: selected.minus({ days: 1 }).toFormat("yyyy-MM-dd"),
      nextDate: selected.plus({ days: 1 }).toFormat("yyyy-MM-dd"),
      dateLabel: selected.toFormat("cccc, LLLL d"),
      rangeStart,
      rangeEnd,
      columns,
    };
  }

  if (view === "week") {
    const weekStart = selected.minus({ days: selected.weekday % 7 }); // Sunday
    const weekStartUtc = weekStart.toUTC().toJSDate();
    const weekEndUtc = weekStart.plus({ days: 7 }).toUTC().toJSDate();

    const [weekBookingsRaw, scheduleRows] = await Promise.all([
      Bookings.query(shop, "shopify", {
        from: weekStartUtc,
        to: weekEndUtc,
        resource_id: resourceIdParam || undefined,
        limit: 1000,
        order: "asc",
      }),
      prisma.schedule.findMany({ where: { shop, ...(resourceIdParam ? { resourceId: resourceIdParam } : {}) } }),
    ]);
    const weekBookings = await Data.attachServiceNames(shop, weekBookingsRaw);

    let rangeStart = DEFAULT_RANGE.startMin;
    let rangeEnd = DEFAULT_RANGE.endMin;
    let sawAny = false;
    for (const row of scheduleRows) {
      const s = toMinutes(row.startTime);
      const e = toMinutes(row.endTime);
      rangeStart = sawAny ? Math.min(rangeStart, s) : s;
      rangeEnd = sawAny ? Math.max(rangeEnd, e) : e;
      sawAny = true;
    }
    for (const b of weekBookings) {
      const tzForBooking = Bookings.displayTz(b, tz);
      const startLocal = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tzForBooking);
      const endLocal = DateTime.fromJSDate(b.endUtc, { zone: "utc" }).setZone(tzForBooking);
      const dayMidnight = startLocal.startOf("day");
      const startMin = startLocal.diff(dayMidnight, "minutes").minutes;
      const endMin = endLocal.diff(dayMidnight, "minutes").minutes;
      rangeStart = sawAny ? Math.min(rangeStart, startMin) : startMin;
      rangeEnd = sawAny ? Math.max(rangeEnd, endMin) : endMin;
      sawAny = true;
    }
    rangeStart = Math.max(0, Math.floor(rangeStart / 60) * 60);
    rangeEnd = Math.min(24 * 60, Math.ceil(rangeEnd / 60) * 60);
    if (rangeEnd <= rangeStart) {
      rangeStart = DEFAULT_RANGE.startMin;
      rangeEnd = DEFAULT_RANGE.endMin;
    }

    const byDate = new Map<string, typeof weekBookings>();
    for (const b of weekBookings) {
      const tzForBooking = Bookings.displayTz(b, tz);
      const localDate = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tzForBooking).toFormat("yyyy-MM-dd");
      const list = byDate.get(localDate) ?? [];
      list.push(b);
      byDate.set(localDate, list);
    }

    const days = Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
    const columns: GridColumn[] = days.map((day) => {
      const iso = day.toFormat("yyyy-MM-dd");
      const dayBookings = byDate.get(iso) ?? [];
      return {
        id: iso,
        name: `${day.toFormat("ccc")} ${day.day}`,
        bookings: dayBookings.map((b) =>
          bookingToGridItem(b, Bookings.displayTz(b, tz), day.startOf("day"), !resourceIdParam)
        ),
      };
    });

    return {
      ...shared,
      view: "week" as const,
      weekLabel: `${weekStart.toFormat("LLL d")} – ${weekStart.plus({ days: 6 }).toFormat("LLL d, yyyy")}`,
      prevWeekDate: weekStart.minus({ days: 7 }).toFormat("yyyy-MM-dd"),
      nextWeekDate: weekStart.plus({ days: 7 }).toFormat("yyyy-MM-dd"),
      rangeStart,
      rangeEnd,
      columns,
    };
  }

  // --- Month grid view ---
  const firstOfMonth = selected.startOf("month");
  const leadingOffset = firstOfMonth.weekday % 7; // Sun=0 .. Sat=6
  const gridStart = firstOfMonth.minus({ days: leadingOffset });
  const totalCells = 42; // 6 full weeks, enough to cover any month's layout
  const gridStartUtc = gridStart.toUTC().toJSDate();
  const gridEndUtc = gridStart.plus({ days: totalCells }).toUTC().toJSDate();

  const monthBookings = await Bookings.query(shop, "shopify", {
    from: gridStartUtc,
    to: gridEndUtc,
    resource_id: resourceIdParam || undefined,
    limit: 2000,
    order: "asc",
  });

  const countsByDate = new Map<string, Record<string, number>>();
  for (const b of monthBookings) {
    const tzForBooking = Bookings.displayTz(b, tz);
    const localDate = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tzForBooking).toFormat("yyyy-MM-dd");
    const rec = countsByDate.get(localDate) ?? {};
    rec[b.status] = (rec[b.status] ?? 0) + 1;
    countsByDate.set(localDate, rec);
  }

  const cells = Array.from({ length: totalCells }, (_, i) => {
    const day = gridStart.plus({ days: i });
    const iso = day.toFormat("yyyy-MM-dd");
    const counts = countsByDate.get(iso) ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return {
      date: iso,
      dayNumber: day.day,
      inMonth: day.month === firstOfMonth.month,
      isToday: iso === todayDate,
      total,
      counts,
    };
  });

  return {
    ...shared,
    view: "month" as const,
    monthLabel: firstOfMonth.toFormat("LLLL yyyy"),
    prevMonthDate: firstOfMonth.minus({ months: 1 }).toFormat("yyyy-MM-dd"),
    nextMonthDate: firstOfMonth.plus({ months: 1 }).toFormat("yyyy-MM-dd"),
    cells,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function hourLabels(rangeStart: number, rangeEnd: number): { min: number; label: string }[] {
  const out: { min: number; label: string }[] = [];
  for (let m = rangeStart; m <= rangeEnd; m += 60) {
    out.push({ min: m, label: DateTime.fromObject({ hour: Math.floor(m / 60), minute: m % 60 }).toFormat("h a") });
  }
  return out;
}

function StatusLegend() {
  return (
    <InlineStack gap="300">
      {Object.entries(STATUS_LABELS).map(([status, label]) => (
        <InlineStack key={status} gap="100" blockAlign="center">
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: STATUS_COLOR[status].bg,
              border: `1px solid ${STATUS_COLOR[status].border}`,
            }}
          />
          <Text as="span" tone="subdued" variant="bodySm">
            {label}
          </Text>
        </InlineStack>
      ))}
    </InlineStack>
  );
}

function TimeGrid({ columns, rangeStart, rangeEnd }: { columns: GridColumn[]; rangeStart: number; rangeEnd: number }) {
  const totalMinutes = rangeEnd - rangeStart;
  const gridHeight = (totalMinutes / 60) * PX_PER_HOUR;
  const hours = hourLabels(rangeStart, rangeEnd);

  return (
    <div style={{ overflow: "auto", maxHeight: GRID_MAX_HEIGHT }}>
      <div style={{ display: "flex", minWidth: 120 + columns.length * 200 }}>
        <div style={{ width: 60, flexShrink: 0, borderRight: "1px solid #e3e3e3", position: "sticky", left: 0, background: "#fff", zIndex: 1 }}>
          <div style={{ height: 44, borderBottom: "1px solid #e3e3e3", position: "sticky", top: 0, background: "#fff", zIndex: 2 }} />
          <div style={{ position: "relative", height: gridHeight }}>
            {hours.map((h) => (
              <div
                key={h.min}
                style={{ position: "absolute", top: ((h.min - rangeStart) / 60) * PX_PER_HOUR - 7, right: 8, fontSize: 12, color: "#6b7280" }}
              >
                {h.label}
              </div>
            ))}
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.id} style={{ flex: "1 0 200px", minWidth: 200, borderRight: "1px solid #e3e3e3" }}>
            <div
              style={{
                height: 44,
                borderBottom: "1px solid #e3e3e3",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 600,
                padding: "0 8px",
                textAlign: "center",
                position: "sticky",
                top: 0,
                background: "#fff",
                zIndex: 2,
              }}
            >
              {col.name}
            </div>
            <div style={{ position: "relative", height: gridHeight, background: "#fafbfb" }}>
              {hours.map((h) => (
                <div
                  key={h.min}
                  style={{ position: "absolute", top: ((h.min - rangeStart) / 60) * PX_PER_HOUR, left: 0, right: 0, borderTop: "1px solid #edeeef" }}
                />
              ))}
              {col.bookings.map((b) => {
                const color = STATUS_COLOR[b.status] ?? STATUS_COLOR.confirmed;
                const top = Math.max(0, ((b.startMin - rangeStart) / 60) * PX_PER_HOUR);
                const height = Math.max(20, (b.durationMin / 60) * PX_PER_HOUR - 2);
                return (
                  <Link
                    key={b.id}
                    to={`/app/bookings/${b.id}`}
                    title={`${b.customer} — ${b.service}${b.subtitle ? ` — ${b.subtitle}` : ""} — ${b.timeLabel} (${b.status})`}
                    style={{
                      position: "absolute",
                      top,
                      left: 4,
                      right: 4,
                      height,
                      background: color.bg,
                      borderLeft: `3px solid ${color.border}`,
                      borderRadius: 4,
                      padding: "2px 6px",
                      overflow: "hidden",
                      textDecoration: "none",
                      color: "#1f2328",
                      display: "block",
                    }}
                  >
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {b.customer}
                    </Text>
                    {height > 32 && (
                      <>
                        <br />
                        <Text as="span" variant="bodySm" tone="subdued">
                          {b.subtitle ? `${b.service} · ${b.subtitle}` : b.service}
                        </Text>
                      </>
                    )}
                    {height > 48 && (
                      <>
                        <br />
                        <Text as="span" variant="bodySm" tone="subdued">
                          {b.timeLabel}
                        </Text>
                      </>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CalendarView() {
  const data = useLoaderData<typeof loader>();
  const { settings, view, date, todayDate, resourceId, resourceOptions } = data;
  const [, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  function goTo(newDate: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("date", newDate);
      return p;
    });
  }

  function goToView(newView: "month" | "week" | "day") {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("view", newView);
      return p;
    });
  }

  function goToResource(newResourceId: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      newResourceId ? p.set("resource_id", newResourceId) : p.delete("resource_id");
      return p;
    });
  }

  const resourceSelect = (
    <div style={{ minWidth: 200 }}>
      <Select
        label={term(settings, "resource_single")}
        labelHidden
        value={resourceId ? String(resourceId) : ""}
        onChange={goToResource}
        options={[
          { label: `All ${term(settings, "resource_plural").toLowerCase()}`, value: "" },
          ...resourceOptions.map((r) => ({ label: r.name, value: String(r.id) })),
        ]}
      />
    </div>
  );

  const viewToggle = (
    <ButtonGroup variant="segmented">
      <Button pressed={view === "month"} onClick={() => goToView("month")}>
        Month
      </Button>
      <Button pressed={view === "week"} onClick={() => goToView("week")}>
        Week
      </Button>
      <Button pressed={view === "day"} onClick={() => goToView("day")}>
        Day
      </Button>
    </ButtonGroup>
  );

  if (data.view === "month") {
    const { monthLabel, prevMonthDate, nextMonthDate, cells } = data;

    return (
      <Page title="Calendar" subtitle={monthLabel} secondaryActions={[{ content: "List view", onAction: () => navigate("/app/bookings") }]}>
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Button onClick={() => goTo(prevMonthDate)}>‹ Prev</Button>
                  <Button onClick={() => goTo(todayDate)}>Today</Button>
                  <Button onClick={() => goTo(nextMonthDate)}>Next ›</Button>
                </InlineStack>
                <InlineStack gap="300" blockAlign="center">
                  {resourceSelect}
                  {viewToggle}
                </InlineStack>
              </InlineStack>
              <StatusLegend />
            </BlockStack>
          </Card>

          <Card padding="0">
            <div style={{ maxHeight: GRID_MAX_HEIGHT, overflowY: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
                {WEEKDAY_LABELS.map((label) => (
                  <div
                    key={label}
                    style={{
                      padding: "10px 8px",
                      textAlign: "center",
                      fontWeight: 600,
                      fontSize: 12,
                      color: "#6b7280",
                      borderBottom: "1px solid #e3e3e3",
                      position: "sticky",
                      top: 0,
                      background: "#fff",
                    }}
                  >
                    {label}
                  </div>
                ))}
                {cells.map((cell) => (
                  <Link
                    key={cell.date}
                    to={`/app/calendar?view=day&date=${cell.date}${resourceId ? `&resource_id=${resourceId}` : ""}`}
                    style={{
                      display: "block",
                      minHeight: 90,
                      padding: 8,
                      borderRight: "1px solid #edeeef",
                      borderBottom: "1px solid #edeeef",
                      background: cell.isToday ? "#f5f8ff" : "#fff",
                      textDecoration: "none",
                      color: "#1f2328",
                    }}
                  >
                    <Text as="span" variant="bodySm" fontWeight={cell.isToday ? "bold" : "regular"} tone={cell.inMonth ? undefined : "subdued"}>
                      {cell.dayNumber}
                    </Text>
                    {cell.total > 0 && (
                      <BlockStack gap="100">
                        <InlineStack gap="050">
                          {Object.keys(cell.counts).map((status) => (
                            <div
                              key={status}
                              title={`${cell.counts[status]} ${STATUS_LABELS[status] ?? status}`}
                              style={{ width: 7, height: 7, borderRadius: 4, background: (STATUS_COLOR[status] ?? STATUS_COLOR.confirmed).border }}
                            />
                          ))}
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {cell.total} booked
                        </Text>
                      </BlockStack>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          </Card>
        </BlockStack>
      </Page>
    );
  }

  if (data.view === "week") {
    const { weekLabel, prevWeekDate, nextWeekDate, rangeStart, rangeEnd, columns } = data;

    return (
      <Page title="Calendar" subtitle={weekLabel} secondaryActions={[{ content: "List view", onAction: () => navigate("/app/bookings") }]}>
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Button onClick={() => goTo(prevWeekDate)}>‹ Prev</Button>
                  <Button onClick={() => goTo(todayDate)}>Today</Button>
                  <Button onClick={() => goTo(nextWeekDate)}>Next ›</Button>
                </InlineStack>
                <InlineStack gap="300" blockAlign="center">
                  {resourceSelect}
                  {viewToggle}
                </InlineStack>
              </InlineStack>
              <StatusLegend />
            </BlockStack>
          </Card>

          <Card padding="0">
            <TimeGrid columns={columns} rangeStart={rangeStart} rangeEnd={rangeEnd} />
          </Card>
        </BlockStack>
      </Page>
    );
  }

  // --- Day view ---
  const { prevDate, nextDate, dateLabel, rangeStart, rangeEnd, columns } = data;

  return (
    <Page title="Calendar" subtitle={dateLabel} secondaryActions={[{ content: "List view", onAction: () => navigate("/app/bookings") }]}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Button onClick={() => goTo(prevDate)}>‹ Prev</Button>
                <Button onClick={() => goTo(todayDate)} disabled={date === todayDate}>
                  Today
                </Button>
                <Button onClick={() => goTo(nextDate)}>Next ›</Button>
              </InlineStack>
              <InlineStack gap="300" blockAlign="center">
                {resourceSelect}
                <div style={{ minWidth: 180 }}>
                  <TextField label="Date" labelHidden type="date" value={date} onChange={(value) => goTo(value)} autoComplete="off" />
                </div>
                {viewToggle}
              </InlineStack>
            </InlineStack>
            <StatusLegend />
          </BlockStack>
        </Card>

        {columns.length === 0 ? (
          <Card>
            <EmptyState
              heading={`No ${term(settings, "resource_plural").toLowerCase()} yet`}
              action={{ content: `Add ${term(settings, "resource_plural").toLowerCase()}`, url: "/app/resources" }}
              image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
            >
              <p>Add staff members to see their booked slots here.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <TimeGrid columns={columns} rangeStart={rangeStart} rangeEnd={rangeEnd} />
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
