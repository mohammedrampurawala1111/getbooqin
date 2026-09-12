import { randomUUID } from "node:crypto";
import prisma from "./db.js";
import { encryptCredentials } from "./auth/encryption.js";
import { assertCanAddBusiness, userHasFeature } from "./billing/enforcement.js";
import { GetBooqinError } from "./booking/errors.js";
import { ensureSubscription } from "./billing/subscriptions.js";

// Thrown when a shop is already linked to a *different* User — the connect
// flow must surface this as a rejection (or a future explicit transfer),
// never silently duplicate or reassign the Connection.
export class ShopAlreadyConnectedError extends Error {
  constructor(public readonly shop: string) {
    super(`${shop} is already connected to a different account`);
    this.name = "ShopAlreadyConnectedError";
  }
}

// Every Connection-creating path below calls this right after writing the
// row — the team-management migration's backfill INSERT only covers
// Connections that already existed at migration time; a Connection created
// afterward needs its own "owner" ConnectionMember row the same way, or
// its own creator would immediately 404 out of it the moment
// requireTenant() starts checking Team.getMembership() instead of
// Connection.userId directly. Callers already call ensureUserRow(userId)
// before reaching here (see connect.shopify.callback.tsx / onboarding.tsx),
// so the FK this depends on is guaranteed to exist. Force-upserts to
// "owner" on every call (not just create) since Connection.userId is still
// the sole source of truth for ownership in this pass — ownership transfer
// is explicitly out of scope (see the plan), so re-linking a store always
// means its existing owner reconnected, never a change of who owns it.
async function ensureOwnerMembership(connectionId: string, userId: string): Promise<void> {
  await prisma.connectionMember.upsert({
    where: { connectionId_userId: { connectionId, userId } },
    create: { connectionId, userId, role: "owner" },
    update: { role: "owner" },
  });
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
    const connection = await prisma.connection.update({
      where: { id: existing.id },
      data: { credentials, status: "active" },
    });
    await ensureOwnerMembership(connection.id, userId);
    // Reconnecting a store that was revoked — idempotent, so an account
    // that already has a subscription keeps it rather than restarting a
    // trial it has already used.
    await ensureSubscription(connection.id);
    return connection;
  }

  // Plan limit — connecting a Shopify store is adding a business, the
  // same as createManualConnection below. Checked only for a genuinely
  // new connection: re-authorising an existing one above must never be
  // blocked, or a merchant whose token expired while they were over
  // their cap could never get back in.
  await assertCanAddBusiness(userId);

  // Shopify is a plan feature that **no plan currently grants** — it is
  // shipped dark until there is a decision to release it generally, and
  // an admin turns it on per account from /admin. So this gate applies
  // to a brand-new user installing from the App Store as much as to an
  // existing merchant: "I don't have an account yet" must not be a way
  // around a feature that is off for everyone.
  //
  // Re-authorising a connection that already exists is handled above and
  // deliberately ungated — locking a merchant out of data they already
  // have, because a feature was switched off after they connected, would
  // be punishing them for our decision.
  if (!(await userHasFeature(userId, "shopify"))) {
    throw new GetBooqinError(
      "getbooqin_plan_feature",
      "Shopify connections aren't available on your account yet. Get in touch if you'd like early access.",
      402
    );
  }

  const connection = await prisma.connection.create({
    data: { userId, platform, shop, credentials, status: "active" },
  });
  await ensureOwnerMembership(connection.id, userId);
  await ensureSubscription(connection.id);
  return connection;
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
  // Plan limit — "businesses / locations". A user's first connection is
  // always allowed; this only bites on the second and beyond.
  await assertCanAddBusiness(userId);

  const shop = `manual-${randomUUID()}`;
  const connection = await prisma.connection.create({
    data: { userId, platform: "manual", shop, credentials: "", status: "active" },
  });
  await ensureOwnerMembership(connection.id, userId);
  // Starts the 30-day trial. Idempotent, so the onboarding flow calling
  // this and a later backfill can't produce two rows.
  await ensureSubscription(connection.id);
  return connection;
}

// Every business this user can reach at all — as owner *or* as an invited
// team member — not just ones where Connection.userId is literally them.
// Queried through ConnectionMember (every Connection gets an "owner" row
// there too, via ensureOwnerMembership above) rather than Connection.userId
// directly, for the same reason the schema comment on ConnectionMember
// gives for requireTenant(): a straight `where: { userId }` against
// Connection only ever finds businesses this user *created*. Before this
// fix, every one of this function's callers (dashboard.tsx's and
// dashboard.account.tsx's "already set up, land on the most recent one"
// redirect, onboarding.tsx's "already set up, don't re-onboard" check, and
// Settings > Integrations' multi-business switcher) saw an invited
// Admin/Write/Read teammate as having *zero* businesses the moment they
// logged in through anything other than the one-time /invite/:token
// redirect — e.g. a completely ordinary subsequent /login — and routed
// them straight into onboarding, which then created a brand-new throwaway
// business for them right on top of the real membership they already had
// (QA testing found this live: an accepted Admin teammate's very next
// login minted a second "manual-<uuid>" Connection with the teammate as
// its owner, while their real "admin" ConnectionMember row on the
// business they were actually invited to sat untouched).
export async function listUserConnections(userId: string) {
  const memberships = await prisma.connectionMember.findMany({
    where: { userId },
    include: { connection: true },
    orderBy: { connection: { connectedAt: "asc" } },
  });
  return memberships.map((m) => m.connection);
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
