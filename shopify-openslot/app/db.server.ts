// Single-backend cutover: this app no longer owns its own database or
// Prisma client — `prisma` here is core's client, backed by core's
// database. `.server.ts` is guaranteed server-only by React Router's own
// convention, so pulling in core's full barrel export is safe here (unlike
// client components, which must use core's client-safe subpath exports).
import { prisma } from "getbooqin-core";

export default prisma;
