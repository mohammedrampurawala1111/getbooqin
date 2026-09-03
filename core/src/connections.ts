import { randomUUID } from "node:crypto";
import prisma from "./db.js";
import { encryptCredentials } from "./auth/encryption.js";

// Thrown when a shop is already linked to a *different* User — the connect
// flow must surface this as a rejection (or a future explicit transfer),
// never silently duplicate or reassign the Connection.
export class ShopAlreadyConnectedError extends Error {
  constructor(public readonly shop: string) {
    super(`${shop} is already connected to a different account`);
    this.name = "ShopAlreadyConnectedError";
  }
}

export async function connectShopifyStore({
  userId,
  shop,
  accessToken,
}: {
  userId: string;
  shop: string;
  accessToken: string;
}) {
  const platform = "shopify";
  const existing = await prisma.connection.findUnique({ where: { platform_shop: { platform, shop } } });

  if (existing && existing.userId !== userId) {
    throw new ShopAlreadyConnectedError(shop);
  }

  const credentials = encryptCredentials(accessToken);

  if (existing) {
    return prisma.connection.update({
      where: { id: existing.id },
      data: { credentials, status: "active" },
    });
  }

  return prisma.connection.create({
    data: { userId, platform, shop, credentials, status: "active" },
  });
}

// A Connection with no real platform behind it yet — lets a user finish
// onboarding and reach a working dashboard without a Shopify store (see the
// UX audit's B3 finding: every previous exit from the wizard required
// Shopify). `shop` is just a generated opaque tenant key here rather than a
// real domain — nothing downstream (Settings, sessions, ServiceConfig/
// ProductCache/Resource/Booking) validates its format, only
// isValidShopDomain()'s Shopify-OAuth-specific callers do. Connecting a
// real Shopify store later (Settings › Integrations' "+ Connect another
// store") creates a second, separate Connection rather than converting
// this one — same multi-store model the app already supports.
export async function createManualConnection({ userId }: { userId: string }) {
  const shop = `manual-${randomUUID()}`;
  return prisma.connection.create({
    data: { userId, platform: "manual", shop, credentials: "", status: "active" },
  });
}

export async function listUserConnections(userId: string) {
  return prisma.connection.findMany({ where: { userId }, orderBy: { connectedAt: "asc" } });
}

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Lazily generates and persists a human-readable slug for the public
 * /book/:connectionId link, from the shop's own business name — a raw cuid
 * reads badly in something a merchant is invited to put in a social bio
 * (UX audit's #13 finding). Idempotent per connection: once set, a slug is
 * never regenerated even if the business name changes later, so a link a
 * merchant already shared keeps working. The cuid `id` itself is left
 * fully functional too (getPublicConnection resolves either) — this is a
 * friendlier alias, not a replacement.
 */
export async function ensureSlug(connectionId: string, businessName: string): Promise<string> {
  const existing = await prisma.connection.findUnique({ where: { id: connectionId }, select: { slug: true } });
  if (existing?.slug) return existing.slug;

  const base = slugify(businessName) || connectionId.slice(0, 8);
  let candidate = base;
  let suffix = 1;
  // Two merchants picking the same business name is rare but not
  // impossible — append a short numeric suffix rather than failing the
  // page render over a unique-constraint collision.
  while (true) {
    const clash = await prisma.connection.findUnique({ where: { slug: candidate } });
    if (!clash || clash.id === connectionId) break;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  await prisma.connection.update({ where: { id: connectionId }, data: { slug: candidate } });
  return candidate;
}

export async function getUserConnection(userId: string, connectionId: string) {
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.userId !== userId) return null;
  return connection;
}

// The public-booking-page equivalent of getUserConnection above — no owner
// to check (the caller is an anonymous customer, not the merchant), but
// still refuses a disconnected/revoked store the same way that dashboard
// routes already do, so a stale or shared /book/:connectionId link can't
// keep working after the merchant disconnects.
export async function getPublicConnection(idOrSlug: string) {
  const connection = await prisma.connection.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
  if (!connection || connection.status !== "active") return null;
  return connection;
}

// Soft-disconnect: keeps the row (and its historical bookings/settings)
// around, just marks it unusable. Reconnecting the same shop later already
// revives it — connectShopifyStore() upserts an owned-but-inactive row back
// to status "active" instead of creating a duplicate.
export async function disconnectConnection(userId: string, connectionId: string) {
  const connection = await getUserConnection(userId, connectionId);
  if (!connection) return null;
  return prisma.connection.update({ where: { id: connectionId }, data: { status: "revoked" } });
}

// Hard delete, unlike disconnectConnection above — only for a manual draft
// abandoned mid-onboarding (routes/onboarding.tsx creates one on step 1,
// then the user connects a real Shopify store instead at step 3/4): it was
// never "gone live" for anyone, so there's no history worth keeping and
// leaving it around would just show up as permanent clutter in Settings ›
// Integrations' "Connected stores" list. Any ShopSettings/ServiceConfig/
// ProductCache/Resource rows already written under its shop key are left in
// place — orphaned but inert, since nothing else references a deleted
// Connection's shop, and cleaning those up isn't worth the extra queries for
// what's normally a same-session, mostly-empty draft.
export async function deleteConnection(userId: string, connectionId: string) {
  const connection = await getUserConnection(userId, connectionId);
  if (!connection) return null;
  await prisma.connection.delete({ where: { id: connectionId } });
  return connection;
}
