import { useEffect, useRef } from "react";
import { Form, redirect, useNavigate, useSearchParams, useSubmit } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.customers";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Field, Input, PageHeader, EmptyState, DataTable, useToast } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardPreset(matches)).customers} · GetBooqin` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const [customers, totalCount] = await Promise.all([
    Data.customers(shop, platform, search, 100, 0),
    Data.customersCount(shop, platform, search),
  ]);
  return { customers, search, totalCount };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const form = await request.formData();
  const firstName = String(form.get("first_name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!firstName || !email) {
    return { error: "Enter at least a first name and email." };
  }
  await Data.createCustomer(shop, platform, {
    first_name: firstName,
    last_name: String(form.get("last_name") ?? ""),
    email,
    phone: String(form.get("phone") ?? ""),
  });
  // Same "?added=1" convention as the other create dialogs (BQ-02/BQ-29) —
  // a plain redirect to this same URL just revalidates the already-mounted
  // route, so nothing tells the dialog it should close.
  return redirect(`/dashboard/${params.connectionId}/customers?added=1`);
}

export default function Customers({ loaderData, actionData, params }: Route.ComponentProps) {
  const { customers, search, totalCount } = loaderData;
  const v = useVocabulary();
  const base = `/dashboard/${params.connectionId}`;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const submit = useSubmit();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error) {
      const dialog = document.getElementById("add-customer") as HTMLDialogElement | null;
      if (dialog && !dialog.open) dialog.showModal();
    }
  }, [actionData]);

  useEffect(() => {
    if (searchParams.get("added") === "1") {
      (document.getElementById("add-customer") as HTMLDialogElement | null)?.close();
      toast(`${v.customerOne.charAt(0).toUpperCase() + v.customerOne.slice(1)} added`);
      navigate(`${base}/customers`, { replace: true });
    } else if (searchParams.get("erased") === "1") {
      toast("Client data erased.");
      navigate(`${base}/customers`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // "Search that filters as you type" (Defect Dossier's BQ-31 finding) —
  // the list was submit-on-click-only. Debounced so every keystroke doesn't
  // fire its own request; a plain GET <Form> submit still works with JS off.
  function handleSearchInput(event: React.ChangeEvent<HTMLInputElement>) {
    const form = event.currentTarget.form;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (form) submit(form);
    }, 300);
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title={v.customers}
        subtitle={`${totalCount} total`}
        actions={
          <button
            type="button"
            className="btn-pri"
            onClick={() => (document.getElementById("add-customer") as HTMLDialogElement | null)?.showModal()}
          >
            + Add {v.customerOne}
          </button>
        }
      />

      <div className="card">
        <div className="card-header">
          <Form method="get" className="flex w-full items-center gap-2">
            <input
              name="q"
              defaultValue={search}
              onChange={handleSearchInput}
              placeholder="Search name, email, phone"
              className="input max-w-[320px]"
            />
            <button type="submit" className="btn-sec">
              Search
            </button>
          </Form>
        </div>
      </div>

      <DataTable
        cols="1.2fr 1.4fr 1fr 28px"
        columns={["Name", "Email", "Phone", ""]}
        rows={customers}
        rowKey={(c) => String(c.id)}
        href={(c) => `${base}/customers/${c.id}`}
        renderRow={(c) => [
          <span className="min-w-0 truncate font-medium">
            {c.firstName} {c.lastName}
          </span>,
          <span className="min-w-0 truncate">{c.email}</span>,
          <span className="min-w-0 truncate">{c.phone}</span>,
          <span className="text-faint">›</span>,
        ]}
        // Same overlap/clipping problem as Bookings/Waitlist below 640px
        // (UX audit's #2 finding) — three columns all truncated to a few
        // characters ("Karin B…", "karin.ba…", "+31 6 …").
        mobileCard={(c) => (
          <>
            <span className="min-w-0 truncate font-medium">
              {c.firstName} {c.lastName}
            </span>
            {(c.email || c.phone) && (
              <span className="min-w-0 truncate text-muted">{[c.email, c.phone].filter(Boolean).join(" · ")}</span>
            )}
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="9" cy="6.5" r="3" />
                <path d="M3.5 15c.6-3 2.8-5 5.5-5s4.9 2 5.5 5" strokeLinecap="round" />
              </svg>
            }
            title={search ? "No results" : `No ${v.customers.toLowerCase()} yet`}
            body={search ? `Nothing matches "${search}".` : "Once someone books, they show up here."}
          />
        }
      />

      <dialog
        id="add-customer"
        className="m-auto w-full max-w-[420px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]"
      >
        <div className="flex flex-col gap-4 p-[22px]">
          <h2 className="m-0 text-[16px] font-semibold">Add {v.customerOne}</h2>
          {actionData && "error" in actionData && actionData.error && <AlertError>{actionData.error}</AlertError>}
          <Form method="post" className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input name="first_name" required autoComplete="given-name" />
              </Field>
              <Field label="Last name">
                <Input name="last_name" autoComplete="family-name" />
              </Field>
            </div>
            <Field label="Email">
              <Input type="email" name="email" required autoComplete="email" />
            </Field>
            <Field label="Phone" hint="Optional">
              <Input type="tel" name="phone" autoComplete="tel" />
            </Field>
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                className="btn-sec"
                onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
              >
                Cancel
              </button>
              <button type="submit" className="btn-pri">
                Add {v.customerOne}
              </button>
            </div>
          </Form>
        </div>
      </dialog>
    </div>
  );
}
