/**
 * Recording POC — internal test harness (Layer A of
 * docs/recording-poc-ux-spec.md, scoped by docs/recording-poc-charter.md).
 *
 * Proves browser mic recording -> Deepgram diarized transcription -> the
 * existing, UNMODIFIED Visit Summary pipeline
 * (core/src/ai/patientSummary.ts, core/src/booking/consultationSummary.ts)
 * works end-to-end. Gated by its own `ENABLE_RECORDING_POC` env var,
 * independent of VISIT_SUMMARIES_ENABLED/visit_summaries_enabled, and
 * linked from nowhere in the real dashboard (charter §2, spec §1.1-1.2).
 *
 * The Deepgram integration and the recording widget's state
 * machine/speaker-mapping toggle now live in `~/lib/deepgram.server.ts` and
 * `~/components/recording-capture.tsx` respectively, shared with the real,
 * integrated intake screen
 * (`dashboard.$connectionId.bookings.$bookingId.summary.tsx`) — this route
 * still behaves exactly as it did as a standalone harness, just without a
 * second copy of the Deepgram call.
 *
 * Note: ConsultationSummary.getForBooking()/createDraft() are themselves
 * still gated behind VISIT_SUMMARIES_ENABLED + settings.visit_summaries_enabled
 * internally (unmodified, off-limits code) — running this harness against a
 * test shop requires both that existing flag pair AND this route's own
 * ENABLE_RECORDING_POC to be on. That's an unavoidable consequence of
 * calling the real pipeline unchanged, not new gating added by this POC.
 */
import { useState } from "react";
import { Form, data, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.recording-poc.$bookingId";
import { Bookings, Data, ConsultationSummary, isGetBooqinError } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Badge, Field, ConfirmDialog } from "~/components/ui";
import { transcribeAudioFromForm } from "~/lib/deepgram.server";
import { useRecordingCapture, RecordingCapturePanel, formatElapsed } from "~/components/recording-capture";

export const meta: Route.MetaFunction = () => [{ title: "Recording POC · GetBooqin" }];

/* ==================================================================== */
/* Loader / action                                                       */
/* ==================================================================== */

const SUMMARY_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  under_review: "Needs review",
  approved: "Approved",
  sent: "Sent",
};

export async function loader({ request, params }: Route.LoaderArgs) {
  if (process.env.ENABLE_RECORDING_POC !== "true") throw data("Not found", { status: 404 });

  const { shop, platform } = await requireTenant(request, params.connectionId);
  const bookingId = Number(params.bookingId);

  const booking = await Bookings.get(shop, bookingId);
  if (!booking) throw data("Booking not found", { status: 404 });

  const [service, resource] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resource(shop, booking.resourceId),
  ]);

  let existingSummary: { status: string } | null = null;
  try {
    const row = await ConsultationSummary.getForBooking({ shop, platform, bookingId });
    existingSummary = row && row.status !== "discarded" ? { status: row.status } : null;
  } catch (err) {
    if (isGetBooqinError(err)) {
      throw data(
        `${err.message} This harness calls the existing Visit Summary pipeline unchanged, which requires ` +
          `VISIT_SUMMARIES_ENABLED and this shop's own visit_summaries_enabled setting to both already be on.`,
        { status: err.status }
      );
    }
    throw err;
  }

  return {
    booking: { id: booking.id, status: booking.status },
    serviceName: service?.name ?? "",
    resourceName: resource?.name ?? "",
    existingSummary,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const bookingId = Number(params.bookingId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (intent === "transcribe") {
    return transcribeAudioFromForm(form);
  }

  if (intent === "generate") {
    const transcriptText = String(form.get("transcript_text") ?? "");
    const rawLang = String(form.get("output_language") ?? "auto");
    const outputLanguage = rawLang === "nl" || rawLang === "en" ? rawLang : "auto";
    try {
      // The existing, unmodified pipeline — same call summary.tsx's own
      // "generate" intent already makes. transcriptSource: "paste" (not a
      // new "record" enum value) is spec §1.4's deliberate, explicit
      // shortcut: adding a value means editing consultationSummary.ts,
      // which is off-limits, and nothing downstream branches on this field.
      await ConsultationSummary.createDraft({
        shop,
        platform,
        bookingId,
        transcriptText,
        transcriptSource: "paste",
        outputLanguage,
      });
    } catch (err) {
      if (isGetBooqinError(err)) return { error: err.message };
      throw err;
    }
    return redirect(`/dashboard/${params.connectionId}/bookings/${bookingId}/summary`);
  }

  return { error: "Unknown request." };
}

/* ==================================================================== */
/* Root component                                                        */
/* ==================================================================== */

export default function RecordingPocRoute({ loaderData, actionData, params }: Route.ComponentProps) {
  const { booking, serviceName, resourceName, existingSummary } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="card">
        <div className="card-body flex flex-col gap-[2px] py-4">
          <h1 className="m-0 text-[15px] font-semibold">Recording POC — internal test harness</h1>
          <p className="m-0 text-[12px] text-subtle">Dev/test bookings only. Not part of the shipping product.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-body flex flex-col gap-2 py-4">
          <div className="kv">
            <span className="kv-key">Booking</span>
            <span className="kv-val">
              #{booking.id} · {serviceName || "—"} · {resourceName || "—"}
            </span>
          </div>
          <div className="kv">
            <span className="kv-key">Status</span>
            <span className="kv-val">
              <Badge status={booking.status as any} />
            </span>
          </div>
        </div>
      </div>

      {existingSummary ? (
        <div className="card">
          <div className="card-body flex flex-col gap-3 py-6">
            <p className="m-0 text-body text-muted">
              A visit summary already exists for this booking (status:{" "}
              {SUMMARY_STATUS_LABELS[existingSummary.status] ?? existingSummary.status}).
            </p>
            <a href={`${base}/bookings/${booking.id}/summary`} className="btn-sec w-fit">
              Discard it on the summary page before recording again →
            </a>
          </div>
        </div>
      ) : booking.status !== "completed" ? (
        <div className="card">
          <div className="card-body flex flex-col gap-3 py-6">
            <p className="m-0 text-body text-muted">
              This booking isn&rsquo;t completed yet — recording only works on a completed booking, same rule the
              real Visit Summary pipeline enforces. Mark it completed on the booking page, then come back here.
            </p>
            <a href={`${base}/bookings/${booking.id}`} className="btn-sec w-fit">
              Go to booking →
            </a>
          </div>
        </div>
      ) : (
        <RecordingWidget actionData={actionData} />
      )}
    </div>
  );
}

