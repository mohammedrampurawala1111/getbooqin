/**
 * Tiny in-process event bus — the equivalent of WordPress's do_action/add_action.
 * PaymentManager, MeetingManager and Mailer each subscribe from their own
 * `init()`, called once from core/src/booking/boot.ts.
 */
import { EventEmitter } from "node:events";
import type { Booking } from "@prisma/client";

export interface GetBooqinEvents {
  booking_created: [booking: Booking];
  booking_status_changed: [booking: Booking, oldStatus: string, newStatus: string, reason: string];
  booking_cancelled: [booking: Booking, reason: string];
  booking_rescheduled: [booking: Booking, previous: Booking];
  booking_deleted: [booking: Booking];
  payment_completed: [booking: Booking, paymentId: number];
  paid_booking_cancelled: [booking: Booking, reason: string];
  meeting_created: [booking: Booking, meeting: { url: string; id?: string }];
  meeting_failed: [booking: Booking, error: string];
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
