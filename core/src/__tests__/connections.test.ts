/**
 * Regression coverage for listUserConnections() — found live during QA's
 * multi-team end-to-end pass: an invited Admin/Write/Read teammate's very
 * next ordinary /login (not the one-time /invite/:token redirect) landed
 * them in onboarding creating a brand-new throwaway business, because this
 * function only ever matched Connection.userId (real ownership) and had
 * never been updated to also recognize a ConnectionMember-only teammate.
 * Real Postgres DB, no mocking — same convention as team.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../db.js";
import { listUserConnections } from "../connections.js";

const RUN = Date.now();
const ownerUserId = `usr-conn-owner-${RUN}`;
const teammateUserId = `usr-conn-teammate-${RUN}`;
const connectionIds: string[] = [];

async function createUser(id: string): Promise<void> {
  await prisma.user.create({ data: { id, email: `${id}@example.com` } });
}

async function createConnection(userId: string, shopSuffix: string): Promise<string> {
  const connection = await prisma.connection.create({
    data: { userId, platform: "manual", shop: `conn-test-${shopSuffix}-${RUN}`, credentials: "", status: "active" },
  });
  connectionIds.push(connection.id);
  return connection.id;
}

describe("listUserConnections", () => {
  afterAll(async () => {
    await prisma.connectionMember.deleteMany({ where: { connectionId: { in: connectionIds } } });
    await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, teammateUserId] } } });
  });

  it("sets up an owner with their own connection, plus a teammate who only holds membership on it", async () => {
    await createUser(ownerUserId);
    await createUser(teammateUserId);
    const connectionId = await createConnection(ownerUserId, "a");
    await prisma.connectionMember.create({ data: { connectionId, userId: ownerUserId, role: "owner" } });
    await prisma.connectionMember.create({ data: { connectionId, userId: teammateUserId, role: "admin" } });
    expect(connectionIds).toHaveLength(1);
  });

  it("includes a connection the user only has ConnectionMember access to, not Connection.userId ownership (the actual bug)", async () => {
    const result = await listUserConnections(teammateUserId);
    expect(result.map((c) => c.id)).toEqual([connectionIds[0]]);
  });

  it("still includes a connection the user actually owns", async () => {
    const result = await listUserConnections(ownerUserId);
    expect(result.map((c) => c.id)).toEqual([connectionIds[0]]);
  });

  it("returns both an owned connection and a membership-only connection together, oldest first", async () => {
    const secondConnectionId = await createConnection(teammateUserId, "b");
    await prisma.connectionMember.create({ data: { connectionId: secondConnectionId, userId: teammateUserId, role: "owner" } });
    // Backdate the first connection so ordering isn't just "insertion order".
    await prisma.connection.update({ where: { id: connectionIds[0] }, data: { connectedAt: new Date(Date.now() - 60_000) } });

    const result = await listUserConnections(teammateUserId);
    expect(result.map((c) => c.id)).toEqual([connectionIds[0], secondConnectionId]);
  });

  it("returns nothing for a user with no membership anywhere", async () => {
    const result = await listUserConnections(`usr-conn-nobody-${RUN}`);
    expect(result).toEqual([]);
  });
});
