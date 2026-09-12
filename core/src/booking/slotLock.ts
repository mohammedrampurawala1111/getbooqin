/**
 * Phase 0 / B2 — the double-booking race.
 *
 * `Bookings.create()` used to check availability and then insert as two
 * separate, unguarded statements. Two customers clicking the last 10:00
 * slot at the same moment both passed the check (neither insert had
 * happened yet) and both got booked. This module holds the two halves of
 * the fix that live in the application; the third — an `EXCLUDE USING
 * gist` constraint per resource dimension — lives in
 * prisma/migrations/20260912090000_booking_overlap_exclusion.
 *
 * ## Why a lock and not just a transaction
 *
 * Wrapping check-and-insert in `prisma.$transaction` alone fixes nothing.
 * Postgres defaults to READ COMMITTED: two concurrent transactions each
 * run the availability SELECT, neither sees the other's uncommitted
 * INSERT, and both commit. There is no row to lock — the conflict is
 * about a row that does not exist yet. That leaves two real options:
 * SERIALIZABLE isolation with retry logic everywhere, or an explicit lock
 * taken before the check. The lock is far less invasive.
 *
 * ## Why the lock is per shop, not per slot
 *
 * A booking occupies more than the obvious thing. It occupies a
 * practitioner for its range *plus that service's before/after buffers*,
 * and — when the service requires one — a room chosen inside
 * `assertSlotBookable()`, which isn't known until the check runs. A
 * per-(resource, start-time) lock would miss both: the 45-minute booking
 * that overlaps a 10:15 start it doesn't share a start time with, and the
 * two different practitioners racing for the same last free room.
 *
 * Locking the whole shop's booking writes sidesteps all of it and has no
 * lock-ordering hazard to deadlock on. The cost is that one shop's booking
 * writes serialise — a few round-trips each, tens of milliseconds. For a
 * small business taking bookings minutes apart that is free; the lock is
 * per shop, so nothing about it is global.
 *
 * ## Why the database constraint as well
 *
 * The lock only protects writes that go through this code. The constraint
 * protects the table: a seed script, an import, a psql session, a future
 * code path that forgets. Between them, the lock produces a clean 409 for
 * the loser of a race, and the constraint makes the bad row impossible
 * even when nothing took the lock — translated back into the same 409 by
 * `translateOverlapViolation()` below rather than surfacing as a 500.
 */
import prisma, { type DbClient } from "../db.js";
import { GetBooqinError } from "./errors.js";

/** Names must match the migration's — they are how a violation is recognised. */
export const RESOURCE_OVERLAP_CONSTRAINT = "Booking_resource_no_overlap";
export const ROOM_OVERLAP_CONSTRAINT = "Booking_room_no_overlap";

/** Postgres SQLSTATE for `exclusion_violation`. */
const EXCLUSION_VIOLATION = "23P01";

/**
 * Serialises every booking write for one shop against every other. Must be
 * called inside a transaction: `pg_advisory_xact_lock` releases on commit
 * or rollback, so there is no leaked-lock failure mode to reason about
 * (unlike `pg_advisory_lock`, which needs an explicit unlock and survives
 * a thrown exception).
 *
 * `hashtext` returns int4, so two shop domains can in principle share a
 * lock key. The consequence is a few milliseconds of pointless contention
 * between two unrelated shops, never a correctness problem — a shared lock
 * is stricter than needed, not looser.
 */
export async function lockShopBookings(db: DbClient, shop: string): Promise<void> {
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`, and
  // Prisma's $queryRaw deserialiser has no mapping for a void column —
  // it fails the statement outright rather than returning nothing.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"getbooqin:booking:" + shop}))`;
}

/**
 * Runs `fn` inside a transaction holding this shop's booking-write lock.
 * The callback gets a client it must use for everything it reads or
 * writes — a query issued through the global `prisma` import from in here
 * runs on a different connection and will not see the transaction's own
 * uncommitted rows.
 */
export function withShopBookingLock<T>(shop: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return translateOverlapViolation(() =>
    prisma.$transaction(
      async (tx) => {
        await lockShopBookings(tx, shop);
        return fn(tx);
      },
      {
        // Prisma's defaults (2s to get a connection, 5s to finish) are
        // tuned for a transaction that never waits on anything. This one
        // queues behind other writers for the same shop by design, so a
        // burst of simultaneous requests would otherwise start failing as
        // timeouts instead of queueing. The body itself is a handful of
        // indexed queries — if it is anywhere near these numbers,
        // something else is wrong and failing is the right outcome.
        maxWait: 10_000,
        timeout: 15_000,
      }
    )
  );
}

/**
 * Which exclusion constraint (if any) this error is a violation of.
 *
 * Prisma has no typed error for SQLSTATE 23P01 — it surfaces as a
 * `PrismaClientUnknownRequestError` whose `code`/`meta` are undefined and
 * whose message carries the raw `PostgresError { code: "23P01", … }`
 * payload. Matching on both the SQLSTATE and the constraint name means a
 * different 23P01 (from a constraint added later) won't be silently
 * reported to a customer as "that time was just taken".
 */
export function overlapViolationKind(err: unknown): "resource" | "room" | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message.includes(EXCLUSION_VIOLATION)) return null;
  if (message.includes(RESOURCE_OVERLAP_CONSTRAINT)) return "resource";
  if (message.includes(ROOM_OVERLAP_CONSTRAINT)) return "room";
  return null;
}

/**
 * The 409 the application already had a message for — `create()`,
 * `reschedule()` and `setStatus()` all throw `getbooqin_slot_taken` from
 * their own checks, and every caller (the public booking form's
 * re-fetch-the-day handler included) already knows that code.
 */
export function slotTakenError(kind: "resource" | "room"): GetBooqinError {
  return new GetBooqinError(
    "getbooqin_slot_taken",
    kind === "room"
      ? "Sorry, the room for that time was just taken. Please pick another slot."
      : "Sorry, that time was just taken. Please pick another slot.",
    409
  );
}

/**
 * Turns a raw exclusion-constraint violation into that 409 and re-throws
 * everything else untouched. Wrap any statement that can write a
 * pending/confirmed booking's resource, room or time range.
 */
export async function translateOverlapViolation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const kind = overlapViolationKind(err);
    if (!kind) throw err;
    // Reaching here means a write raced past the advisory lock — either it
    // never took one, or two processes are talking to the same database
    // through different code. Worth a log line: the customer gets a clean
    // "pick another slot", but the constraint firing at all is a signal.
    console.warn(`[getbooqin bookings] ${kind} overlap constraint rejected a booking write — the advisory lock did not cover this path`);
    throw slotTakenError(kind);
  }
}
