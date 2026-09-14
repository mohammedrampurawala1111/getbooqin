/**
 * Invoice numbering.
 *
 * The requirement is consecutive numbers within a financial year, and
 * the failure mode is not a wrong pixel — it is two customers holding
 * documents with the same invoice number, which cannot be undone after
 * the fact. So this tests the thing that actually breaks it:
 * concurrency.
 *
 * Real Postgres, because the atomicity being tested *is* the database's.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { nextInvoiceNumber } from "../invoiceNumber.js";
import { financialYear, seriesFor } from "../seller.js";

const SERIES = `TEST/${Date.now()}`;

beforeEach(async () => {
  await prisma.invoiceCounter.deleteMany({ where: { series: { startsWith: "TEST/" } } });
});

afterAll(async () => {
  await prisma.invoiceCounter.deleteMany({ where: { series: { startsWith: "TEST/" } } });
});

describe("allocation", () => {
  it("starts at 1 and pads to four digits", async () => {
    expect(await nextInvoiceNumber(SERIES)).toBe(`${SERIES}/0001`);
  });

  it("counts up", async () => {
    expect(await nextInvoiceNumber(SERIES)).toBe(`${SERIES}/0001`);
    expect(await nextInvoiceNumber(SERIES)).toBe(`${SERIES}/0002`);
    expect(await nextInvoiceNumber(SERIES)).toBe(`${SERIES}/0003`);
  });

  it("never hands the same number to two callers at once", async () => {
    // The case that matters. A read-then-write would give several of
    // these the same number, and two customers would hold documents
    // claiming to be the same invoice.
    const numbers = await Promise.all(Array.from({ length: 25 }, () => nextInvoiceNumber(SERIES)));

    expect(new Set(numbers).size).toBe(25);
    expect(numbers.sort()).toEqual(
      Array.from({ length: 25 }, (_, i) => `${SERIES}/${String(i + 1).padStart(4, "0")}`)
    );
  });

  it("keeps series independent of each other", async () => {
    const other = `${SERIES}-other`;
    await nextInvoiceNumber(SERIES);
    await nextInvoiceNumber(SERIES);

    expect(await nextInvoiceNumber(other)).toBe(`${other}/0001`);
    expect(await nextInvoiceNumber(SERIES)).toBe(`${SERIES}/0003`);
  });
});

describe("the Indian financial year", () => {
  it("runs April to March, not January to December", async () => {
    // A calendar-year series is a numbering run no Indian auditor
    // recognises.
    expect(financialYear(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2026-09-13T00:00:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2027-03-31T23:59:59Z"))).toBe("2026-27");
    // One second later is a new year, and a new series.
    expect(financialYear(new Date("2027-04-01T00:00:00Z"))).toBe("2027-28");
  });

  it("handles a January date as the previous April's year", async () => {
    expect(financialYear(new Date("2027-01-15T00:00:00Z"))).toBe("2026-27");
  });

  it("rolls the century over without producing 2099-100", async () => {
    expect(financialYear(new Date("2099-06-01T00:00:00Z"))).toBe("2099-00");
  });

  it("builds the series from the seller's prefix", async () => {
    const seller = { seriesPrefix: "GB" } as Parameters<typeof seriesFor>[0];
    expect(seriesFor(seller, new Date("2026-09-13T00:00:00Z"))).toBe("GB/2026-27");
  });
});
