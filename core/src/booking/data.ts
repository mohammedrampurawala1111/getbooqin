/**
 * Repository layer. Ported from shopify-openslot/app/lib/data.server.ts —
 * same shape and logic, adapted at two points: (1) Prisma resolves against
 * core's own client/database instead of shopify-openslot's, and (2) every
 * function gains an explicit `platform` parameter (defaulting to "shopify")
 * since core is designed to serve more than one platform's tenants from a
 * single database, where shopify-openslot only ever had one.
 *
 * `ServiceConfig` owns booking config only — name/price/category/description
 * live on the platform's product and are only ever cached (read-only) in
 * `ProductCache`, refreshed by src/platforms/shopifyAdmin.ts's product sync.
 * `catalogService`/`catalogServices` join the two and return a
 * `CatalogService` shaped exactly like shopify-openslot's compatibility
 * accessor of the same name, so UI code reads identically either side.
 */
import prisma from "../db.js";
import type { Resource, ServiceConfig, ProductCache } from "@prisma/client";
import type { ServiceConfigFields } from "./serviceMetafields.js";
import { GetBooqinError } from "./errors.js";

/* ------------------------------------------------------------- Services */

export interface CatalogService {
  id: number;
  shop: string;
  platform: string;
  name: string;
  category: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  capacity: number;
  price: number;
  locationType: string;
  paymentRequired: boolean;
  depositPercent: number;
  color: string;
  position: number;
  status: boolean;
  productId: string;
  productHandle: string;
}

function mergeCatalog(config: ServiceConfig, product: ProductCache | null): CatalogService {
  return {
    id: config.id,
    shop: config.shop,
    platform: config.platform,
    name: product?.title ?? "",
    category: product?.category ?? "",
    description: product?.description ?? "",
    durationMin: config.durationMin,
    bufferBeforeMin: config.bufferBeforeMin,
    bufferAfterMin: config.bufferAfterMin,
    capacity: config.capacity,
    price: product?.price ?? 0,
    locationType: config.locationType,
    paymentRequired: config.paymentRequired,
    depositPercent: config.depositPercent,
    color: config.color,
    position: config.position,
    status: config.status,
    productId: config.productId,
    productHandle: config.productHandle,
  };
}

