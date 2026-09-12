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
import { randomUUID } from "node:crypto";
import prisma, { type DbClient } from "../db.js";
import type { Resource, ServiceConfig, ProductCache } from "@prisma/client";
import type { ServiceConfigFields } from "./serviceMetafields.js";
import { GetBooqinError, isGetBooqinError } from "./errors.js";
import { assertCanAddResource, assertCanAddService } from "../billing/enforcement.js";
import { translateOverlapViolation } from "./slotLock.js";

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
  // See ServiceConfig.requiresRoom's own schema comment (GetBooqin clinic
  // audit's RS-01 finding).
  requiresRoom: boolean;
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
    requiresRoom: config.requiresRoom,
  };
}

export async function catalogServices(shop: string, platform = "shopify", onlyActive = true): Promise<CatalogService[]> {
  const configs = await prisma.serviceConfig.findMany({
    // deletedAt: null excludes a soft-deleted service even in the
    // onlyActive:false admin-listing mode — it's gone, not just switched
    // off (Defect Dossier's BQ-32 finding).
    where: { shop, platform, deletedAt: null, ...(onlyActive ? { status: true } : {}) },
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
  // resource_ids carries both kinds together — a service's practitioner and
  // room assignments live in the same ServiceResource join table, so the
  // route combines both checkbox groups into one array before calling this
  // (see dashboard.$connectionId.services.$serviceId.tsx's action).
  resource_ids?: number[];
  requires_room?: boolean;
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

  // Plan limit — creates only, same reasoning as saveResource above.
  if (!id) await assertCanAddService(shop, platform);

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
    // Merchant deposits came out with Phase 1's trim and no form sends
    // these any more, but the columns stay (no destructive migrations) and
    // so does the ability to write them, for whatever re-introduces
    // deposits as an integration later. Omitted rather than defaulted when
    // not supplied, same as `color` below, so a service edited today
    // doesn't silently zero a percentage a merchant set before the trim.
    ...(data.payment_required !== undefined ? { paymentRequired: data.payment_required } : {}),
    // A 100% default on an unset (or 0) price is meaningless and becomes a
    // live billing rule the moment a merchant later sets a price without
    // ever touching this field (Defect Dossier's BQ-22 finding — Legal's
    // seeded services all landed with deposit_percent 100 on a €0 price).
    ...(data.deposit_percent !== undefined
      ? { depositPercent: Math.max(0, Math.min(100, data.deposit_percent)) }
      : {}),
    // Omitted (not reset to a default) when not supplied — on update this
    // leaves an existing custom swatch alone rather than clobbering it every
    // time a merchant edits duration/buffers without touching colour; on
    // create, Postgres' column default (#2563eb) applies.
    ...(data.color !== undefined
      ? { color: /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : "#2563eb" }
      : {}),
    position: data.position ?? 0,
    status: data.status ?? true,
    requiresRoom: !!data.requires_room,
  };

  // Keep Booking.exclusive in step with the capacity this service is being
  // saved with, in the same transaction as the save itself. That column is
  // what the Booking_resource_no_overlap exclusion constraint keys on — a
  // constraint predicate can't join to ServiceConfig, so "one customer per
  // slot" has to be denormalised onto each booking row (see the schema
  // comment). Only future bookings are touched: a past booking's
  // exclusivity records how it was actually delivered, not a rule to
  // re-apply.
  const exclusive = row.capacity <= 1;
  const saved = await translateOverlapViolation(() =>
    prisma.$transaction(async (tx) => {
      const service = id
        ? await tx.serviceConfig.update({ where: { id }, data: row })
        : await tx.serviceConfig.create({ data: row });

      await tx.booking.updateMany({
        where: { shop, serviceId: service.id, startUtc: { gt: new Date() }, exclusive: !exclusive },
        data: { exclusive },
      });

      return service;
    })
  ).catch((err) => {
    // Narrowing a class back to capacity 1 while several people are still
    // booked into the same slot can't be done by editing a number — the
    // bookings that already share that slot have to go somewhere first.
    // Without this the merchant would get a raw Postgres error from the
    // service form; the transaction has already rolled the capacity change
    // back, so the service is untouched either way.
    if (isGetBooqinError(err) && err.code === "getbooqin_slot_taken") {
      throw new GetBooqinError(
        "getbooqin_capacity_in_use",
        "Upcoming bookings already share a time slot for this service, so its capacity can't be reduced to 1. Move or cancel those bookings first.",
        409
      );
    }
    throw err;
  });

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

/** How many bookings (any status, any time) still reference this service —
 * the number a delete confirmation needs to phrase honestly. */
export async function bookingCountForService(shop: string, id: number): Promise<number> {
  return prisma.booking.count({ where: { shop, serviceId: id } });
}

/**
 * A service could only ever be switched inactive, never actually removed
 * (Defect Dossier's BQ-32 finding) — one created by mistake, or seeded by
 * the wrong template, stayed in the list forever. Historical bookings hold
 * a required, non-cascading foreign key to ServiceConfig, so hard-deleting
 * a referenced row would just throw a raw FK-violation error; soft-delete
 * instead, keeping the row (and its name) resolvable for past bookings
 * while hiding it from every active list (catalogServices' deletedAt
 * filter, above).
 */
export async function deleteServiceConfig(shop: string, id: number): Promise<{ hardDeleted: boolean; referencedBookings: number }> {
  const referencedBookings = await bookingCountForService(shop, id);
  if (referencedBookings > 0) {
    await prisma.serviceConfig.updateMany({ where: { shop, id }, data: { deletedAt: new Date(), status: false } });
    return { hardDeleted: false, referencedBookings };
  }
  await prisma.serviceResource.deleteMany({ where: { shop, serviceId: id } });
  await prisma.serviceAddon.deleteMany({ where: { shop, serviceId: id } });
  await prisma.waitlist.deleteMany({ where: { shop, serviceId: id } });
  await prisma.serviceConfig.deleteMany({ where: { shop, id } });
  return { hardDeleted: true, referencedBookings: 0 };
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

export type ResourceKind = "practitioner" | "room";

// `kind` filters to one dimension when a caller only ever meant
// "practitioners" (the public booking page's resource picker, the
// Add-booking dialog, the Business template's auto-assign-new-services
// step, Overview's utilisation chart, ...) — every one of those existed
// before rooms did and would otherwise start mixing rooms into a list that
// used to mean "who can deliver this" (GetBooqin clinic audit's RS-01
// finding). Omitted (the default) returns both kinds, for the Resources
// list page and Time off's resource picker, which both deliberately show
// everything.
export function resources(shop: string, platform: string, onlyActive = true, kind?: ResourceKind) {
  return prisma.resource.findMany({
    where: { shop, platform, ...(onlyActive ? { status: true } : {}), ...(kind ? { kind } : {}) },
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
  // Defaults to "practitioner" — every caller that predates rooms (the
  // onboarding wizard's first-resource step, any script) never sets this
  // and keeps creating exactly what it always created.
  kind?: ResourceKind;
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
  // Plan limit — creates only. An edit to an existing resource is never
  // blocked, including on an account that is already over its cap after
  // a downgrade: what a limit stops is *adding the next one*, never
  // touching what's already there (see billing/entitlements.ts).
  if (!id) await assertCanAddResource(shop, platform);

  const row = {
    shop,
    platform,
    kind: data.kind === "room" ? "room" : "practitioner",
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
  // Marks this service as having a real, merchant-made assignment decision
  // — including an explicit "assigned to nobody" (empty array) — so
  // resourcesForService() below can tell that apart from "never touched"
  // (Defect Dossier's BQ-05 finding).
  await prisma.serviceConfig.updateMany({ where: { shop, id: serviceId }, data: { resourceAssignmentCustomized: true } });
}

export async function setResourceServices(shop: string, resourceId: number, serviceIds: number[]) {
  // Every service this resource was linked to before the edit, plus every
  // one it's linked to after, had its assignment set genuinely touched by
  // this save (a service losing its only resource here is exactly the
  // "assigned to nobody on purpose" case the fallback below must respect).
  const before = await prisma.serviceResource.findMany({ where: { shop, resourceId }, select: { serviceId: true } });
  const touchedServiceIds = Array.from(new Set([...before.map((r) => r.serviceId), ...serviceIds]));

  await prisma.serviceResource.deleteMany({ where: { shop, resourceId } });
  const unique = Array.from(new Set(serviceIds)).filter((id) => id > 0);
  if (unique.length) {
    await prisma.serviceResource.createMany({
      data: unique.map((serviceId) => ({ shop, serviceId, resourceId })),
    });
  }
  if (touchedServiceIds.length) {
    await prisma.serviceConfig.updateMany({ where: { shop, id: { in: touchedServiceIds } }, data: { resourceAssignmentCustomized: true } });
  }
}

/**
 * Resources able to deliver a service. No fallback: zero rows means zero
 * resources, full stop. There used to be a fallback to "every active
 * resource" for a service nobody had ever explicitly assigned, meant to
 * keep a fresh business usable before its first deliberate assignment —
 * but it made two identically-empty "Who can deliver this" boxes behave
 * oppositely depending on unrelated history nobody could see (Defect
 * Dossier's R2-04 finding, still open after two rounds specifically
 * because of this fallback). Every place a service or resource gets
 * created now assigns real rows up front instead (preset seeding, template
 * switching, onboarding, a new resource's own create form), so the
 * fallback's job is done by explicit assignment, not by guessing.
 */
export async function resourcesForService(shop: string, platform: string, serviceId: number): Promise<Resource[]> {
  return prisma.resource.findMany({
    where: {
      shop,
      platform,
      status: true,
      // Excludes a kind: "room" row linked to this same service via the
      // shared ServiceResource table (see roomsForService() below) — every
      // caller of this function predates rooms and means "who can deliver
      // this," a question a room was never a valid answer to (GetBooqin
      // clinic audit's RS-01 finding).
      kind: "practitioner",
      serviceLinks: { some: { shop, serviceId } },
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

/**
 * Rooms assigned to a service — the RS-01 half of resourcesForService()
 * above. Reuses the exact same ServiceResource join table (it only ever
 * meant "this resource, whatever kind, is linked to this service"); only
 * the `kind` filter differs. Callers only ever need this when the service
 * itself has requiresRoom on — see availability.ts's room-gate logic and
 * Bookings.create()'s room selection.
 */
export async function roomsForService(
  shop: string,
  platform: string,
  serviceId: number,
  db: DbClient = prisma
): Promise<Resource[]> {
  return db.resource.findMany({
    where: {
      shop,
      platform,
      status: true,
      kind: "room",
      serviceLinks: { some: { shop, serviceId } },
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

/**
 * Active services that resolve to zero deliverable resources right now —
 * batched version of resourcesForService()'s own "empty means empty" check,
 * for the consultation-types list and Overview's warning count. A service
 * that requires a room but has none assigned is just as unbookable as one
 * with no practitioner, so it's flagged the same way (GetBooqin clinic
 * audit's RS-01 finding).
 */
export async function unbookableServiceIds(shop: string, platform: string): Promise<Set<number>> {
  const [services, links, roomLinks] = await Promise.all([
    prisma.serviceConfig.findMany({ where: { shop, platform, status: true }, select: { id: true, requiresRoom: true } }),
    prisma.serviceResource.findMany({
      where: { shop, resource: { platform, status: true, kind: "practitioner" } },
      select: { serviceId: true },
    }),
    prisma.serviceResource.findMany({
      where: { shop, resource: { platform, status: true, kind: "room" } },
      select: { serviceId: true },
    }),
  ]);
  const assigned = new Set(links.map((l) => l.serviceId));
  const roomAssigned = new Set(roomLinks.map((l) => l.serviceId));

  const unbookable = new Set<number>();
  for (const s of services) {
    if (!assigned.has(s.id) || (s.requiresRoom && !roomAssigned.has(s.id))) unbookable.add(s.id);
  }
  return unbookable;
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

/** Every visible resource's rows in one query, for the appointments calendar's day columns. */
export function schedulesForResources(shop: string, resourceIds: number[]) {
  if (!resourceIds.length) return Promise.resolve([]);
  return prisma.schedule.findMany({
    where: { shop, resourceId: { in: resourceIds } },
    orderBy: [{ resourceId: "asc" }, { dayOfWeek: "asc" }, { startTime: "asc" }],
  });
}

/**
 * Whole-business opening hours for the public page's header (Defect
 * Dossier's BQ-33 finding) — hours live per resource, not per shop, and
 * different resources can keep different hours. A day counts as "open" if
 * any active resource is, widened to the earliest start and latest end
 * across all of them for that day, since that's the actual window a
 * prospective client could get an appointment in. Index 0 = Sunday,
 * matching Schedule.dayOfWeek's own convention.
 */
export async function businessHours(
  shop: string,
  platform: string
): Promise<Array<{ dayOfWeek: number; open: boolean; start: string; end: string }>> {
  const resources = await prisma.resource.findMany({ where: { shop, platform, status: true }, select: { id: true } });
  const resourceIds = resources.map((r) => r.id);
  const rows = resourceIds.length
    ? await prisma.schedule.findMany({ where: { shop, resourceId: { in: resourceIds } } })
    : [];

  const byDay = new Map<number, { start: string; end: string }>();
  for (const row of rows) {
    const existing = byDay.get(row.dayOfWeek);
    if (!existing) {
      byDay.set(row.dayOfWeek, { start: row.startTime, end: row.endTime });
    } else {
      if (row.startTime < existing.start) existing.start = row.startTime;
      if (row.endTime > existing.end) existing.end = row.endTime;
    }
  }

  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const hours = byDay.get(dayOfWeek);
    return hours ? { dayOfWeek, open: true, ...hours } : { dayOfWeek, open: false, start: "", end: "" };
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

/**
 * Real interval-overlap query (mirrors Bookings.occupyingBetween) across the
 * given resources plus whole-business blocks (resourceId 0, same OR
 * convention isBlockedByTimeOff uses) — timeoff()'s recency-capped, shop-wide
 * list is the wrong tool for "everything blocking this specific date range",
 * since a busy shop could have a real block sitting past its 200-row cap.
 */
export function timeoffBetween(shop: string, resourceIds: number[], start: Date, end: Date) {
  return prisma.timeOff.findMany({
    where: {
      shop,
      OR: [{ resourceId: { in: resourceIds } }, { resourceId: 0 }],
      startUtc: { lt: end },
      endUtc: { gt: start },
    },
    orderBy: { startUtc: "asc" },
  });
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
  // Optional since Settings > Booking rules' "Require an email address" can
  // be turned off (GetBooqin clinic audit's PB-03 finding: a walk-in
  // patient with no email address couldn't book online at all before
  // this). Customer.email stays a required, unique-per-shop column with no
  // schema change — see the placeholder synthesis below.
  email?: string;
  phone?: string;
  timezone?: string;
}

export async function findOrCreateCustomer(shop: string, platform: string, data: CustomerInput) {
  const rawEmail = (data.email ?? "").toLowerCase().trim();
  // No real email given: synthesize a deterministic placeholder keyed to
  // the phone number, so repeat bookings from the same number still
  // resolve to one customer record instead of a fresh duplicate every
  // time. bookingsShared.ts's isRealEmail() is what keeps mailer.ts from
  // ever sending to one of these. Falls back to a random placeholder only
  // when there's no phone either — Bookings.create() itself already
  // refuses to reach here with neither on record.
  const phoneDigits = (data.phone ?? "").replace(/\D/g, "");
  const email = rawEmail || (phoneDigits ? `phone-${phoneDigits}@getbooqin.invalid` : `no-contact-${randomUUID()}@getbooqin.invalid`);
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

// eraseCustomerData()'s own pseudonymization marker — "Deleted"/"client" is
// never a real name a customer types (unlike a placeholder *.invalid
// email, which a legitimately contactless-but-real customer can also have
// via findOrCreateCustomer, so filtering on the email domain alone would
// hide real customers too). Excluded from both list functions below by
// default: a tombstone stayed listed, counted toward "N total", and kept
// offering its own "Delete this client's data" button that did nothing
// further (GetBooqin clinic audit's PT-01 finding).
const NOT_ERASED = { NOT: { firstName: "Deleted", lastName: "client" } } as const;

export function customersCount(shop: string, platform: string, search = "") {
  return prisma.customer.count({
    where: {
      shop,
      platform,
      ...NOT_ERASED,
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
      ...NOT_ERASED,
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

/**
 * Creates (or reuses) a client record with no booking attached, so staff
 * can enter someone from a phone call before they've booked anything — the
 * Clients page was previously read-only with no way to do this (Defect
 * Dossier's BQ-31 finding). Just findOrCreateCustomer under a name staff
 * actually recognize as "add a client": the same email-based de-dupe
 * (lowercased, unique per shop) applies either way.
 */
export const createCustomer = findOrCreateCustomer;

export function updateCustomerNotes(shop: string, id: number, notes: string) {
  return prisma.customer.updateMany({ where: { shop, id }, data: { notes } });
}

/**
 * Lets the Danger zone dialog describe eraseCustomerData()'s actual outcome
 * (hard delete vs. pseudonymize) *before* the destructive action runs,
 * rather than promising "permanently erased" unconditionally and only
 * being honest about it after the fact (GetBooqin clinic audit's PT-01
 * finding).
 */
export function customerHasHistory(shop: string, id: number): Promise<boolean> {
  return Promise.all([
    prisma.booking.count({ where: { shop, customerId: id } }),
    prisma.waitlist.count({ where: { shop, customerId: id } }),
  ]).then(([bookingCount, waitlistCount]) => bookingCount > 0 || waitlistCount > 0);
}

/**
 * Lets a receptionist fix a mistyped contact detail without erasing and
 * re-creating the record (which, per eraseCustomerData() above, would
 * leave a tombstone behind for anyone with real booking history) — contact
 * fields were read-only from the moment a customer record was first
 * created (GetBooqin clinic audit's PT-02 finding). Email re-validates
 * uniqueness the same way findOrCreateCustomer's own upsert does; the
 * caller surfaces a Prisma unique-constraint failure as a normal form
 * error rather than a 500.
 */
export interface CustomerUpdateInput {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  date_of_birth: string | null;
  medical_alert: string;
}

export async function updateCustomer(shop: string, id: number, data: CustomerUpdateInput) {
  return prisma.customer.updateMany({
    where: { shop, id },
    data: {
      firstName: data.first_name,
      lastName: data.last_name,
      email: data.email.toLowerCase().trim(),
      phone: data.phone,
      dateOfBirth: data.date_of_birth,
      medicalAlert: data.medical_alert,
    },
  });
}

/**
 * The GDPR-relevant piece of BQ-31: a client can ask to have their data
 * erased. Booking.customerId and Waitlist.customerId are required,
 * non-cascading foreign keys, so a customer with real history can't be
 * hard-deleted without either orphaning those rows or hitting a FK
 * violation — for that case this still anonymizes the Customer row in
 * place, leaving historical bookings resolvable ("Deleted client") instead
 * of broken.
 *
 * But a customer with *no* booking or waitlist history at all has nothing
 * to keep resolvable, and the confirmation dialog above this promises
 * "permanently erased... this can't be undone" regardless — pseudonymizing
 * that case unconditionally left a tombstone (a "Deleted client" row still
 * counted in the client total, still listed, still offering its own
 * "Delete this client's data" button that did nothing further) that no
 * control anywhere could actually remove, for a record that might exist
 * purely because someone was added by mistake (GetBooqin clinic audit's
 * PT-01 finding). Checked and hard-deleted here instead whenever it's
 * genuinely safe to.
 */
export async function eraseCustomerData(shop: string, id: number): Promise<{ hardDeleted: boolean }> {
  const [bookingCount, waitlistCount] = await Promise.all([
    prisma.booking.count({ where: { shop, customerId: id } }),
    prisma.waitlist.count({ where: { shop, customerId: id } }),
  ]);

  if (bookingCount === 0 && waitlistCount === 0) {
    await prisma.customer.deleteMany({ where: { shop, id } });
    return { hardDeleted: true };
  }

  // The erased email still has to be unique per the platform_shop_email
  // constraint.
  await prisma.customer.updateMany({
    where: { shop, id },
    data: { firstName: "Deleted", lastName: "client", email: `erased-${id}@getbooqin.invalid`, phone: "", notes: "" },
  });
  return { hardDeleted: false };
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
