import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useSubmit, Form } from "react-router";
import { Page, Card, BlockStack, FormLayout, TextField, Checkbox, Button, InlineStack, Text, ChoiceList } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const isNew = params.id === "new";
  const resource = isNew ? null : await Data.resource(shop, Number(params.id));
  const services = await Data.catalogServices(shop, "shopify", true);
  const scheduleRows = isNew || !resource ? [] : await Data.schedule(shop, resource.id);
  const assignedServiceIds = isNew || !resource ? [] : await Data.serviceIdsForResource(shop, resource.id);

  return { settings, resource, services, scheduleRows, assignedServiceIds, isNew };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteResource(shop, Number(params.id));
    return redirect("/app/resources");
  }

  const id = params.id === "new" ? 0 : Number(params.id);
  const serviceIds = form.getAll("service_ids").map(Number);

  const schedule: Array<{ day: number; start: string; end: string }> = [];
  for (let day = 0; day < 7; day++) {
    const enabled = form.get(`day_${day}_enabled`) === "true";
    const start = String(form.get(`day_${day}_start`) || "");
    const end = String(form.get(`day_${day}_end`) || "");
    if (enabled && start && end) schedule.push({ day, start, end });
  }

  await Data.saveResource(
    shop,
    "shopify",
    {
      name: String(form.get("name") || ""),
      title: String(form.get("title") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      description: String(form.get("description") || ""),
      meeting_link: String(form.get("meeting_link") || ""),
      timezone: String(form.get("timezone") || ""),
      status: form.get("status") === "true",
      schedule,
      service_ids: serviceIds,
    },
    id
  );

  return redirect("/app/resources");
}

export default function ResourceForm() {
  const { settings, resource, services, scheduleRows, assignedServiceIds, isNew } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [name, setName] = useState(resource?.name ?? "");
  const [title, setTitle] = useState(resource?.title ?? "");
  const [email, setEmail] = useState(resource?.email ?? "");
  const [phone, setPhone] = useState(resource?.phone ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [meetingLink, setMeetingLink] = useState(resource?.meetingLink ?? "");
  const [timezone, setTimezone] = useState(resource?.timezone ?? "");
  const [status, setStatus] = useState(resource?.status ?? true);
  const [selectedServices, setSelectedServices] = useState<string[]>(assignedServiceIds.map(String));

  const initialSchedule = DAY_NAMES.map((_, day) => {
    const existing = scheduleRows.find((r) => r.dayOfWeek === day);
    return {
      enabled: !!existing,
      start: existing?.startTime ?? "09:00",
      end: existing?.endTime ?? "17:00",
    };
  });
  const [schedule, setSchedule] = useState(initialSchedule);

  function updateDay(day: number, patch: Partial<(typeof schedule)[number]>) {
    setSchedule((prev) => prev.map((row, i) => (i === day ? { ...row, ...patch } : row)));
  }

  function handleSubmit() {
    const form = new FormData();
    form.set("name", name);
    form.set("title", title);
    form.set("email", email);
    form.set("phone", phone);
    form.set("description", description);
    form.set("meeting_link", meetingLink);
    form.set("timezone", timezone);
    form.set("status", String(status));
    selectedServices.forEach((id) => form.append("service_ids", id));
    schedule.forEach((row, day) => {
      form.set(`day_${day}_enabled`, String(row.enabled));
      form.set(`day_${day}_start`, row.start);
      form.set(`day_${day}_end`, row.end);
    });
    submit(form, { method: "post" });
  }

  return (
    <Page
      title={isNew ? `Add ${term(settings, "resource_single").toLowerCase()}` : name}
      backAction={{ content: "Staff", onAction: () => navigate("/app/resources") }}
      primaryAction={{ content: "Save", onAction: handleSubmit }}
      secondaryActions={
        isNew
          ? []
          : [
              {
                content: "Delete",
                destructive: true,
                onAction: () => {
                  const form = new FormData();
                  form.set("_action", "delete");
                  submit(form, { method: "post" });
                },
              },
            ]
      }
    >
      <Form method="post">
        <BlockStack gap="400">
          <Card>
            <FormLayout>
              <TextField label="Name" value={name} onChange={setName} autoComplete="off" requiredIndicator />
              <TextField label="Title" value={title} onChange={setTitle} autoComplete="off" />
              <FormLayout.Group>
                <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
                <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
              </FormLayout.Group>
              <TextField label="Description" value={description} onChange={setDescription} multiline={3} autoComplete="off" />
              <TextField
                label="Personal meeting link"
                value={meetingLink}
                onChange={setMeetingLink}
                autoComplete="off"
                helpText='Used by the "Fixed room link" video provider.'
              />
              <TextField
                label="Timezone override"
                value={timezone}
                onChange={setTimezone}
                autoComplete="off"
                helpText={`IANA timezone, e.g. America/New_York. Leave blank to use the shop timezone (${settings.timezone}).`}
              />
              <Checkbox label="Active" checked={status} onChange={setStatus} />
            </FormLayout>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Weekly hours</Text>
              {DAY_NAMES.map((dayName, day) => (
                <InlineStack key={dayName} gap="300" blockAlign="center" wrap={false}>
                  <div style={{ width: 110 }}>
                    <Checkbox
                      label={dayName}
                      checked={schedule[day].enabled}
                      onChange={(checked) => updateDay(day, { enabled: checked })}
                    />
                  </div>
                  <TextField
                    label="Start"
                    labelHidden
                    type="time"
                    value={schedule[day].start}
                    onChange={(value) => updateDay(day, { start: value })}
                    disabled={!schedule[day].enabled}
                    autoComplete="off"
                  />
                  <Text as="span">to</Text>
                  <TextField
                    label="End"
                    labelHidden
                    type="time"
                    value={schedule[day].end}
                    onChange={(value) => updateDay(day, { end: value })}
                    disabled={!schedule[day].enabled}
                    autoComplete="off"
                  />
                </InlineStack>
              ))}
            </BlockStack>
          </Card>

          <Card>
            <ChoiceList
              title={`${term(settings, "service_plural")} this ${term(settings, "resource_single").toLowerCase()} can deliver`}
              allowMultiple
              choices={services.map((s) => ({ label: s.name, value: String(s.id) }))}
              selected={selectedServices}
              onChange={setSelectedServices}
            />
          </Card>

          <InlineStack align="end">
            <Button variant="primary" onClick={handleSubmit}>Save</Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
