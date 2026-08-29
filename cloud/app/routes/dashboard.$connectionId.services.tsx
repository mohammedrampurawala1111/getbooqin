import { Form } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.services";
import { Data, Settings, ShopifyAdmin, decryptCredentials } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, PageHeader, DataTable, EmptyState, Badge } from "~/components/ui";

export const meta: Route.MetaFunction = () => [{ title: "Services · GetBooqin" }];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform, connection } = await requireTenant(request, params.connectionId);
  const [services, settings] = await Promise.all([
    Data.catalogServices(shop, platform, false),
    Settings.getSettings(shop, platform),
  ]);
  return { services, platform, connectionId: connection.id, currencySymbol: settings.currency_symbol };
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
  const { services, platform, currencySymbol } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        title="Services"
        subtitle={
          platform === "shopify"
            ? "Name, price, and description come from the connected store's product catalog. Click a service to configure booking settings only."
            : "Add and edit the services you offer, or configure booking settings for an existing one."
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
              + New service
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
          <Badge status={s.status ? "confirmed" : "cancelled"} label={s.status ? "Active" : "Inactive"} />,
          <span className="text-faint">›</span>,
        ]}
        mobileCard={(s) => (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{s.name || `Service #${s.id}`}</span>
              <span className="num shrink-0">{s.price > 0 ? `${currencySymbol}${s.price.toFixed(2)}` : "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="num text-muted">{s.durationMin} min</span>
              <Badge status={s.status ? "confirmed" : "cancelled"} label={s.status ? "Active" : "Inactive"} />
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
            title="No services yet"
            body={
              platform === "shopify"
                ? 'Sync products, then a product typed "Service" becomes bookable automatically.'
                : "Add your first service to start taking bookings."
            }
            action={
              platform !== "shopify" ? (
                <a href={`${base}/services/new`} className="btn-pri no-underline hover:no-underline">
                  + New service
                </a>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}
