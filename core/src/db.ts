import { PrismaClient } from "@prisma/client";

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
