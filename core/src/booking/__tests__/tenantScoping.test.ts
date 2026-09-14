/**
 * One tenant must never be able to write another tenant's rows.
 *
 * `Resource.id` and `ServiceConfig.id` are global autoincrements, shared
 * across every business on the platform. An id taken from a URL is
 * therefore a guess at somebody else's row, and a save that trusts it
 * does not merely leak data — because the write carries the *caller's*
 * shop, it re-parents the row into the attacker's business, where it
 * disappears from the victim's lists, their availability, and every
 * future booking.
 *
 * These tests exist because exactly that was possible: the resource
 * edit route validated ownership in its loader and not in its action.
 * The guard now lives in the core function, so it holds however the
 * function is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";

const RUN = Date.now();
const victim = { shop: `victim-${RUN}`, platform: "manual" };
const attacker = { shop: `attacker-${RUN}`, platform: "manual" };

let victimResourceId = 0;
let victimServiceId = 0;

beforeAll(async () => {
  const resource = await prisma.resource.create({
    data: { ...victim, name: "Victim's practitioner", status: true },
  });
  victimResourceId = resource.id;

  await prisma.productCache.create({
    data: { ...victim, productId: `p-${RUN}`, productHandle: `h-${RUN}`, title: "Victim's service", price: 100 },
  });
  const service = await prisma.serviceConfig.create({
    data: { ...victim, productId: `p-${RUN}`, productHandle: `h-${RUN}`, durationMin: 30, status: true },
  });
  victimServiceId = service.id;
});

afterAll(async () => {
  for (const tenant of [victim, attacker]) {
    await prisma.serviceConfig.deleteMany({ where: { shop: tenant.shop } });
    await prisma.productCache.deleteMany({ where: { shop: tenant.shop } });
    await prisma.resource.deleteMany({ where: { shop: tenant.shop } });
  }
});

describe("resources", () => {
  it("refuses a save aimed at another shop's resource", async () => {
    await expect(
      Data.saveResource(attacker.shop, attacker.platform, { name: "Stolen" }, victimResourceId)
    ).rejects.toMatchObject({ code: "getbooqin_not_found" });
  });

  it("leaves the victim's resource exactly as it was", async () => {
    // The damage was not a leak. `UPDATE Resource SET shop='attacker'
    // WHERE id=42` moved the row, and the practitioner simply vanished
    // from the business that owned them.
    await Data.saveResource(attacker.shop, attacker.platform, { name: "Stolen" }, victimResourceId).catch(() => {});

    const row = await prisma.resource.findUnique({ where: { id: victimResourceId } });
    expect(row?.shop).toBe(victim.shop);
    expect(row?.name).toBe("Victim's practitioner");
  });

  it("still lets a shop edit its own resource", async () => {
    const own = await Data.saveResource(attacker.shop, attacker.platform, { name: "Mine" });

    const renamed = await Data.saveResource(attacker.shop, attacker.platform, { name: "Mine, renamed" }, own.id);

    expect(renamed.name).toBe("Mine, renamed");
    expect(renamed.shop).toBe(attacker.shop);
  });
});

describe("services", () => {
  it("refuses a save aimed at another shop's service", async () => {
    await expect(
      Data.saveServiceConfig(attacker.shop, attacker.platform, { duration_min: 15 }, victimServiceId)
    ).rejects.toMatchObject({ code: "getbooqin_not_found" });
  });

  it("leaves the victim's service where it belongs", async () => {
    await Data.saveServiceConfig(attacker.shop, attacker.platform, { duration_min: 15 }, victimServiceId).catch(
      () => {}
    );

    const row = await prisma.serviceConfig.findUnique({ where: { id: victimServiceId } });
    expect(row?.shop).toBe(victim.shop);
    expect(row?.durationMin).toBe(30);
  });
});
