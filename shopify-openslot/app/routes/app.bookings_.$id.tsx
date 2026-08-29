import { useState } from "react";
import { DateTime } from "luxon";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  TextField,
  Select,
  Modal,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { Data } from "getbooqin-core";
import { Bookings } from "getbooqin-core";
import { Mailer } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";
import { TRANSITIONS, statusLabels, paymentStatusLabels, type BookingStatus } from "getbooqin-core/booking/bookingsShared";
import { GetBooqinError } from "getbooqin-core";
import { BookingStatusMenu } from "~/components/BookingStatusMenu";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const id = Number(params.id);

  const booking = await prisma.booking.findFirst({
    where: { shop, id },
    include: { resource: true, customer: true },
  });
  if (!booking) throw new Response("Booking not found", { status: 404 });

  const [service, resourceOptions] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resourcesForService(shop, "shopify", booking.serviceId),
  ]);

  const tz = Bookings.displayTz(booking, settings.timezone);
  const local = DateTime.fromJSDate(booking.startUtc, { zone: "utc" }).setZone(tz);
  const endLocal = DateTime.fromJSDate(booking.endUtc, { zone: "utc" }).setZone(tz);

  return {
    settings,
    booking: {
      id: booking.id,
      uid: booking.uid,
      status: booking.status,
      serviceId: booking.serviceId,
      resourceId: booking.resourceId,
      service: service?.name ?? "",
      locationType: service?.locationType ?? "onsite",
      resource: booking.resource?.name ?? "Anyone available",
      customer: {
        id: booking.customer?.id ?? 0,
        firstName: booking.customer?.firstName ?? "",
        lastName: booking.customer?.lastName ?? "",
        email: booking.customer?.email ?? "",
        phone: booking.customer?.phone ?? "",
      },
      date: local.toFormat("d LLL yyyy, h:mm a"),
      weekday: local.toFormat("cccc"),
      rawDate: local.toFormat("yyyy-MM-dd"),
      rawTime: local.toFormat("HH:mm"),
      durationLabel: `${Math.round(endLocal.diff(local, "minutes").minutes)} mins`,
      paymentStatus: booking.paymentStatus,
      amountDue: booking.amountDue,
      meetingUrl: booking.meetingUrl,
      notes: booking.notes ?? "",
      manageUrl: Bookings.manageUrl(booking, settings),
    },
    resourceOptions: resourceOptions.map((r) => ({ id: r.id, name: r.name })),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const id = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("_intent") || "status");

  try {
    if (intent === "resend_mail") {
      await Mailer.resendConfirmation(shop, "shopify", id);
      return { ok: true, message: "Confirmation email sent." };
    }

    if (intent === "save_notes") {
      await prisma.booking.update({ where: { id }, data: { notes: String(form.get("notes") || "") } });
      return { ok: true, message: "Notes saved." };
    }

    if (intent === "update_customer") {
      const booking = await prisma.booking.findFirst({ where: { shop, id } });
      if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);
      await prisma.customer.update({
        where: { id: booking.customerId },
        data: {
          firstName: String(form.get("first_name") || ""),
          lastName: String(form.get("last_name") || ""),
          email: String(form.get("email") || ""),
          phone: String(form.get("phone") || ""),
        },
      });
      return { ok: true, message: "Customer details updated." };
    }

    if (intent === "reschedule") {
      await Bookings.reschedule(
        shop,
        "shopify",
        settings.timezone,
        id,
        String(form.get("date") || ""),
        String(form.get("time") || ""),
        Number(form.get("resource_id") || 0)
      );
      return { ok: true, message: "Booking rescheduled." };
    }

    const status = String(form.get("status"));
    if (status === "declined") {
      await Bookings.decline(shop, id, String(form.get("reason") || ""));
    } else {
      await Bookings.setStatus(shop, id, status);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export default function BookingDetail() {
  const { settings, booking, resourceOptions } = useLoaderData<typeof loader>();
  // A fetcher submission posts and refreshes this route's data in place,
  // without pushing a browser-history entry or doing a full navigation-style
  // transition — useSubmit() did both here, which turned every save (notes,
  // status, reschedule, ...) into a history entry and, at least once, left
  // the page showing a bare "200" after the POST instead of re-rendering.
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data;
  function submit(form: FormData, options: { method: "post" }) {
    fetcher.submit(form, options);
  }

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState(booking.rawDate);
  const [rescheduleTime, setRescheduleTime] = useState(booking.rawTime);
  const [rescheduleResourceId, setRescheduleResourceId] = useState(String(booking.resourceId || ""));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [declineTarget, setDeclineTarget] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const [editingCustomer, setEditingCustomer] = useState(false);
  const [firstName, setFirstName] = useState(booking.customer.firstName);
  const [lastName, setLastName] = useState(booking.customer.lastName);
  const [email, setEmail] = useState(booking.customer.email);
  const [phone, setPhone] = useState(booking.customer.phone);

  const [notes, setNotes] = useState(booking.notes);
  const [copied, setCopied] = useState(false);

  function submitStatus(status: string) {
    const form = new FormData();
    form.set("status", status);
    submit(form, { method: "post" });
  }

  function confirmReschedule() {
    const form = new FormData();
    form.set("_intent", "reschedule");
    form.set("date", rescheduleDate);
    form.set("time", rescheduleTime);
    form.set("resource_id", rescheduleResourceId);
    submit(form, { method: "post" });
    setRescheduleOpen(false);
  }

  function confirmCancel() {
    submitStatus("cancelled");
    setCancelOpen(false);
  }

  function confirmDecline() {
    const form = new FormData();
    form.set("status", "declined");
    form.set("reason", declineReason);
    submit(form, { method: "post" });
    setDeclineTarget(false);
    setDeclineReason("");
  }

  function saveCustomer() {
    const form = new FormData();
    form.set("_intent", "update_customer");
    form.set("first_name", firstName);
    form.set("last_name", lastName);
    form.set("email", email);
    form.set("phone", phone);
    submit(form, { method: "post" });
    setEditingCustomer(false);
  }

  function saveNotes() {
    const form = new FormData();
    form.set("_intent", "save_notes");
    form.set("notes", notes);
    submit(form, { method: "post" });
  }

  function resendMail() {
    const form = new FormData();
    form.set("_intent", "resend_mail");
    submit(form, { method: "post" });
  }

  function copyLink() {
    navigator.clipboard.writeText(booking.manageUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const canCancel = (TRANSITIONS[booking.status as BookingStatus] ?? []).includes("cancelled");
  const canDecline = booking.status === "pending";

  return (
    <Page title="Booking details" backAction={{ content: term(settings, "booking_plural"), url: "/app/bookings" }}>
      <BlockStack gap="400">
        {actionData && !actionData.ok && <Banner tone="critical">{actionData.error}</Banner>}
        {actionData?.ok && actionData.message && <Banner tone="success">{actionData.message}</Banner>}

        <Card>
          <BlockStack gap="200">
            <Text as="span" tone="subdued">Booking #{booking.uid}</Text>

            <Text as="h2" variant="headingMd">Edit timing</Text>
            <InlineStack gap="200">
              <Button onClick={() => setRescheduleOpen(true)}>Re-schedule booking</Button>
              {canCancel && (
                <Button tone="critical" onClick={() => setCancelOpen(true)}>
                  Cancel booking
                </Button>
              )}
              {canDecline && (
                <Button tone="critical" onClick={() => setDeclineTarget(true)}>
                  Decline request
                </Button>
              )}
              <BookingStatusMenu bookingId={booking.id} current={booking.status} onRequestDecline={() => setDeclineTarget(true)} />
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Booking details</Text>
            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Customer</Text>
                <Text as="span">{booking.customer.firstName} {booking.customer.lastName}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Status</Text>
                <Badge tone={statusTone(booking.status)}>{statusLabels()[booking.status as BookingStatus] ?? booking.status}</Badge>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Payment</Text>
                <Text as="span">
                  {booking.paymentStatus === "not_required"
                    ? "No payment required"
                    : `${paymentStatusLabels()[booking.paymentStatus] ?? booking.paymentStatus}${booking.amountDue ? ` — ${money(settings, booking.amountDue)}` : ""}`}
                </Text>
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Service details</Text>
            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Service</Text>
                <Text as="span">{booking.service}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">{term(settings, "resource_single")}</Text>
                <Text as="span">{booking.resource}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Appointment time</Text>
                <Text as="span">{booking.date} ({booking.weekday})</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" tone="subdued" variant="bodySm">Duration</Text>
                <Text as="span">{booking.durationLabel}</Text>
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">Customer details</Text>
              {!editingCustomer && <Button variant="plain" onClick={() => setEditingCustomer(true)}>Edit</Button>}
            </InlineStack>
            {editingCustomer ? (
              <BlockStack gap="200">
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
                <InlineStack gap="200">
                  <Button variant="primary" onClick={saveCustomer}>Save</Button>
                  <Button onClick={() => setEditingCustomer(false)}>Cancel</Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <InlineStack gap="600">
                <BlockStack gap="050">
                  <Text as="span" tone="subdued" variant="bodySm">Name</Text>
                  <Text as="span">{booking.customer.firstName} {booking.customer.lastName}</Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="span" tone="subdued" variant="bodySm">Email</Text>
                  <Text as="span">{booking.customer.email || "—"}</Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="span" tone="subdued" variant="bodySm">Phone</Text>
                  <Text as="span">{booking.customer.phone || "—"}</Text>
                </BlockStack>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Joining details</Text>
            <Text as="span" tone="subdued" variant="bodySm">Location</Text>
            <Text as="span">
              {booking.locationType === "video"
                ? booking.meetingUrl || "Video link will be sent before the appointment"
                : booking.locationType === "phone"
                ? "Phone call — customer will be contacted"
                : `In person at ${settings.business_name}`}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Resend booking mail</Text>
            <InlineStack gap="200" blockAlign="center">
              <Button onClick={resendMail}>Resend mail</Button>
              <Text as="span" tone="subdued" variant="bodySm">Sends the original confirmation email to the customer</Text>
            </InlineStack>

            <Text as="h3" variant="headingSm">Customer's manage booking link</Text>
            <InlineStack gap="200">
              <div style={{ flex: 1 }}>
                <TextField label="" labelHidden value={booking.manageUrl} readOnly autoComplete="off" />
              </div>
              <Button onClick={copyLink}>{copied ? "Copied" : "Copy"}</Button>
            </InlineStack>
            <Text as="span" tone="subdued" variant="bodySm">Customers can reschedule or cancel with this link</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Personal notes</Text>
            <TextField label="" labelHidden value={notes} onChange={setNotes} multiline={4} autoComplete="off" />
            <InlineStack>
              <Button onClick={saveNotes}>Save notes</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>

      <Modal
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        title="Re-schedule booking"
        primaryAction={{ content: "Save", onAction: confirmReschedule }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRescheduleOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <TextField label="Date" type="date" value={rescheduleDate} onChange={setRescheduleDate} autoComplete="off" />
            <TextField label="Time" type="time" value={rescheduleTime} onChange={setRescheduleTime} autoComplete="off" />
            <Select
              label={term(settings, "resource_single")}
              value={rescheduleResourceId}
              onChange={setRescheduleResourceId}
              options={[
                { label: "Any available", value: "" },
                ...resourceOptions.map((r) => ({ label: r.name, value: String(r.id) })),
              ]}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this booking?"
        primaryAction={{ content: "Cancel booking", destructive: true, onAction: confirmCancel }}
        secondaryActions={[{ content: "Back", onAction: () => setCancelOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">The customer will be notified that this booking was cancelled.</Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={declineTarget}
        onClose={() => setDeclineTarget(false)}
        title="Decline this request?"
        primaryAction={{ content: "Decline", destructive: true, onAction: confirmDecline }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeclineTarget(false) }]}
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
    </Page>
  );
}

function statusTone(status: string): "success" | "attention" | "critical" | "info" | "new" {
  const tones: Record<string, "success" | "attention" | "critical" | "info" | "new"> = {
    confirmed: "success",
    pending: "attention",
    declined: "critical",
    cancelled: "critical",
    completed: "info",
    no_show: "critical",
  };
  return tones[status] ?? "new";
}
