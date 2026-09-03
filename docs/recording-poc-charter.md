# Recording POC — Charter

**Status:** active internal technical spike. **Not** a production rollout, not a step
toward one. Governs scope for Designer/Developer/QA while this is underway; §5's
sign-off criteria are fixed now so they aren't invented later.

Chain under test: **browser mic recording → Deepgram speech-to-text (diarized) →
existing Visit Summary pipeline** (`core/src/ai/patientSummary.ts`,
`core/src/booking/consultationSummary.ts`), left unchanged.

## 1. Why this POC

`docs/patient-summary-cloud-integration-plan.md` argues GetBooqin's edge isn't
out-documenting Juvoly/Abridge on clinical depth — it's owning the patient-communication
channel dedicated scribe vendors don't touch. That argument currently rests on a
text-in MVP where someone hand-pastes a transcript; every real scribe competitor's
product is ambient, audio-in. The plan doc deferred audio as a "separate project with
its own vendor risk" precisely because nothing here had been tested — an unproven
assumption, not a validated one. This POC closes that one unknown cheaply: does
diarized audio actually feed the existing prompt cleanly, or does transcription noise
(misheard drug names, mislabeled speakers) undercut the summary quality that makes the
pitch work? Answering that now, in a sandbox with dummy recordings, for a few dollars
of API spend, beats finding out after the compliance investment in Part 5 is made.

## 2. Scope boundary — read before writing code

**Proves:** the live-recording → Deepgram-diarization → existing-summary-pipeline
chain works end-to-end on dummy recordings, in dev, for the team's own eyes.

**Explicitly does NOT cover, and no PR here should touch:**
- GDPR Article 9 work — DPA with Deepgram, consent UI, retention policy, legal opinion.
  All still pending per the plan doc.
- Real patient data or real clinics. Test recordings only — team members reading a
  script, never anything overheard from an actual visit.
- Production hardening, rate limiting, cost caps, or polished UI. A bare dev-gated
  harness is enough.
- Any change to `core/src/ai/patientSummary.ts` or `consultationSummary.ts` — the
  summary pipeline is the fixed half of this chain. If it needs changing, that's a
  finding to report, not something to quietly patch.
- Wiring this behind `visit_summaries_enabled` / `VISIT_SUMMARIES_ENABLED`, or exposing
  it to any real Clinic-preset shop.

Suggested seam: per the plan doc's Part 3 §2, both existing intake methods already
funnel into one shared `transcriptText` value before `createDraft`. Populate that same
field from the Deepgram transcript — everything downstream, including the review
screen, stays untouched.

**If this boundary blurs — any talk of a real clinic seeing this — stop and escalate.**
That needs the compliance foundation in Part 5 step 1, not a decision made mid-POC.

## 3. Cost model

Use Deepgram's **pre-recorded (batch)** endpoint, not live streaming — send the full
audio after the clinician hits stop. Simpler, cheaper, and diarization is native to
the batch API.

| Stage | Rate (Pay‑As‑You‑Go, deepgram.com/pricing) | 5‑min recording | 10‑min recording |
|---|---|---|---|
| Deepgram Nova‑3 (monolingual), pre‑recorded, diarization included free | $0.0043/min | ~$0.02 | ~$0.04 |
| Claude Sonnet 5 summary (measured in this project: $2/1M in + $10/1M out) | $0.05–$0.19/summary | $0.05–$0.19 | $0.05–$0.19 |
| **Total per test consultation** | | **~$0.07–$0.21** | **~$0.09–$0.23** |

New Deepgram accounts get a **$200 free-trial credit**, no card required — roughly
46,000 minutes at this rate, far more than this POC will ever burn. In practice
Deepgram cost is a non-issue; the LLM call remains the dominant, still-trivial cost.
Re-check pricing before any spend beyond the free credit — vendor pages change.

## 4. Success criteria (QA checklist)

1. Tester can grant mic permission and start a live recording, with a visible
   recording indicator and elapsed timer.
2. Stopping the recording submits the audio to Deepgram's pre-recorded API with
   diarization on, and a transcript returns in reasonable time — no indefinite spinner.
3. On a clean two-speaker test recording, turns are correctly attributed to
   `ARTS:`/`PATIENT:` (per `docs/patient-summary-prompt.md`'s format), checked by ear
   against 3+ separate recordings.
4. Transcript flows into the pipeline with no manual copy-paste — record, stop, a
   populated draft appears.
5. Each resulting draft is non-empty, valid JSON matching `PatientSummaryDraft`, and
   renders without error on the existing review screen for all 3+ runs.
6. Denied mic permission shows a clear, non-crashing error with a retry or
   paste/upload fallback.
7. A forced Deepgram failure (bad key, network error, timeout) shows a clear error and
   never silently continues into the pipeline with an empty/garbled transcript.
8. Speaker-attribution errors across the test set are rare enough to fix by eye in
   under a minute — not unusable garble.

## 5. Final UAT — Business Analyst sign-off

I sign off personally, after QA clears §4, by re-running a few test recordings myself
and judging fit, not just pass/fail:

1. **Recording usability** (→ #1–2): starting/stopping feels usable by a clinician,
   not just functional for whoever built it.
2. **Transcript trustworthiness** (→ #3, #8): the diarized transcript is accurate
   enough, skimmed against what was actually said, that I wouldn't distrust a summary
   built from it — this is §1's actual thesis, and the real bar.
3. **Summary quality holds** (→ #4–5): drafts read as sensible across a few different
   scripts, not one cherry-picked run — no drug names or numbers visibly mangled by
   transcription noise.
4. **Failure modes fail safely** (→ #6–7): mic-denied and Deepgram-down both fail
   loudly and recoverably, never producing a summary that looks legitimate but wasn't.
5. **Boundary held** (→ §2): nothing in the branch touched `VISIT_SUMMARIES_ENABLED`,
   `visit_summaries_enabled`, the patient-send path, or consent/retention surfaces.
   This sign-off covers "the chain works" only — not a go/no-go on real clinics, which
   still requires Part 5 step 1 of the integration plan.
