import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useActionData } from "react-router";
import { Page, IndexTable, Card, Badge, Text, EmptyState, InlineStack, Banner, useIndexResourceState } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";
import { syncAllProductsFromShopify } from "~/lib/productSync.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const services = await Data.catalogServices(shop, "shopify", false);
  return { settings, services };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const actionType = form.get("_action");

  if (actionType === "delete") {
    const id = Number(form.get("id"));
    if (id) await Data.deleteServiceConfig(shop, id);
    return { ok: true };
  }

  if (actionType === "bulk_delete") {
    let ids: number[] = [];
    try {
      ids = JSON.parse(String(form.get("ids") || "[]"));
    } catch {
      ids = [];
    }
    let deleted = 0;
    for (const id of ids) {
      if (await Data.deleteServiceConfig(shop, id)) deleted += 1;
    }
    return { ok: true, deleted };
  }

  if (actionType === "sync_all_products") {
    const result = await syncAllProductsFromShopify(admin, shop);
    return { ok: true, synced: result };
  }

  if (actionType === "create_from_products") {
    let products: { id: string; handle: string; title?: string }[] = [];
    try {
      products = JSON.parse(String(form.get("products") || "[]"));
    } catch {
      products = [];
    }
    // createServiceConfigsFromProducts only writes ServiceConfig — name/price
    // are joined from ProductCache (see data.ts's header comment), so without
    // this upsert every service created here shows a blank name/"Free" price
    // until a full "Sync products" happens to run later.
    for (const product of products) {
      await Data.upsertProductCache(shop, "shopify", {
        productId: product.id,
        productHandle: product.handle,
        title: product.title ?? "",
      });
    }
    const { created, skipped } = await Data.createServiceConfigsFromProducts(shop, "shopify", products);
    return { ok: true, created: created.length, skipped };
  }

  return { ok: true };
}

export default function ServicesList() {
  const { settings, services } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(
    services as unknown as { [key: string]: unknown }[]
  );

  async function createFromProducts() {
    const shopify = (window as any).shopify;
    if (!shopify?.resourcePicker) return;
    const selected = await shopify.resourcePicker({ type: "product", multiple: true });
    if (!selected || !selected.length) return;

    const products = selected.map((p: any) => ({
      id: String(p.id).split("/").pop() ?? "",
      handle: p.handle ?? "",
      title: p.title ?? "",
    }));

    const form = new FormData();
    form.set("_action", "create_from_products");
    form.set("products", JSON.stringify(products));
    submit(form, { method: "post" });
  }

  function syncAllProducts() {
    const form = new FormData();
    form.set("_action", "sync_all_products");
    submit(form, { method: "post" });
  }

  function deleteSelected() {
    const label = term(settings, selectedResources.length === 1 ? "service_single" : "service_plural").toLowerCase();
    if (!window.confirm(`Delete ${selectedResources.length} ${label}? This can't be undone.`)) return;
    const form = new FormData();
    form.set("_action", "bulk_delete");
    form.set("ids", JSON.stringify(selectedResources.map(Number)));
    submit(form, { method: "post" });
    clearSelection();
  }

  return (
    <Page
      title={term(settings, "service_plural")}
      primaryAction={{ content: `Add ${term(settings, "service_single").toLowerCase()}`, onAction: () => navigate("/app/services/new") }}
      secondaryActions={[
        { content: "Create from products", onAction: createFromProducts },
        { content: "Sync all products", onAction: syncAllProducts },
      ]}
    >
      {actionData?.created !== undefined && actionData.created > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <Banner tone="success" title={`Created ${actionData.created} service${actionData.created === 1 ? "" : "s"} from products`}>
            <p>
              Duration defaults to 30 minutes on each — open a service to adjust duration, buffers, or which staff can deliver it.
              {actionData.skipped && actionData.skipped.length > 0
                ? ` Skipped (already configured): ${actionData.skipped.join(", ")}.`
                : ""}
            </p>
          </Banner>
        </div>
      )}
      {actionData?.synced && (
        <div style={{ marginBottom: "1rem" }}>
          <Banner tone="success" title="Synced products from Shopify">
            <p>
              {actionData.synced.productsSynced} product{actionData.synced.productsSynced === 1 ? "" : "s"} synced, created{" "}
              {actionData.synced.servicesCreated} new service{actionData.synced.servicesCreated === 1 ? "" : "s"}.
            </p>
          </Banner>
        </div>
      )}
      {actionData?.deleted !== undefined && (
        <div style={{ marginBottom: "1rem" }}>
          <Banner tone="success" title={`Deleted ${actionData.deleted} service${actionData.deleted === 1 ? "" : "s"}`} />
        </div>
      )}

      <Card padding="0">
        {services.length === 0 ? (
          <EmptyState
            heading={`No ${term(settings, "service_plural").toLowerCase()} yet`}
            action={{ content: `Add ${term(settings, "service_single").toLowerCase()}`, onAction: () => navigate("/app/services/new") }}
            secondaryAction={{ content: "Create from products", onAction: createFromProducts }}
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>Services define duration, price and buffers. A resource delivers a service to a customer. Already have products for your services? Use "Create from products" instead of filling this in by hand.</p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: term(settings, "service_single"), plural: term(settings, "service_plural") }}
            itemCount={services.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            promotedBulkActions={[{ content: "Delete", onAction: deleteSelected }]}
            headings={[
              { title: "Name" },
              { title: "Duration" },
              { title: "Price" },
              { title: "Location" },
              { title: "Status" },
            ]}
          >
            {services.map((service, index) => (
              <IndexTable.Row
                id={String(service.id)}
                key={service.id}
                position={index}
                selected={selectedResources.includes(String(service.id))}
                onClick={() => navigate(`/app/services/${service.id}`)}
              >
                <IndexTable.Cell>
                  <InlineStack gap="200" blockAlign="center">
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: service.color, display: "inline-block" }} />
                    <Text as="span" fontWeight="semibold">{service.name}</Text>
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>{service.durationMin} min</IndexTable.Cell>
                <IndexTable.Cell>{service.price > 0 ? money(settings, service.price) : "Free"}</IndexTable.Cell>
                <IndexTable.Cell>{service.locationType}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={service.status ? "success" : undefined}>{service.status ? "Active" : "Inactive"}</Badge>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
