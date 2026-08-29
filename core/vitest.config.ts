import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests hit a real local Postgres (see .env / scripts_seed_local.ts —
    // this workspace doesn't mock Prisma), so DATABASE_URL has to be on
    // process.env before db.ts's `new PrismaClient()` runs. Loading .env
    // here means `npm test` works the same way `npm run prisma:migrate`
    // already does, without every contributor having to export it by hand.
    setupFiles: ["./vitest.setup.ts"],
  },
});
