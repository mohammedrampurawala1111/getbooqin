import { useState } from "react";
import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.resources.$resourceId";
import { Data, Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { Field, Input, Toggle, CheckCard, TimezoneSelect, ConfirmDialog } from "~/components/ui";
import { getPreset, useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ params, matches, data: loaderData }) => [
  {
    title: `${params.resourceId === "new" ? "Add" : "Edit"} ${
      loaderData?.kind === "room" ? "room" : vocabFor(dashboardPreset(matches)).resourceOne
    } · GetBooqin`,
  },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const isNew = params.resourceId === "new";
  const id = isNew ? 0 : Number(params.resourceId);

  const resource = isNew ? null : await Data.resource(shop, id);
  if (!isNew && !resource) throw data("Resource not found", { status: 404 });

  // The Resources list's "+ Add room" button links here with ?kind=room —
  // the one place a brand-new resource's kind is actually chosen (GetBooqin
  // clinic audit's RS-01 finding: "Practitioners & rooms" promised a
  // resource type that didn't exist at all). Kind is fixed once created,
  // same as most identity-defining fields elsewhere in this app — changing
  // an existing practitioner into a room mid-life would leave its own
  // booking history and assignments in a confusing state.
  const url = new URL(request.url);
  const initialKind = url.searchParams.get("kind") === "room" ? "room" : "practitioner";
  const kind = isNew ? initialKind : (resource!.kind as "practitioner" | "room");

  const [services, schedule, linkedServiceIds, settings] = await Promise.all([
    Data.catalogServices(shop, platform, true),
    isNew ? Promise.resolve([]) : Data.schedule(shop, id),
    // A brand-new resource's "Assigned services" started every box unticked
    // — since resourcesForService() no longer falls back to "everyone" for
    // an unconfigured service, saving that as-is silently created a
    // resource nobody could ever book (Defect Dossier's R2-04 finding,
    // item 3). Defaults to every currently-active service instead, same as
    // onboarding's own first-resource step already does; the merchant can
    // still untick anything before saving.
    isNew ? Data.catalogServices(shop, platform, true).then((list) => list.map((s) => s.id)) : Data.serviceIdsForResource(shop, id),
    Settings.getSettings(shop, platform),
  ]);

  // Multiple blocks per weekday — Schedule already allowed more than one
  // row per (resourceId, dayOfWeek) and availability.ts's slot generator
  // already walks every one of them, but this editor only ever wrote and
  // read a single {start,end} pair per day, so the split morning/evening
  // session that's the normal shape of an Indian dental practice (roughly
  // 10:00–14:00 and 17:00–21:00) had no way to be entered short of a
  // recurring Time off block recreated by hand every week (GetBooqin clinic
  // audit's RS-02 finding). No backend change needed — this was purely an
  // editor limitation.
  const scheduleByDay: Record<number, { startTime: string; endTime: string }[]> = {};
  for (const s of schedule) {
    (scheduleByDay[s.dayOfWeek] ??= []).push({ startTime: s.startTime, endTime: s.endTime });
  }
  for (const day of Object.keys(scheduleByDay).map(Number)) {
    scheduleByDay[day].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  // A resource created with every day off and 0 bookable hours can't take
  // any bookings, yet the Overview checklist counted "Add resources" done
  // the moment one merely existed — onboarding's own step 2 already
  // *previewed* the business's hours from its industry preset and then
  // never carried them into the resource it creates (UX audit's #2
  // finding). Seed a brand-new resource's schedule from that same preset
  // instead of leaving every day unchecked; the merchant can still turn
  // any day off before saving, same as always.
  if (isNew) {
    const preset = getPreset(settings.preset);
    const [start, end] = preset.range.split("–");
    for (let day = 0; day < 7; day++) {
      // DAYS below is Sunday-first (index 0); preset.open is Monday-first.
      const presetDay = day === 0 ? 6 : day - 1;
      if (preset.open[presetDay]) scheduleByDay[day] = [{ startTime: start, endTime: end }];
    }
  }

  return { resource, services, scheduleByDay, linkedServiceIds, isNew, kind, timezone: settings.timezone };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId, "write");
  const isNew = params.resourceId === "new";
  const id = isNew ? 0 : Number(params.resourceId);
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteResource(shop, id);
    return redirect(`/dashboard/${params.connectionId}/resources`);
  }

  // Same field name repeated once per block within a day (day_2_start,
  // day_2_start, ...) — FormData.getAll() keeps them in DOM order, so
  // zipping starts/ends together reconstructs each day's block list
  // without needing a separate "how many blocks" field. A block with
  // either side blank (can only happen if a day is enabled with zero
  // blocks left after removing all of them) is dropped rather than saved
  // as a bad row.
  const scheduleRows = [0, 1, 2, 3, 4, 5, 6]
    .filter((day) => form.get(`day_${day}_enabled`))
    .flatMap((day) => {
      const starts = form.getAll(`day_${day}_start`).map(String);
      const ends = form.getAll(`day_${day}_end`).map(String);
      return starts
        .map((start, i) => ({ day, start, end: ends[i] ?? "" }))
        .filter((row) => row.start && row.end);
    });

  const serviceIds = form.getAll("service_ids").map(Number);

  const saved = await Data.saveResource(
    shop,
    platform,
    {
      name: String(form.get("name") ?? ""),
      // Sent as a hidden field (fixed) when editing, and a real selectable
      // control only when creating — see the component (GetBooqin clinic
      // audit's RS-01 finding).
      kind: form.get("kind") === "room" ? "room" : "practitioner",
      title: String(form.get("title") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
      description: String(form.get("description") ?? ""),
      meeting_link: String(form.get("meeting_link") ?? ""),
      timezone: String(form.get("timezone") ?? ""),
      status: form.get("status") === "on",
      schedule: scheduleRows,
      service_ids: serviceIds,
    },
    id
  );

  // A new resource still needs the redirect — its URL is /resources/new
  // until it has a real id. Editing an existing one redirected to the
  // exact URL it was already on, so a save looked like nothing had
  // happened at all (UX audit's #14 finding); returning saved:true instead
  // renders the same "Saved." feedback the rest of the app already uses
  // (SettingsCard's savedAt, PasswordCard) without a pointless navigation.
  if (isNew) {
    return redirect(`/dashboard/${params.connectionId}/resources/${saved.id}`);
  }
  return { saved: true };
}

