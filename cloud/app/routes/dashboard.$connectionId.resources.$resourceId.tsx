import { useState } from "react";
import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.resources.$resourceId";
import { Data, Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { Field, Input, Toggle, CheckCard, TimezoneSelect, ConfirmDialog } from "~/components/ui";
import { getPreset, useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ params, matches }) => [
  {
    title: `${params.resourceId === "new" ? "Add" : "Edit"} ${vocabFor(dashboardPreset(matches)).resourceOne} · GetBooqin`,
  },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const isNew = params.resourceId === "new";
  const id = isNew ? 0 : Number(params.resourceId);

  const resource = isNew ? null : await Data.resource(shop, id);
  if (!isNew && !resource) throw data("Resource not found", { status: 404 });

  const [services, schedule, linkedServiceIds, settings] = await Promise.all([
    Data.catalogServices(shop, platform, true),
    isNew ? Promise.resolve([]) : Data.schedule(shop, id),
    isNew ? Promise.resolve([]) : Data.serviceIdsForResource(shop, id),
    Settings.getSettings(shop, platform),
  ]);

  const scheduleByDay: Record<number, { startTime: string; endTime: string }> = {};
  for (const s of schedule) scheduleByDay[s.dayOfWeek] = { startTime: s.startTime, endTime: s.endTime };

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
      if (preset.open[presetDay]) scheduleByDay[day] = { startTime: start, endTime: end };
    }
  }

  return { resource, services, scheduleByDay, linkedServiceIds, isNew, timezone: settings.timezone };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const isNew = params.resourceId === "new";
  const id = isNew ? 0 : Number(params.resourceId);
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteResource(shop, id);
    return redirect(`/dashboard/${params.connectionId}/resources`);
  }

  const scheduleRows = [0, 1, 2, 3, 4, 5, 6]
    .filter((day) => form.get(`day_${day}_enabled`))
    .map((day) => ({ day, start: String(form.get(`day_${day}_start`) ?? ""), end: String(form.get(`day_${day}_end`) ?? "") }));

  const serviceIds = form.getAll("service_ids").map(Number);

  const saved = await Data.saveResource(
    shop,
    platform,
    {
      name: String(form.get("name") ?? ""),
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

export default function ResourceDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { resource, services, scheduleByDay, linkedServiceIds, isNew, timezone } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const byDay = scheduleByDay as Record<number, { startTime: string; endTime: string } | undefined>;
  const v = useVocabulary();

  const [enabled, setEnabled] = useState<boolean[]>(DAYS.map((_, day) => !!byDay[day]));
  const totalHours = DAYS.reduce((sum, _, day) => {
    if (!enabled[day]) return sum;
    const existing = byDay[day];
    return sum + hoursBetween(existing?.startTime ?? "09:00", existing?.endTime ?? "17:00");
  }, 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/resources`} className="btn-link">
          &larr; All {v.resources}
        </a>
      </div>
      <h1 className="page-title">{isNew ? `Add ${v.resourceOne}` : resource!.name}</h1>

      <Form method="post" className="flex flex-col gap-[14px]">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Details</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <Field label="Name">
              <Input name="name" required defaultValue={resource?.name ?? ""} />
            </Field>
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
          <div className="card-body flex flex-col gap-2">
            {DAYS.map((label, day) => {
              const existing = byDay[day];
              const dayEnabled = enabled[day];
              const summary = dayEnabled ? formatHours(hoursBetween(existing?.startTime ?? "09:00", existing?.endTime ?? "17:00")) : "Closed";
              return (
                // A fixed "132px 1fr 1fr 118px" grid used to run the toggle
                // and the 118px summary off the edge of the card below
                // ~520px, with no scrollbar to reach them (UX audit's #11
                // finding, still present at 298px in the follow-up pass).
                // flex-wrap instead of grid: the toggle+summary pair wraps
                // onto its own full-width row once the two 1fr time inputs
                // no longer fit beside it, rather than every column
                // shrinking past usability. The summary itself renders
                // twice — once inline next to the toggle for the wrapped
                // (mobile) row, once at the fixed 118px trailing position
                // for the unwrapped (desktop) row — with `hidden`/`sm:hidden`
                // making only one present in the accessibility tree at a
                // time, so nothing is announced twice.
                <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex w-full items-center justify-between gap-3 sm:w-[132px] sm:shrink-0 sm:justify-start">
                    <Toggle
                      name={`day_${day}_enabled`}
                      defaultChecked={dayEnabled}
                      label={label}
                      onChange={(checked) => setEnabled((prev) => prev.map((v, i) => (i === day ? checked : v)))}
                    />
                    <span className="num text-[13px] text-muted sm:hidden">{summary}</span>
                  </div>
                  {/* min-w-0: flex items default to min-width:auto, which
                      for a native <input type="time"> is wider than these
                      flex-1 tracks actually have room for below ~520px — the
                      track can't shrink to fit without this, so the input
                      overflowed the card's edge instead (UX audit's #11
                      finding). Same class of fix as Row/RowInput in
                      settings.tsx for the identical reason.
                      aria-label: this row isn't a Row/Field, so neither
                      gets an implicit label from anywhere — Toggle's own
                      `label` covers the day name, but the two time inputs
                      had nothing at all (pass 7's N1 finding: 7 days × 2
                      inputs = 14, exactly the count axe flagged here). */}
                  <input
                    type="time"
                    name={`day_${day}_start`}
                    aria-label={`${label} start time`}
                    defaultValue={existing?.startTime ?? "09:00"}
                    disabled={!dayEnabled}
                    className={`input min-w-0 flex-1 sm:flex-1 ${!dayEnabled ? "bg-canvas" : ""}`}
                  />
                  <input
                    type="time"
                    name={`day_${day}_end`}
                    aria-label={`${label} end time`}
                    defaultValue={existing?.endTime ?? "17:00"}
                    disabled={!dayEnabled}
                    className={`input min-w-0 flex-1 sm:flex-1 ${!dayEnabled ? "bg-canvas" : ""}`}
                  />
                  <span className="num hidden text-right text-[13px] text-muted sm:block sm:w-[118px] sm:shrink-0">
                    {summary}
                  </span>
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
              Delete {v.resourceOne}
            </button>
          )}
        </div>
      </Form>

      {!isNew && (
        <ConfirmDialog
          id="delete-resource"
          title={`Delete this ${v.resourceOne}?`}
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
