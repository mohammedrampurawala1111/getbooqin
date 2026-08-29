import { useState } from "react";
import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.resources.$resourceId";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { Field, Input, Toggle, CheckCard } from "~/components/ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const isNew = params.resourceId === "new";
  const id = isNew ? 0 : Number(params.resourceId);

  const resource = isNew ? null : await Data.resource(shop, id);
  if (!isNew && !resource) throw data("Resource not found", { status: 404 });

  const [services, schedule, linkedServiceIds] = await Promise.all([
    Data.catalogServices(shop, platform, true),
    isNew ? Promise.resolve([]) : Data.schedule(shop, id),
    isNew ? Promise.resolve([]) : Data.serviceIdsForResource(shop, id),
  ]);

  const scheduleByDay = new Map(schedule.map((s) => [s.dayOfWeek, s]));

  return { resource, services, scheduleByDay: Object.fromEntries(scheduleByDay), linkedServiceIds, isNew };
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

  return redirect(`/dashboard/${params.connectionId}/resources/${saved.id}`);
}

function hoursBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm)) / 60;
}

function formatHours(h: number): string {
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

export default function ResourceDetail({ loaderData, params }: Route.ComponentProps) {
  const { resource, services, scheduleByDay, linkedServiceIds, isNew } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const byDay = scheduleByDay as Record<number, { startTime: string; endTime: string } | undefined>;

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
          &larr; All resources
        </a>
      </div>
      <h1 className="page-title">{isNew ? "Add resource" : resource!.name}</h1>

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
            <Field label="Timezone override" hint="e.g. America/New_York">
              <Input name="timezone" defaultValue={resource?.timezone ?? ""} placeholder="e.g. America/New_York" />
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
              return (
                <div
                  key={day}
                  className="grid items-center gap-3"
                  style={{ gridTemplateColumns: "132px 1fr 1fr 118px" }}
                >
                  <Toggle
                    name={`day_${day}_enabled`}
                    defaultChecked={dayEnabled}
                    label={label}
                    onChange={(checked) => setEnabled((prev) => prev.map((v, i) => (i === day ? checked : v)))}
                  />
                  <input
                    type="time"
                    name={`day_${day}_start`}
                    defaultValue={existing?.startTime ?? "09:00"}
                    disabled={!dayEnabled}
                    className={`input ${!dayEnabled ? "bg-canvas" : ""}`}
                  />
                  <input
                    type="time"
                    name={`day_${day}_end`}
                    defaultValue={existing?.endTime ?? "17:00"}
                    disabled={!dayEnabled}
                    className={`input ${!dayEnabled ? "bg-canvas" : ""}`}
                  />
                  <span className="num text-right text-[13px] text-muted">
                    {dayEnabled ? formatHours(hoursBetween(existing?.startTime ?? "09:00", existing?.endTime ?? "17:00")) : "Closed"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Assigned services</h2>
          </div>
          <div className="card-body grid grid-cols-2 gap-2">
            {services.length === 0 ? (
              <p className="col-span-2 m-0 text-body text-muted">No services yet.</p>
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
          <button type="submit" className="btn-pri">
            Save
          </button>
          {!isNew && (
            <button type="submit" form="delete-resource" className="btn-del">
              Delete resource
            </button>
          )}
        </div>
      </Form>

      {!isNew && (
        <Form method="post" id="delete-resource" className="hidden">
          <input type="hidden" name="_action" value="delete" />
        </Form>
      )}
    </div>
  );
}