/* ==================================================================== */
/* Recording widget — states & mockups (spec §2)                         */
/* ==================================================================== */

type ActionData = Route.ComponentProps["actionData"];

// bookingId isn't a prop here — the action reads it straight from the URL
// params (same as every other intent in this file), not from client state.
// The idle/recording/mic-error/transcribing/error states and the
// Deepgram-transcribe fetcher submission come from the shared
// useRecordingCapture()/RecordingCapturePanel (~/components/recording-capture)
// — identical behavior to before, just no longer a second copy of that
// state machine. Only the "done" step below (transcript review + Generate)
// stays local, since it's this route's own bespoke action/redirect, not
// shared with the real intake screen's different "done" handling.
function RecordingWidget({ actionData }: { actionData: ActionData }) {
  const capture = useRecordingCapture();
  const navigation = useNavigation();
  const isGeneratingSummary = navigation.state !== "idle" && navigation.formData?.get("_action") === "generate";
  const generateError = actionData && "error" in actionData ? actionData.error : undefined;

  const [outputLanguage, setOutputLanguage] = useState<"auto" | "nl" | "en">("auto");

  if (capture.state !== "done") {
    return <RecordingCapturePanel capture={capture} />;
  }

  const transcript = capture.transcript;
  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            ✓ Recorded {formatElapsed(capture.elapsedRecording)} · Transcribed
          </h2>
          <button
            type="button"
            className="btn-sec"
            onClick={() => (document.getElementById("rerecord-confirm") as HTMLDialogElement | null)?.showModal()}
          >
            Re-record
          </button>
        </div>
        <div className="card-body flex flex-col gap-4">
          {generateError && <AlertError>{generateError}</AlertError>}
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="_action" value="generate" />
            <Field label="Transcript" hint={`${words} word${words === 1 ? "" : "s"}`}>
              <textarea
                name="transcript_text"
                rows={12}
                className="input font-mono text-[12.5px]"
                value={transcript}
                onChange={(e) => capture.setTranscript(e.target.value)}
              />
            </Field>
            <Field label="Summary language">
              <SegmentedControl
                name="output_language"
                value={outputLanguage}
                onChange={(v) => setOutputLanguage(v as "auto" | "nl" | "en")}
                options={[
                  { value: "auto", label: "Detect automatically" },
                  { value: "nl", label: "NL" },
                  { value: "en", label: "EN" },
                ]}
              />
            </Field>
            <div className="flex justify-end">
              <button type="submit" className="btn-pri" disabled={!transcript.trim() || isGeneratingSummary}>
                {isGeneratingSummary ? "Drafting summary…" : "Generate summary →"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      <ConfirmDialog
        id="rerecord-confirm"
        title="Re-record this consultation?"
        body="This discards the current transcript. You'll need to record again from the start."
        confirmLabel="Re-record"
        cancelLabel="Keep transcript"
      >
        <form
          id="rerecord-confirm-form"
          onSubmit={(e) => {
            e.preventDefault();
            capture.reRecord();
            (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close();
          }}
        />
      </ConfirmDialog>
    </>
  );
}

/* Controlled three-option switch — same visual pattern as settings.tsx's
   Segmented, but controlled (onChange) rather than the uncontrolled radio
   version. Used here for the summary-language selector once a transcript is
   in hand; the speaker-first toggle used earlier in the state machine now
   lives inside ~/components/recording-capture's own RecordingCapturePanel.
   Optional `name` renders a hidden input alongside so a controlled value
   still participates in a native form submission. */
function SegmentedControl({
  options, value, onChange, name,
}: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; name?: string }) {
  return (
    <div className="flex w-fit gap-[2px] rounded-[9px] bg-[#efecf4] p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`cursor-pointer rounded-[7px] px-3 py-[5px] text-meta ${
            o.value === value ? "bg-surface font-semibold shadow-card" : "font-medium text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
      {name ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  );
}
