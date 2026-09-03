/**
 * Visit Summary business logic (Clinic preset only — see
 * docs/patient-summary-cloud-integration-plan.md). Operates on the
 * ConsultationSummary Prisma model and enforces the workflow state machine
 * described in the integration plan's Part 3 §4:
 *
 *   (none) -> draft -> under_review -> approved -> sent
 *                                          ^
 *                          unlockForEdit --'  (approved -> under_review)
 *
 * `discarded` is reachable from draft/under_review/approved (never from
 * sent). `approved` is an integrity boundary — updateEditedFields() and
 * acknowledgeFlag() both refuse to touch a row once it's approved;
 * unlockForEdit() is the only door back to under_review, and it clears the
 * prior attestation (approvedByResourceId/approvedAt) since it no longer
 * describes the content that will eventually be sent. `sent` is immutable
 * — the only way to correct a sent summary is createRevision(), which
 * creates a new row rather than mutating the sent one.
 *
 * Every entry point checks both the env-level VISIT_SUMMARIES_ENABLED flag
 * and the shop's own `settings.visit_summaries_enabled` — this feature is
 * off unless both are true (see featureFlags.ts and settingsShared.ts's
 * header comment on why it's deliberately not preset-controlled).
 */
import type { ConsultationSummary } from "@prisma/client";
import prisma from "../db.js";
import * as Bookings from "./bookings.js";
import * as Mailer from "./mailer.js";
import { getSettings } from "./settings.js";
import { GetBooqinError } from "./errors.js";
import { now } from "./ids.js";
import { VISIT_SUMMARIES_ENABLED } from "./featureFlags.js";
import { generatePatientSummary, type PatientSummaryDraft } from "../ai/patientSummary.js";

export const STATUSES = ["draft", "under_review", "approved", "sent", "discarded"] as const;
export type ConsultationSummaryStatus = (typeof STATUSES)[number];

const EDITABLE_STATUSES: ConsultationSummaryStatus[] = ["draft", "under_review"];
const TRANSCRIPT_SOURCES = ["paste", "upload", "record"] as const;
const OUTPUT_LANGUAGES = ["nl", "en", "auto"] as const;

/* -------------------------------------------------------------- Gating */

async function assertEnabled(shop: string, platform: string): Promise<void> {
  const settings = await getSettings(shop, platform);
  if (!VISIT_SUMMARIES_ENABLED || !settings.visit_summaries_enabled) {
    throw new GetBooqinError(
      "getbooqin_visit_summaries_disabled",
      "Visit Summary is not enabled for this shop.",
      403
    );
  }
}

/** Tenant-scoped row lookup — same (shop, id) convention as Bookings.get(), never a bare id. */
async function getRow(shop: string, id: number): Promise<ConsultationSummary> {
  const row = await prisma.consultationSummary.findFirst({ where: { shop, id } });
  if (!row) throw new GetBooqinError("getbooqin_not_found", "Visit summary not found.", 404);
  return row;
}

/* --------------------------------------------------------------- Parsing */

export function parseDraftJson(row: Pick<ConsultationSummary, "draftJson">): PatientSummaryDraft {
  return JSON.parse(row.draftJson) as PatientSummaryDraft;
}

export function parseEditedJson(row: Pick<ConsultationSummary, "editedJson">): PatientSummaryDraft {
  return JSON.parse(row.editedJson) as PatientSummaryDraft;
}

