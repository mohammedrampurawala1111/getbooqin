import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { Page, IndexTable, Card, Badge, Text, EmptyState, useIndexResourceState } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const addons = await Data.addons(shop, "shopify", false);
  return { settings, addons };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const id = Number(form.get("id"));

  if (form.get("_action") === "delete" && id) {
    await Data.deleteAddon(shop, id);
  }
  return { ok: true };
}

export default function AddonsList() {
  const { settings, addons } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    addons as unknown as { [key: string]: unknown }[]
  );

  return (
    <Page
      title="Add-ons"
      primaryAction={{ content: "Add add-on", onAction: () => navigate("/app/addons/new") }}
    >
      <Card padding="0">
        {addons.length === 0 ? (
          <EmptyState
            heading="No add-ons yet"
            action={{ content: "Add add-on", onAction: () => navigate("/app/addons/new") }}
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>Add-ons are optional extras a customer can attach to a service at booking time — extra time, a bundled product, anything with a price. Attach them to services from that service's edit page.</p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: "add-on", plural: "add-ons" }}
            itemCount={addons.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            headings={[
              { title: "Name" },
              { title: "Price" },
              { title: "Extra time" },
              { title: "Status" },
            ]}
          >
            {addons.map((addon, index) => (
              <IndexTable.Row
                id={String(addon.id)}
                key={addon.id}
                position={index}
                selected={selectedResources.includes(String(addon.id))}
                onClick={() => navigate(`/app/addons/${addon.id}`)}
              >
                <IndexTable.Cell>
                  <Text as="span" fontWeight="semibold">{addon.name}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{addon.price > 0 ? money(settings, addon.price) : "Free"}</IndexTable.Cell>
                <IndexTable.Cell>{addon.durationMin > 0 ? `${addon.durationMin} min` : "—"}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={addon.status ? "success" : undefined}>{addon.status ? "Active" : "Inactive"}</Badge>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
