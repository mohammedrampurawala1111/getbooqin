import { useEffect, useState } from "react";
import { Form, data, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.customers.$customerId";
import { Bookings, Data, Settings } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import { requireTenant } from "~/tenant.server";
import { AlertError, Badge, ConfirmDialog, DataTable, EmptyState, Field, Input, useToast } from "~/components/ui";
import { useVocabulary } from "~/lib/presets";
import { contactFieldErrors } from "~/lib/validation";

export const meta: Route.MetaFunction = ({ data: loaderData }) => [
  { title: `${loaderData ? `${loaderData.customer.firstName} ${loaderData.customer.lastName}`.trim() : "Client"} · GetBooqin` },
];

// A client detail page reached by clicking a row on the Clients list, with
// contact details, full booking history and free-text staff notes — the
// list was previously three columns you could only look at (Defect
// Dossier's BQ-31 finding).
export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform, role } = await requireTenant(request, params.connectionId);
  const id = Number(params.customerId);

  const customer = await Data.customer(shop, id);
  if (!customer) throw data("Client not found", { status: 404 });

  const [rows, settings, hasHistory] = await Promise.all([
    Bookings.query(shop, platform, { customer_id: id, limit: 200, order: "desc" }),
    Settings.getSettings(shop, platform),
    // Lets the Danger zone dialog say, before the destructive action runs,
    // whether this record will be hard-deleted or pseudonymized — see
    // eraseCustomerData()'s own comment (GetBooqin clinic audit's PT-01
    // finding).
    Data.customerHasHistory(shop, id),
  ]);
  const bookings = await Data.attachServiceNames(shop, rows);
  const noShowCount = rows.filter((b) => b.status === "no_show").length;

  return {
    customer,
    bookings,
    totalBookings: rows.length,
    noShowCount,
    hasHistory,
    labels: Bookings.statusLabels(),
    timezone: settings.timezone,
    requirePhone: settings.require_phone,
    requireEmail: settings.require_email,
    // A "write" teammate needs to move appointments and see who they're
    // for, but got every patient's private notes and medical alerts as an
    // unavoidable side effect of that — the three roles (Admin/Write/Read)
    // draw no line between scheduling access and clinical-record access at
    // all (GetBooqin clinic audit's TS-02 finding). Scoped here to what
    // already exists rather than a new role: clinical fields (notes, date
    // of birth, medical alert) render only for admin/owner; a write/read
    // viewer sees contact details and booking history same as before.
    canViewClinicalNotes: role === "owner" || role === "admin",
    // Same "hide, never disable" convention team-ui-spec.md already
    // establishes for write/read-gated controls elsewhere (§0) — a "read"
    // viewer reaching this page shouldn't see an Edit button that would
    // just 404 on submit, since both write actions below require "write".
    canManage: role !== "read",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform, role } = await requireTenant(request, params.connectionId, "write");
  const id = Number(params.customerId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  // Same admin/owner-only line the loader draws for viewing clinical
  // fields (GetBooqin clinic audit's TS-02 finding) — enforced again here
  // so a write-role request crafted directly against this action can't
  // write them either.
  const canViewClinicalNotes = role === "owner" || role === "admin";

  if (intent === "notes") {
    if (!canViewClinicalNotes) throw data("Not found", { status: 404 });
    await Data.updateCustomerNotes(shop, id, String(form.get("notes") ?? ""));
    return { saved: true };
  }
  if (intent === "update") {
    // Contact details were read-only from the moment a record was created
    // — a mistyped phone number could only be fixed by erasing (leaving a
    // tombstone per PT-01) and re-creating the client from scratch
    // (GetBooqin clinic audit's PT-02 finding).
    const settings = await Settings.getSettings(shop, platform);
    const firstName = String(form.get("first_name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const phone = String(form.get("phone") ?? "").trim();
    const fieldErrors = contactFieldErrors({ first_name: firstName, email, phone }, settings.require_phone, settings.require_email);
    if (Object.keys(fieldErrors).length > 0) {
      return { updateError: Object.values(fieldErrors)[0], fieldErrors };
    }
    const existing = await Data.customer(shop, id);
    try {
      await Data.updateCustomer(shop, id, {
        first_name: firstName,
        last_name: String(form.get("last_name") ?? "").trim(),
        email,
        phone: phone ? Bookings.normalizePhone(phone, settings.default_country_code) : phone,
        // A write-role viewer never sees these fields to begin with (the
        // form doesn't render them), but the fields still exist in the
        // record — keep whatever was already there rather than letting a
        // crafted request blank them.
        date_of_birth: canViewClinicalNotes ? String(form.get("date_of_birth") ?? "").trim() || null : (existing?.dateOfBirth ?? null),
        medical_alert: canViewClinicalNotes ? String(form.get("medical_alert") ?? "").trim() : (existing?.medicalAlert ?? ""),
      });
    } catch (err: unknown) {
      // Prisma's unique-constraint violation on (platform, shop, email) —
      // surfaced as a normal field error instead of a 500.
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
        return { updateError: "Another client already uses that email address.", fieldErrors: { email: "Already in use by another client." } };
      }
      throw err;
    }
    return { saved: true, updated: true };
  }
  if (intent === "erase") {
    const { hardDeleted } = await Data.eraseCustomerData(shop, id);
    return redirect(`/dashboard/${params.connectionId}/customers?erased=1${hardDeleted ? "&hardDeleted=1" : ""}`);
  }
  return { error: "Unknown request." };
}

export default function CustomerDetail({ loaderData, actionData, params }: Route.ComponentProps) {
  const { customer, bookings, totalBookings, noShowCount, hasHistory, labels, timezone, requirePhone, requireEmail, canViewClinicalNotes, canManage } = loaderData;
  const base = `/dashboard/${params.connectionId}`;
  const v = useVocabulary();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const updateError = actionData && "updateError" in actionData ? actionData.updateError : undefined;
  const fieldErrors = (actionData && "fieldErrors" in actionData ? actionData.fieldErrors : undefined) ?? {};

  useEffect(() => {
    if (!actionData || !("saved" in actionData) || !actionData.saved) return;
    if ("updated" in actionData && actionData.updated) {
      toast("Contact details saved");
      setEditing(false);
    } else {
      toast("Notes saved");
    }
  }, [actionData]);

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/customers`} className="btn-link">
          &larr; All {v.customers}
        </a>
      </div>

      <h1 className="page-title">{customer.firstName} {customer.lastName}</h1>

      <div className="grid grid-cols-[1.35fr_1fr] gap-[14px]">
        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Booking history</h2>
            </div>
            <DataTable
              cols="1.1fr 1.2fr .8fr"
              columns={["When", v.serviceOne ? v.serviceOne.charAt(0).toUpperCase() + v.serviceOne.slice(1) : "Service", "Status"]}
              rows={bookings}
              rowKey={(b) => String(b.id)}
              href={(b) => `${base}/bookings/${b.id}`}
              renderRow={(b) => [
                <span className="num">{formatInZone(b.startUtc, timezone)}</span>,
                <span className="min-w-0 truncate">{b.serviceName}</span>,
                <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />,
              ]}
              mobileCard={(b) => (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{b.serviceName}</span>
                    <Badge status={b.status as any} label={labels[b.status as keyof typeof labels]} />
                  </div>
                  <span className="num text-muted">{formatInZone(b.startUtc, timezone)}</span>
                </>
              )}
              empty={
                <EmptyState
                  title={`No ${v.bookingMany} yet`}
                  body={`Once ${customer.firstName || "this client"} books, it shows up here.`}
                />
              }
            />
          </div>
        </div>

        <div className="flex flex-col gap-[14px]">
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="card-title">Contact</h2>
              {/* Read-only-since-creation was the actual bug (GetBooqin
                  clinic audit's PT-02 finding) — a mistyped phone number
                  had no fix except erasing and re-creating the whole
                  record. */}
              {!editing && canManage && (
                <button type="button" className="btn-link" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <Form method="post" className="card-body flex flex-col gap-[12px]">
                <input type="hidden" name="_action" value="update" />
                {updateError && <AlertError>{updateError}</AlertError>}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name" error={fieldErrors.first_name}>
                    <Input name="first_name" defaultValue={customer.firstName} autoComplete="given-name" />
                  </Field>
                  <Field label="Last name">
                    <Input name="last_name" defaultValue={customer.lastName} autoComplete="family-name" />
                  </Field>
                </div>
                <Field label="Email" required={requireEmail} error={fieldErrors.email}>
                  <Input type="email" name="email" defaultValue={customer.email.endsWith("@getbooqin.invalid") ? "" : customer.email} autoComplete="email" />
                </Field>
                <Field label="Phone" required={requirePhone} error={fieldErrors.phone}>
                  <Input type="tel" name="phone" defaultValue={customer.phone} autoComplete="tel" />
                </Field>
                {/* Date of birth and a medical alert — the record before
                    this held four fields and a free-text notes box, with
                    no way to tell two patients named Sharma apart, and no
                    structured place for an allergy or condition that
                    should surface on the appointment itself (GetBooqin
                    clinic audit's PT-02 finding). Structured clinical
                    history can come later; these two can't wait.
                    Admin/owner only — a "write" teammate who only needs to
                    move appointments shouldn't get every patient's clinical
                    detail as an unavoidable side effect (TS-02 finding). */}
                {canViewClinicalNotes && (
                  <>
                    <Field label="Date of birth">
                      <Input type="date" name="date_of_birth" defaultValue={customer.dateOfBirth ?? ""} />
                    </Field>
                    <Field label="Medical alert" hint="Allergy or condition staff should see before the appointment. Shown on the appointment detail.">
                      <Input name="medical_alert" defaultValue={customer.medicalAlert} placeholder="e.g. Penicillin allergy" />
                    </Field>
                  </>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-sec" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-pri">
                    Save
                  </button>
                </div>
              </Form>
            ) : (
              <div className="card-body flex flex-col gap-[10px] text-body">
                <div className="text-muted">{customer.email.endsWith("@getbooqin.invalid") ? "No email on file" : customer.email}</div>
                {customer.phone && <div className="text-muted">{customer.phone}</div>}
                {canViewClinicalNotes && customer.dateOfBirth && <div className="text-muted">Born {customer.dateOfBirth}</div>}
                {canViewClinicalNotes && customer.medicalAlert && (
                  <div className="flex items-start gap-[7px] rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] font-medium text-warn">
                    <span className="mt-[1px] inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-warn text-[9px] text-white">!</span>
                    {customer.medicalAlert}
                  </div>
                )}
                <div className="mt-2 flex gap-4 text-meta text-muted">
                  <span>{totalBookings} total {totalBookings === 1 ? v.bookingOne : v.bookingMany}</span>
                  <span>{noShowCount} no-show{noShowCount === 1 ? "" : "s"}</span>
                </div>
              </div>
            )}
          </div>

          {/* Admin/owner only — same TS-02 line as date of birth/medical
              alert above. A "write" teammate scheduling appointments has no
              need to read every patient's private notes. */}
          {canViewClinicalNotes && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Notes</h2>
              </div>
              <Form method="post">
                <input type="hidden" name="_action" value="notes" />
                <div className="card-body">
                  <textarea
                    name="notes"
                    defaultValue={customer.notes ?? ""}
                    placeholder={`Private notes — never shown to the ${v.customerOne}.`}
                    className="input min-h-[120px]"
                  />
                </div>
                <div className="card-footer">
                  <button type="submit" className="btn-pri ml-auto">
                    Save notes
                  </button>
                </div>
              </Form>
            </div>
          )}

          {canManage && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Danger zone</h2>
              </div>
              <div className="card-body">
                <button
                  type="button"
                  className="btn-del"
                  onClick={() => (document.getElementById("erase-customer") as HTMLDialogElement | null)?.showModal()}
                >
                  Delete this {v.customerOne}&rsquo;s data
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Body now says, in advance, exactly which of the two things
          eraseCustomerData() will actually do — the old copy promised
          "permanently erased... this can't be undone" unconditionally, when
          a record with any booking or waitlist history was (and still is)
          pseudonymized in place, not deleted, and the dialog never said
          what happened to that history either (GetBooqin clinic audit's
          PT-01 finding). A record with no history at all is now genuinely,
          fully deleted — so for that case, this promise is finally true. */}
      <ConfirmDialog
        id="erase-customer"
        title={hasHistory ? `Erase this ${v.customerOne}'s contact details?` : `Delete this ${v.customerOne}?`}
        body={
          hasHistory
            ? `Name, email and phone will be replaced with "Deleted client" everywhere, including on ${totalBookings > 0 ? `${totalBookings} past ${totalBookings === 1 ? v.bookingOne : v.bookingMany}` : "waitlist history"} — their date and service are kept. The record itself isn't deleted, since ${v.bookingMany.toLowerCase()} still reference it. This can't be undone.`
            : `This ${v.customerOne} has no booking or waitlist history, so the record itself will be permanently deleted, not just anonymized. This can't be undone.`
        }
        confirmLabel={hasHistory ? "Erase details" : `Delete ${v.customerOne}`}
      >
        <Form method="post" id="erase-customer-form">
          <input type="hidden" name="_action" value="erase" />
        </Form>
      </ConfirmDialog>
    </div>
  );
}
