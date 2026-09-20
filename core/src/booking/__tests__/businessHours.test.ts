/**
 * "When are you open?" — asked on Settings, stored per resource.
 *
 * The write is the part worth pinning down, because it overwrites every
 * active resource's schedule. For the one-person account this exists
 * for that is invisible and right; for three staff on different shifts
 * it is destructive, which is why the Settings card warns before
 * offering it. These tests hold the behaviour the warning describes.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";

const RUN = Date.now();
const shop = `hours-${RUN}`;
const platform = "manual";

async function makeResource(name: string, status = true) {
  const row = await prisma.resource.create({ data: { shop, platform, name, status } });
  return row.id;
}

const WEEKDAYS_9_TO_5 = [
  { day: 0, open: false, start: "", end: "" },
  { day: 1, open: true, start: "09:00", end: "17:00" },
  { day: 2, open: true, start: "09:00", end: "17:00" },
  { day: 3, open: true, start: "09:00", end: "17:00" },
  { day: 4, open: true, start: "09:00", end: "17:00" },
  { day: 5, open: true, start: "09:00", end: "17:00" },
  { day: 6, open: false, start: "", end: "" },
];

beforeEach(async () => {
  await prisma.schedule.deleteMany({ where: { shop } });
  await prisma.resource.deleteMany({ where: { shop } });
});

afterAll(async () => {
  await prisma.schedule.deleteMany({ where: { shop } });
  await prisma.resource.deleteMany({ where: { shop } });
});

describe("setting hours for a one-person business", () => {
  it("writes the open days and skips the closed ones", async () => {
    await makeResource("Owner");

    const { resourcesUpdated } = await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    expect(resourcesUpdated).toBe(1);
    const rows = await prisma.schedule.findMany({ where: { shop } });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.dayOfWeek).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads back as the same week", async () => {
    // businessHours() is the read side of the same idea, and the two
    // drifting would mean a merchant sees something other than what they
    // saved.
    await makeResource("Owner");
    await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    const hours = await Data.businessHours(shop, platform);

    expect(hours.find((d) => d.dayOfWeek === 1)).toMatchObject({ open: true, start: "09:00", end: "17:00" });
    expect(hours.find((d) => d.dayOfWeek === 0)).toMatchObject({ open: false });
  });

  it("closing a day removes it rather than leaving a stale row", async () => {
    await makeResource("Owner");
    await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    await Data.setBusinessHours(
      shop,
      platform,
      WEEKDAYS_9_TO_5.map((d) => (d.day === 3 ? { ...d, open: false } : d))
    );

    const hours = await Data.businessHours(shop, platform);
    expect(hours.find((d) => d.dayOfWeek === 3)!.open).toBe(false);
    expect(await prisma.schedule.count({ where: { shop } })).toBe(4);
  });

  it("refuses a day whose end is not after its start", async () => {
    // Otherwise the availability engine is handed a window it cannot
    // make a single slot out of, and the day silently offers nothing.
    await makeResource("Owner");

    await Data.setBusinessHours(shop, platform, [{ day: 1, open: true, start: "17:00", end: "09:00" }]);

    expect(await prisma.schedule.count({ where: { shop } })).toBe(0);
  });
});

describe("what it does to more than one resource", () => {
  it("applies the same pattern to all of them — the thing the card warns about", async () => {
    await makeResource("Alex");
    await makeResource("Sam");

    const { resourcesUpdated } = await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    expect(resourcesUpdated).toBe(2);
    expect(await prisma.schedule.count({ where: { shop } })).toBe(10);
  });

  it("leaves a deactivated resource's schedule alone", async () => {
    // A deactivated practitioner is not part of the business's hours,
    // and rewriting their schedule would quietly change what
    // reactivating them does.
    const active = await makeResource("Alex");
    const inactive = await makeResource("Former colleague", false);
    await Data.setSchedule(shop, inactive, [{ day: 6, start: "10:00", end: "14:00" }]);

    await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    const theirs = await prisma.schedule.findMany({ where: { shop, resourceId: inactive } });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ dayOfWeek: 6, startTime: "10:00" });
    expect(await prisma.schedule.count({ where: { shop, resourceId: active } })).toBe(5);
  });

  it("reports nothing updated when there is nothing bookable", async () => {
    // A real state, and one the Settings action turns into an error
    // rather than a silent success — saving hours onto nothing would
    // leave a merchant with a booking page that offers no times.
    const { resourcesUpdated } = await Data.setBusinessHours(shop, platform, WEEKDAYS_9_TO_5);

    expect(resourcesUpdated).toBe(0);
  });
});

describe("activeResourceCount", () => {
  it("counts only what can actually be booked", async () => {
    await makeResource("Alex");
    await makeResource("Sam");
    await makeResource("Former colleague", false);

    expect(await Data.activeResourceCount(shop, platform)).toBe(2);
  });
});