export function parseAcknowledgedFlags(row: Pick<ConsultationSummary, "reviewFlagsAcknowledged">): number[] {
  try {
    const parsed = JSON.parse(row.reviewFlagsAcknowledged || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- Create */

export interface CreateDraftArgs {
  shop: string;
  platform: string;
  bookingId: number;
  transcriptText: string;
  transcriptSource: "paste" | "upload" | "record";
  outputLanguage: "nl" | "en" | "auto";
}

/**
 * Drafts a new visit summary from a transcript. Requires the booking to
 * exist and be `completed` — the plan's UI only ever surfaces the entry
 * point on a completed booking (Part 3 §1), and this mirrors that as a real
 * server-side rule rather than trusting the client to only ask at the right
 * time. Refuses to start a second concurrent draft while an unresolved one
 * (draft/under_review/approved) already exists for the booking — discard or
 * send it first.
 */
export async function createDraft(args: CreateDraftArgs): Promise<ConsultationSummary> {
  await assertEnabled(args.shop, args.platform);

  if (!TRANSCRIPT_SOURCES.includes(args.transcriptSource)) {
    throw new GetBooqinError("getbooqin_invalid_transcript_source", "Unknown transcript source.", 400);
  }
  if (!OUTPUT_LANGUAGES.includes(args.outputLanguage)) {
    throw new GetBooqinError("getbooqin_invalid_output_language", "Unknown output language.", 400);
  }
  if (!args.transcriptText.trim()) {
    throw new GetBooqinError("getbooqin_empty_transcript", "Please provide a transcript to summarize.", 400);
  }

  const booking = await Bookings.get(args.shop, args.bookingId);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);
  if (booking.status !== "completed") {
    throw new GetBooqinError(
      "getbooqin_booking_not_completed",
      "A visit summary can only be created for a completed booking.",
      400
    );
  }

  const existing = await prisma.consultationSummary.findFirst({
    where: { shop: args.shop, platform: args.platform, bookingId: args.bookingId, status: { in: ["draft", "under_review", "approved"] } },
  });
  if (existing) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_in_progress",
      "A visit summary is already in progress for this booking. Discard or send it before starting another.",
      409
    );
  }

  const draft = await generatePatientSummary({ transcript: args.transcriptText, outputLanguage: args.outputLanguage });
  const draftJson = JSON.stringify(draft);

  return prisma.consultationSummary.create({
    data: {
      shop: args.shop,
      platform: args.platform,
      bookingId: args.bookingId,
      status: "draft",
      transcriptText: args.transcriptText,
      transcriptSource: args.transcriptSource,
      outputLanguage: args.outputLanguage,
      detectedLanguage: draft.detected_language,
      draftJson,
      editedJson: draftJson,
      reviewFlagsAcknowledged: "[]",
      createdAt: now(),
      updatedAt: now(),
    },
  });
}

/* ---------------------------------------------------------------- Reads */

export interface GetForBookingArgs {
  shop: string;
  platform: string;
  bookingId: number;
}

/** The most recent summary row for a booking (a fresh draft after a discard, or the current revision after a send), or null if none exists yet. */
export async function getForBooking(args: GetForBookingArgs): Promise<ConsultationSummary | null> {
  await assertEnabled(args.shop, args.platform);
  return prisma.consultationSummary.findFirst({
    where: { shop: args.shop, platform: args.platform, bookingId: args.bookingId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/* ----------------------------------------------------------------- Edit */

export interface UpdateEditedFieldsArgs {
  shop: string;
  id: number;
  editedJson: PatientSummaryDraft;
}

/** Saves clinician edits. First edit on a fresh draft also moves it into under_review. Refuses once approved — call unlockForEdit() first. */
export async function updateEditedFields(args: UpdateEditedFieldsArgs): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);
  assertEditable(row);

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: {
      editedJson: JSON.stringify(args.editedJson),
      status: row.status === "draft" ? "under_review" : row.status,
      updatedAt: now(),
    },
  });
}

export interface AcknowledgeFlagArgs {
  shop: string;
  id: number;
  flagIndex: number;
}

/** Checks off one entry in the review_flags banner (Part 3 §3) — approve() requires every entry acknowledged. */
export async function acknowledgeFlag(args: AcknowledgeFlagArgs): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);
  assertEditable(row);

  const acknowledged = new Set(parseAcknowledgedFlags(row));
  acknowledged.add(args.flagIndex);

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: {
      reviewFlagsAcknowledged: JSON.stringify([...acknowledged].sort((a, b) => a - b)),
      status: row.status === "draft" ? "under_review" : row.status,
      updatedAt: now(),
    },
  });
}

function assertEditable(row: ConsultationSummary): void {
  if (!EDITABLE_STATUSES.includes(row.status as ConsultationSummaryStatus)) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_locked",
      `Cannot edit a visit summary while it is "${row.status}". Unlock it first.`,
      400
    );
  }
}

/* ---------------------------------------------------------- State machine */

export interface ApproveArgs {
  shop: string;
  id: number;
  /** The attesting resource (doctor) id — see the plan's Part 3 §4 attestation step. */
  resourceId: number;
}

/** Approves a summary. Requires every entry in editedJson.review_flags to have been acknowledged first — the integrity boundary described in Part 3 §4. */
export async function approve(args: ApproveArgs): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (!EDITABLE_STATUSES.includes(row.status as ConsultationSummaryStatus)) {
    throw new GetBooqinError("getbooqin_bad_transition", `Cannot approve a visit summary from status "${row.status}".`, 400);
  }

  const edited = parseEditedJson(row);
  const acknowledged = new Set(parseAcknowledgedFlags(row));
  const allAcknowledged = edited.review_flags.every((_, index) => acknowledged.has(index));
  if (!allAcknowledged) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_flags_unacknowledged",
      "Every review flag must be acknowledged before this summary can be approved.",
      400
    );
  }

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: { status: "approved", approvedByResourceId: args.resourceId, approvedAt: now(), updatedAt: now() },
  });
}

