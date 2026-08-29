import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useSubmit, Form } from "react-router";
import { Page, Card, BlockStack, FormLayout, TextField, Checkbox, Button, InlineStack } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await Settings.getSettings(shop, "shopify");
  const isNew = params.id === "new";
  const addon = isNew ? null : await Data.addon(shop, Number(params.id));

  return { settings, addon, isNew };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  if (form.get("_action") === "delete") {
    await Data.deleteAddon(shop, Number(params.id));
    return redirect("/app/addons");
  }

  const id = params.id === "new" ? 0 : Number(params.id);

  await Data.saveAddon(
    shop,
    "shopify",
    {
      name: String(form.get("name") || ""),
      description: String(form.get("description") || ""),
      price: Number(form.get("price") || 0),
      duration_min: Number(form.get("duration_min") || 0),
      status: form.get("status") === "true",
    },
    id
  );

  return redirect("/app/addons");
}

export default function AddonForm() {
  const { settings, addon, isNew } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [name, setName] = useState(addon?.name ?? "");
  const [description, setDescription] = useState(addon?.description ?? "");
  const [price, setPrice] = useState(String(addon?.price ?? 0));
  const [durationMin, setDurationMin] = useState(String(addon?.durationMin ?? 0));
  const [status, setStatus] = useState(addon?.status ?? true);

  function handleSubmit() {
    const form = new FormData();
    form.set("name", name);
    form.set("description", description);
    form.set("price", price);
    form.set("duration_min", durationMin);
    form.set("status", String(status));
    submit(form, { method: "post" });
  }

  return (
    <Page
      title={isNew ? "Add add-on" : name}
      backAction={{ content: "Add-ons", onAction: () => navigate("/app/addons") }}
      primaryAction={{ content: "Save", onAction: handleSubmit }}
      secondaryActions={
        isNew
          ? []
          : [
              {
                content: "Delete",
                destructive: true,
                onAction: () => {
                  const form = new FormData();
                  form.set("_action", "delete");
                  submit(form, { method: "post" });
                },
              },
            ]
      }
    >
      <Form method="post">
        <BlockStack gap="400">
          <Card>
            <FormLayout>
              <TextField label="Name" value={name} onChange={setName} autoComplete="off" requiredIndicator />
              <TextField label="Description" value={description} onChange={setDescription} multiline={2} autoComplete="off" />
              <FormLayout.Group>
                <TextField label={`Price (${settings.currency})`} type="number" value={price} onChange={setPrice} autoComplete="off" />
                <TextField
                  label="Extra time (minutes)"
                  type="number"
                  value={durationMin}
                  onChange={setDurationMin}
                  autoComplete="off"
                  helpText="Added on top of the service's own duration when this add-on is selected."
                />
              </FormLayout.Group>
              <Checkbox label="Active" checked={status} onChange={setStatus} />
            </FormLayout>
          </Card>

          <InlineStack align="end">
            <Button variant="primary" onClick={handleSubmit}>Save</Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}
