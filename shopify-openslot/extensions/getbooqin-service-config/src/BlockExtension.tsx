import { useEffect, useState } from "react";
import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Text,
  NumberField,
  Select,
  Checkbox,
  ChoiceList,
  Banner,
  Button,
} from "@shopify/ui-extensions-react/admin";

const TARGET = "admin.product-details.block.render";

// Same namespace/keys app/lib/serviceMetafields.server.ts writes and reads —
// duplicated here (not imported) because this extension bundles in an
// isolated sandbox with no access to the app's server-only code; it talks to
// Shopify directly via useApi().query, never through the app backend, for
// the metafield read/write itself.
const METAFIELD_NAMESPACE = "getbooqin";

// Must match shopify.app.production.toml's application_url — this extension
// calls the app's own /api/resources-addons endpoint (app/routes/
// api.resources-addons.tsx) to list GetBooqin's Resource/Addon registries,
// which exist only in GetBooqin's database, not Shopify.
const APP_URL = "https://getbooqin.fly.dev";

interface PickerOption {
  id: number;
  name: string;
}

export default reactExtension(TARGET, () => <App />);

function App() {
  const { data, query, auth } = useApi(TARGET);
  const productGid = data.selected[0]?.id ?? "";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const [durationMin, setDurationMin] = useState(30);
  const [bufferBeforeMin, setBufferBeforeMin] = useState(0);
  const [bufferAfterMin, setBufferAfterMin] = useState(0);
  const [capacity, setCapacity] = useState(1);
  const [locationType, setLocationType] = useState("onsite");
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [depositPercent, setDepositPercent] = useState(100);
  const [status, setStatus] = useState(true);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [resourceOptions, setResourceOptions] = useState<PickerOption[]>([]);
  const [addonOptions, setAddonOptions] = useState<PickerOption[]>([]);

  useEffect(() => {
    if (!productGid) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await query<{
          product: { metafields: { nodes: { key: string; value: string }[] } } | null;
        }>(
          `#graphql
          query ServiceConfigMetafields($id: ID!, $namespace: String!) {
            product(id: $id) {
              metafields(namespace: $namespace, first: 20) { nodes { key value } }
            }
          }`,
          { variables: { id: productGid, namespace: METAFIELD_NAMESPACE } }
        );
        if (cancelled) return;

        const nodes = result.data?.product?.metafields?.nodes ?? [];
        const byKey = new Map(nodes.map((n) => [n.key, n.value]));
        if (byKey.has("duration_min")) setDurationMin(Number(byKey.get("duration_min")));
        if (byKey.has("buffer_before_min")) setBufferBeforeMin(Number(byKey.get("buffer_before_min")));
        if (byKey.has("buffer_after_min")) setBufferAfterMin(Number(byKey.get("buffer_after_min")));
        if (byKey.has("capacity")) setCapacity(Number(byKey.get("capacity")));
        if (byKey.has("location_type")) setLocationType(String(byKey.get("location_type")));
        if (byKey.has("payment_required")) setPaymentRequired(byKey.get("payment_required") === "true");
        if (byKey.has("deposit_percent")) setDepositPercent(Number(byKey.get("deposit_percent")));
        if (byKey.has("status")) setStatus(byKey.get("status") === "true");
        if (byKey.has("resource_ids")) setResourceIds(safeParseIds(byKey.get("resource_ids")));
        if (byKey.has("addon_ids")) setAddonIds(safeParseIds(byKey.get("addon_ids")));
      } catch {
        if (!cancelled) setError("Could not load booking config.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [productGid, query]);

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      try {
        const token = await auth.idToken();
        const response = await fetch(`${APP_URL}/api/resources-addons`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body: { resources?: PickerOption[]; addons?: PickerOption[] } = await response.json();
        if (cancelled) return;
        setResourceOptions(body.resources ?? []);
        setAddonOptions(body.addons ?? []);
      } catch {
        // Non-fatal — the pickers just render empty; the rest of the form still works.
      }
    }

    loadOptions();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // ChoiceList's onChange is typed (value: string | string[]) => void
  // regardless of `multiple` — normalize to an array either way.
  function handleResourceIdsChange(value: string | string[]) {
    setResourceIds(Array.isArray(value) ? value : [value]);
  }
  function handleAddonIdsChange(value: string | string[]) {
    setAddonIds(Array.isArray(value) ? value : [value]);
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const metafields = [
        { key: "duration_min", type: "number_integer", value: String(durationMin) },
        { key: "buffer_before_min", type: "number_integer", value: String(bufferBeforeMin) },
        { key: "buffer_after_min", type: "number_integer", value: String(bufferAfterMin) },
        { key: "capacity", type: "number_integer", value: String(capacity) },
        { key: "location_type", type: "single_line_text_field", value: locationType },
        { key: "payment_required", type: "boolean", value: String(paymentRequired) },
        { key: "deposit_percent", type: "number_integer", value: String(depositPercent) },
        { key: "status", type: "boolean", value: String(status) },
        { key: "resource_ids", type: "json", value: JSON.stringify(resourceIds.map(Number)) },
        { key: "addon_ids", type: "json", value: JSON.stringify(addonIds.map(Number)) },
      ].map((m) => ({ ownerId: productGid, namespace: METAFIELD_NAMESPACE, ...m }));

      const result = await query<{ metafieldsSet: { userErrors: { field: string[]; message: string }[] } }>(
        `#graphql
        mutation SetServiceConfigMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        { variables: { metafields } }
      );

      const userErrors = result.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        setError(userErrors.map((e) => e.message).join("; "));
      } else {
        setSaved(true);
      }
    } catch {
      setError("Save failed — try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminBlock title="Booking config">
        <Text>Loading…</Text>
      </AdminBlock>
    );
  }

  return (
    <AdminBlock title="Booking config" collapsedSummary={`${durationMin} min · ${status ? "Active" : "Inactive"}`}>
      <BlockStack>
        {error && <Banner tone="critical" title={error} />}
        {saved && <Banner tone="success" title="Saved — synced with GetBooqin." />}

        <NumberField label="Duration (minutes)" value={durationMin} onChange={setDurationMin} min={5} />
        <InlineStack>
          <NumberField label="Buffer before (minutes)" value={bufferBeforeMin} onChange={setBufferBeforeMin} min={0} />
          <NumberField label="Buffer after (minutes)" value={bufferAfterMin} onChange={setBufferAfterMin} min={0} />
        </InlineStack>
        <NumberField label="Capacity" value={capacity} onChange={setCapacity} min={1} />
        <Select
          label="Location"
          value={locationType}
          onChange={setLocationType}
          options={[
            { value: "onsite", label: "On site" },
            { value: "video", label: "Video call" },
            { value: "phone", label: "Phone" },
          ]}
        />
        <Checkbox checked={paymentRequired} onChange={setPaymentRequired} label="Payment required to hold the booking" />
        <NumberField label="Deposit (% of price)" value={depositPercent} onChange={setDepositPercent} min={1} max={100} />
        <Checkbox checked={status} onChange={setStatus} label="Active" />

        {resourceOptions.length > 0 && (
          <BlockStack>
            <Text fontWeight="bold">Who can deliver this</Text>
            <ChoiceList
              multiple
              value={resourceIds}
              onChange={handleResourceIdsChange}
              choices={resourceOptions.map((r) => ({ id: String(r.id), label: r.name }))}
            />
          </BlockStack>
        )}
        {addonOptions.length > 0 && (
          <BlockStack>
            <Text fontWeight="bold">Add-ons offered</Text>
            <ChoiceList
              multiple
              value={addonIds}
              onChange={handleAddonIdsChange}
              choices={addonOptions.map((a) => ({ id: String(a.id), label: a.name }))}
            />
          </BlockStack>
        )}

        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}

function safeParseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
