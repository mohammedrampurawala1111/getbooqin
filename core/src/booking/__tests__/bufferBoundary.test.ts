/**
 * Regression test for the Defect Dossier's BQ-06 finding: generateSlots()
 * checked a slot's raw duration against the working window, but never the
 * service's own buffer_before_min/buffer_after_min — so a service with a
 * 30-minute buffer-after could still be offered a start time whose buffer
 * period ran past closing, and a buffer-before could be offered a start
 * whose buffer period would need to begin before opening.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Availability from "../availability.js";
import * as Settings from "../settings.js";

const shop = `buffer-boundary-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
const testDate = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

let resourceId: number;

describe("generateSlots() respects buffers at the day's own open/close boundary", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 30, timezone: "UTC" });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "demo" } });
    resourceId = resource.id;
    // 09:00-18:00, every day, so testDate's actual weekday never matters.
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ shop, platform, resourceId, dayOfWeek: dow, startTime: "09:00", endTime: "18:00" })),
    });
  });

  afterAll(async () => {
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  async function makeService(handle: string, opts: { bufferBeforeMin?: number; bufferAfterMin?: number }) {
    await prisma.productCache.create({ data: { shop, platform, productId: handle, productHandle: handle, title: handle, price: 10 } });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: handle, productHandle: handle, durationMin: 30, status: true, ...opts },
    });
    await prisma.serviceResource.create({ data: { shop, platform, serviceId: service.id, resourceId } });
    return service.id;
  }

  it("does not offer the last slot of the day when its buffer-after would run past closing", async () => {
    const serviceId = await makeService("buffer-after-30", { bufferAfterMin: 30 });
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resourceId, testDate);
    const times = slots.map((s) => s.time);
    // 30 min service + 30 min buffer-after = needs the resource until
    // start+60min; closing is 18:00, so the latest offerable start is
    // 17:00, not 17:30.
    expect(times).not.toContain("17:30");
    expect(times).toContain("17:00");
  });

  it("does not offer the first slot of the day when its buffer-before would need to start before opening", async () => {
    const serviceId = await makeService("buffer-before-30", { bufferBeforeMin: 30 });
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resourceId, testDate);
    const times = slots.map((s) => s.time);
    // Opening is 09:00; a 30-min buffer-before means the earliest offerable
    // start is 09:30, not 09:00.
    expect(times).not.toContain("09:00");
    expect(times).toContain("09:30");
  });

  it("respects both buffers at once", async () => {
    const serviceId = await makeService("buffer-both-30", { bufferBeforeMin: 30, bufferAfterMin: 30 });
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resourceId, testDate);
    const times = slots.map((s) => s.time);
    expect(times).not.toContain("09:00");
    expect(times).not.toContain("17:30");
    expect(times).toContain("09:30");
    expect(times).toContain("17:00");
  });
});
