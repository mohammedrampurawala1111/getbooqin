import { Form } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.services";
import { Data, Settings, ShopifyAdmin, decryptCredentials } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, DataTable, EmptyState, Badge } from "~/components/ui";
import { useVocabulary, vocabFor } from "~/lib/presets";
import { dashboardPreset } from "~/lib/dashboardMeta";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: `${vocabFor(dashboardPreset(matches)).services} · GetBooqin` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform, connection } = await requireTenant(request, params.connectionId);
  const [services, settings, unbookableIds] = await Promise.all([
    Data.catalogServices(shop, platform, false),
    Settings.getSettings(shop, platform),
    Data.unbookableServiceIds(shop, platform),
  ]);
  return {
    services,
    platform,
    connectionId: connection.id,
    currencySymbol: settings.currency_symbol,
    unbookableIds: Array.from(unbookableIds),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform, connection } = await requireTenant(request, params.connectionId);

  if (platform !== "shopify") {
    return { error: "Product sync is only available for Shopify stores." };
  }

  try {
    const accessToken = decryptCredentials(connection.credentials);
    const result = await ShopifyAdmin.syncProductsFromShopify(shop, platform, accessToken);
    return { synced: result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Sync failed." };
  }
}

export default function ServicesList({ loaderData, actionData, params }: Route.ComponentProps) {
  const { services, platform, currencySymbol, unbookableIds } = loaderData;
  const unbookable = new Set(unbookableIds);
  const base = `/dashboard/${params.connectionId}`;
  const v = useVocabulary();

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title={v.services}
        subtitle={
          platform === "shopify"
            ? "Name, price, and description come from the connected store's product catalog. Click a service to configure booking settings only."
            : `Add and edit the ${v.services.toLowerCase()} you offer, or configure booking settings for an existing one.`
        }
        actions={
          platform === "shopify" ? (
            <Form method="post">
              <button type="submit" className="btn-sec">
                Sync products from Shopify
              </button>
            </Form>
          ) : (
            <a href={`${base}/services/new`} className="btn-pri no-underline hover:no-underline">
              + New {v.serviceOne}
            </a>
          )
        }
      />

      {actionData?.error && <AlertError>{actionData.error}</AlertError>}
      {actionData?.synced && (
        <div className="alert-success">
          Synced {actionData.synced.productsSynced} product{actionData.synced.productsSynced === 1 ? "" : "s"}, created{" "}
          {actionData.synced.servicesCreated} new booking config{actionData.synced.servicesCreated === 1 ? "" : "s"}.
        </div>
      )}

      <DataTable
        cols="1.6fr .7fr .8fr .9fr .7fr 28px"
        columns={["Name", "Colour", "Price", "Duration", "Status", ""]}
        rows={services}
        rowKey={(s) => String(s.id)}
        href={(s) => `${base}/services/${s.id}`}
        renderRow={(s) => [
          s.name || `Service #${s.id}`,
          <span className="inline-block h-[10px] w-6 rounded-[3px]" style={{ backgroundColor: s.color }} />,
          <span className="num">{s.price > 0 ? `${currencySymbol}${s.price.toFixed(2)}` : "—"}</span>,
          <span className="num">{s.durationMin} min</span>,
          <div className="flex flex-wrap items-center gap-[6px]">
            <Badge status={s.status ? "confirmed" : "cancelled"} label={s.status ? "Active" : "Inactive"} />
            {/* Two identically-unticked "who can deliver this" boxes used to
                behave differently with no visible difference between them
                (Defect Dossier's R2-04 finding) — this is the same signal
                as the public page's own "not bookable" fallback, surfaced
                here instead of discovered by a customer. */}
            {s.status && unbookable.has(s.id) && (
              <span className="badge-pending" title="No one is assigned to deliver this — it won't show any open times on the public page.">
                Not bookable — no one assigned
              </span>
            )}
          </div>,
          <span className="text-faint">›</span>,
        ]}
        mobileCard={(s) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{s.name || `Service #${s.id}`}</span>
              <span className="num shrink-0">{s.price > 0 ? `${currencySymbol}${s.price.toFixed(2)}` : "—"}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="num text-muted">{s.durationMin} min</span>
              <div className="flex flex-wrap items-center gap-[6px]">
                <Badge status={s.status ? "confirmed" : "cancelled"} label={s.status ? "Active" : "Inactive"} />
                {s.status && unbookable.has(s.id) && <span className="badge-pending">Not bookable</span>}
              </div>
            </div>
          </>
        )}
        empty={
          <EmptyState
            icon={
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" />
                <path d="M6 9h6M9 6v6" strokeLinecap="round" />
              </svg>
            }
            title={`No ${v.services.toLowerCase()} yet`}
            body={
              platform === "shopify"
                ? 'Sync products, then a product typed "Service" becomes bookable automatically.'
                : `Add some ${v.services.toLowerCase()} to start taking ${v.bookingMany}.`
            }
            action={
              platform !== "shopify" ? (
                <a href={`${base}/services/new`} className="btn-pri no-underline hover:no-underline">
                  + New {v.serviceOne}
                </a>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}
