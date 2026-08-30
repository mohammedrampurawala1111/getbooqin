/**
 * Tiny in-process event bus — the equivalent of WordPress's do_action/add_action.
 * PaymentManager, MeetingManager and Mailer each subscribe from their own
 * `init()`, called once from core/src/booking/boot.ts.
 */
import { EventEmitter } from "node:events";
import type { Booking, Waitlist } from "@prisma/client";

export interface FreedSlot {
  shop: string;
  platform: string;
  serviceId: number;
  resourceId: number;
  startUtc: Date;
  endUtc: Date;
}

export interface GetBooqinEvents {
  booking_created: [booking: Booking];
  booking_status_changed: [booking: Booking, oldStatus: string, newStatus: string, reason: string];
  booking_cancelled: [booking: Booking, reason: string];
  booking_rescheduled: [booking: Booking, previous: Booking];
  booking_deleted: [booking: Booking];
  // Fired when a booking stops occupying its slot early — cancelled,
  // declined, or marked no-show (not "completed", which is a normal
  // conclusion, not a vacancy to recover) — or a reschedule vacates its
  // original slot. See Bookings.setStatus()/reschedule() and
  // Waitlist.init()'s listener.
  booking_slot_freed: [freed: FreedSlot];
  payment_completed: [booking: Booking, paymentId: number];
  paid_booking_cancelled: [booking: Booking, reason: string];
  meeting_created: [booking: Booking, meeting: { url: string; id?: string }];
  meeting_failed: [booking: Booking, error: string];
  waitlist_offered: [entry: Waitlist];
  waitlist_expired: [entry: Waitlist];
  waitlist_claimed: [entry: Waitlist, booking: Booking];
}

class TypedBus extends EventEmitter {
  emitEvent<K extends keyof GetBooqinEvents>(event: K, ...args: GetBooqinEvents[K]) {
    return super.emit(event as string, ...args);
  }
  onEvent<K extends keyof GetBooqinEvents>(event: K, listener: (...args: GetBooqinEvents[K]) => void | Promise<void>) {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }
}

const bus = new TypedBus();
bus.setMaxListeners(50);

export default bus;
