import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Same namespace/keys app/lib/serviceMetafields.server.ts writes and reads —
// duplicated here (not imported) because this extension bundles in an
// isolated sandbox with no access to the app's server-only code; it talks to
// Shopify directly via the shopify:admin/api/graphql.json fetch below, never
// through the app backend, for the metafield read/write itself.
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

// Admin extensions talk to Shopify's Admin API directly through this
// sandboxed URL — no auth header needed, the runtime signs it. See
// shopify.auth.idToken() below for the *app's own* backend instead.
async function adminQuery<T>(query: string, variables: Record<string, unknown>): Promise<{ data?: T }> {
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { data, auth } = shopify;
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
        const result = await adminQuery<{
          product: { metafields: { nodes: { key: string; value: string }[] } } | null;
        }>(
          `#graphql
          query ServiceConfigMetafields($id: ID!, $namespace: String!) {
            product(id: $id) {
              metafields(namespace: $namespace, first: 20) { nodes { key value } }
            }
          }`,
          { id: productGid, namespace: METAFIELD_NAMESPACE }
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
  }, [productGid]);

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

      const result = await adminQuery<{ metafieldsSet: { userErrors: { field: string[]; message: string }[] } }>(
        `#graphql
        mutation SetServiceConfigMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        { metafields }
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
      <s-admin-block heading="Booking config">
        <s-text>Loading…</s-text>
      </s-admin-block>
    );
  }

  return (
    <s-admin-block
      heading="Booking config"
      collapsed-summary={`${durationMin} min · ${status ? "Active" : "Inactive"}`}
    >
      <s-stack direction="block" gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}
        {saved && <s-banner tone="success">Saved — synced with GetBooqin.</s-banner>}

        <s-number-field
          label="Duration (minutes)"
          value={String(durationMin)}
          min={5}
          onChange={(e: Event) => setDurationMin(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <s-stack direction="inline" gap="base">
          <s-number-field
            label="Buffer before (minutes)"
            value={String(bufferBeforeMin)}
            min={0}
            onChange={(e: Event) => setBufferBeforeMin(Number((e.currentTarget as HTMLInputElement).value))}
          />
          <s-number-field
            label="Buffer after (minutes)"
            value={String(bufferAfterMin)}
            min={0}
            onChange={(e: Event) => setBufferAfterMin(Number((e.currentTarget as HTMLInputElement).value))}
          />
        </s-stack>
        <s-number-field
          label="Capacity"
          value={String(capacity)}
          min={1}
          onChange={(e: Event) => setCapacity(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <s-select
          label="Location"
          value={locationType}
          onChange={(e: Event) => setLocationType((e.currentTarget as HTMLSelectElement).value)}
        >
          <s-option value="onsite">On site</s-option>
          <s-option value="video">Video call</s-option>
          <s-option value="phone">Phone</s-option>
        </s-select>
        <s-checkbox
          label="Payment required to hold the booking"
          checked={paymentRequired}
          onChange={(e: Event) => setPaymentRequired((e.currentTarget as HTMLInputElement).checked)}
        />
        <s-number-field
          label="Deposit (% of price)"
          value={String(depositPercent)}
          min={1}
          max={100}
          onChange={(e: Event) => setDepositPercent(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <s-checkbox
          label="Active"
          checked={status}
          onChange={(e: Event) => setStatus((e.currentTarget as HTMLInputElement).checked)}
        />

        {resourceOptions.length > 0 && (
          <s-choice-list
            label="Who can deliver this"
            name="resource_ids"
            multiple
            values={resourceIds}
            onChange={(e: Event) => setResourceIds((e.currentTarget as unknown as { values: string[] }).values)}
          >
            {resourceOptions.map((r) => (
              <s-choice key={r.id} value={String(r.id)}>{r.name}</s-choice>
            ))}
          </s-choice-list>
        )}
        {addonOptions.length > 0 && (
          <s-choice-list
            label="Add-ons offered"
            name="addon_ids"
            multiple
            values={addonIds}
            onChange={(e: Event) => setAddonIds((e.currentTarget as unknown as { values: string[] }).values)}
          >
            {addonOptions.map((a) => (
              <s-choice key={a.id} value={String(a.id)}>{a.name}</s-choice>
            ))}
          </s-choice-list>
        )}

        <s-button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </s-button>
      </s-stack>
    </s-admin-block>
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
