/**
 * Handing out the next invoice number in a series.
 *
 * India requires invoice numbers to be **consecutive** within a
 * financial year. That makes this one of the few places in the codebase
 * where "two requests got the same value" is not a bug you can paper
 * over later — a duplicate number is what an auditor opens with, and a
 * number issued twice cannot be un-issued.
 *
 * So it is a single statement holding a row lock, not a read followed
 * by a write. `UPDATE … RETURNING` is atomic against concurrent
 * callers: two webhooks arriving in the same millisecond serialise on
 * the row and get consecutive numbers, rather than both reading 4 and
 * both writing 5.
 *
 * The caller passes its own transaction, so the number and the Invoice
 * row that uses it commit together. A number handed out and then not
 * used leaves a gap, and a gap in a consecutive series needs explaining
 * — so the two must not be able to come apart.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";

/** How many digits the running number is padded to: GB/2026-27/0001. */
const WIDTH = 4;

export async function nextInvoiceNumber(
  series: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  // One statement: insert the series if this is its first invoice,
  // otherwise increment it, and return whichever number this caller got.
  // ON CONFLICT … DO UPDATE takes the row lock, which is what serialises
  // concurrent callers.
  const rows = await db.$queryRaw<{ next: number }[]>`
    INSERT INTO "InvoiceCounter" ("series", "next", "updatedAt")
    VALUES (${series}, 2, now())
    ON CONFLICT ("series") DO UPDATE
      SET "next" = "InvoiceCounter"."next" + 1,
          "updatedAt" = now()
    RETURNING "next" - 1 AS "next"
  `;

  const value = rows[0]?.next;
  if (typeof value !== "number") {
    throw new Error(`Could not allocate an invoice number in series ${series}`);
  }

  return `${series}/${String(value).padStart(WIDTH, "0")}`;
}
