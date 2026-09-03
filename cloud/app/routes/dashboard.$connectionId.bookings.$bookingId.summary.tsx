import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, data, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/dashboard.$connectionId.bookings.$bookingId.summary";
import { Bookings, Data, Settings, ConsultationSummary, FeatureFlags, isGetBooqinError } from "getbooqin-core";
import { formatInZone } from "getbooqin-core/booking/tz";
import type { PatientSummary } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { AlertError, Field, Input, ConfirmDialog } from "~/components/ui";
import { transcribeAudioFromForm } from "~/lib/deepgram.server";
import { useRecordingCapture, RecordingCapturePanel, formatElapsed } from "~/components/recording-capture";

export const meta: Route.MetaFunction = () => [{ title: "Visit summary · GetBooqin" }];

/* ------------------------------------------------------------------ */
/* Types — mirrors core/src/ai/patientSummary.ts. Don't redeclare these  */
/* shapes; alias them for brevity only.                                 */
/* ------------------------------------------------------------------ */
type Draft = PatientSummary.PatientSummaryDraft;
type Item = PatientSummary.Item;
type Medication = PatientSummary.Medication;
type SummaryStatus = ConsultationSummary.ConsultationSummaryStatus;

const MIN_TRANSCRIPT_WORDS = 30;

