import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// globalThis, not the Node-only `global` — this module (and everything that
// imports it) can end up evaluated in a browser bundle via a barrel
// re-export (see index.ts's `export * as X` chain), and `global` throws
// ReferenceError there. Reuse the client across hot reloads in dev so we do
// not exhaust connections.
const prisma = globalThis.prismaGlobal ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = prisma;
}

export default prisma;

/**
 * Anything you can run a query through: the long-lived client above, or the
 * short-lived one `prisma.$transaction(async (tx) => …)` hands you. Query
 * helpers that need to be usable *inside* a transaction take one of these
 * as an optional trailing argument defaulting to the global client, so
 * every existing call site keeps working unchanged while the booking write
 * path can pass its own `tx` and actually see its own uncommitted rows —
 * see src/booking/slotLock.ts for why that matters.
 */
export type DbClient = Prisma.TransactionClient;
