/**
 * "Send yourself a test booking."
 *
 * The gap this closes is a confidence one. A merchant finishing setup
 * has a booking page they have never seen work, and the only way to
 * find out whether it does is to wait for a stranger to try it. That is
 * a bad first day, and it is where people quietly stop.
 *
 * One click puts a real booking through the real path — the same
 * create() a customer's form submission calls, the same
 * `booking_created` event, the same confirmation email with the same
 * .ics attached, the same row in the same calendar. Nothing about it is
 * simulated, which is the point: a mock that always succeeds tells the
 * merchant nothing about whether *their* setup works.
 *
 * It is deliberately a genuine booking, quota and all. A "free" test
 * booking would mean a second code path through create() whose only
 * purpose is to behave differently from the real one — exactly the
 * thing that lets the real one break unnoticed.
 */
import { DateTime } from "luxon";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Bookings from "./bookings.js";
import * as Availability from "./availability.js";
import { getSettings } from "./settings.js";
import { isEmail } from "./bookingsShared.js";
import { GetBooqinError } from "./errors.js";

export interface TestBookingResult {
  uid: string;
  serviceName: string;
  resourceName: string;
  /** Already localized to the business's timezone, ready to show. */
  when: string;
  /** Where the confirmation went. */
  email: string;
  status: string;
}

/** The note left on the booking, so it is obvious in the calendar what it is. */
export const TEST_BOOKING_NOTE = "Test booking you sent yourself during setup — safe to cancel.";

export async function createTestBooking(connectionId: string): Promise<TestBookingResult> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    include: { user: { select: { email: true } } },
  });
  if (!connection) throw new GetBooqinError("getbooqin_not_found", "Business not found.", 404);

  const email = connection.user.email;
  if (!isEmail(email)) {
    throw new GetBooqinError("getbooqin_invalid_email", "Your account has no valid email address to send to.", 400);
  }

  const { shop, platform } = connection;
  const settings = await getSettings(shop, platform);
  const tz = settings.timezone || "UTC";

  const services = await Data.catalogServices(shop, platform, true);
  const service = services[0];
  if (!service) {
    throw new GetBooqinError(
      "getbooqin_no_service",
      `Add a ${(settings.terms?.service_single || "service").toLowerCase()} first — there is nothing to book yet.`,
      400
    );
  }

  const resources = await Data.resourcesForService(shop, platform, service.id);
  const resourceId = resources[0]?.id ?? 0;

  const slot = await firstOpenSlot(shop, platform, tz, service.id, resourceId);

  const booking = await Bookings.create(shop, platform, tz, {
    service_id: service.id,
    resource_id: resourceId,
    date: slot.date,
    time: slot.time,
    first_name: "Test",
    last_name: "Booking",
    email,
    notes: TEST_BOOKING_NOTE,
    // Not "form": the quota meters that source, so a merchant's own
    // setup test would come off the allowance their customers are
    // supposed to have. It still goes through the real create() — the
    // point is that nothing about the path is simulated, not that it is
    // free of every consequence.
    source: "test",
    // Set only on the fallback below, where no open slot exists and the
    // alternative is telling the merchant their booking page doesn't
    // work when what they actually have is empty opening hours.
    override: slot.override,
  });

  return {
    uid: booking.uid,
    serviceName: service.name,
    resourceName: resources[0]?.name ?? "",
    when: DateTime.fromJSDate(booking.startUtc, { zone: "utc" }).setZone(tz).toFormat("ccc d LLL 'at' HH:mm"),
    email,
    status: booking.status,
  };
}

/**
 * The next slot the booking page would actually offer, or — when there
 * are none — tomorrow morning as an explicit override.
 *
 * The fallback matters more than it looks. A merchant who has not set
 * their opening hours yet has no available slots at all, and that is
 * the most likely state at exactly the moment this button is pressed.
 * Refusing there would demonstrate a broken product to someone who has
 * merely not finished configuring it.
 */
async function firstOpenSlot(
  shop: string,
  platform: string,
  tz: string,
  serviceId: number,
  resourceId: number
): Promise<{ date: string; time: string; override: boolean }> {
  const days = await Availability.nextAvailableDays(shop, platform, tz, serviceId, resourceId, 1);
  const day = days[0];

  if (day) {
    const slots = await Availability.slots(shop, platform, tz, serviceId, resourceId, day.date);
    const open = slots.find((s) => s.available !== false);
    if (open) return { date: day.date, time: open.time, override: false };
  }

  const tomorrow = DateTime.now().setZone(tz).plus({ days: 1 }).set({ hour: 10, minute: 0 });
  return { date: tomorrow.toFormat("yyyy-MM-dd"), time: "10:00", override: true };
}
