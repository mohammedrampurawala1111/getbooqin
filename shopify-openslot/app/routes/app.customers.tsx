import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { Page, Card, IndexTable, TextField, Text } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const rows = await Data.customers(shop, "shopify", search, 100, 0);
  return { settings, rows };
}

export default function Customers() {
  const { settings, rows } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <Page title={term(settings, "customer_plural")}>
      <Card>
        <TextField
          label="Search"
          labelHidden
          placeholder="Search by name, email or phone"
          value={searchParams.get("q") || ""}
          onChange={(value) =>
            setSearchParams((prev) => {
              const p = new URLSearchParams(prev);
              value ? p.set("q", value) : p.delete("q");
              return p;
            })
          }
          autoComplete="off"
        />
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card padding="0">
          <IndexTable
            resourceName={{ singular: term(settings, "customer_single"), plural: term(settings, "customer_plural") }}
            itemCount={rows.length}
            selectable={false}
            headings={[{ title: "Name" }, { title: "Email" }, { title: "Phone" }]}
          >
            {rows.map((c, index) => (
              <IndexTable.Row id={String(c.id)} key={c.id} position={index}>
                <IndexTable.Cell>
                  <Text as="span" fontWeight="semibold">{`${c.firstName} ${c.lastName}`.trim() || "—"}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{c.email}</IndexTable.Cell>
                <IndexTable.Cell>{c.phone}</IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </div>
    </Page>
  );
}
