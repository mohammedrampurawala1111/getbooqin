/**
 * Deleting a business, and deleting an account.
 *
 * ## Why this can't be a cascade
 *
 * Almost every tenant table is keyed by `(shop, platform)`, not by
 * `connectionId` — that is what lets a business exist on a platform
 * before a Connection row does, and it is deliberate. The cost is that
 * deleting the Connection cascades only to its own children (members,
 * invites, subscription, entitlements) and would leave every Booking,
 * Customer, Resource and Schedule behind as orphaned rows nobody can
 * reach and nobody can erase. So the purge below is explicit, ordered by
 * foreign key, and covered by a test that counts what's left.
 *
 * ## The mandate goes first
 *
 * A deleted account whose Razorpay mandate is still live keeps being
 * charged, with nothing left in the product to explain the debit or
 * cancel it. That is the single worst outcome available here, so the
 * cancellation happens before anything is destroyed and a failure to
 * cancel **aborts the deletion**.
 *
 * ## What survives, and why
 *
 * `BillingEvent` rows are kept, with their `connectionId` set to null by
 * the schema's own `onDelete: SetNull`. They are the record of money
 * that actually moved — needed to answer a chargeback or a tax question
 * long after an account is gone, and they carry no personal data beyond
 * an opaque provider id. `AdminAuditLog` survives for the same reason:
 * an audit trail you can erase is not an audit trail.
 */
import prisma from "../db.js";
import { GetBooqinError } from "../booking/errors.js";
import { cancelSubscription } from "../billing/providers/razorpay.js";

export interface DeletionPreview {
  connectionId: string;
  shop: string;
  platform: string;
  businessName: string;
  bookings: number;
  customers: number;
  resources: number;
  services: number;
  teamMembers: number;
  /** A live mandate that will be cancelled before anything is deleted. */
  liveSubscription: { plan: string; provider: string; providerSubscriptionId: string } | null;
}

function businessNameFrom(raw: string | undefined, shop: string): string {
  if (!raw) return shop;
  try {
    const parsed = JSON.parse(raw) as { business_name?: string };
    return (parsed.business_name ?? "").trim() || shop;
  } catch {
    return shop;
  }
}

/**
 * Exactly what is about to be destroyed. The confirmation dialog renders
 * from this rather than from adjectives — "1,240 bookings and 380
 * customers" is a different decision from "some data".
 */
export async function preview(connectionId: string): Promise<DeletionPreview | null> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, shop: true, platform: true, subscription: true },
  });
  if (!connection) return null;

  const { shop, platform } = connection;
  const scope = { shop, platform };

  const [settings, bookings, customers, resources, services, teamMembers] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { platform_shop: { platform, shop } }, select: { data: true } }),
    prisma.booking.count({ where: scope }),
    prisma.customer.count({ where: scope }),
    prisma.resource.count({ where: scope }),
    prisma.serviceConfig.count({ where: scope }),
    prisma.connectionMember.count({ where: { connectionId } }),
  ]);

  const sub = connection.subscription;
  return {
    connectionId,
    shop,
    platform,
    businessName: businessNameFrom(settings?.data, shop),
    bookings,
    customers,
    resources,
    services,
    teamMembers,
    liveSubscription:
      sub?.providerSubscriptionId && (sub.status === "active" || sub.status === "past_due")
        ? { plan: sub.plan, provider: sub.billingProvider, providerSubscriptionId: sub.providerSubscriptionId }
        : null,
  };
}

/**
 * Purges every `(shop, platform)`-scoped row, child tables first.
 *
 * Ordered by foreign key rather than by `deleteMany` on everything at
 * once: Postgres would reject a parent whose children still exist, and a
 * half-finished delete is worse than no delete at all — which is why the
 * caller runs this inside a transaction.
 */