function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm)) / 60;
}

function formatHours(h: number): string {
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

type DayBlock = { start: string; end: string };

export default function ResourceDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { resource, services, scheduleByDay, linkedServiceIds, isNew, kind: initialKind, timezone } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const byDay = scheduleByDay as Record<number, { startTime: string; endTime: string }[] | undefined>;
  const v = useVocabulary();

  // Only ever selectable while creating — see the loader's own comment on
  // why an existing resource's kind is fixed (GetBooqin clinic audit's
  // RS-01 finding: "Practitioners & rooms" promised a resource type that
  // didn't exist at all; a room is a Resource row like any other, just one
  // with no email/phone/video-link fields to fill in).
  const [kind, setKind] = useState<"practitioner" | "room">(initialKind);
  const isRoom = kind === "room";
  const kindLabel = isRoom ? "room" : v.resourceOne;

  const [enabled, setEnabled] = useState<boolean[]>(DAYS.map((_, day) => !!byDay[day]?.length));
  // One block list per day, independent of `enabled` — turning a day off
  // and back on again shouldn't lose the blocks it had (same reasoning as
  // the time inputs' own values surviving a disabled round-trip). Split
  // morning/evening sessions (roughly 10:00–14:00 and 17:00–21:00), the
  // normal shape of an Indian dental practice, previously had no way to be
  // entered at all — this editor only ever offered one start/end pair per
  // day, and the only workaround was a recurring Time off block recreated
  // by hand (GetBooqin clinic audit's RS-02 finding).
  const [blocks, setBlocks] = useState<DayBlock[][]>(
    DAYS.map((_, day) => {
      const existing = byDay[day];
      return existing?.length ? existing.map((b) => ({ start: b.startTime, end: b.endTime })) : [{ start: "09:00", end: "17:00" }];
    })
  );

  function updateBlock(day: number, index: number, field: "start" | "end", value: string) {
    setBlocks((prev) => prev.map((dayBlocks, d) => (d !== day ? dayBlocks : dayBlocks.map((b, i) => (i === index ? { ...b, [field]: value } : b)))));
  }
  function addBlock(day: number) {
    setBlocks((prev) => prev.map((dayBlocks, d) => (d !== day ? dayBlocks : [...dayBlocks, { start: "17:00", end: "21:00" }])));
  }
  function removeBlock(day: number, index: number) {
    setBlocks((prev) => prev.map((dayBlocks, d) => (d !== day ? dayBlocks : dayBlocks.length > 1 ? dayBlocks.filter((_, i) => i !== index) : dayBlocks)));
  }

  const totalHours = DAYS.reduce((sum, _, day) => {
    if (!enabled[day]) return sum;
    return sum + blocks[day].reduce((daySum, b) => daySum + hoursBetween(b.start, b.end), 0);
  }, 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/resources`} className="btn-link">
          &larr; All {v.resources}
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-[10px]">
        <h1 className="page-title">{isNew ? `Add a ${kindLabel}` : resource!.name}</h1>
        {!isNew && <span className="badge-neutral">{isRoom ? "Room" : v.resourceOneTitle}</span>}
      </div>

      <Form method="post" className="flex flex-col gap-[14px]">
        {isNew ? (
          <input type="hidden" name="kind" value={kind} />
        ) : (
          <input type="hidden" name="kind" value={initialKind} />
        )}
        {isNew && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Type</h2>
            </div>
            {/* The one moment kind is actually chosen — see the loader's own
                comment on why it's fixed after that. A room is a resource
                with its own bookable hours and its own occupancy, just none
                of a practitioner's contact fields (GetBooqin clinic audit's
                RS-01 finding). */}
            <div className="card-body flex gap-2">
              <label className={`tile flex-1 cursor-pointer justify-center text-center ${!isRoom ? "tile-on" : ""}`}>
                <input type="radio" className="sr-only" checked={!isRoom} onChange={() => setKind("practitioner")} />
                {v.resourceOneTitle}
              </label>
              <label className={`tile flex-1 cursor-pointer justify-center text-center ${isRoom ? "tile-on" : ""}`}>
                <input type="radio" className="sr-only" checked={isRoom} onChange={() => setKind("room")} />
                Room
              </label>
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Details</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <Field label="Name" hint={isRoom ? "e.g. Operatory 1, Treatment Room A" : undefined}>
              <Input name="name" required defaultValue={resource?.name ?? ""} />
            </Field>
            {/* A room has no title, email, phone or video-meeting link of
                its own — those describe a person, not a chair (GetBooqin
                clinic audit's RS-01 finding). */}
            {!isRoom && (
              <>
                <Field label="Title">
                  <Input name="title" defaultValue={resource?.title ?? ""} />
                </Field>
                <Field label="Email">
                  <Input name="email" type="email" defaultValue={resource?.email ?? ""} />
                </Field>
                <Field label="Phone">
                  <Input name="phone" defaultValue={resource?.phone ?? ""} />
                </Field>
                <Field label="Video meeting link">
                  <Input name="meeting_link" defaultValue={resource?.meetingLink ?? ""} />
                </Field>
              </>
            )}
            {/* Free-text timezone with the placeholder repeated as its own
                hint underneath — both patterns already fixed elsewhere
                (Settings' own timezone field, and the Shopify-domain
                field's duplicated hint) and both back here (UX audit's
                #10 finding). Defaults to the business's own timezone
                rather than empty, so this resource always has one
                concrete, valid zone selected — not a landmine unset value
                a booking calculation could silently misread later. */}
            <Field label="Timezone" hint="Business default, unless changed here">
              <TimezoneSelect name="timezone" defaultValue={resource?.timezone || timezone} />
            </Field>
            <div className="col-span-2">
              <Field label="Description">
                <textarea name="description" defaultValue={resource?.description ?? ""} className="input" rows={3} />
              </Field>
            </div>
            <Toggle name="status" defaultChecked={resource?.status ?? true} label="Active" />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Weekly hours</h2>
            <span className="num text-meta text-muted">{formatHours(totalHours)} / week</span>
          </div>
          <div className="card-body flex flex-col gap-3">
            {DAYS.map((label, day) => {
              const dayEnabled = enabled[day];
              const dayBlocks = blocks[day];
              const summary = dayEnabled ? formatHours(dayBlocks.reduce((s, b) => s + hoursBetween(b.start, b.end), 0)) : "Closed";
              return (
                // A fixed "132px 1fr 1fr 118px" grid used to run the toggle
                // and the 118px summary off the edge of the card below
                // ~520px, with no scrollbar to reach them (UX audit's #11
                // finding, still present at 298px in the follow-up pass).
                // flex-wrap instead of grid: the toggle+summary pair wraps
                // onto its own full-width row once the two 1fr time inputs
                // no longer fit beside it, rather than every column
                // shrinking past usability.
                <div key={day} className="flex flex-col gap-[6px]">
                  <div className="flex w-full items-center justify-between gap-3">
                    <Toggle
                      name={`day_${day}_enabled`}
                      defaultChecked={dayEnabled}
                      label={label}
                      onChange={(checked) => setEnabled((prev) => prev.map((v, i) => (i === day ? checked : v)))}
                    />
                    <span className="num text-[13px] text-muted">{summary}</span>
                  </div>
                  {dayEnabled && (
                    <div className="flex flex-col gap-[6px] pl-[2px]">
                      {dayBlocks.map((b, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          {/* min-w-0: flex items default to min-width:auto,
                              which for a native <input type="time"> is
                              wider than these flex-1 tracks actually have
                              room for below ~520px (UX audit's #11
                              finding). aria-label: neither input has a
                              visible label of its own (pass 7's N1
                              finding). lang="en-GB" forces 24-hour display
                              regardless of browser locale (UX audit's C6
                              finding) — display only, the submitted value
                              is always "HH:mm". */}
                          <input
                            type="time"
                            name={`day_${day}_start`}
                            lang="en-GB"
                            aria-label={`${label} block ${i + 1} start time`}
                            value={b.start}
                            onChange={(e) => updateBlock(day, i, "start", e.target.value)}
                            className="input min-w-0 flex-1"
                          />
                          <input
                            type="time"
                            name={`day_${day}_end`}
                            lang="en-GB"
                            aria-label={`${label} block ${i + 1} end time`}
                            value={b.end}
                            onChange={(e) => updateBlock(day, i, "end", e.target.value)}
                            className="input min-w-0 flex-1"
                          />
                          {dayBlocks.length > 1 && (
                            <button
                              type="button"
                              className="btn-link shrink-0 text-danger"
                              aria-label={`Remove ${label} block ${i + 1}`}
                              onClick={() => removeBlock(day, i)}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                      {/* The split morning/evening session a lot of
                          businesses actually run on — a lunch break, a
                          midday closure, a second evening sitting — is
                          exactly what a single start/end pair per day
                          couldn't express (GetBooqin clinic audit's RS-02
                          finding). */}
                      <button type="button" className="btn-link w-fit" onClick={() => addBlock(day)}>
                        + Add another time
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Assigned {v.services.toLowerCase()}</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-2">
            {services.length === 0 ? (
              <p className="col-span-2 m-0 text-body text-muted">No {v.services.toLowerCase()} yet.</p>
            ) : (
              services.map((s) => (
                <CheckCard
                  key={s.id}
                  name="service_ids"
                  value={String(s.id)}
                  label={s.name}
                  defaultChecked={linkedServiceIds.includes(s.id)}
                />
              ))
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-pri">
              Save
            </button>
            {actionData?.saved && <span className="alert-success">Saved.</span>}
          </div>
          {!isNew && (
            <button
              type="button"
              className="btn-del"
              onClick={() => (document.getElementById("delete-resource") as HTMLDialogElement | null)?.showModal()}
            >
              Delete {kindLabel}
            </button>
          )}
        </div>
      </Form>

      {!isNew && (
        <ConfirmDialog
          id="delete-resource"
          title={`Delete this ${kindLabel}?`}
          body="This can't be undone."
          confirmLabel="Delete"
        >
          <Form method="post" id="delete-resource-form">
            <input type="hidden" name="_action" value="delete" />
          </Form>
        </ConfirmDialog>
      )}
    </div>
  );
}
