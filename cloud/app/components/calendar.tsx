import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useFetcher } from "react-router";
import { Badge } from "~/components/ui";
import { toHHMM } from "~/lib/calendarDate";

const HOUR_HEIGHT_PX = 60;
const PX_PER_MIN = HOUR_HEIGHT_PX / 60;

export interface CalendarBooking {
  id: number;
  status: string;
  startMin: number;
  endMin: number;
  resourceId: number;
  resourceName: string;
  serviceName: string;
  serviceColor: string;
  customerName: string;
  // False for a booking that only spills onto this day from a previous
  // midnight (occupyingBetween's real interval-overlap semantics can return
  // it) — dragging a block that isn't fully represented on this grid would
  // be confusing, so it's clipped to [0, endMin] and rendered inert.
  draggable: boolean;
}

interface CalendarWindow {
  startMin: number;
  endMin: number;
}

interface CalendarTimeOff {
  id: number;
  startMin: number;
  endMin: number;
  reason: string;
}

export interface CalendarColumn {
  resourceId: number;
  resourceName: string;
  inactive: boolean;
  openWindows: CalendarWindow[];
  timeOff: CalendarTimeOff[];
}

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

function topHeightStyle(startMin: number, endMin: number, visibleStartMin: number): { top: number; height: number } {
  return {
    top: (startMin - visibleStartMin) * PX_PER_MIN,
    height: Math.max((endMin - startMin) * PX_PER_MIN, 24),
  };
}

