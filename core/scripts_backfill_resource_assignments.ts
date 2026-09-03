// One-off backfill for resourcesForService()'s removed "fall back to every
// active resource" behaviour (Defect Dossier's R2-04 finding, still open
// after two rounds specifically because of that fallback). Every
// ServiceConfig row with zero ServiceResource rows used to be silently
// bookable by every active resource; now zero rows means zero resources,
// full stop, so any such row created before this fix shipped would go
// dark the moment the new code starts serving.
//
// Assigns every currently-active resource to every active service that has
// zero ServiceResource rows (regardless of the old resourceAssignmentCustomized
// flag — that distinction no longer matters now that there's no fallback to
// tell apart from). A business with zero active resources is left alone
// (nothing to assign yet); it gets assigned correctly the moment its first
// resource is created, same as onboarding and the "Add resource" form both
// already do.
//
// Wired into the Docker image's boot sequence (see Dockerfile), right after
// `prisma migrate deploy` and before the server starts — idempotent, so
// running it on every boot is harmless; it's a no-op once existing data is
// caught up.
//
// Can also be run manually from core/:
//   DATABASE_URL=... npx tsx scripts_backfill_resource_assignments.ts
import prisma from "./src/db.js";

async function main() {
  const services = await prisma.serviceConfig.findMany({
    where: { status: true },
    select: { id: true, shop: true, platform: true },
  });

  let touched = 0;
  let skippedNoResources = 0;

  for (const service of services) {
    const existingLinks = await prisma.serviceResource.count({ where: { shop: service.shop, serviceId: service.id } });
    if (existingLinks > 0) continue; // already has a real assignment — leave as-is

    const resources = await prisma.resource.findMany({
      where: { shop: service.shop, platform: service.platform, status: true },
      select: { id: true },
    });
    if (resources.length === 0) {
      skippedNoResources++;
      continue;
    }

    await prisma.serviceResource.createMany({
      data: resources.map((r) => ({ shop: service.shop, serviceId: service.id, resourceId: r.id })),
    });
    await prisma.serviceConfig.update({ where: { id: service.id }, data: { resourceAssignmentCustomized: true } });
    touched++;
  }

  console.log(
    `Backfilled resource assignment for ${touched} of ${services.length} unassigned service(s). ` +
      `${skippedNoResources} skipped (shop has no active resources yet).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
