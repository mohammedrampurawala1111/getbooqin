import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams, useSubmit, useActionData } from "react-router";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  Select,
  TextField,
  InlineStack,
  BlockStack,
  Text,
  Button,
  Tabs,
  Modal,
  Banner,
  Toast,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Bookings } from "getbooqin-core";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";
import { paymentStatusLabels } from "getbooqin-core/booking/bookingsShared";
import { BookingStatusMenu } from "~/components/BookingStatusMenu";

const RANGES = ["upcoming", "past", "cancelled"] as const;
type Range = (typeof RANGES)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  const range: Range = RANGES.includes(rangeParam as Range) ? (rangeParam as Range) : "upcoming";
  const search = url.searchParams.get("q") || "";
  const resourceId = Number(url.searchParams.get("resource_id") || 0);
  const serviceId = Number(url.searchParams.get("service_id") || 0);

  const now = new Date();
  const queryArgs: Bookings.QueryArgs = {
    search,
    resource_id: resourceId || undefined,
    service_id: serviceId || undefined,
    limit: 100,
    order: range === "past" ? "desc" : "asc",
  };
  if (range === "upcoming") {
    queryArgs.from = now;
    queryArgs.notStatus = ["cancelled", "declined"];
  } else if (range === "past") {
    queryArgs.to = now;
    queryArgs.notStatus = ["cancelled", "declined"];
  } else {
    queryArgs.statusIn = ["cancelled", "declined"];
  }

  const [rawRows, allServices, allResources] = await Promise.all([
    Bookings.query(shop, "shopify", queryArgs),
    Data.catalogServices(shop, "shopify", true),
    Data.resources(shop, "shopify", true),
  ]);
  const rows = await Data.attachServiceNames(shop, rawRows);

  const resourcesByService: Record<number, { id: number; name: string }[]> = {};
  for (const service of allServices) {
    const resources = await Data.resourcesForService(shop, "shopify", service.id);
    resourcesByService[service.id] = resources.map((r) => ({ id: r.id, name: r.name }));
  }

  return {
    settings,
    range,
    resourceOptions: allResources.map((r) => ({ id: r.id, name: r.name })),
    serviceOptions: allServices.map((s) => ({ id: s.id, name: s.name, price: s.price, durationMin: s.durationMin })),
    resourcesByService,
    bookings: rows.map((b) => {
      const tz = Bookings.displayTz(b, settings.timezone);
      const local = DateTime.fromJSDate(b.startUtc, { zone: "utc" }).setZone(tz);
      return {
        id: b.id,
        uid: b.uid,
        status: b.status,
        serviceId: b.serviceId,
        resourceId: b.resourceId,
        service: b.serviceName,
        resource: b.resource?.name ?? "",
        customer: b.customer ? `${b.customer.firstName} ${b.customer.lastName}`.trim() : "Guest",
        email: b.customer?.email ?? "",
        date: local.toFormat("d LLL yyyy, h:mm a"),
        weekday: local.toFormat("cccc"),
        paymentStatus: b.paymentStatus,
        amountDue: b.amountDue,
      };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const form = await request.formData();
  const intent = String(form.get("_intent") || "status");

  try {
    if (intent === "create_manual") {
      await Bookings.create(shop, "shopify", settings.timezone, {
        service_id: Number(form.get("service_id") || 0),
        resource_id: Number(form.get("resource_id") || 0) || undefined,
        date: String(form.get("date") || ""),
        time: String(form.get("time") || ""),
        first_name: String(form.get("first_name") || ""),
        last_name: String(form.get("last_name") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
        notes: String(form.get("notes") || ""),
        source: "form",
      });
      return { ok: true, message: "Booking created." };
    }

    const id = Number(form.get("id"));
    const status = String(form.get("status"));
    if (status === "declined") {
      await Bookings.decline(shop, id, String(form.get("reason") || ""));
      return { ok: true, message: "Booking declined." };
    }
    await Bookings.setStatus(shop, id, status);
    return { ok: true, message: "Booking updated." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export default function BookingsList() {
  const { settings, range, resourceOptions, serviceOptions, resourcesByService, bookings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const navigate = useNavigate();

  const [declineTarget, setDeclineTarget] = useState<number | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  const [showSavedToast, setShowSavedToast] = useState(false);
  useEffect(() => {
    if (actionData?.ok) setShowSavedToast(true);
  }, [actionData]);

  const [addOpen, setAddOpen] = useState(false);
  const [addServiceId, setAddServiceId] = useState("");
  const [addResourceId, setAddResourceId] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addTime, setAddTime] = useState("");
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addNotes, setAddNotes] = useState("");

  function resetAddForm() {
    setAddServiceId("");
    setAddResourceId("");
    setAddDate("");
    setAddTime("");
    setAddFirstName("");
    setAddLastName("");
    setAddEmail("");
    setAddPhone("");
    setAddNotes("");
  }

  function confirmDecline() {
    if (declineTarget == null) return;
    const form = new FormData();
    form.set("id", String(declineTarget));
    form.set("status", "declined");
    form.set("reason", declineReason);
    submit(form, { method: "post" });
    setDeclineTarget(null);
    setDeclineReason("");
  }

  function confirmAdd() {
    const form = new FormData();
    form.set("_intent", "create_manual");
    form.set("service_id", addServiceId);
    form.set("resource_id", addResourceId);
    form.set("date", addDate);
    form.set("time", addTime);
    form.set("first_name", addFirstName);
    form.set("last_name", addLastName);
    form.set("email", addEmail);
    form.set("phone", addPhone);
    form.set("notes", addNotes);
    submit(form, { method: "post" });
    setAddOpen(false);
    resetAddForm();
  }

  const addResourceOptions = addServiceId ? resourcesByService[Number(addServiceId)] ?? [] : [];

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      value ? p.set(key, value) : p.delete(key);
      return p;
    });
  }

  const tabs = RANGES.map((r) => ({
    id: r,
    content: r === "upcoming" ? "Upcoming" : r === "past" ? "Past" : "Cancelled",
    accessibilityLabel: r,
    panelID: `bookings-${r}`,
  }));

  return (
    <Page
      title={term(settings, "booking_plural")}
      primaryAction={{ content: "Add booking manually", onAction: () => setAddOpen(true) }}
    >
      <Card padding="0">
        <Tabs
          tabs={tabs}
          selected={RANGES.indexOf(range)}
          onSelect={(index) => setParam("range", RANGES[index])}
        />
        <div style={{ padding: 16 }}>
          <BlockStack gap="300">
            <InlineStack gap="300">
              <div style={{ minWidth: 200 }}>
                <Select
                  label={term(settings, "resource_single")}
                  value={searchParams.get("resource_id") || ""}
                  onChange={(v) => setParam("resource_id", v)}
                  options={[{ label: "All", value: "" }, ...resourceOptions.map((r) => ({ label: r.name, value: String(r.id) }))]}
                />
              </div>
              <div style={{ minWidth: 200 }}>
                <Select
                  label={term(settings, "service_single")}
                  value={searchParams.get("service_id") || ""}
                  onChange={(v) => setParam("service_id", v)}
                  options={[{ label: "All", value: "" }, ...serviceOptions.map((s) => ({ label: s.name, value: String(s.id) }))]}
                />
              </div>
            </InlineStack>
            <TextField
              label="Search"
              labelHidden
              placeholder="Search by name, email or phone"
              value={searchParams.get("q") || ""}
              onChange={(v) => setParam("q", v)}
              autoComplete="off"
            />
          </BlockStack>
        </div>

        <IndexTable
          resourceName={{ singular: term(settings, "booking_single"), plural: term(settings, "booking_plural") }}
          itemCount={bookings.length}
          selectable={false}
          headings={[
            { title: "Appointment time" },
            { title: term(settings, "service_single") },
            { title: term(settings, "resource_single") },
            { title: "Payment" },
            { title: "Status" },
            { title: "" },
          ]}
        >
          {bookings.map((b, index) => (
            <IndexTable.Row id={String(b.id)} key={b.id} position={index}>
              <IndexTable.Cell>
                <BlockStack gap="100">
                  <Text as="span" fontWeight="semibold">{b.date}</Text>
                  <Text as="span" tone="subdued" variant="bodySm">{b.weekday}</Text>
                  <InlineStack gap="100" blockAlign="center">
                    <Text as="span" tone="subdued" variant="bodySm">Customer:</Text>
                    <Badge>{b.customer || "Guest"}</Badge>
                  </InlineStack>
                </BlockStack>
              </IndexTable.Cell>
              <IndexTable.Cell>{b.service}</IndexTable.Cell>
              <IndexTable.Cell>{b.resource || "—"}</IndexTable.Cell>
              <IndexTable.Cell>
                {b.paymentStatus === "not_required" ? (
                  "—"
                ) : (
                  <Badge tone={b.paymentStatus === "paid" ? "success" : b.paymentStatus === "failed" ? "critical" : "attention"}>
                    {`${paymentStatusLabels()[b.paymentStatus] ?? b.paymentStatus}${b.amountDue ? ` · ${money(settings, b.amountDue)}` : ""}`}
                  </Badge>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                <BookingStatusMenu bookingId={b.id} current={b.status} onRequestDecline={setDeclineTarget} />
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Button size="slim" onClick={() => navigate(`/app/bookings/${b.id}`)}>
                  Manage booking
                </Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>

      <Modal
        open={declineTarget != null}
        onClose={() => setDeclineTarget(null)}
        title="Decline this request?"
        primaryAction={{ content: "Decline", destructive: true, onAction: confirmDecline }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeclineTarget(null) }]}
      >
        <Modal.Section>
          <TextField
            label="Reason (optional — included in the email to the customer)"
            value={declineReason}
            onChange={setDeclineReason}
            multiline={3}
            autoComplete="off"
          />
        </Modal.Section>
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          resetAddForm();
        }}
        title="Add booking manually"
        primaryAction={{ content: "Create booking", onAction: confirmAdd }}
        secondaryActions={[{ content: "Cancel", onAction: () => setAddOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {actionData && !actionData.ok && <Banner tone="critical">{actionData.error}</Banner>}
            <Select
              label={term(settings, "service_single")}
              value={addServiceId}
              onChange={(v) => {
                setAddServiceId(v);
                setAddResourceId("");
              }}
              options={[{ label: "Choose a service", value: "" }, ...serviceOptions.map((s) => ({ label: s.name, value: String(s.id) }))]}
            />
            <Select
              label={term(settings, "resource_single")}
              value={addResourceId}
              onChange={setAddResourceId}
              disabled={!addServiceId}
              options={[
                { label: "Any available", value: "" },
                ...addResourceOptions.map((r) => ({ label: r.name, value: String(r.id) })),
              ]}
            />
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Date" type="date" value={addDate} onChange={setAddDate} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Time" type="time" value={addTime} onChange={setAddTime} autoComplete="off" />
              </div>
            </InlineStack>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="First name" value={addFirstName} onChange={setAddFirstName} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Last name" value={addLastName} onChange={setAddLastName} autoComplete="off" />
              </div>
            </InlineStack>
            <TextField label="Email" type="email" value={addEmail} onChange={setAddEmail} autoComplete="off" />
            <TextField label="Phone" value={addPhone} onChange={setAddPhone} autoComplete="off" />
            <TextField label="Notes" value={addNotes} onChange={setAddNotes} multiline={2} autoComplete="off" />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {showSavedToast && (
        <Toast content={actionData?.ok ? actionData.message ?? "Booking updated." : "Booking updated."} onDismiss={() => setShowSavedToast(false)} />
      )}
    </Page>
  );
}