/* ==================================================================== */
/* Loader / action                                                       */
/* ==================================================================== */

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const bookingId = Number(params.bookingId);

  const booking = await Bookings.get(shop, bookingId);
  if (!booking) throw data("Booking not found", { status: 404 });

  const settings = await Settings.getSettings(shop, platform);
  if (settings.preset !== "clinic" || !FeatureFlags.VISIT_SUMMARIES_ENABLED || !settings.visit_summaries_enabled) {
    throw data("Visit Summary isn't available for this booking.", { status: 404 });
  }

  const [service, resource, customer, row] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resource(shop, booking.resourceId),
    Data.customer(shop, booking.customerId),
    ConsultationSummary.getForBooking({ shop, platform, bookingId }),
  ]);

  // A discarded row still counts as "the most recent row" for
  // getForBooking(), but for this screen's purposes it means "nothing
  // active" — the intake screen should show, same as if no row existed.
  const activeRow = row && row.status !== "discarded" ? row : null;

  // Mirrors createDraft()'s own server-side rule (booking must be
  // completed) — guards a guessed URL for a booking that hasn't happened
  // yet from showing a dead intake form. Widened to also allow `confirmed`
  // (docs/recording-poc-ux-spec.md §3.1): recording has to start before the
  // visit is marked completed, so the intake screen needs to be reachable
  // one status earlier than paste/upload ever needed it. Once a row exists
  // this no longer matters: TRANSITIONS.completed = [] makes "completed"
  // terminal, so a booking that already has a summary can never un-complete
  // out from under it.
  if (!activeRow && !["confirmed", "completed"].includes(booking.status)) {
    throw data("Visit Summary is only available once this booking is confirmed or completed.", { status: 404 });
  }

  const summary = activeRow
    ? {
        id: activeRow.id,
        status: activeRow.status as SummaryStatus,
        transcriptSource: activeRow.transcriptSource as "paste" | "upload" | "record",
        outputLanguage: activeRow.outputLanguage as "auto" | "nl" | "en",
        detectedLanguage: activeRow.detectedLanguage,
        draft: ConsultationSummary.parseDraftJson(activeRow),
        edited: ConsultationSummary.parseEditedJson(activeRow),
        // Included purely so the client can key the edit form on a value
        // that only changes when the underlying draft content actually
        // changes (regenerate() rewrites it; a plain save_edits/ack_flag
        // does not) — see ReviewScreen's usage below for why that matters.
        draftJsonRaw: activeRow.draftJson,
        acknowledgedFlags: ConsultationSummary.parseAcknowledgedFlags(activeRow),
        approvedAt: activeRow.approvedAt ? activeRow.approvedAt.toISOString() : null,
        sentAt: activeRow.sentAt ? activeRow.sentAt.toISOString() : null,
        revisionOfId: activeRow.revisionOfId,
        createdAt: activeRow.createdAt.toISOString(),
        updatedAt: activeRow.updatedAt.toISOString(),
      }
    : null;

  return {
    booking: {
      id: booking.id,
      uid: booking.uid,
      status: booking.status,
      resourceId: booking.resourceId,
    },
    serviceName: service?.name ?? "",
    resourceName: resource?.name ?? "",
    customerName: `${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim(),
    defaultLanguage: settings.visit_summary_default_language,
    timezone: settings.timezone,
    summary,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId);
  const bookingId = Number(params.bookingId);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const redirectBack = () => redirect(`/dashboard/${params.connectionId}/bookings/${bookingId}/summary`);

  try {
    if (intent === "transcribe") {
      // Feeds the "Record" input mode's recording widget (shared with the
      // standalone harness route via ~/lib/deepgram.server.ts) — see
      // IntakeScreen below.
      return transcribeAudioFromForm(form);
    }

    if (intent === "generate") {
      const transcriptText = String(form.get("transcript_text") ?? "");
      const rawSource = String(form.get("transcript_source") ?? "paste");
      const transcriptSource = rawSource === "upload" ? "upload" : rawSource === "record" ? "record" : "paste";
      const rawLang = String(form.get("output_language") ?? "auto");
      const outputLanguage = rawLang === "nl" || rawLang === "en" ? rawLang : "auto";

      // docs/recording-poc-ux-spec.md §3.1: the intake screen is now
      // reachable while the booking is still `confirmed` (recording has to
      // start before the visit is marked done). If it's still confirmed at
      // the moment of submission, auto-complete it first — an already-legal
      // confirmed -> completed transition, just triggered from this second
      // call site — so createDraft()'s own "booking must be completed" rule
      // is satisfied. Re-checked here against the current row rather than
      // trusted from the client, since this has a real side effect.
      const booking = await Bookings.get(shop, bookingId);
      if (booking && booking.status === "confirmed") {
        await Bookings.setStatus(shop, bookingId, "completed");
      }

      await ConsultationSummary.createDraft({
        shop,
        platform,
        bookingId,
        transcriptText,
        transcriptSource,
        outputLanguage,
      });
      return redirectBack();
    }

    const id = Number(form.get("summary_id"));

    if (intent === "save_edits") {
      const editedJson = JSON.parse(String(form.get("edited_json") ?? "null")) as Draft;
      await ConsultationSummary.updateEditedFields({ shop, id, editedJson });
      return { ok: true as const, savedAt: new Date().toISOString() };
    }
    if (intent === "ack_flag") {
      const flagIndex = Number(form.get("flag_index"));
      await ConsultationSummary.acknowledgeFlag({ shop, id, flagIndex });
      return { ok: true as const };
    }
    if (intent === "approve") {
      // Always persists whatever's currently in the editor first — see the
      // ApproveDialog component below for why this route folds save+approve
      // into one submission instead of requiring the clinician to hit
      // "Save draft" separately before approving.
      const editedJsonRaw = String(form.get("edited_json") ?? "");
      if (editedJsonRaw) {
        await ConsultationSummary.updateEditedFields({ shop, id, editedJson: JSON.parse(editedJsonRaw) as Draft });
      }
      const resourceId = Number(form.get("resource_id"));
      await ConsultationSummary.approve({ shop, id, resourceId });
      return redirectBack();
    }
    if (intent === "unlock") {
      await ConsultationSummary.unlockForEdit({ shop, id });
      return redirectBack();
    }
    if (intent === "send") {
      await ConsultationSummary.send({ shop, id });
      return redirectBack();
    }
    if (intent === "discard") {
      await ConsultationSummary.discard({ shop, id });
      return redirectBack();
    }
    if (intent === "regenerate") {
      await ConsultationSummary.regenerate({ shop, id });
      return redirectBack();
    }
    if (intent === "create_revision") {
      await ConsultationSummary.createRevision({ shop, id });
      return redirectBack();
    }

    return { error: "Unknown request." };
  } catch (err) {
    if (isGetBooqinError(err)) {
      return {
        error: err.message,
        code: err.code,
        // There's no background job queue yet (createDraft() is a
        // blocking 20-40s call inside this action) — on failure the
        // intake screen needs the transcript back verbatim rather than
        // making the clinician re-paste/re-upload it.
        ...(intent === "generate"
          ? {
              preserved: {
                transcriptText: String(form.get("transcript_text") ?? ""),
                transcriptSource: String(form.get("transcript_source") ?? "paste"),
                outputLanguage: String(form.get("output_language") ?? "auto"),
              },
            }
          : {}),
      };
    }
    throw err;
  }
}

/* ==================================================================== */
/* Shared bits                                                           */
/* ==================================================================== */

const STATUS_META: Record<SummaryStatus, [string, string]> = {
  draft: ["badge-pending", "Draft"],
  under_review: ["badge-pending", "Needs review"],
  approved: ["badge-ok", "Approved"],
  sent: ["badge-ok", "Sent"],
  discarded: ["badge-neutral", "Discarded"],
};

function StatusPill({ status }: { status: SummaryStatus }) {
  const [cls, label] = STATUS_META[status] ?? ["badge-neutral", status];
  return <span className={cls}>{label}</span>;
}

function formatDateTime(iso: string, timezone: string): string {
  return formatInZone(iso, timezone);
}

/* Controlled two/three-option switch, visually matching
   cloud/app/components/settings.tsx's Segmented — that one is
   uncontrolled (radio + defaultChecked, no onChange), which doesn't fit
   the paste/upload and language switches here needing to drive other
   client state. Kept local rather than editing the shared component. */
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

type FieldTag = "ai" | "edited" | "added";

function tagForItem(original: Item | null, edited: Item | null): FieldTag | null {
  if (!edited) return null;
  if (!original) return "added";
  return edited.text === original.text ? "ai" : "edited";
}

function tagForIndexed(original: { text: string }[], edited: { text: string }, index: number): FieldTag {
  const src = original[index];
  if (!src) return "added";
  return edited.text === src.text ? "ai" : "edited";
}

function tagForMedication(original: Medication[], edited: Medication, index: number): FieldTag {
  const src = original[index];
  if (!src) return "added";
  const same =
    src.name === edited.name && src.dose === edited.dose && src.frequency === edited.frequency &&
    src.duration === edited.duration && src.purpose === edited.purpose;
  return same ? "ai" : "edited";
}

function TagPill({ tag }: { tag: FieldTag | null }) {
  if (tag === "ai") return <span className="badge-neutral">AI-drafted</span>;
  if (tag === "edited") return <span className="badge bg-brand-50 text-brand-600">Edited</span>;
  if (tag === "added") return <span className="badge bg-brand-50 text-brand-600">Added manually</span>;
  return null;
}

const LANGUAGE_NAMES: Record<string, string> = { nl: "Dutch", en: "English" };

function SourceQuote({ source, detectedLanguage, outputLanguage }: { source: string; detectedLanguage: string | null; outputLanguage: string }) {
  if (!source) {
    return <p className="m-0 text-[11.5px] text-subtle">No transcript excerpt — added manually.</p>;
  }
  const mismatch = !!detectedLanguage && detectedLanguage !== outputLanguage && !!LANGUAGE_NAMES[detectedLanguage];
  return (
    <div className="mt-2 rounded-[8px] border border-line bg-canvas-alt px-3 py-2">
      <p className="m-0 text-[11px] font-medium text-subtle">
        From the transcript{mismatch ? ` (spoken in ${LANGUAGE_NAMES[detectedLanguage as string]})` : ""}:
      </p>
      <p className="m-0 mt-[2px] text-[12.5px] italic leading-snug text-ink-3">&ldquo;{source}&rdquo;</p>
    </div>
  );
}

type LangMeta = { detectedLanguage: string | null; outputLanguage: string };

/* Collapsible audit section — <details>, same chevron pattern as
   cloud/app/components/account.tsx's UserMenu popover. */
function Accordion({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <details className="group rounded-card border border-line bg-surface [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[15px] py-[11px]">
        <span className="text-[13px] font-medium">
          {title} <span className="font-normal text-subtle">({count})</span>
        </span>
        <span className="text-[11px] text-subtle transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-[15px] py-[13px]">{children}</div>
    </details>
  );
}

function AuditSections({ edited }: { edited: Draft }) {
  return (
    <div className="flex flex-col gap-2 p-[18px]">
      <Accordion title="What was left out" count={edited.withheld.length}>
        {edited.withheld.length === 0 ? (
          <span className="text-body text-muted">Nothing was withheld.</span>
        ) : (
          edited.withheld.map((w, i) => (
            <div key={i}>
              <p className="m-0 text-body">{w.content}</p>
              <p className="m-0 text-[12px] text-subtle">{w.reason}</p>
            </div>
          ))
        )}
      </Accordion>
      <Accordion title="Unclear parts of the transcript" count={edited.unclear_passages.length}>
        {edited.unclear_passages.length === 0 ? (
          <span className="text-body text-muted">Nothing was marked unclear.</span>
        ) : (
          edited.unclear_passages.map((u, i) => (
            <div key={i}>
              <p className="m-0 text-body italic">&ldquo;{u.marker}&rdquo;</p>
              <p className="m-0 text-[12px] text-subtle">{u.why_it_matters}</p>
            </div>
          ))
        )}
      </Accordion>
      <Accordion title="Questions the patient asked" count={edited.questions_answered.length}>
        {edited.questions_answered.length === 0 ? (
          <span className="text-body text-muted">No questions were logged.</span>
        ) : (
          edited.questions_answered.map((q, i) => (
            <div key={i}>
              <p className="m-0 text-body font-medium">{q.question}</p>
              <p className="m-0 text-body text-muted">{q.answer}</p>
              <SourceQuote source={q.source} detectedLanguage={null} outputLanguage="" />
            </div>
          ))
        )}
      </Accordion>
    </div>
  );
}

/* ==================================================================== */
/* Root component                                                        */
/* ==================================================================== */

export default function VisitSummaryRoute({ loaderData, actionData, params }: Route.ComponentProps) {
  const { booking, resourceName, customerName, defaultLanguage, timezone, summary } = loaderData;
  const base = `/dashboard/${params.connectionId}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <a href={`${base}/bookings/${booking.id}`} className="btn-link">&larr; Back to booking</a>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Visit summary</h1>
        {summary && <StatusPill status={summary.status} />}
      </div>

      {!summary && (
        <IntakeScreen defaultLanguage={defaultLanguage} actionData={actionData} bookingStatus={booking.status} />
      )}

      {summary && (summary.status === "draft" || summary.status === "under_review") && (
        <ReviewScreen
          key={`${summary.id}:${summary.draftJsonRaw}`}
          summary={summary}
          resourceId={booking.resourceId}
          resourceName={resourceName}
          customerName={customerName}
          timezone={timezone}
        />
      )}

      {summary && summary.status === "approved" && (
        <ApprovedScreen summary={summary} resourceName={resourceName} timezone={timezone} />
      )}

      {summary && summary.status === "sent" && (
        <SentScreen summary={summary} customerName={customerName} timezone={timezone} />
      )}
    </div>
  );
}