/** Demotes an approved summary back to under_review so it can be edited. Clears the prior attestation — an [Approved] badge must never coexist with content that differs from what was actually approved. */
export async function unlockForEdit(args: { shop: string; id: number }): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (row.status !== "approved") {
    throw new GetBooqinError("getbooqin_bad_transition", `Cannot unlock a visit summary from status "${row.status}".`, 400);
  }

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: { status: "under_review", approvedByResourceId: null, approvedAt: null, updatedAt: now() },
  });
}

/** Sends the approved summary to the patient. The status transition commits even if the notification email fails to send — "sent" records that the content is finalized, independent of whether the email notification succeeded (same philosophy as the rest of mailer.ts's send* triggers). */
export async function send(args: { shop: string; id: number }): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (row.status !== "approved") {
    throw new GetBooqinError("getbooqin_bad_transition", `Cannot send a visit summary from status "${row.status}".`, 400);
  }

  const updated = await prisma.consultationSummary.update({
    where: { id: row.id },
    data: { status: "sent", sentAt: now(), updatedAt: now() },
  });

  try {
    await Mailer.sendVisitSummary(row.shop, row.platform, row.bookingId);
  } catch (error) {
    console.error(`[getbooqin visit-summary] failed to email visit summary ${row.id} for booking ${row.bookingId} (shop=${row.shop}):`, error);
  }

  return updated;
}

/** Discards a summary. Reachable from any pre-sent state; a sent summary is a permanent record and can only be corrected via createRevision(). */
export async function discard(args: { shop: string; id: number }): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (row.status === "sent" || row.status === "discarded") {
    throw new GetBooqinError("getbooqin_bad_transition", `Cannot discard a visit summary from status "${row.status}".`, 400);
  }

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: { status: "discarded", updatedAt: now() },
  });
}

/** Re-runs the LLM against the same transcript and replaces draftJson/editedJson wholesale, resetting status to draft and clearing prior flag acknowledgements (they described the old draft's flags, not the new one's). Deliberately unreachable once approved — regenerating after sign-off would silently invalidate the attestation. */
export async function regenerate(args: { shop: string; id: number }): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (!EDITABLE_STATUSES.includes(row.status as ConsultationSummaryStatus)) {
    throw new GetBooqinError("getbooqin_bad_transition", `Cannot regenerate a visit summary from status "${row.status}".`, 400);
  }

  const draft = await generatePatientSummary({
    transcript: row.transcriptText,
    outputLanguage: row.outputLanguage as "nl" | "en" | "auto",
  });
  const draftJson = JSON.stringify(draft);

  return prisma.consultationSummary.update({
    where: { id: row.id },
    data: {
      draftJson,
      editedJson: draftJson,
      detectedLanguage: draft.detected_language,
      reviewFlagsAcknowledged: "[]",
      status: "draft",
      updatedAt: now(),
    },
  });
}

/**
 * Post-send correction: creates a new row seeded from the sent row's
 * editedJson (never a fresh LLM call — the model never re-sees a
 * transcript once its output has already reached a patient). The sent row
 * itself is untouched, so it stays a permanent record of what was actually
 * delivered. The new row starts at "draft" and goes through the same
 * review/approve/send workflow as any other summary.
 */
export async function createRevision(args: { shop: string; id: number }): Promise<ConsultationSummary> {
  const row = await getRow(args.shop, args.id);
  await assertEnabled(row.shop, row.platform);

  if (row.status !== "sent") {
    throw new GetBooqinError(
      "getbooqin_bad_transition",
      `Cannot create a revision of a visit summary from status "${row.status}" — only a sent summary can be revised.`,
      400
    );
  }

  return prisma.consultationSummary.create({
    data: {
      shop: row.shop,
      platform: row.platform,
      bookingId: row.bookingId,
      status: "draft",
      transcriptText: row.transcriptText,
      transcriptSource: row.transcriptSource,
      outputLanguage: row.outputLanguage,
      detectedLanguage: row.detectedLanguage,
      draftJson: row.editedJson,
      editedJson: row.editedJson,
      reviewFlagsAcknowledged: "[]",
      revisionOfId: row.id,
      createdAt: now(),
      updatedAt: now(),
    },
  });
}
