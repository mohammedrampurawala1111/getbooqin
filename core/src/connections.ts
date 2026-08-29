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

export async function listUserConnections(userId: string) {
  return prisma.connection.findMany({ where: { userId }, orderBy: { connectedAt: "asc" } });
}

export async function getUserConnection(userId: string, connectionId: string) {
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.userId !== userId) return null;
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