/** The gaps in `windows` within [visibleStart, visibleEnd) — what renders as "closed." */
function closedSegments(windows: CalendarWindow[], visibleStart: number, visibleEnd: number): CalendarWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMin - b.startMin);
  const segments: CalendarWindow[] = [];
  let cursor = visibleStart;
  for (const w of sorted) {
    const s = Math.max(w.startMin, visibleStart);
    const e = Math.min(w.endMin, visibleEnd);
    if (s > cursor) segments.push({ startMin: cursor, endMin: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < visibleEnd) segments.push({ startMin: cursor, endMin: visibleEnd });
  return segments;
}

/* ------------------------------------------------------------------ */
/* ModeToggle — Day/Week, plain navigation links (not a form radio,    */
/* since the mode lives in the URL, not a submitted value)             */
/* ------------------------------------------------------------------ */
export function ModeToggle({ mode, base, date }: { mode: "day" | "week"; base: string; date: string }) {
  const options: { key: "day" | "week"; label: string }[] = [
    { key: "day", label: "Day" },
    { key: "week", label: "Week" },
  ];
  return (
    <div className="flex w-fit gap-[2px] rounded-[9px] bg-[#efecf4] p-[2px]">
      {options.map((o) => (
        <a
          key={o.key}
          href={`${base}?mode=${o.key}&date=${date}`}
          className={`rounded-[7px] px-3 py-[5px] text-meta no-underline ${
            o.key === mode ? "bg-surface font-semibold text-ink shadow-card" : "font-medium text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </a>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DayCalendar — practitioner columns, absolute-positioned blocks,     */
/* Pointer Events drag-to-reschedule                                    */
/* ------------------------------------------------------------------ */
interface DayCalendarProps {
  date: string;
  slotInterval: number;
  visibleStartMin: number;
  visibleEndMin: number;
  columns: CalendarColumn[];
  bookings: CalendarBooking[];
  detailBase: string;
  emptyNote?: string;
}

interface DragState {
  bookingId: number;
  pointerId: number;
  grabOffsetMin: number;
  durationMin: number;
  originResourceId: number;
  originStartMin: number;
  resourceId: number;
  startMin: number;
  startX: number;
  startY: number;
  moved: boolean;
}

export function DayCalendar({ date, slotInterval, visibleStartMin, visibleEndMin, columns, bookings, detailBase, emptyNote }: DayCalendarProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<number, HTMLDivElement>());
  const justDraggedRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (!fetcher.data.ok) setToastMsg(fetcher.data.error || "Couldn't reschedule.");
    setPendingId(null);
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 5000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const bodyHeight = (visibleEndMin - visibleStartMin) * PX_PER_MIN;
  const hourMarks = useMemo(() => {
    const marks: number[] = [];
    const first = Math.ceil(visibleStartMin / 60) * 60;
    for (let m = first; m <= visibleEndMin; m += 60) marks.push(m);
    return marks;
  }, [visibleStartMin, visibleEndMin]);

  function bookingsFor(resourceId: number) {
    return bookings.filter((b) => b.resourceId === resourceId);
  }

  // Deterministic, client-knowable conflicts only (closed hours, time off,
  // another booking) — the real backstop against a concurrent change
  // elsewhere is the server rejecting the submit itself.
  function wouldConflict(resourceId: number, startMin: number, endMin: number, excludeId: number): boolean {
    const col = columns.find((c) => c.resourceId === resourceId);
    if (!col) return true;
    const inOpenWindow = col.openWindows.some((w) => startMin >= w.startMin && endMin <= w.endMin);
    if (!inOpenWindow) return true;
    if (col.timeOff.some((t) => startMin < t.endMin && endMin > t.startMin)) return true;
    return bookings.some((b) => b.id !== excludeId && b.resourceId === resourceId && startMin < b.endMin && endMin > b.startMin);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLAnchorElement>, booking: CalendarBooking) {
    if (!booking.draggable || e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      bookingId: booking.id,
      pointerId: e.pointerId,
      grabOffsetMin: (e.clientY - rect.top) / PX_PER_MIN,
      durationMin: booking.endMin - booking.startMin,
      originResourceId: booking.resourceId,
      originStartMin: booking.startMin,
      resourceId: booking.resourceId,
      startMin: booking.startMin,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    });
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLAnchorElement>) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5;

    let targetResourceId = drag.resourceId;
    for (const [resourceId, el] of columnRefs.current) {
      const rect = el.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX < rect.right) {
        targetResourceId = resourceId;
        break;
      }
    }
    let startMin = drag.startMin;
    const targetEl = columnRefs.current.get(targetResourceId);
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const rawMin = visibleStartMin + (e.clientY - rect.top) / PX_PER_MIN - drag.grabOffsetMin;
      const snapped = Math.round(rawMin / slotInterval) * slotInterval;
      startMin = Math.max(visibleStartMin, Math.min(snapped, visibleEndMin - drag.durationMin));
    }
    setDrag({ ...drag, moved, resourceId: targetResourceId, startMin });
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLAnchorElement>) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const { bookingId, moved, resourceId, startMin, durationMin, originResourceId, originStartMin } = drag;
    setDrag(null);
    if (!moved) return; // a click, not a drag — the anchor's own href handles it

    justDraggedRef.current = true;
    if (resourceId === originResourceId && startMin === originStartMin) return; // dropped back where it started

    if (wouldConflict(resourceId, startMin, startMin + durationMin, bookingId)) {
      setToastMsg("That time isn't available.");
      return;
    }

    setPendingId(bookingId);
    const fd = new FormData();
    fd.set("_action", "reschedule_drag");
    fd.set("booking_id", String(bookingId));
    fd.set("date", date);
    fd.set("time", toHHMM(startMin));
    fd.set("resource_id", String(resourceId));
    fetcher.submit(fd, { method: "post" });
  }

  const dragTargetColumn = drag ? columns.find((c) => c.resourceId === drag.resourceId) : undefined;

  return (
    <div className="card overflow-hidden p-0">
      <div className="overflow-x-auto">
        <div className="min-w-fit">
          <div
            className="grid border-b border-line"
            style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))` }}
          >
            <div />
            {columns.map((c) => (
              <div key={c.resourceId} className="truncate border-l border-line px-3 py-[10px] text-[13px] font-semibold">
                {c.resourceName}
                {c.inactive ? <span className="ml-1 text-[11px] font-normal text-faint">(inactive)</span> : null}
              </div>
            ))}
          </div>

          {columns.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-muted">{emptyNote || "Nothing to show."}</div>
          ) : (
            <div ref={gridRef} className="relative grid" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))`, height: bodyHeight }}>
              <div className="relative border-r border-line">
                {hourMarks.map((m) => (
                  <div key={m} className="absolute right-2 -translate-y-1/2 text-[11px] text-faint" style={{ top: (m - visibleStartMin) * PX_PER_MIN }}>
                    {minutesLabel(m)}
                  </div>
                ))}
              </div>

              {columns.map((col) => (
                <div
                  key={col.resourceId}
                  ref={(el) => {
                    if (el) columnRefs.current.set(col.resourceId, el);
                    else columnRefs.current.delete(col.resourceId);
                  }}
                  className="relative border-l border-line"
                >
                  {hourMarks.map((m) => (
                    <div key={m} className="absolute inset-x-0 border-t border-row" style={{ top: (m - visibleStartMin) * PX_PER_MIN }} />
                  ))}

                  {closedSegments(col.openWindows, visibleStartMin, visibleEndMin).map((seg, i) => (
                    <div key={`closed-${i}`} className="absolute inset-x-0 bg-row" style={topHeightStyle(seg.startMin, seg.endMin, visibleStartMin)} />
                  ))}

                  {col.timeOff.map((t) => {
                    const s = Math.max(t.startMin, visibleStartMin);
                    const en = Math.min(t.endMin, visibleEndMin);
                    if (en <= s) return null;
                    return (
                      <div
                        key={`to-${t.id}`}
                        title={t.reason || "Time off"}
                        className="absolute inset-x-0"
                        style={{
                          ...topHeightStyle(s, en, visibleStartMin),
                          background:
                            "repeating-linear-gradient(45deg, var(--color-warn-bg), var(--color-warn-bg) 6px, color-mix(in srgb, var(--color-warn) 22%, var(--color-warn-bg)) 6px, color-mix(in srgb, var(--color-warn) 22%, var(--color-warn-bg)) 12px)",
                        }}
                      />
                    );
                  })}

                  {bookingsFor(col.resourceId).map((b) => {
                    const isDragging = drag?.bookingId === b.id;
                    return (
                      <a
                        key={b.id}
                        href={`${detailBase}/${b.id}`}
                        onClick={(e) => {
                          if (justDraggedRef.current) {
                            e.preventDefault();
                            justDraggedRef.current = false;
                          }
                        }}
                        onPointerDown={(e) => handlePointerDown(e, b)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        className={`absolute inset-x-[3px] block overflow-hidden rounded-[6px] border border-line px-[6px] py-[3px] text-[11px] leading-tight text-ink no-underline shadow-card ${
                          b.draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                        } ${isDragging ? "opacity-30" : ""} ${pendingId === b.id ? "pointer-events-none opacity-50" : ""}`}
                        style={{
                          ...topHeightStyle(b.startMin, b.endMin, visibleStartMin),
                          borderLeft: `3px solid ${b.serviceColor}`,
                          background: `color-mix(in srgb, ${b.serviceColor} 12%, var(--color-surface))`,
                        }}
                      >
                        <div className="truncate font-medium">{b.customerName}</div>
                        <div className="truncate text-faint">{b.serviceName}</div>
                      </a>
                    );
                  })}
                </div>
              ))}

              {drag &&
                (() => {
                  const el = columnRefs.current.get(drag.resourceId);
                  const gridEl = gridRef.current;
                  if (!el || !gridEl) return null;
                  const rect = el.getBoundingClientRect();
                  const gridRect = gridEl.getBoundingClientRect();
                  return (
                    <div
                      className="pointer-events-none absolute z-10 overflow-hidden rounded-[6px] border-2 border-dashed border-line-strong bg-surface px-[6px] py-[3px] text-[11px] shadow-modal"
                      style={{
                        left: rect.left - gridRect.left,
                        width: rect.width,
                        ...topHeightStyle(drag.startMin, drag.startMin + drag.durationMin, visibleStartMin),
                      }}
                    >
                      <div className="truncate font-medium">
                        {toHHMM(drag.startMin)} · {dragTargetColumn?.resourceName}
                      </div>
                    </div>
                  );
                })()}
            </div>
          )}
        </div>
      </div>
      {toastMsg && <div className="border-t border-line bg-warn-bg px-4 py-2 text-[13px] text-warn">{toastMsg}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* WeekCalendar — day columns, plain agenda rows, no drag              */
/* ------------------------------------------------------------------ */
export interface WeekBooking {
  id: number;
  date: string;
  startMin: number;
  status: string;
  resourceName: string;
  serviceName: string;
  serviceColor: string;
  customerName: string;
}

interface WeekCalendarProps {
  weekStart: string;
  todayIso: string;
  bookings: WeekBooking[];
  detailBase: string;
  calendarBase: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekCalendar({ weekStart, todayIso, bookings, detailBase, calendarBase }: WeekCalendarProps) {
  const days = useMemo(() => {
    const list: { iso: string; label: string }[] = [];
    const start = new Date(`${weekStart}T00:00:00Z`);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      list.push({ iso: d.toISOString().slice(0, 10), label: WEEKDAY_LABELS[i] });
    }
    return list;
  }, [weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, WeekBooking[]>();
    for (const b of bookings) {
      const list = map.get(b.date) ?? [];
      list.push(b);
      map.set(b.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.startMin - b.startMin);
    return map;
  }, [bookings]);

  return (
    <div className="card flex flex-col gap-0 overflow-hidden p-0 sm:flex-row">
      {days.map((day) => {
        const rows = byDay.get(day.iso) ?? [];
        const isToday = day.iso === todayIso;
        return (
          <div key={day.iso} className="flex min-w-0 flex-1 flex-col border-b border-line sm:border-b-0 sm:border-l">
            <a
              href={`${calendarBase}?mode=day&date=${day.iso}`}
              className={`flex items-baseline justify-between border-b border-line px-3 py-2 no-underline ${isToday ? "bg-canvas-alt" : ""}`}
            >
              <span className="text-[13px] font-semibold text-ink">{day.label}</span>
              <span className="num text-[12px] text-muted">{day.iso.slice(5)}</span>
            </a>
            <div className="flex flex-1 flex-col gap-[6px] p-2">
              {rows.length === 0 ? (
                <span className="px-1 py-2 text-[12px] text-faint">No bookings</span>
              ) : (
                rows.map((b) => (
                  <a
                    key={b.id}
                    href={`${detailBase}/${b.id}`}
                    className="flex flex-col gap-[2px] rounded-[6px] border border-line px-2 py-[6px] text-[12px] no-underline text-ink shadow-card"
                    style={{ borderLeft: `3px solid ${b.serviceColor}`, background: `color-mix(in srgb, ${b.serviceColor} 10%, var(--color-surface))` }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="num font-medium">{toHHMM(b.startMin)}</span>
                      <Badge status={b.status as any} />
                    </div>
                    <span className="truncate">{b.customerName}</span>
                    <span className="truncate text-faint">
                      {b.serviceName} · {b.resourceName}
                    </span>
                  </a>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