export async function catalogServices(shop: string, platform = "shopify", onlyActive = true): Promise<CatalogService[]> {
  const configs = await prisma.serviceConfig.findMany({
    where: { shop, platform, ...(onlyActive ? { status: true } : {}) },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  if (configs.length === 0) return [];

  const products = await prisma.productCache.findMany({
    where: { shop, platform, productId: { in: configs.map((c) => c.productId) } },
  });
  const byProductId = new Map(products.map((p) => [p.productId, p]));
  return configs.map((c) => mergeCatalog(c, byProductId.get(c.productId) ?? null));
}

export async function catalogService(shop: string, id: number): Promise<CatalogService | null> {
  const config = await prisma.serviceConfig.findFirst({ where: { shop, id } });
  if (!config) return null;
  const product = await prisma.productCache.findFirst({
    where: { shop, platform: config.platform, productId: config.productId },
  });
  return mergeCatalog(config, product);
}

/** The service config linked to a platform product, if any — keyed on the
 * product handle (the storefront-facing lookup). */
export async function serviceByProductHandle(shop: string, platform: string, productHandle: string): Promise<CatalogService | null> {
  const config = await prisma.serviceConfig.findFirst({ where: { shop, platform, productHandle, status: true } });
  if (!config) return null;
  const product = await prisma.productCache.findFirst({
    where: { shop, platform: config.platform, productId: config.productId },
  });
  return mergeCatalog(config, product);
}

export function serviceConfig(shop: string, id: number) {
  return prisma.serviceConfig.findFirst({ where: { shop, id } });
}

export interface ServiceConfigInput {
  product_id: string;
  product_handle: string;
  duration_min: number;
  buffer_before_min?: number;
  buffer_after_min?: number;
  capacity?: number;
  location_type?: "onsite" | "video" | "phone";
  payment_required?: boolean;
  deposit_percent?: number;
  color?: string;
  position?: number;
  status?: boolean;
  resource_ids?: number[];
  addon_ids?: number[];
}

export async function saveServiceConfig(shop: string, platform: string, data: ServiceConfigInput, id = 0) {
  // Duration silently floored to a 5-minute minimum used to also mean a
  // missing/zero value quietly became "5 minutes" instead of failing — five
  // real services ended up wrong at once (auto-sync's 30-minute default,
  // see createServiceConfigsFromProducts) because nothing forced a real
  // value in. A wrong duration means every slot's end_utc is wrong too,
  // which is exactly what lets two customers get booked into one chair.
  if (!Number.isFinite(data.duration_min) || data.duration_min < 5) {
    throw new GetBooqinError(
      "getbooqin_invalid_duration",
      "Duration is required and must be at least 5 minutes.",
      400
    );
  }

  const row = {
    shop,
    platform,
    productId: data.product_id,
    productHandle: data.product_handle,
    durationMin: data.duration_min,
    bufferBeforeMin: Math.max(0, data.buffer_before_min ?? 0),
    bufferAfterMin: Math.max(0, data.buffer_after_min ?? 0),
    capacity: Math.max(1, data.capacity ?? 1),
    locationType: (["onsite", "video", "phone"] as const).includes(
      (data.location_type ?? "onsite") as "onsite" | "video" | "phone"
    )
      ? data.location_type ?? "onsite"
      : "onsite",
    paymentRequired: !!data.payment_required,
    depositPercent: Math.max(1, Math.min(100, data.deposit_percent ?? 100)),
    // Omitted (not reset to a default) when not supplied — on update this
    // leaves an existing custom swatch alone rather than clobbering it every
    // time a merchant edits duration/buffers without touching colour; on
    // create, Postgres' column default (#2563eb) applies.
    ...(data.color !== undefined
      ? { color: /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : "#2563eb" }
      : {}),
    position: data.position ?? 0,
    status: data.status ?? true,
  };

  const saved = id
    ? await prisma.serviceConfig.update({ where: { id }, data: row })
    : await prisma.serviceConfig.create({ data: row });

  if (data.resource_ids) {
    await setServiceResources(shop, saved.id, data.resource_ids);
  }
  if (data.addon_ids) {
    await setServiceAddons(shop, saved.id, data.addon_ids);
  }

  return saved;
}

/**
 * Creates a ServiceConfig for each given product that doesn't already have
 * one (1:1, same convention as shopify-openslot). A product that already
 * has a config is skipped rather than failing the whole batch.
 *
 * The real duration is never known at sync time (Shopify has no such field
 * to read), so this can't set one that means anything — it used to guess 30
 * minutes and go live immediately, which is exactly how five services ended
 * up bookable with the wrong length. Created inactive (status: false)
 * instead: the placeholder duration is a DB-required non-null column, not a
 * claim about the real service, and a merchant has to open it, set the
 * actual duration, and activate it before it's ever offered to a customer.
 */
export async function createServiceConfigsFromProducts(
  shop: string,
  platform: string,
  products: { id: string; handle: string; title?: string }[]
): Promise<{ created: ServiceConfig[]; skipped: string[] }> {
  const created: ServiceConfig[] = [];
  const skipped: string[] = [];

  for (const product of products) {
    const existing = await prisma.serviceConfig.findFirst({ where: { shop, platform, productId: product.id } });
    if (existing) {
      skipped.push(product.title || product.handle);
      continue;
    }
    const saved = await saveServiceConfig(shop, platform, {
      product_id: product.id,
      product_handle: product.handle,
      duration_min: 30,
      status: false,
    });
    created.push(saved);
  }

  return { created, skipped };
}

export async function deleteServiceConfig(shop: string, id: number) {
  await prisma.serviceResource.deleteMany({ where: { shop, serviceId: id } });
  await prisma.serviceAddon.deleteMany({ where: { shop, serviceId: id } });
  const result = await prisma.serviceConfig.deleteMany({ where: { shop, id } });
  return result.count > 0;
}

export function serviceConfigByProductId(shop: string, platform: string, productId: string) {
  return prisma.serviceConfig.findFirst({ where: { shop, platform, productId } });
}

export async function stampServiceConfigPlatformUpdatedAt(id: number, updatedAt: Date) {
  await prisma.serviceConfig.update({ where: { id }, data: { platformUpdatedAt: updatedAt } });
}

/** Applies only the fields webhooks.products.tsx's diff actually found
 * changed on the Shopify side — see serviceMetafields.ts. */
export async function applyServiceConfigMetafieldChanges(
  shop: string,
  id: number,
  changed: Partial<ServiceConfigFields>
) {
  const { resourceIds, addonIds, ...rest } = changed;
  if (Object.keys(rest).length > 0) {
    await prisma.serviceConfig.update({ where: { id }, data: rest });
  }
  if (resourceIds) await setServiceResources(shop, id, resourceIds);
  if (addonIds) await setServiceAddons(shop, id, addonIds);
}

/* --------------------------------------------------------- Product cache */

export interface ProductCacheInput {
  productId: string;
  productHandle: string;
  title?: string;
  description?: string;
  category?: string;
  image?: string;
  price?: number;
}

/** Read-only reference cache — never edited directly (name/price/category/
 * description are product-owned, not GetBooqin-editable state). */
export async function upsertProductCache(shop: string, platform: string, data: ProductCacheInput) {
  const fields = {
    productHandle: data.productHandle,
    title: data.title ?? "",
    description: data.description ?? "",
    category: data.category ?? "",
    image: data.image ?? "",
    price: data.price ?? 0,
  };
  return prisma.productCache.upsert({
    where: { platform_shop_productId: { platform, shop, productId: data.productId } },
    create: { shop, platform, productId: data.productId, ...fields },
    update: fields,
  });
}

export function productCacheByProductId(shop: string, platform: string, productId: string) {
  return prisma.productCache.findFirst({ where: { shop, platform, productId } });
}

/** Enriches booking rows fetched with `include: { service: true }` with each
 * row's product name, via a single batched lookup rather than N+1
 * catalogService() calls. */
export async function attachServiceNames<T extends { service: { productId: string; platform: string } }>(
  shop: string,
  rows: T[]
): Promise<(T & { serviceName: string })[]> {
  if (rows.length === 0) return [];
  const products = await prisma.productCache.findMany({
    where: { shop, productId: { in: rows.map((r) => r.service.productId) } },
  });
  const byProductId = new Map(products.map((p) => [p.productId, p]));
  return rows.map((r) => ({ ...r, serviceName: byProductId.get(r.service.productId)?.title ?? "" }));
}

/* ------------------------------------------------------------ Resources */

export function resources(shop: string, platform: string, onlyActive = true) {
  return prisma.resource.findMany({
    where: { shop, platform, ...(onlyActive ? { status: true } : {}) },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

export function resource(shop: string, id: number) {
  return prisma.resource.findFirst({ where: { shop, id } });
}

// A resource row existing is not the same as it being bookable — one can
// have every day of its schedule toggled off (onboarding's own resource
// step used to create exactly that; see onboarding.tsx's handleStep2) and
// take zero bookings despite passing a plain "at least one resource
// exists" check. Takes the caller's own resource ids rather than
// re-querying resources() itself, since every call site already has them.
export async function bookableResourceCount(shop: string, resourceIds: number[]) {
  if (resourceIds.length === 0) return 0;
  const withHours = await prisma.schedule.findMany({
    where: { shop, resourceId: { in: resourceIds } },
    distinct: ["resourceId"],
    select: { resourceId: true },
  });
  return withHours.length;
}

export interface ResourceInput {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  description?: string;
  avatar_url?: string;
  meeting_link?: string;
  timezone?: string;
  position?: number;
  status?: boolean;
  schedule?: Array<{ day: number; start: string; end: string }>;
  service_ids?: number[];
}

export async function saveResource(shop: string, platform: string, data: ResourceInput, id = 0) {
  const row = {
    shop,
    platform,
    name: data.name,
    title: data.title ?? "",
    email: data.email ?? "",
    phone: data.phone ?? "",
    description: data.description ?? "",
    avatarUrl: data.avatar_url ?? "",
    meetingLink: data.meeting_link ?? "",
    timezone: data.timezone ?? "",
    position: data.position ?? 0,
    status: data.status ?? true,
  };

  const saved = id
    ? await prisma.resource.update({ where: { id }, data: row })
    : await prisma.resource.create({ data: row });

  if (data.schedule) {
    await setSchedule(shop, saved.id, data.schedule);
  }
  if (data.service_ids) {
    await setResourceServices(shop, saved.id, data.service_ids);
  }

  return saved;
}

export async function deleteResource(shop: string, id: number) {
  await prisma.serviceResource.deleteMany({ where: { shop, resourceId: id } });
  await prisma.schedule.deleteMany({ where: { shop, resourceId: id } });
  const result = await prisma.resource.deleteMany({ where: { shop, id } });
  return result.count > 0;
}

/* ---------------------------------------------------------- Assignments */

export async function setServiceResources(shop: string, serviceId: number, resourceIds: number[]) {
  await prisma.serviceResource.deleteMany({ where: { shop, serviceId } });
  const unique = Array.from(new Set(resourceIds)).filter((id) => id > 0);
  if (unique.length) {
    await prisma.serviceResource.createMany({
      data: unique.map((resourceId) => ({ shop, serviceId, resourceId })),
    });
  }
}

export async function setResourceServices(shop: string, resourceId: number, serviceIds: number[]) {
  await prisma.serviceResource.deleteMany({ where: { shop, resourceId } });
  const unique = Array.from(new Set(serviceIds)).filter((id) => id > 0);
  if (unique.length) {
    await prisma.serviceResource.createMany({
      data: unique.map((serviceId) => ({ shop, serviceId, resourceId })),
    });
  }
}

/** Resources able to deliver a service. Falls back to all active resources when nothing is assigned. */
export async function resourcesForService(shop: string, platform: string, serviceId: number): Promise<Resource[]> {
  const rows = await prisma.resource.findMany({
    where: {
      shop,
      platform,
      status: true,
      serviceLinks: { some: { shop, serviceId } },
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  if (rows.length === 0) {
    const assigned = await prisma.serviceResource.count({ where: { shop, serviceId } });
    if (assigned === 0) {
      return resources(shop, platform, true);
    }
  }
  return rows;
}

export async function serviceIdsForResource(shop: string, resourceId: number) {
  const rows = await prisma.serviceResource.findMany({ where: { shop, resourceId }, select: { serviceId: true } });
  return rows.map((r) => r.serviceId);
}

export async function resourceIdsForService(shop: string, serviceId: number) {
  const rows = await prisma.serviceResource.findMany({ where: { shop, serviceId }, select: { resourceId: true } });
  return rows.map((r) => r.resourceId);
}

/* ---------------------------------------------------------------- Addons */

export function addons(shop: string, platform: string, onlyActive = true) {
  return prisma.addon.findMany({
    where: { shop, platform, ...(onlyActive ? { status: true } : {}) },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

export function addon(shop: string, id: number) {
  return prisma.addon.findFirst({ where: { shop, id } });
}

export interface AddonInput {
  name: string;
  description?: string;
  price?: number;
  duration_min?: number;
  position?: number;
  status?: boolean;
  service_ids?: number[];
}

export async function saveAddon(shop: string, platform: string, data: AddonInput, id = 0) {
  const row = {
    shop,
    platform,
    name: data.name,
    description: data.description ?? "",
    price: Math.round((data.price ?? 0) * 100) / 100,
    durationMin: Math.max(0, data.duration_min ?? 0),
    position: data.position ?? 0,
    status: data.status ?? true,
  };

  const saved = id
    ? await prisma.addon.update({ where: { id }, data: row })
    : await prisma.addon.create({ data: row });

  if (data.service_ids) {
    await setAddonServices(shop, saved.id, data.service_ids);
  }

  return saved;
}

export async function deleteAddon(shop: string, id: number) {
  await prisma.serviceAddon.deleteMany({ where: { shop, addonId: id } });
  const result = await prisma.addon.deleteMany({ where: { shop, id } });
  return result.count > 0;
}

export async function setServiceAddons(shop: string, serviceId: number, addonIds: number[]) {
  await prisma.serviceAddon.deleteMany({ where: { shop, serviceId } });
  const unique = Array.from(new Set(addonIds)).filter((id) => id > 0);
  if (unique.length) {
    await prisma.serviceAddon.createMany({
      data: unique.map((addonId) => ({ shop, serviceId, addonId })),
    });
  }
}

export async function setAddonServices(shop: string, addonId: number, serviceIds: number[]) {
  await prisma.serviceAddon.deleteMany({ where: { shop, addonId } });
  const unique = Array.from(new Set(serviceIds)).filter((id) => id > 0);
  if (unique.length) {
    await prisma.serviceAddon.createMany({
      data: unique.map((serviceId) => ({ shop, serviceId, addonId })),
    });
  }
}

/** Add-ons offered for a service. Explicit opt-in only — no "all if none assigned" fallback. */
export async function addonsForService(shop: string, serviceId: number) {
  return prisma.addon.findMany({
    where: {
      shop,
      status: true,
      serviceLinks: { some: { shop, serviceId } },
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

export async function addonIdsForService(shop: string, serviceId: number) {
  const rows = await prisma.serviceAddon.findMany({ where: { shop, serviceId }, select: { addonId: true } });
  return rows.map((r) => r.addonId);
}

/** Requested add-on IDs, filtered down to ones actually offered (active + attached) for this service. */
export async function addonsForServiceByIds(shop: string, serviceId: number, addonIds: number[]) {
  if (!addonIds.length) return [];
  const offered = await addonsForService(shop, serviceId);
  return offered.filter((a) => addonIds.includes(a.id));
}

/** The add-ons snapshot recorded on a booking at creation time. */
export function bookingAddons(shop: string, bookingId: number) {
  return prisma.bookingAddon.findMany({ where: { shop, bookingId }, orderBy: { id: "asc" } });
}

/* ------------------------------------------------------------- Schedules */

export function schedule(shop: string, resourceId: number) {
  return prisma.schedule.findMany({
    where: { shop, resourceId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
}

export async function setSchedule(
  shop: string,
  resourceId: number,
  rows: Array<{ day: number; start: string; end: string }>
) {
  await prisma.schedule.deleteMany({ where: { shop, resourceId } });
  const clean = rows
    .map((row) => ({
      dayOfWeek: Math.max(0, Math.min(6, row.day)),
      startTime: (row.start || "").slice(0, 5),
      endTime: (row.end || "").slice(0, 5),
    }))
    .filter((row) => row.startTime && row.endTime && row.startTime < row.endTime);

  if (clean.length) {
    await prisma.schedule.createMany({
      data: clean.map((row) => ({ shop, resourceId, ...row })),
    });
  }
}

/* --------------------------------------------------------------- Timeoff */

export function timeoff(shop: string, limit = 200) {
  return prisma.timeOff.findMany({ where: { shop }, orderBy: { startUtc: "desc" }, take: limit });
}

export function addTimeoff(shop: string, resourceId: number, startUtc: Date, endUtc: Date, reason = "") {
  return prisma.timeOff.create({ data: { shop, resourceId, startUtc, endUtc, reason } });
}

export async function deleteTimeoff(shop: string, id: number) {
  const result = await prisma.timeOff.deleteMany({ where: { shop, id } });
  return result.count > 0;
}

/* ------------------------------------------------------------- Customers */

export interface CustomerInput {
  first_name?: string;
  last_name?: string;
  email: string;
  phone?: string;
  timezone?: string;
}

export async function findOrCreateCustomer(shop: string, platform: string, data: CustomerInput) {
  const email = data.email.toLowerCase().trim();
  const existing = await prisma.customer.findUnique({ where: { platform_shop_email: { platform, shop, email } } });

  const row = {
    firstName: data.first_name ?? "",
    lastName: data.last_name ?? "",
    email,
    phone: data.phone ?? "",
    timezone: data.timezone ?? "",
  };

  if (existing) {
    // Do not blank out existing values with empty submissions.
    const merged = {
      firstName: row.firstName || existing.firstName,
      lastName: row.lastName || existing.lastName,
      phone: row.phone || existing.phone,
      timezone: row.timezone || existing.timezone,
    };
    const updated = await prisma.customer.update({ where: { id: existing.id }, data: merged });
    return updated.id;
  }

  const created = await prisma.customer.create({ data: { shop, platform, ...row } });
  return created.id;
}

export function customer(shop: string, id: number) {
  return prisma.customer.findFirst({ where: { shop, id } });
}

export function customersCount(shop: string, platform: string, search = "") {
  return prisma.customer.count({
    where: {
      shop,
      platform,
      ...(search
        ? {
            OR: [
              { firstName: { contains: search } },
              { lastName: { contains: search } },
              { email: { contains: search } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    },
  });
}

export function customers(shop: string, platform: string, search = "", limit = 100, offset = 0) {
  return prisma.customer.findMany({
    where: {
      shop,
      platform,
      ...(search
        ? {
            OR: [
              { firstName: { contains: search } },
              { lastName: { contains: search } },
              { email: { contains: search } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
    skip: offset,
  });
}

/* -------------------------------------------------------------------- FAQs */

export function faqs(shop: string, platform: string, onlyActive = true) {
  return prisma.faq.findMany({
    where: { shop, platform, ...(onlyActive ? { status: true } : {}) },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
}

export function faq(shop: string, id: number) {
  return prisma.faq.findFirst({ where: { shop, id } });
}

export interface FaqInput {
  question: string;
  answer?: string;
  keywords?: string;
  position?: number;
  status?: boolean;
}

export async function saveFaq(shop: string, platform: string, data: FaqInput, id = 0) {
  const row = {
    shop,
    platform,
    question: data.question,
    answer: data.answer ?? "",
    keywords: data.keywords ?? "",
    position: data.position ?? 0,
    status: data.status ?? true,
  };
  if (id) {
    await prisma.faq.update({ where: { id }, data: row });
    return id;
  }
  const created = await prisma.faq.create({ data: row });
  return created.id;
}

export async function deleteFaq(shop: string, id: number) {
  const result = await prisma.faq.deleteMany({ where: { shop, id } });
  return result.count > 0;
}

export type { ServiceConfig, ProductCache, Resource };
