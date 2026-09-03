# Recording POC — UX spec

Status: **proposal, not built**. Companion to `docs/recording-poc-charter.md`
(Business Analyst's scope memo for this same POC) — read that first if you
haven't; this spec is written to fit inside its boundary, not around it.

Chain under test: **browser mic recording → Deepgram (diarized) →
existing Visit Summary pipeline** (`core/src/ai/patientSummary.ts`,
`core/src/booking/consultationSummary.ts`), both left completely unchanged.

## 0. Two layers — read this before the rest

This spec has two parts, and they are not the same kind of thing:

- **Layer A (§1–2): the harness — build this now.** A small, standalone,
  dev-gated page that proves the recording→Deepgram→pipeline chain works,
  per the charter's own scope. It never touches
  `core/src/ai/patientSummary.ts` or `core/src/booking/consultationSummary.ts`,
  never gates on `VISIT_SUMMARIES_ENABLED`/`visit_summaries_enabled`, and is
  not linked from anywhere a real clinic could stumble onto it (charter §2).
- **Layer B (§3): the production integration path — designed, not built.**
  The original ask behind this spec included two harder problems: where a
  live-recording entry point belongs relative to the booking lifecycle, and
  how "Record" becomes a real third option next to "Paste text"/"Upload
  file" in the shipping intake screen. Those are real, unsolved design
  questions and worth answering now, while the shape of the problem is
  fresh — but answering them on paper is not the same as building them.
  §3 is that answer, explicitly marked **do not implement as part of this
  POC** — implementing any of it would mean editing the two files the
  charter names as off-limits, and would expose a half-finished recording
  flow to real Clinic-preset shops. It's recorded here so that if/when this
  graduates past spike status, the eventual production PR doesn't have to
  re-derive it.

If you're the Developer building against this doc: **your work is §1–2.**
§3 is reading material for later, not a task list.

---

## 1. The harness — where it lives, how it's gated

### 1.1 A new, standalone, unlinked route

New route, nested under the existing tenant layout for auth reuse only
(so it inherits `requireTenant`'s session check — this is not a public
page), registered as an addition to `cloud/app/routes.ts`:

```
route("recording-poc/:bookingId", "routes/dashboard.$connectionId.recording-poc.$bookingId.tsx"),
```

Reached only by typing the URL directly
(`/dashboard/:connectionId/recording-poc/:bookingId`). **No link to it
exists anywhere in the real dashboard** — not on the booking detail page,
not in `SETTINGS_NAV`, nowhere a logged-in clinic user would browse into
it. That's the actual enforcement of charter §2's "not exposed to any real
Clinic-preset shop," same spirit as how the real feature's own env flag
keeps it dark by default (`docs/patient-summary-cloud-integration-plan.md`
Part 5's "pilot-cohort mechanism" section already documents this exact
"unlinked/env-gated is a real boundary, not security theater" reasoning
for this codebase).

### 1.2 Its own gate — deliberately not the real feature's

A second layer of defense, independent of `VISIT_SUMMARIES_ENABLED`: a
new env var, `ENABLE_RECORDING_POC`, checked inline at the top of this
route's loader —

```
if (process.env.ENABLE_RECORDING_POC !== "true") throw data("Not found", { status: 404 });
```

Deliberately **not** added to `core/src/booking/featureFlags.ts` — that
file is fine to extend in principle, but keeping the check inline in the
one new route file means this entire POC is exactly one route file plus
two `.env.example` lines, trivially deletable when the spike concludes,
with zero surface area inside the two files the charter protects. Add
`ENABLE_RECORDING_POC` and `DEEPGRAM_API_KEY` to `cloud/.env.example`,
same section/pattern as the existing `ANTHROPIC_API_KEY`/
`ENABLE_VISIT_SUMMARIES` pair added for the real feature.

### 1.3 What the page actually does

```
┌──────────────────────────────────────────────────────────┐
│ Recording POC — internal test harness                       │
│ Dev/test bookings only. Not part of the shipping product.   │
├──────────────────────────────────────────────────────────┤
│ Booking #{bookingId} · {service} · {resource}                │
│ Status: Completed                                            │
│                                                                │
│  (recording widget — §2 — renders here)                      │
└──────────────────────────────────────────────────────────┘
```

Loads the booking via the existing `Bookings.get(shop, bookingId)` — same
call the real routes already make, unchanged. **Requires the booking to
already be `completed`** — the harness does not attempt to solve the
confirmed-vs-completed timing problem (that's §3.1's job, on paper only).
If the test booking isn't completed yet, show a short message and a link
to the real booking detail page's existing "Mark completed" action
(`dashboard...bookings.$bookingId.tsx:127-131`, already shipping,
untouched) — the tester flips it there, then comes back. One extra click
for a test harness is a fine trade against not touching production files.

If a resolvable summary row already exists for this booking (an earlier
test run's draft/under_review/approved), surface it plainly and link to
the real `.../summary` route to discard it — reusing the existing Discard
flow (`summary.tsx:668-679`) rather than building a second one:

```
A visit summary already exists for this booking (status: Draft).
Discard it on the summary page before recording again →
```

### 1.4 Finishing a run

Once the recording widget (§2) reaches its `done` state, the harness shows
the assembled transcript in a plain editable textarea (same `input
font-mono text-[12.5px]` styling the real intake screen's paste textarea
already uses — free reuse, not new CSS), a language selector (`Segmented`,
same component `cloud/app/components/settings.tsx:227-242` already
exports), and one button:

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Recorded 6:12 · Transcribed                [ Re-record ] │
│                                                                │
│ ┌────────────────────────────────────────────────────────┐  │
│ │ ARTS: Uw keel is flink rood...                            │  │
│ │ PATIENT: En als het niet overgaat?                        │  │
│ └────────────────────────────────────────────────────────┘  │
│ 142 words                                                     │
│                                                                │
│ Summary language:  [ Detect automatically ][ NL ][ EN ]       │
│                                                                │
│                              [ Generate summary → ]           │
└──────────────────────────────────────────────────────────┘
```

Clicking it posts to this route's own `action()`, which calls the
**existing, unmodified** `ConsultationSummary.createDraft({ shop, platform,
bookingId, transcriptText, transcriptSource: "paste", outputLanguage })` —
literally the same function call `summary.tsx`'s own `generate` intent
already makes (`summary.tsx:111-118`), imported the same way. Note
`transcriptSource: "paste"` — not `"record"`. Adding a new enum value
means editing `consultationSummary.ts`, which is off-limits per the
charter; `"paste"` is the closest existing value, and nothing downstream
branches on `transcriptSource` today (it's stored/displayed only — see
§3.2's table for confirmation), so this is an honest, harmless shortcut
for the POC, not a bug being papered over.

On success, `redirect` straight to the real, completely unmodified
`.../bookings/:bookingId/summary` route. Because `createDraft()` already
created a row, that route's existing loader finds an `activeRow` and
renders the existing `ReviewScreen` exactly as it does for a
paste/uploaded transcript today — checklist item 5 ("renders without
error on the existing review screen") is satisfied by construction, not
by building a second review UI.

---

## 2. The recording widget — states & mockups

This is the part of the original design brief that survives untouched by
the charter's boundary — it's pure client-side/new-file UX, doesn't touch
either protected file, and is exactly what QA's checklist (§4, items
1–3, 6–7) is testing. Same state machine, same mockups as originally
designed, just living inside the new harness route (§1) instead of inside
`IntakeScreen`.

### 2.1 State machine

```
idle ──(Start)──> recording ──(Stop)──> transcribing ──(success)──> done
  ^                    │                      │
  │              (mic blocked)          (Deepgram/upload fails)
  │                    ↓                      ↓
  └──────────────── denied                  error ──(Retry)──> transcribing
```

`done` also offers **Re-record**, discarding the captured transcript and
returning to `idle` — a real choice to lose work, so gate it behind the
existing `ConfirmDialog` component (`~/components/ui`, same pattern
already used for "Discard this draft?", `summary.tsx:668-679`) rather than
a bare click.

### 2.2 Idle — speaker-mapping setup

Deepgram's diarization returns generic `Speaker 0`/`Speaker 1` labels — it
has no notion of "doctor" vs "patient." Resolved with one toggle, set once
before recording starts:

```
┌────────────────────────────────────────────────┐
│  Who speaks first?                                │
│  ┌──────────┐┌──────────┐                         │
│  │  Doctor  ││ Patient  │                         │
│  └──────────┘└──────────┘                         │
│  Deepgram can tell the two speakers apart but      │
│  doesn't know which is which — this tells us.      │
│                                                    │
│                     ⏺                              │
│              [ Start recording ]                  │
└────────────────────────────────────────────────┘
```

Default: **Doctor** (clinicians typically open the consultation). This is
the same `Segmented`/`SegmentedControl` pattern already used throughout
the dashboard — two options instead of three, no new control type. Labels
are fixed English strings ("Doctor"/"Patient"), not run through
`useVocabulary()` — same precedent as the review screen's "Doctor's
assessment" label (`docs/patient-summary-cloud-integration-plan.md` Part 3
conventions: clinical schema labels are fixed, clinic-only, not
vocab-driven).

**Mapping algorithm**, applied server-side once Deepgram returns diarized
utterances in chronological order:

1. The `speaker` id of the *first* utterance maps to whichever role the
   toggle said goes first.
2. The next *distinct* speaker id encountered maps to the other role.
3. Reassemble utterances in order as `ARTS: {text}` / `PATIENT: {text}`
   lines, newline-joined — the exact format the real intake screen's
   placeholder already models (`summary.tsx:460`) and
   `docs/patient-summary-prompt.md`'s worked example uses. This is a hard
   requirement, not a style choice: the prompt this feeds is untouched by
   this POC, so its expected input shape is untouched too.
4. **Known POC limitation, not solved here**: a third distinct speaker id
   (someone else briefly in the room) gets folded into whichever of the
   two mapped speakers was active immediately before it — a rough
   heuristic. Acceptable for the two-person test recordings the charter
   scopes this to (§2's "team members reading a script").

### 2.3 Recording

```
┌────────────────────────────────────────────────┐
│  ● Recording                    04:32             │
│                                                    │
│              [ ■ Stop recording ]                 │
│                                                    │
│  Speaking first: Doctor                           │
└────────────────────────────────────────────────┘
```

Elapsed timer only — no waveform, no audio-level meter (per the original
brief: "elapsed timer is enough for POC"). Same `useEffect` +
`setInterval` pattern `GeneratingScreen` already uses for its own elapsed
counter (`summary.tsx:517-521`), same `num` monospace class. `● Recording`
uses the existing `text-danger` token (already used for `badge-danger`/
`btn-del`) — not a new color. Mechanically:
`navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder`,
accumulating a `Blob` in component state. The speaker toggle is shown
greyed/locked once recording starts (already committed).

### 2.4 Mic permission denied

`getUserMedia()` rejecting with `NotAllowedError` — the browser's own
permission prompt isn't ours to design; this is what renders after it's
declined (or blocked at the site-settings level, so the prompt never even
appeared):

```
┌────────────────────────────────────────────────┐
│  ⚠ Microphone access is blocked                  │
│                                                    │
│  This page needs microphone access to record.     │
│  Enable it in your browser's site settings for     │
│  this page, then try again.                        │
│                                                    │
│                  [ Try again ]                     │
└────────────────────────────────────────────────┘
```

"Try again" just re-invokes `getUserMedia()`. No paste/upload fallback
link here — unlike the production version in §3, this harness has no
paste/upload path to fall back to (§1.4 explains why: those already exist
on the real intake screen, and duplicating them here would be scope creep
the charter explicitly rules out — "Production hardening... or polished
UI. A bare dev-gated harness is enough").

### 2.5 Recording/transcription error

Covers both possible failures the same way, since the recovery is
identical either way — audio upload to this route's own action failed, or
the action's Deepgram call failed:

```
┌────────────────────────────────────────────────┐
│  ⚠ Transcription failed                          │
│                                                    │
│  Recorded 6:12 of audio but couldn't get a         │
│  transcript back. {short error detail if any}      │
│                                                    │
│              [ Retry transcription ]               │
└────────────────────────────────────────────────┘
```

**"Retry transcription" reuses the same audio `Blob`** already held in
component state from when Stop was pressed — no re-recording required.
Only works within the same page session (no reload, no navigating away
and back — the `Blob` is in memory only, never persisted). An explicit,
acceptable POC limitation, directly serving checklist item 7 ("a forced
Deepgram failure... shows a clear error and never silently continues into
the pipeline with an empty/garbled transcript") — the transcript textarea
in §1.4 only ever renders after a real, successful transcription; nothing
here can produce a silent empty-transcript pass-through.

### 2.6 Transcribing — reuses `GeneratingScreen`'s pattern

Between Stop and a returned transcript, this route's own component shows
a screen structurally identical to the existing `GeneratingScreen`
(`summary.tsx:516-537`) — same spinner, same centered layout, same `num`
elapsed counter, same absence of a Cancel button and the same reason
(there's no cancellation endpoint once the upload/Deepgram call is
in flight — offering Cancel would be a lie, exactly the existing
component's own comment already explains at `summary.tsx:510-515`). Only
the copy differs:

```
┌────────────────────────────────────────────────┐
│                                                    │
│           ◐  Transcribing the recording…           │
│      Uploading audio and waiting for Deepgram to    │
│      process it — usually about as long as the      │
│      recording itself.                               │
│      Elapsed: 0:42                                    │
│                                                    │
└────────────────────────────────────────────────┘
```

Worth literally copy-pasting `GeneratingScreen`'s JSX into this new file
rather than trying to import/share it — it lives in a route file with no
existing export boundary for it, and this whole harness is meant to be
disposable, not a refactor opportunity.

### 2.7 Done

Covered already in §1.4 — the recording widget's terminal state hands
straight into the harness page's transcript-review-and-generate step.

---

## 3. Production integration path — designed, not built

Everything below answers the two questions the original design brief
posed (where does a live-recording entry point live relative to the
booking lifecycle, and how does "Record" become a real third
`SegmentedControl` option) **as they'd apply if this feature ever leaves
spike status**. None of it should be implemented alongside §1–2. Treat it
as the equivalent of Part 3 in
`docs/patient-summary-cloud-integration-plan.md` — a design that exists on
paper, deliberately, before the compliance/rollout gate that has to clear
first (that plan's own Part 5 step 1, plus whatever this POC's findings
turn out to be).

### 3.1 The timing mismatch

The real "Visit summary" card
(`dashboard.$connectionId.bookings.$bookingId.tsx:178-219`) only renders
once `booking.status === "completed"` — correct for paste/upload, wrong
for recording, which has to start while the booking is still `confirmed`
(`TRANSITIONS.confirmed = ["completed", "cancelled", "no_show"]`,
`bookingsShared.ts:22`).

**Production answer**: a second, mutually-exclusive card in the same
slot, gated on `booking.status === "confirmed"` instead of `"completed"`
(booking status can't be both, so the two cards never collide):

```
booking.status === "confirmed"                booking.status === "completed"
┌────────────────────────────────────┐        ┌────────────────────────────────────┐
│ Record consultation                 │        │ Visit summary                       │
│ Record today's consultation and     │        │ Turn today's consultation into a    │
│ have it transcribed automatically — │        │ plain-language summary Anna can     │
│ you'll review the transcript before │        │ keep — reviewed and approved by     │
│ it becomes a visit summary.         │        │ you before it's sent.               │
│      [ ● Record consultation ]      │        │        [ + Create visit summary ]   │
└────────────────────────────────────┘        └────────────────────────────────────┘
```

Both would link to the same `.../summary` route — no second route needed.
That route's loader gate would widen from `!== "completed"` to
`!["confirmed", "completed"].includes(...)`, and `IntakeScreen` would
default its `SegmentedControl` to `"record"` when the booking is still
`confirmed` (defaulting to `"paste"` otherwise, unchanged). The submit
action would call the already-imported `Bookings.setStatus(shop,
bookingId, "completed")` immediately before `createDraft()` when the
booking is still `confirmed` — `confirmed → completed` is already a legal
transition, this just triggers it from a second call site — and the
submit button's label would say so plainly: `Mark visit completed &
draft summary` instead of `Draft summary`, so the side effect is visible,
not silent.

### 3.2 "Record" as the `SegmentedControl`'s third option

```
// summary.tsx:410, today:
const [inputMode, setInputMode] = useState<"paste" | "upload">(...)
// production:
const [inputMode, setInputMode] = useState<"paste" | "upload" | "record">(...)
```

```
// summary.tsx:444-448, today:
options={[{ value: "paste", label: "Paste text" }, { value: "upload", label: "Upload file" }]}
// production:
options={[..., { value: "record", label: "Record" }]}
```

The `SegmentedControl` component itself needs no change — it already
renders however many options it's given. Selecting "Record" would replace
the textarea/file-input block (`summary.tsx:451-485`) with the widget
from §2, converging back onto the same shared `transcript` field once
recording finishes (§2.7/§1.4's "done" pattern, unchanged in spirit) —
exactly the "no rework of anything downstream" property
`docs/patient-summary-cloud-integration-plan.md` Part 3 §2 already
promised when it deferred this. What changes per mode:

| | Paste text | Upload file | Record |
|---|---|---|---|
| Populates | `transcript` state directly | `transcript` via `file.text()` | `transcript` via recording → Deepgram |
| `transcript_source` | `"paste"` | `"upload"` | `"record"` **(new enum value — the one change this path needs in `consultationSummary.ts`, off-limits for now)** |
| Word count gate, language selector, submit button | same | same | same |
| Extra content above the field | none | none | speaker-first toggle, pre-recording only |
| Full-card takeover | only during `generate` | same | also during recording/transcription, before `generate` even runs |

### 3.3 Why this stays on paper for now

Building §3.1–3.2 means editing `core/src/booking/consultationSummary.ts`
(the `transcript_source` enum) and wiring a new entry point behind
`VISIT_SUMMARIES_ENABLED`/`visit_summaries_enabled` on the real booking
detail page — both explicitly out of bounds per the charter's §2, whose
whole premise is that the compliance/rollout question
(`docs/patient-summary-cloud-integration-plan.md` Part 5 step 1) hasn't
been decided yet, and shouldn't be pre-empted by a spike quietly growing
production surface area. If the charter's success criteria clear and
someone decides to build the real thing, §3 is the starting point, not a
fresh design exercise.

---

## 4. What this deliberately does not design, and why

No consent-notice screen, no patient-facing recording disclosure, no
retention-policy UI, anywhere in this document — matching both the
original brief's POC framing and the charter's explicit scope ("Explicitly
does NOT cover... GDPR Article 9 work — DPA with Deepgram, consent UI,
retention policy, legal opinion. All still pending per the plan doc.").
This isn't an oversight: designing a consent screen against a harness that
only ever sees team members reading a test script has nothing real to
validate against, and building one now would misleadingly suggest the
compliance question is closer to answered than it is. Also out of scope,
same reasoning: a waveform/audio-level visualizer, playback/scrub review
of the raw audio before transcribing, support for more than two speakers,
persistence of the audio `Blob` beyond the browser tab, and (per §3.3) any
of the production entry-point/wiring work until the charter's own sign-off
gate (§5) clears and a separate decision is made to proceed.

---

## Appendix — touch points

**Build now (Layer A):**
- New file: `cloud/app/routes/dashboard.$connectionId.recording-poc.$bookingId.tsx` — loader (flag check, `Bookings.get`, existing-row check), the recording widget (§2), the transcript-review-and-generate step (§1.4), an action with two intents: `transcribe` (audio → Deepgram → mapped transcript) and `generate` (calls the existing `ConsultationSummary.createDraft(...)` unchanged, `transcriptSource: "paste"`, then redirects to the real `.../summary` route).
- One additive line in `cloud/app/routes.ts` registering the route above.
- Two new lines in `cloud/.env.example`: `ENABLE_RECORDING_POC`, `DEEPGRAM_API_KEY` (same section/pattern as the existing `ANTHROPIC_API_KEY`/`ENABLE_VISIT_SUMMARIES` pair).
- No changes to any other existing file. In particular: **not** `core/src/ai/patientSummary.ts`, **not** `core/src/booking/consultationSummary.ts`, **not** `dashboard.$connectionId.bookings.$bookingId.tsx`, **not** `dashboard.$connectionId.bookings.$bookingId.summary.tsx`.

**Deferred (Layer B, §3) — do not build as part of this POC:**
- `core/src/booking/consultationSummary.ts`: widen `TRANSCRIPT_SOURCES` (line 39) and `CreateDraftArgs.transcriptSource` (line 88) to include `"record"`.
- `dashboard.$connectionId.bookings.$bookingId.tsx`: new "Record consultation" card (§3.1).
- `dashboard.$connectionId.bookings.$bookingId.summary.tsx`: widened loader gate, `Bookings.setStatus` auto-complete in the `generate` action, third `SegmentedControl` option, `TranscribingScreen` component (§3.1–3.2).
