import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, useSubmit } from "react-router";
import { Page, Card, IndexTable, Badge, Select, TextField, InlineStack, BlockStack, Text, Button, Modal, Banner, Toast } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Waitlist, Data, Settings, isGetBooqinError } from "getbooqin-core";
import { term } from "getbooqin-core/booking/settingsShared";
import { waitlistStatusLabels, formatWaitlistWindow, type WaitlistStatus } from "getbooqin-core/booking/waitlistShared";

const STATUS_TONE: Record<WaitlistStatus, "info" | "attention" | "success" | "critical" | undefined> = {
  waiting: undefined,
  offered: "attention",
  claimed: "success",
  expired: "critical",
  cancelled: undefined,
};

/**
 * Staff-entered join (standing in for a self-service "join the waitlist"
 * button on the storefront widget — deliberately out of scope for this
 * pass, see core/src/booking/waitlist.ts's header comment) + a read-only
 * list of where every entry stands in the offer/claim lifecycle.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");

  const [entries, allServices, allResources] = await Promise.all([
    Waitlist.list(shop, "shopify"),
    Data.catalogServices(shop, "shopify", true),
    Data.resources(shop, "shopify", true),
  ]);

  const resourcesByService: Record<number, { id: number; name: string }[]> = {};
  for (const service of allServices) {
    const resources = await Data.resourcesForService(shop, "shopify", service.id);
    resourcesByService[service.id] = resources.map((r) => ({ id: r.id, name: r.name }));
  }

  return {
    settings,
    serviceOptions: allServices.map((s) => ({ id: s.id, name: s.name })),
    resourcesByService,
    entries: entries.map((e) => {
      const service = allServices.find((s) => s.id === e.serviceId);
      const resource = allResources.find((r) => r.id === e.resourceId);
      return {
        id: e.id,
        status: e.status as WaitlistStatus,
        service: service?.name ?? "",
        resource: e.resourceId ? resource?.name ?? "" : "Any",
        customer: `${e.customer.firstName} ${e.customer.lastName}`.trim() || e.customer.email,
        email: e.customer.email,
        window: formatWaitlistWindow(e.windowStartUtc, e.windowEndUtc, settings.timezone),
        joined: DateTime.fromJSDate(e.createdAt, { zone: "utc" }).setZone(settings.timezone).toFormat("d LLL yyyy"),
      };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const form = await request.formData();
  const intent = String(form.get("_intent") || "");

  try {
    if (intent === "join") {
      await Waitlist.join(shop, "shopify", settings.timezone, {
        service_id: Number(form.get("service_id") || 0),
        resource_id: Number(form.get("resource_id") || 0) || undefined,
        window_start: String(form.get("window_start") || ""),
        window_end: String(form.get("window_end") || "") || undefined,
        first_name: String(form.get("first_name") || ""),
        last_name: String(form.get("last_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
        notes: String(form.get("notes") || ""),
      });
      return { ok: true, message: "Added to the waitlist." };
    }
    if (intent === "leave") {
      await Waitlist.leave(shop, Number(form.get("id")));
      return { ok: true, message: "Removed from the waitlist." };
    }
    return { ok: false, error: "Unknown action." };
  } catch (err) {
    return { ok: false, error: isGetBooqinError(err) ? err.message : "Something went wrong." };
  }
}

export default function WaitlistPage() {
  const { settings, serviceOptions, resourcesByService, entries } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const labels = waitlistStatusLabels();

  const [showToast, setShowToast] = useState(false);
  useEffect(() => {
    if (actionData) setShowToast(true);
  }, [actionData]);

  const [addOpen, setAddOpen] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  function resetForm() {
    setServiceId("");
    setResourceId("");
    setWindowStart("");
    setWindowEnd("");
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setNotes("");
  }

  function confirmAdd() {
    const form = new FormData();
    form.set("_intent", "join");
    form.set("service_id", serviceId);
    form.set("resource_id", resourceId);
    form.set("window_start", windowStart);
    form.set("window_end", windowEnd);
    form.set("first_name", firstName);
    form.set("last_name", lastName);
    form.set("email", email);
    form.set("phone", phone);
    form.set("notes", notes);
    submit(form, { method: "post" });
    setAddOpen(false);
    resetForm();
  }

  function removeEntry(id: number) {
    const form = new FormData();
    form.set("_intent", "leave");
    form.set("id", String(id));
    submit(form, { method: "post" });
  }

  const resourceOptions = serviceId ? resourcesByService[Number(serviceId)] ?? [] : [];

  return (
    <Page title="Waitlist" primaryAction={{ content: "Add to waitlist", onAction: () => setAddOpen(true) }}>
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: "entry", plural: "entries" }}
          itemCount={entries.length}
          selectable={false}
          headings={[
            { title: term(settings, "customer_plural") },
            { title: term(settings, "service_single") },
            { title: term(settings, "resource_single") },
            { title: "Window" },
            { title: "Status" },
            { title: "Joined" },
            { title: "" },
          ]}
        >
          {entries.map((e, index) => (
            <IndexTable.Row id={String(e.id)} key={e.id} position={index}>
              <IndexTable.Cell>
                <BlockStack gap="050">
                  <Text as="span" fontWeight="semibold">{e.customer}</Text>
                  <Text as="span" tone="subdued" variant="bodySm">{e.email}</Text>
                </BlockStack>
              </IndexTable.Cell>
              <IndexTable.Cell>{e.service}</IndexTable.Cell>
              <IndexTable.Cell>{e.resource}</IndexTable.Cell>
              <IndexTable.Cell>{e.window}</IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={STATUS_TONE[e.status]}>{labels[e.status]}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>{e.joined}</IndexTable.Cell>
              <IndexTable.Cell>
                {(e.status === "waiting" || e.status === "offered") && (
                  <Button size="slim" onClick={() => removeEntry(e.id)}>
                    Remove
                  </Button>
                )}
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>

      <Modal
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          resetForm();
        }}
        title="Add to waitlist"
        primaryAction={{ content: "Add", onAction: confirmAdd }}
        secondaryActions={[{ content: "Cancel", onAction: () => setAddOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {actionData && !actionData.ok && <Banner tone="critical">{actionData.error}</Banner>}
            <Select
              label={term(settings, "service_single")}
              value={serviceId}
              onChange={(v) => {
                setServiceId(v);
                setResourceId("");
              }}
              options={[{ label: "Choose a service", value: "" }, ...serviceOptions.map((s) => ({ label: s.name, value: String(s.id) }))]}
            />
            <Select
              label={term(settings, "resource_single")}
              value={resourceId}
              onChange={setResourceId}
              disabled={!serviceId}
              options={[{ label: "Any available", value: "" }, ...resourceOptions.map((r) => ({ label: r.name, value: String(r.id) }))]}
            />
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Earliest date wanted" type="date" value={windowStart} onChange={setWindowStart} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Latest date wanted (optional)" type="date" value={windowEnd} onChange={setWindowEnd} autoComplete="off" />
              </div>
            </InlineStack>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="First name" value={firstName} onChange={setFirstName} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Last name" value={lastName} onChange={setLastName} autoComplete="off" />
              </div>
            </InlineStack>
            <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
            <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
            <TextField label="Notes" value={notes} onChange={setNotes} multiline={2} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {showToast && (
        <Toast content={actionData?.ok ? actionData.message ?? "Done." : actionData?.error ?? "Something went wrong."} onDismiss={() => setShowToast(false)} />
      )}
    </Page>
  );
}
