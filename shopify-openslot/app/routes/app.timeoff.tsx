import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { Page, Card, IndexTable, Button, BlockStack, FormLayout, TextField, Select, InlineStack } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { term, money } from "getbooqin-core/booking/settingsShared";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const [rows, resources] = await Promise.all([Data.timeoff(shop), Data.resources(shop, "shopify", true)]);
  return {
    settings,
    resources,
    rows: rows.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      startUtc: r.startUtc.toISOString(),
      endUtc: r.endUtc.toISOString(),
      reason: r.reason,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteTimeoff(shop, Number(form.get("id")));
    return { ok: true };
  }

  const resourceId = Number(form.get("resource_id") || 0);
  const start = new Date(String(form.get("start")));
  const end = new Date(String(form.get("end")));
  const reason = String(form.get("reason") || "");

  if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start) {
    await Data.addTimeoff(shop, resourceId, start, end, reason);
  }
  return { ok: true };
}

export default function TimeOff() {
  const { settings, resources, rows } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const [resourceId, setResourceId] = useState("0");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");

  function handleAdd() {
    const form = new FormData();
    form.set("resource_id", resourceId);
    form.set("start", start);
    form.set("end", end);
    form.set("reason", reason);
    submit(form, { method: "post" });
    setStart("");
    setEnd("");
    setReason("");
  }

  const resourceName = (id: number) =>
    id === 0 ? "Whole business" : resources.find((r) => r.id === id)?.name ?? `#${id}`;

  return (
    <Page title="Time Off">
      <BlockStack gap="400">
        <Card>
          <FormLayout>
            <Select
              label={term(settings, "resource_single")}
              value={resourceId}
              onChange={setResourceId}
              options={[{ label: "Whole business", value: "0" }, ...resources.map((r) => ({ label: r.name, value: String(r.id) }))]}
            />
            <FormLayout.Group>
              <TextField label="Starts" type="datetime-local" value={start} onChange={setStart} autoComplete="off" />
              <TextField label="Ends" type="datetime-local" value={end} onChange={setEnd} autoComplete="off" />
            </FormLayout.Group>
            <TextField label="Reason" value={reason} onChange={setReason} autoComplete="off" />
            <InlineStack align="end">
              <Button variant="primary" onClick={handleAdd} disabled={!start || !end}>Add time off</Button>
            </InlineStack>
          </FormLayout>
        </Card>

        <Card padding="0">
          <IndexTable
            resourceName={{ singular: "block", plural: "blocks" }}
            itemCount={rows.length}
            selectable={false}
            headings={[{ title: "Applies to" }, { title: "From" }, { title: "To" }, { title: "Reason" }, { title: "" }]}
          >
            {rows.map((row, index) => (
              <IndexTable.Row id={String(row.id)} key={row.id} position={index}>
                <IndexTable.Cell>{resourceName(row.resourceId)}</IndexTable.Cell>
                <IndexTable.Cell>{new Date(row.startUtc).toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>{new Date(row.endUtc).toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>{row.reason}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Button
                    size="slim"
                    tone="critical"
                    onClick={() => {
                      const form = new FormData();
                      form.set("_action", "delete");
                      form.set("id", String(row.id));
                      submit(form, { method: "post" });
                    }}
                  >
                    Remove
                  </Button>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}
