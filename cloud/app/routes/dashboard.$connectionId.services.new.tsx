import { randomUUID } from "node:crypto";
import { Form, redirect } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.services.new";
import { Data } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Field, Input } from "~/components/ui";

// Only reachable for a manual (non-Shopify) connection — Shopify's catalogue
// is the source of truth for that platform (see services.tsx's "Sync
// products from Shopify" action), so creating a service there directly
// would drift from the store's real product list. A manual connection has
// no such external catalogue, so this is that catalogue: it writes a
// ProductCache row (name/price/description — normally a read-through
// Shopify cache) directly, the same shape syncProductsFromShopify would
// have produced, then a ServiceConfig pointing at it.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { platform } = await requireTenant(request, params.connectionId);
  if (platform !== "manual") throw redirect(`/dashboard/${params.connectionId}/services`);
  return null;
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  if (platform !== "manual") throw redirect(`/dashboard/${params.connectionId}/services`);

  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) {
    return { error: "Enter a name for this service." };
  }

  const productId = randomUUID();
  const productHandle = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service"}-${productId.slice(0, 8)}`;

  await Data.upsertProductCache(shop, platform, {
    productId,
    productHandle,
    title,
    description: String(form.get("description") ?? ""),
    category: String(form.get("category") ?? ""),
    price: Number(form.get("price") ?? 0),
  });

  const saved = await Data.saveServiceConfig(shop, platform, {
    product_id: productId,
    product_handle: productHandle,
    duration_min: Number(form.get("duration_min") ?? 30),
  });

  throw redirect(`/dashboard/${params.connectionId}/services/${saved.id}`);
}

export default function NewService({ actionData, params }: Route.ComponentProps) {
  const base = `/dashboard/${params.connectionId}`;
  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/services`} className="btn-link">&larr; All services</a>
      </div>
      <h1 className="page-title">New service</h1>
      {actionData?.error && <AlertError>{actionData.error}</AlertError>}

      <Form method="post" className="card">
        <div className="card-body grid grid-cols-2 gap-x-4 gap-y-[14px]">
          <div className="col-span-2">
            <Field label="Name">
              <Input name="title" placeholder="e.g. Cut & finish" required />
            </Field>
          </div>
          <Field label="Price">
            <Input type="number" name="price" min={0} step="0.01" defaultValue={0} />
          </Field>
          <Field label="Duration (minutes)">
            <Input type="number" name="duration_min" min={5} defaultValue={30} />
          </Field>
          <Field label="Category" hint="Optional — shown alongside the service.">
            <Input name="category" />
          </Field>
          <div className="col-span-2">
            <Field label="Description" hint="Optional.">
              <textarea name="description" rows={3} className="input" />
            </Field>
          </div>
        </div>
        <div className="card-footer">
          <button type="submit" className="btn-pri ml-auto">Create service</button>
        </div>
      </Form>
    </div>
  );
}
