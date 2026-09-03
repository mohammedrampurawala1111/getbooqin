/**
 * Regression test for the Defect Dossier's BQ-32 finding: a service could
 * only ever be switched inactive, never actually removed. Booking.serviceId
 * is a required, non-cascading foreign key, so hard-deleting a service a
 * booking still references would previously just throw a raw FK-violation
 * error — deleteServiceConfig() now soft-deletes instead whenever a booking
 * exists, and only hard-deletes when it's safe to.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";

const shop = `delete-service-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("deleteServiceConfig()", () => {
  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
  });

  it("hard-deletes a service with no bookings", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "svc-unused", title: "Unused Service", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "svc-unused", durationMin: 30 },
    });

    const result = await Data.deleteServiceConfig(shop, service.id);
    expect(result).toEqual({ hardDeleted: true, referencedBookings: 0 });
    expect(await prisma.serviceConfig.findFirst({ where: { shop, id: service.id } })).toBeNull();
  });

  it("soft-deletes a service with bookings, keeping it resolvable but hidden from active listings", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p2", productHandle: "svc-used", title: "Used Service", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p2", productHandle: "svc-used", durationMin: 30 },
    });
    const customer = await prisma.customer.create({
      data: { shop, platform, firstName: "Past", lastName: "Customer", email: "past@example.com" },
    });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "R1" } });
    await prisma.booking.create({
      data: {
        shop, platform, uid: "delete-test-" + Date.now(), serviceId: service.id, resourceId: resource.id, customerId: customer.id,
        startUtc: new Date(Date.now() - 86400000), endUtc: new Date(Date.now() - 86400000 + 1800000),
        timezone: "UTC", status: "completed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
      },
    });

    const result = await Data.deleteServiceConfig(shop, service.id);
    expect(result).toEqual({ hardDeleted: false, referencedBookings: 1 });

    const row = await prisma.serviceConfig.findFirst({ where: { shop, id: service.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.status).toBe(false);

    const active = await Data.catalogServices(shop, platform, false);
    expect(active.find((s) => s.id === service.id)).toBeUndefined();

    // Still resolvable by direct lookup, so a past booking can show its name.
    const direct = await Data.catalogService(shop, service.id);
    expect(direct?.name).toBe("Used Service");
  });

  it("reports the exact referencing-booking count so a confirmation dialog can phrase it honestly", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p3", productHandle: "svc-multi", title: "Multi Service", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p3", productHandle: "svc-multi", durationMin: 30 },
    });
    const customer = await prisma.customer.create({
      data: { shop, platform, firstName: "Multi", lastName: "Customer", email: "multi@example.com" },
    });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "R2" } });
    for (let i = 0; i < 3; i++) {
      await prisma.booking.create({
        data: {
          shop, platform, uid: `delete-multi-${Date.now()}-${i}`, serviceId: service.id, resourceId: resource.id, customerId: customer.id,
          startUtc: new Date(Date.now() - 86400000 * (i + 1)), endUtc: new Date(Date.now() - 86400000 * (i + 1) + 1800000),
          timezone: "UTC", status: "completed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
        },
      });
    }

    expect(await Data.bookingCountForService(shop, service.id)).toBe(3);
    const result = await Data.deleteServiceConfig(shop, service.id);
    expect(result).toEqual({ hardDeleted: false, referencedBookings: 3 });
  });
});
