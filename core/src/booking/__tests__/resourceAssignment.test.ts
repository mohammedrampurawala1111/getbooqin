/**
 * Regression test for the Defect Dossier's R2-04 finding (still open after
 * two rounds): resourcesForService() used to fall back to every active
 * resource for a service nobody had ever explicitly assigned, so two
 * identically-empty "Who can deliver this" boxes behaved oppositely
 * depending on unrelated history nobody could see — one merchant's
 * unconfigured service was quietly bookable by everyone, another's
 * identical-looking one (explicitly emptied) was bookable by nobody.
 * There is no more fallback: zero rows always means zero resources.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";

const shop = `resource-assignment-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("resourcesForService() has no implicit fallback", () => {
  afterAll(async () => {
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
  });

  it("returns nobody for a service that has never had a resource assigned, even though active resources exist", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "svc-a", title: "Service A", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "svc-a", durationMin: 30 },
    });
    await prisma.resource.create({ data: { shop, platform, name: "Solo Resource" } });

    const result = await Data.resourcesForService(shop, platform, service.id);
    expect(result).toEqual([]);
  });

  it("returns exactly the assigned resource once one is explicitly linked", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p2", productHandle: "svc-b", title: "Service B", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p2", productHandle: "svc-b", durationMin: 30 },
    });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Other Resource" } });

    await Data.setServiceResources(shop, service.id, [resource.id]);

    const result = await Data.resourcesForService(shop, platform, service.id);
    expect(result.map((r) => r.id)).toEqual([resource.id]);
  });

  it("setResourceServices keeps the mapping in sync from the resource side too, including unassigning", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p3", productHandle: "svc-c", title: "Service C", price: 10 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p3", productHandle: "svc-c", durationMin: 30 },
    });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Fickle Resource" } });

    await Data.setResourceServices(shop, resource.id, [service.id]);
    let result = await Data.resourcesForService(shop, platform, service.id);
    expect(result.map((r) => r.id)).toEqual([resource.id]);

    await Data.setResourceServices(shop, resource.id, []);
    result = await Data.resourcesForService(shop, platform, service.id);
    expect(result).toEqual([]);
  });

  it("unbookableServiceIds() flags any active service with zero resource links", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p4", productHandle: "svc-d", title: "Service D", price: 10 },
    });
    const unassigned = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p4", productHandle: "svc-d", durationMin: 30, status: true },
    });
    await prisma.productCache.create({
      data: { shop, platform, productId: "p5", productHandle: "svc-e", title: "Service E", price: 10 },
    });
    const assigned = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p5", productHandle: "svc-e", durationMin: 30, status: true },
    });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Assigned Resource" } });
    await Data.setServiceResources(shop, assigned.id, [resource.id]);

    const unbookable = await Data.unbookableServiceIds(shop, platform);
    expect(unbookable.has(unassigned.id)).toBe(true);
    expect(unbookable.has(assigned.id)).toBe(false);
  });
});
