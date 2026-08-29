import { useLoaderData, useNavigate } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { Page, IndexTable, Card, Badge, Text, EmptyState, useIndexResourceState } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const resources = await Data.resources(shop, "shopify", false);
  return { settings, resources };
}

export default function ResourcesList() {
  const { settings, resources } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    resources as unknown as { [key: string]: unknown }[]
  );

  return (
    <Page
      title={term(settings, "resource_plural")}
      primaryAction={{ content: `Add ${term(settings, "resource_single").toLowerCase()}`, onAction: () => navigate("/app/resources/new") }}
    >
      <Card padding="0">
        {resources.length === 0 ? (
          <EmptyState
            heading={`No ${term(settings, "resource_plural").toLowerCase()} yet`}
            action={{ content: `Add ${term(settings, "resource_single").toLowerCase()}`, onAction: () => navigate("/app/resources/new") }}
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>A {term(settings, "resource_single").toLowerCase()} is whoever (or whatever) gets booked.</p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: term(settings, "resource_single"), plural: term(settings, "resource_plural") }}
            itemCount={resources.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            headings={[{ title: "Name" }, { title: "Title" }, { title: "Email" }, { title: "Status" }]}
          >
            {resources.map((resource, index) => (
              <IndexTable.Row
                id={String(resource.id)}
                key={resource.id}
                position={index}
                selected={selectedResources.includes(String(resource.id))}
                onClick={() => navigate(`/app/resources/${resource.id}`)}
              >
                <IndexTable.Cell>
                  <Text as="span" fontWeight="semibold">{resource.name}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{resource.title}</IndexTable.Cell>
                <IndexTable.Cell>{resource.email}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={resource.status ? "success" : undefined}>{resource.status ? "Active" : "Inactive"}</Badge>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