async function purgeTenantData(tx: Parameters<typeof prisma.$transaction>[0] extends (c: infer C) => unknown ? C : never, shop: string, platform: string) {
  const scope = { shop, platform };

  // Grandchildren first.
  await tx.chatMessage.deleteMany({ where: { conversation: { shop, platform } } });
  await tx.bookingAddon.deleteMany({ where: { booking: { shop, platform } } });

  await tx.consultationSummary.deleteMany({ where: scope });
  await tx.payment.deleteMany({ where: scope });
  await tx.waitlist.deleteMany({ where: scope });
  await tx.booking.deleteMany({ where: scope });

  await tx.serviceAddon.deleteMany({ where: scope });
  await tx.serviceResource.deleteMany({ where: scope });
  await tx.addon.deleteMany({ where: scope });
  await tx.schedule.deleteMany({ where: scope });
  await tx.timeOff.deleteMany({ where: scope });

  await tx.chatConversation.deleteMany({ where: scope });
  await tx.faq.deleteMany({ where: scope });
  await tx.customer.deleteMany({ where: scope });
  await tx.resource.deleteMany({ where: scope });
  await tx.serviceConfig.deleteMany({ where: scope });
  await tx.productCache.deleteMany({ where: scope });
  await tx.shopSettings.deleteMany({ where: scope });
}

export interface DeletionResult {
  shop: string;
  platform: string;
  cancelledSubscription: string | null;
}

/**
 * Deletes one business and everything it holds.
 *
 * Irreversible, and deliberately so — a "soft delete" that keeps a
 * merchant's customer list around after they asked for it to be gone is
 * not erasure, whatever the column says.
 */
export async function deleteBusiness(connectionId: string): Promise<DeletionResult> {
  const target = await preview(connectionId);
  if (!target) throw new GetBooqinError("getbooqin_not_found", "That business no longer exists.", 404);

  // Before anything is destroyed. A deleted account whose mandate is
  // still live keeps taking money with nothing left to explain or stop
  // it, so a failure here aborts rather than proceeding.
  let cancelled: string | null = null;
  if (target.liveSubscription) {
    try {
      await cancelSubscription(target.liveSubscription.providerSubscriptionId, { immediately: true });
      cancelled = target.liveSubscription.providerSubscriptionId;
    } catch (err) {
      console.error(`[getbooqin account] refusing to delete ${connectionId} — cancel failed:`, err);
      throw new GetBooqinError(
        "getbooqin_cancel_failed",
        "We couldn't cancel your subscription, so we've stopped rather than delete an account that would keep being charged. Please get in touch.",
        502
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await purgeTenantData(tx, target.shop, target.platform);
    // Members, invites, subscription and entitlements go with this by
    // cascade; BillingEvent is deliberately SetNull, not cascade.
    await tx.connection.delete({ where: { id: connectionId } });
  });

  return { shop: target.shop, platform: target.platform, cancelledSubscription: cancelled };
}

/**
 * Deletes a person: every business they own, then the user record.
 *
 * Businesses they merely belong to are untouched — their membership row
 * goes with the user by cascade, but someone else's business is not
 * theirs to erase. A business whose owner leaves and which has other
 * members is the one case this refuses outright, because silently
 * deleting a working business out from under a team is worse than making
 * someone hand it over first.
 */
export async function deleteUserAccount(userId: string): Promise<{ businessesDeleted: number }> {
  const owned = await prisma.connection.findMany({ where: { userId }, select: { id: true } });

  for (const connection of owned) {
    const others = await prisma.connectionMember.count({
      where: { connectionId: connection.id, userId: { not: userId } },
    });
    if (others > 0) {
      throw new GetBooqinError(
        "getbooqin_business_has_team",
        "One of your businesses still has other team members. Remove them, or transfer ownership, before deleting your account.",
        409
      );
    }
  }

  for (const connection of owned) {
    await deleteBusiness(connection.id);
  }

  await prisma.user.delete({ where: { id: userId } });
  return { businessesDeleted: owned.length };
}