/* ==================================================================== */
/* Intake screen (Part 3 §2)                                             */
/* ==================================================================== */

type ActionData = Route.ComponentProps["actionData"];

function IntakeScreen({
  defaultLanguage, actionData, bookingStatus,
}: { defaultLanguage: "auto" | "nl" | "en"; actionData: ActionData; bookingStatus: string }) {
  const navigation = useNavigation();
  const isGenerating = navigation.state !== "idle" && navigation.formData?.get("_action") === "generate";

  const preserved = actionData && "preserved" in actionData ? actionData.preserved : undefined;
  const error = actionData && "error" in actionData ? actionData.error : undefined;

  // docs/recording-poc-ux-spec.md §3.1: recording has to start while the
  // booking is still `confirmed` — the "record" mode is only the useful
  // default in that window, so it's the default input mode precisely then.
  // A preserved value from a failed submission always wins (respect what
  // the user just tried over re-deriving a default).
  const isConfirmed = bookingStatus === "confirmed";
  const [inputMode, setInputMode] = useState<"paste" | "upload" | "record">(
    preserved?.transcriptSource === "upload"
      ? "upload"
      : preserved?.transcriptSource === "record"
        ? "record"
        : preserved?.transcriptSource === "paste"
          ? "paste"
          : isConfirmed
            ? "record"
            : "paste"
  );
  const [language, setLanguage] = useState<"auto" | "nl" | "en">(
    (preserved?.outputLanguage as "auto" | "nl" | "en") || defaultLanguage || "auto"
  );
  const [transcript, setTranscript] = useState(preserved?.transcriptText ?? "");
  const [fileName, setFileName] = useState("");

  // The recording widget's own state machine/Deepgram integration, shared
  // with the standalone harness route (~/components/recording-capture).
  // Always called (rules of hooks) — inert unless inputMode === "record".
  const capture = useRecordingCapture();

  if (isGenerating) return <GeneratingScreen />;

  // "Record" full-card takeover until a transcript is in hand — mirrors the
  // harness's own mockups (spec §2.2-2.6) rather than squeezing the
  // speaker-toggle/recording/error states into the textarea's slot
  // alongside an inactive mode switcher and a disabled submit button.
  if (inputMode === "record" && capture.state !== "done") {
    return <RecordingCapturePanel capture={capture} />;
  }

  const activeTranscript = inputMode === "record" ? capture.transcript : transcript;
  const words = activeTranscript.trim() ? activeTranscript.trim().split(/\s+/).length : 0;
  const canSubmit = words >= MIN_TRANSCRIPT_WORDS;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Create a visit summary</h2>
      </div>
      <div className="card-body flex flex-col gap-4">
        {error && <AlertError>{error}</AlertError>}
        <p className="text-body text-muted">
          Turn today&rsquo;s consultation into a plain-language summary the patient can keep — reviewed and approved by
          you before it&rsquo;s sent.
        </p>

        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="_action" value="generate" />
          <input type="hidden" name="transcript_source" value={inputMode} />
          <input type="hidden" name="output_language" value={language} />
          {inputMode === "upload" && <input type="hidden" name="transcript_text" value={transcript} />}

          <Field label="Transcript input">
            <SegmentedControl
              value={inputMode}
              onChange={(v) => setInputMode(v as "paste" | "upload" | "record")}
              options={[
                { value: "paste", label: "Paste text" },
                { value: "upload", label: "Upload file" },
                { value: "record", label: "Record" },
              ]}
            />
          </Field>

          {inputMode === "paste" ? (
            <Field
              label="Transcript"
              hint={`${words} word${words === 1 ? "" : "s"}${words < MIN_TRANSCRIPT_WORDS ? ` — at least ${MIN_TRANSCRIPT_WORDS} needed` : ""}`}
            >
              <textarea
                name="transcript_text"
                rows={14}
                className="input font-mono text-[12.5px]"
                placeholder={"ARTS: ...\nPATIENT: ...\nARTS: ..."}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
              />
            </Field>
          ) : inputMode === "upload" ? (
            <Field label="Transcript file" hint=".txt only">
              <input
                type="file"
                accept=".txt,text/plain"
                className="input cursor-pointer"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setFileName(file.name);
                  setTranscript(await file.text());
                }}
              />
              {fileName && (
                <p className="mt-1 text-[12px] text-subtle">
                  {fileName} — {words} word{words === 1 ? "" : "s"} loaded
                  {words < MIN_TRANSCRIPT_WORDS ? ` (at least ${MIN_TRANSCRIPT_WORDS} needed)` : ""}.
                </p>
              )}
            </Field>
          ) : (
            // inputMode === "record", capture.state === "done" here (the
            // full-card takeover above handles every earlier state).
            <Field
              label="Transcript"
              hint={`${words} word${words === 1 ? "" : "s"}${words < MIN_TRANSCRIPT_WORDS ? ` — at least ${MIN_TRANSCRIPT_WORDS} needed` : ""}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[12px] text-subtle">
                  ✓ Recorded {formatElapsed(capture.elapsedRecording)} · Transcribed
                </span>
                <button
                  type="button"
                  className="btn-link text-[12px]"
                  onClick={() => (document.getElementById("rerecord-confirm") as HTMLDialogElement | null)?.showModal()}
                >
                  Re-record
                </button>
              </div>
              <textarea
                name="transcript_text"
                rows={14}
                className="input font-mono text-[12.5px]"
                value={capture.transcript}
                onChange={(e) => capture.setTranscript(e.target.value)}
              />
            </Field>
          )}

          <Field label="Summary language">
            <SegmentedControl
              value={language}
              onChange={(v) => setLanguage(v as "auto" | "nl" | "en")}
              options={[
                { value: "auto", label: "Detect automatically" },
                { value: "nl", label: "Nederlands" },
                { value: "en", label: "English" },
              ]}
            />
          </Field>

          <div className="flex justify-end">
            <button type="submit" className="btn-pri" disabled={!canSubmit}>
              {isConfirmed ? "Mark visit completed & draft summary" : "Draft summary"}
            </button>
          </div>
        </Form>
      </div>

      {inputMode === "record" && (
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
      )}
    </div>
  );
}

/* In-flight state (Part 3 §2). createDraft() is a blocking ~20-40s call
   inside the action — there's no background job queue yet to poll, so
   this reads navigation.state === "submitting" rather than a job status.
   No "Cancel and edit transcript" button: the request is already running
   server-side and there's no cancellation endpoint, so a Cancel button
   here couldn't actually stop it — offering one would be a lie. */
function GeneratingScreen() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="card">
      <div className="card-body flex flex-col items-center gap-3 py-16 text-center">
        <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-line-strong border-t-brand-500" aria-hidden="true" />
        <h2 className="text-card font-semibold">Drafting the summary…</h2>
        <p className="max-w-[360px] text-body text-muted">
          Reading the transcript... This usually takes 20–40 seconds for a typical visit.
        </p>
        <p className="num text-[12px] text-subtle">Elapsed: {mm}:{ss}</p>
      </div>
    </div>
  );
}

/* ==================================================================== */
/* Review & edit screen (Part 3 §3) — the core screen                    */
/* ==================================================================== */

type LoaderSummary = NonNullable<Route.ComponentProps["loaderData"]["summary"]>;

function ReviewScreen({
  summary, resourceId, resourceName, customerName, timezone,
}: { summary: LoaderSummary; resourceId: number; resourceName: string; customerName: string; timezone: string }) {
  const { draft, edited } = summary;
  const meta: LangMeta = { detectedLanguage: summary.detectedLanguage, outputLanguage: edited.output_language };

  const [reasonForVisit, setReasonForVisit] = useState<Item | null>(edited.reason_for_visit);
  const [discussed, setDiscussed] = useState<Item[]>(edited.discussed);
  const [examinedOrTested, setExaminedOrTested] = useState<Item[]>(edited.examined_or_tested);
  const [clinicianAssessment, setClinicianAssessment] = useState<Item | null>(edited.clinician_assessment);
  const [medication, setMedication] = useState<Medication[]>(edited.plan.medication);
  const [testsOrdered, setTestsOrdered] = useState<Item[]>(edited.plan.tests_ordered);
  const [referrals, setReferrals] = useState<Item[]>(edited.plan.referrals);
  const [selfCare, setSelfCare] = useState<Item[]>(edited.plan.self_care);
  const [followUp, setFollowUp] = useState<Item | null>(edited.follow_up);
  const [safetyNetting, setSafetyNetting] = useState<Item | null>(edited.safety_netting);

  function assembleEdited(): Draft {
    return {
      ...edited,
      reason_for_visit: reasonForVisit,
      discussed,
      examined_or_tested: examinedOrTested,
      clinician_assessment: clinicianAssessment,
      plan: { medication, tests_ordered: testsOrdered, referrals, self_care: selfCare },
      follow_up: followUp,
      safety_netting: safetyNetting,
    };
  }

  const currentJson = JSON.stringify(assembleEdited());
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(edited));
  const hasUnsavedChanges = currentJson !== savedJson;

  const saveFetcher = useFetcher<{ ok?: boolean }>();
  const pendingSaveJson = useRef<string | null>(null);
  const saving = saveFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && pendingSaveJson.current) {
      setSavedJson(pendingSaveJson.current);
      pendingSaveJson.current = null;
    }
  }, [saveFetcher.state, saveFetcher.data]);

  function handleSave() {
    const json = currentJson;
    pendingSaveJson.current = json;
    const fd = new FormData();
    fd.set("_action", "save_edits");
    fd.set("summary_id", String(summary.id));
    fd.set("edited_json", json);
    saveFetcher.submit(fd, { method: "post" });
  }

  const flags = edited.review_flags;
  const ackSet = new Set(summary.acknowledgedFlags);
  const allFlagsAcknowledged = flags.every((_, i) => ackSet.has(i));

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Review &amp; edit</h2>
        <span className="text-[12px] text-subtle">
          {summary.detectedLanguage ? `Detected: ${LANGUAGE_NAMES[summary.detectedLanguage] ?? summary.detectedLanguage}` : ""}
          {summary.detectedLanguage ? " · " : ""}
          Summary language: {LANGUAGE_NAMES[edited.output_language] ?? edited.output_language}
        </span>
      </div>

      <div className="card-body flex flex-col gap-4">
        <FlagsBanner flags={flags} acknowledged={summary.acknowledgedFlags} summaryId={summary.id} />
      </div>

      <div className="flex flex-col">
        <SingleItemCard label="Reason for visit" value={reasonForVisit} original={draft.reason_for_visit} onChange={setReasonForVisit} meta={meta} />
        <ItemListSection label="Discussed" items={discussed} original={draft.discussed} onChange={setDiscussed} meta={meta} />
        <ItemListSection label="Examined / tested" items={examinedOrTested} original={draft.examined_or_tested} onChange={setExaminedOrTested} meta={meta} />
        <SingleItemCard label="Doctor's assessment" value={clinicianAssessment} original={draft.clinician_assessment} onChange={setClinicianAssessment} meta={meta} />
        <MedicationSection items={medication} original={draft.plan.medication} onChange={setMedication} meta={meta} />
        <ItemListSection label="Tests ordered" items={testsOrdered} original={draft.plan.tests_ordered} onChange={setTestsOrdered} meta={meta} />
        <ItemListSection label="Referrals" items={referrals} original={draft.plan.referrals} onChange={setReferrals} meta={meta} />
        <ItemListSection label="Self-care" items={selfCare} original={draft.plan.self_care} onChange={setSelfCare} meta={meta} />
        <SingleItemCard label="Follow-up" value={followUp} original={draft.follow_up} onChange={setFollowUp} meta={meta} />
        <SingleItemCard label="Safety netting" value={safetyNetting} original={draft.safety_netting} onChange={setSafetyNetting} meta={meta} />
      </div>

      <AuditSections edited={edited} />

      <div className="card-footer flex-wrap gap-3">
        <span className="text-[12px] text-subtle">
          {saving ? "Saving…" : hasUnsavedChanges ? "Unsaved changes" : `Saved · last updated ${formatDateTime(summary.updatedAt, timezone)}`}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-del"
            onClick={() => (document.getElementById("discard-summary") as HTMLDialogElement | null)?.showModal()}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn-sec"
            onClick={() => (document.getElementById("regenerate-summary") as HTMLDialogElement | null)?.showModal()}
          >
            Regenerate
          </button>
          <button type="button" className="btn-sec" onClick={handleSave} disabled={!hasUnsavedChanges || saving}>
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn-pri"
            disabled={!allFlagsAcknowledged}
            title={!allFlagsAcknowledged ? "Acknowledge every review flag above first" : undefined}
            onClick={() => (document.getElementById("approve-summary") as HTMLDialogElement | null)?.showModal()}
          >
            Approve &amp; continue
          </button>
        </div>
      </div>

      <ConfirmDialog
        id="discard-summary"
        title="Discard this draft?"
        body="This removes the current draft. You can start a new one from a transcript at any time. This can't be undone."
        confirmLabel="Discard draft"
        cancelLabel="Keep draft"
      >
        <Form method="post" id="discard-summary-form">
          <input type="hidden" name="_action" value="discard" />
          <input type="hidden" name="summary_id" value={summary.id} />
        </Form>
      </ConfirmDialog>

      <ConfirmDialog
        id="regenerate-summary"
        title="Regenerate this summary?"
        body="This runs the AI again on the same transcript and replaces the current draft text. Any edits you've made to this draft will be lost."
        confirmLabel="Regenerate"
        cancelLabel="Keep current draft"
      >
        <Form method="post" id="regenerate-summary-form">
          <input type="hidden" name="_action" value="regenerate" />
          <input type="hidden" name="summary_id" value={summary.id} />
        </Form>
      </ConfirmDialog>

      <ApproveDialog
        summaryId={summary.id}
        resourceId={resourceId}
        resourceName={resourceName}
        customerName={customerName}
        editedJson={currentJson}
      />
    </div>
  );
}

/* Real checkbox per flag (not one blanket "I've read this") — checking
   one auto-submits immediately via a fetcher (no full-page reload, so it
   can't clobber in-progress edits elsewhere on the screen). The backend
   only ever adds to the acknowledged set (no "unacknowledge"), so an
   already-checked flag renders disabled rather than offering an uncheck
   that silently wouldn't do anything. */
function FlagsBanner({ flags, acknowledged, summaryId }: { flags: string[]; acknowledged: number[]; summaryId: number }) {
  const fetcher = useFetcher();
  if (flags.length === 0) return null;
  const ackSet = new Set(acknowledged);

  return (
    <div role="alert" aria-live="assertive" className="flex flex-col gap-3 rounded-card border border-line bg-warn-bg px-[16px] py-[14px]">
      <div className="flex items-start gap-2">
        <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warn text-[11px] font-bold text-white">!</span>
        <div className="flex flex-col gap-[2px]">
          <span className="text-[13.5px] font-semibold text-warn">
            Review flags — {ackSet.size}/{flags.length} acknowledged
          </span>
          <span className="text-[12px] text-ink-3">
            The model flagged these for a closer look. Acknowledge each one after reviewing it — every flag must be
            checked before this summary can be approved.
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {flags.map((flag, i) => {
          const isAck = ackSet.has(i);
          return (
            <fetcher.Form key={i} method="post">
              <input type="hidden" name="_action" value="ack_flag" />
              <input type="hidden" name="summary_id" value={summaryId} />
              <input type="hidden" name="flag_index" value={i} />
              <label className="flex cursor-pointer items-start gap-[10px] rounded-[9px] bg-surface/70 px-3 py-[9px]">
                <input
                  type="checkbox"
                  defaultChecked={isAck}
                  disabled={isAck}
                  className="mt-[3px] h-4 w-4 shrink-0 accent-brand-600"
                  onChange={(e) => e.currentTarget.checked && fetcher.submit(e.currentTarget.form)}
                />
                <span className="text-[12.5px] leading-snug">{flag}</span>
              </label>
            </fetcher.Form>
          );
        })}
      </div>
    </div>
  );
}

/* Attestation step (Part 3 §4) — no per-staff login yet, so "approved by
   Dr. X" can't come from session identity. Locked to the booking's
   assigned resource; the checkbox has to be explicitly ticked before
   Confirm approval enables. Custom (not ui.tsx's ConfirmDialog) because
   ConfirmDialog can't gate its own confirm button on other form state. */
function ApproveDialog({
  summaryId, resourceId, resourceName, customerName, editedJson,
}: { summaryId: number; resourceId: number; resourceName: string; customerName: string; editedJson: string }) {
  const [attested, setAttested] = useState(false);
  const who = resourceName || "the assigned practitioner";
  const patient = customerName || "the patient";

  return (
    <dialog id="approve-summary" className="m-auto w-full max-w-[440px] rounded-modal p-0 shadow-modal backdrop:bg-[rgba(19,17,24,0.42)]">
      <Form method="post" className="flex flex-col gap-4 p-[22px]" onSubmit={() => setAttested(false)}>
        <input type="hidden" name="_action" value="approve" />
        <input type="hidden" name="summary_id" value={summaryId} />
        <input type="hidden" name="resource_id" value={resourceId} />
        <input type="hidden" name="edited_json" value={editedJson} />
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[16px] font-semibold">Approve this summary?</h2>
          <p className="m-0 text-[13px] text-muted">Approving as: {who}</p>
        </div>
        <label className="flex cursor-pointer items-start gap-[10px] rounded-[9px] border border-line px-3 py-[10px]">
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-[2px] h-4 w-4 accent-brand-600" />
          <span className="text-[12.5px] leading-snug">
            I am {who} and I approve this summary to be sent to {patient}.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn-sec"
            onClick={(e) => (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close()}
          >
            Cancel
          </button>
          <button type="submit" className="btn-pri" disabled={!attested}>
            Confirm approval
          </button>
        </div>
      </Form>
    </dialog>
  );
}

/* ---- editable field building blocks ---- */

function SingleItemCard({
  label, value, original, onChange, meta,
}: { label: string; value: Item | null; original: Item | null; onChange: (v: Item | null) => void; meta: LangMeta }) {
  const tag = tagForItem(original, value);
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{label}</span>
        {value ? <TagPill tag={tag} /> : <span className="badge-neutral">Not discussed</span>}
      </div>
      {value ? (
        <>
          <textarea className="input min-h-[68px]" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
          <SourceQuote source={value.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
          {original && value.text !== original.text && (
            <button type="button" className="btn-link w-fit text-[12px]" onClick={() => onChange(original)}>
              Revert to AI draft
            </button>
          )}
        </>
      ) : (
        <button type="button" className="btn-sec w-fit" onClick={() => onChange({ text: "", source: "" })}>
          + Add manually
        </button>
      )}
    </div>
  );
}

function ItemListSection({
  label, items, original, onChange, meta,
}: { label: string; items: Item[]; original: Item[]; onChange: (v: Item[]) => void; meta: LangMeta }) {
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      {items.length === 0 ? (
        <span className="badge-neutral w-fit">None mentioned</span>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item, i) => (
            <div key={i} className="rounded-[9px] border border-line px-3 py-[10px]">
              <div className="mb-1 flex items-center justify-between gap-2">
                <TagPill tag={tagForIndexed(original, item, i)} />
                <button type="button" className="btn-link text-[12px]" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
              <textarea
                className="input min-h-[54px]"
                value={item.text}
                onChange={(e) => onChange(items.map((it, j) => (j === i ? { ...it, text: e.target.value } : it)))}
              />
              <SourceQuote source={item.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn-sec w-fit" onClick={() => onChange([...items, { text: "", source: "" }])}>
        + Add item
      </button>
    </div>
  );
}

function MedicationSection({
  items, original, onChange, meta,
}: { items: Medication[]; original: Medication[]; onChange: (v: Medication[]) => void; meta: LangMeta }) {
  function update(i: number, patch: Partial<Medication>) {
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <span className="text-[13px] font-medium">Medication</span>
      {items.length === 0 ? (
        <span className="badge-neutral w-fit">None mentioned</span>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((med, i) => (
            <div key={i} className="rounded-[9px] border border-line px-3 py-[10px]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <TagPill tag={tagForMedication(original, med, i)} />
                <button type="button" className="btn-link text-[12px]" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name"><Input value={med.name} onChange={(e) => update(i, { name: e.target.value })} /></Field>
                <Field label="Dose"><Input value={med.dose ?? ""} onChange={(e) => update(i, { dose: e.target.value || null })} /></Field>
                <Field label="Frequency"><Input value={med.frequency ?? ""} onChange={(e) => update(i, { frequency: e.target.value || null })} /></Field>
                <Field label="Duration"><Input value={med.duration ?? ""} onChange={(e) => update(i, { duration: e.target.value || null })} /></Field>
                <div className="col-span-2">
                  <Field label="Purpose"><Input value={med.purpose ?? ""} onChange={(e) => update(i, { purpose: e.target.value || null })} /></Field>
                </div>
              </div>
              <SourceQuote source={med.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn-sec w-fit"
        onClick={() => onChange([...items, { name: "", dose: null, frequency: null, duration: null, purpose: null, source: "" }])}
      >
        + Add medication
      </button>
    </div>
  );
}

/* ==================================================================== */
/* Read-only views — Approved / Sent (Part 3 §4)                         */
/* ==================================================================== */

function ReadOnlyItem({ label, value, original, meta }: { label: string; value: Item | null; original: Item | null; meta: LangMeta }) {
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{label}</span>
        {value ? <TagPill tag={tagForItem(original, value)} /> : <span className="badge-neutral">Not discussed</span>}
      </div>
      {value && (
        <>
          <p className="m-0 whitespace-pre-wrap text-body">{value.text}</p>
          <SourceQuote source={value.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
        </>
      )}
    </div>
  );
}

function ReadOnlyList({ label, items, original, meta }: { label: string; items: Item[]; original: Item[]; meta: LangMeta }) {
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      {items.length === 0 ? (
        <span className="badge-neutral w-fit">None mentioned</span>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item, i) => (
            <div key={i} className="rounded-[9px] border border-line px-3 py-[10px]">
              <div className="mb-1"><TagPill tag={tagForIndexed(original, item, i)} /></div>
              <p className="m-0 whitespace-pre-wrap text-body">{item.text}</p>
              <SourceQuote source={item.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadOnlyMedication({ items, original, meta }: { items: Medication[]; original: Medication[]; meta: LangMeta }) {
  return (
    <div className="flex flex-col gap-2 border-b border-row px-[18px] py-[14px] last:border-b-0">
      <span className="text-[13px] font-medium">Medication</span>
      {items.length === 0 ? (
        <span className="badge-neutral w-fit">None mentioned</span>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((med, i) => (
            <div key={i} className="rounded-[9px] border border-line px-3 py-[10px]">
              <div className="mb-1"><TagPill tag={tagForMedication(original, med, i)} /></div>
              <p className="m-0 font-medium">{med.name}</p>
              <p className="m-0 text-[12.5px] text-muted">{[med.dose, med.frequency, med.duration].filter(Boolean).join(" · ")}</p>
              {med.purpose && <p className="m-0 text-[12.5px] text-muted">{med.purpose}</p>}
              <SourceQuote source={med.source} detectedLanguage={meta.detectedLanguage} outputLanguage={meta.outputLanguage} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadOnlySummaryView({ edited, original, meta }: { edited: Draft; original: Draft; meta: LangMeta }) {
  return (
    <>
      <div className="flex flex-col">
        <ReadOnlyItem label="Reason for visit" value={edited.reason_for_visit} original={original.reason_for_visit} meta={meta} />
        <ReadOnlyList label="Discussed" items={edited.discussed} original={original.discussed} meta={meta} />
        <ReadOnlyList label="Examined / tested" items={edited.examined_or_tested} original={original.examined_or_tested} meta={meta} />
        <ReadOnlyItem label="Doctor's assessment" value={edited.clinician_assessment} original={original.clinician_assessment} meta={meta} />
        <ReadOnlyMedication items={edited.plan.medication} original={original.plan.medication} meta={meta} />
        <ReadOnlyList label="Tests ordered" items={edited.plan.tests_ordered} original={original.plan.tests_ordered} meta={meta} />
        <ReadOnlyList label="Referrals" items={edited.plan.referrals} original={original.plan.referrals} meta={meta} />
        <ReadOnlyList label="Self-care" items={edited.plan.self_care} original={original.plan.self_care} meta={meta} />
        <ReadOnlyItem label="Follow-up" value={edited.follow_up} original={original.follow_up} meta={meta} />
        <ReadOnlyItem label="Safety netting" value={edited.safety_netting} original={original.safety_netting} meta={meta} />
      </div>
      <AuditSections edited={edited} />
    </>
  );
}

function ApprovedScreen({ summary, resourceName, timezone }: { summary: LoaderSummary; resourceName: string; timezone: string }) {
  const meta: LangMeta = { detectedLanguage: summary.detectedLanguage, outputLanguage: summary.edited.output_language };
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Approved</h2>
        <span className="badge-ok">Approved</span>
      </div>
      <div className="card-body py-3">
        <p className="m-0 text-body text-muted">
          Approved by {resourceName || "the assigned practitioner"}
          {summary.approvedAt ? ` on ${formatDateTime(summary.approvedAt, timezone)}` : ""}. Editing is locked — unlock to make
          further changes.
        </p>
      </div>
      <ReadOnlySummaryView edited={summary.edited} original={summary.draft} meta={meta} />
      <div className="card-footer">
        <span className="text-[12px] text-subtle">Ready to send</span>
        <div className="flex gap-2">
          <Form method="post">
            <input type="hidden" name="_action" value="unlock" />
            <input type="hidden" name="summary_id" value={summary.id} />
            <button type="submit" className="btn-sec">Unlock to edit</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="_action" value="send" />
            <input type="hidden" name="summary_id" value={summary.id} />
            <button type="submit" className="btn-pri">Send to patient</button>
          </Form>
        </div>
      </div>
    </div>
  );
}

function SentScreen({ summary, customerName, timezone }: { summary: LoaderSummary; customerName: string; timezone: string }) {
  const meta: LangMeta = { detectedLanguage: summary.detectedLanguage, outputLanguage: summary.edited.output_language };
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Sent</h2>
        <span className="badge-ok">Sent</span>
      </div>
      <div className="card-body py-3">
        <p className="m-0 text-body text-muted">
          Sent to {customerName || "the patient"}{summary.sentAt ? ` on ${formatDateTime(summary.sentAt, timezone)}` : ""}. This
          is a permanent record of what the patient received — corrections create a new revision instead of editing
          it in place.
        </p>
      </div>
      <ReadOnlySummaryView edited={summary.edited} original={summary.draft} meta={meta} />
      <div className="card-footer">
        <span className="text-[12px] text-subtle">Read-only</span>
        <Form method="post">
          <input type="hidden" name="_action" value="create_revision" />
          <input type="hidden" name="summary_id" value={summary.id} />
          <button type="submit" className="btn-sec">Send a correction</button>
        </Form>
      </div>
    </div>
  );
}
