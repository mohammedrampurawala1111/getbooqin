/**
 * GetBooqin clinic audit's PT-01 finding: eraseCustomerData() always
 * pseudonymized in place, even for a customer with zero booking or
 * waitlist history — the "permanently erased... this can't be undone"
 * confirmation dialog was only true for that case after this fix. A
 * customer with real history still can't be hard-deleted (Booking/
 * Waitlist.customerId are required, non-cascading foreign keys), so that
 * path is unchanged. Also covers PT-01's default-list filtering
 * (customers()/customersCount() excluding the pseudonymization marker) and
 * PB-03's placeholder-email synthesis for a customer with no email.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";

const shop = `customer-erasure-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("eraseCustomerData (PT-01)", () => {
  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
  });

  it("hard-deletes a customer with no booking or waitlist history at all", async () => {
    const id = await Data.findOrCreateCustomer(shop, platform, { first_name: "Mistake", email: "mistake@example.com" });
    expect(await Data.customerHasHistory(shop, id)).toBe(false);

    const result = await Data.eraseCustomerData(shop, id);
    expect(result.hardDeleted).toBe(true);
    expect(await Data.customer(shop, id)).toBeNull();
  });

  it("pseudonymizes, rather than hard-deletes, a customer with real booking history", async () => {
    const id = await Data.findOrCreateCustomer(shop, platform, { first_name: "Has", last_name: "History", email: "has-history@example.com" });
    const service = await Data.saveServiceConfig(shop, platform, { product_id: `p-${id}`, product_handle: `p-${id}`, duration_min: 30 });
    const resource = await Data.saveResource(shop, platform, { name: "Dr. Test", schedule: [], service_ids: [service.id] });
    await prisma.booking.create({
      data: {
        shop, platform, uid: `erasure-test-${id}`, serviceId: service.id, resourceId: resource.id, customerId: id,
        startUtc: new Date(Date.now() + 86_400_000), endUtc: new Date(Date.now() + 86_400_000 + 1_800_000),
        timezone: "UTC", status: "confirmed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required", source: "form",
      },
    });
    expect(await Data.customerHasHistory(shop, id)).toBe(true);

    const result = await Data.eraseCustomerData(shop, id);
    expect(result.hardDeleted).toBe(false);
    const row = await Data.customer(shop, id);
    expect(row).not.toBeNull();
    expect(row!.firstName).toBe("Deleted");
    expect(row!.lastName).toBe("client");
    expect(row!.email).toBe(`erased-${id}@getbooqin.invalid`);
  });

  it("excludes a pseudonymized tombstone from the default customers list and count, without hiding a real contactless customer", async () => {
    const tombstoneId = await Data.findOrCreateCustomer(shop, platform, { first_name: "Tombstone", email: "tombstone@example.com" });
    const service = await Data.saveServiceConfig(shop, platform, { product_id: `p-tomb-${tombstoneId}`, product_handle: `p-tomb-${tombstoneId}`, duration_min: 30 });
    const resource = await Data.saveResource(shop, platform, { name: "Dr. Tomb", schedule: [], service_ids: [service.id] });
    await prisma.booking.create({
      data: {
        shop, platform, uid: `tombstone-${tombstoneId}`, serviceId: service.id, resourceId: resource.id, customerId: tombstoneId,
        startUtc: new Date(Date.now() + 86_400_000), endUtc: new Date(Date.now() + 86_400_000 + 1_800_000),
        timezone: "UTC", status: "confirmed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required", source: "form",
      },
    });
    await Data.eraseCustomerData(shop, tombstoneId);

    // A legitimately contactless customer (PB-03: no email given) also gets
    // a *.invalid placeholder address — must not be swept up by the same
    // filter, which keys on the "Deleted"/"client" name marker instead.
    const contactlessId = await Data.findOrCreateCustomer(shop, platform, { first_name: "Walk-in", phone: "9325705315" });

    const list = await Data.customers(shop, platform);
    expect(list.some((c) => c.id === tombstoneId)).toBe(false);
    expect(list.some((c) => c.id === contactlessId)).toBe(true);

    const countBefore = await Data.customersCount(shop, platform);
    expect(countBefore).toBe(list.length);
  });
});

describe("findOrCreateCustomer placeholder synthesis (PB-03)", () => {
  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { shop: `${shop}-placeholder` } });
  });

  it("synthesizes a phone-keyed placeholder email, and resolves the same phone back to the same record", async () => {
    const phShop = `${shop}-placeholder`;
    const first = await Data.findOrCreateCustomer(phShop, platform, { first_name: "Walk-in", phone: "9325705315" });
    const second = await Data.findOrCreateCustomer(phShop, platform, { first_name: "Walk-in", phone: "9325705315" });
    expect(second).toBe(first);

    const row = await Data.customer(phShop, first);
    expect(row!.email).toBe("phone-9325705315@getbooqin.invalid");
  });
});
