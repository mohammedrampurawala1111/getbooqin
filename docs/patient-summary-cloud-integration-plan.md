# Visit Summary — incorporating `patient-summary-prompt.md` into GetBooqin Cloud (Clinic preset)

Status: **proposal, not started**. Nothing in this plan is built yet. This
document evaluates whether/how to turn `docs/patient-summary-prompt.md` — a
system prompt that drafts a patient-facing visit summary from a consultation
transcript — into a real feature of GetBooqin Cloud, scoped to the
**Clinic / Healthcare** preset (`core/src/booking/presets.ts`).

Produced by two research passes run against this repo: a business-analyst
pass (market/competitive/regulatory research) and a UI/UX pass (grounded in
the actual dashboard code). Both are reproduced in full below, followed by a
technical integration plan and a phased recommendation.

---

## TL;DR

- **Worth building, but narrowly, and only as a real compliance commitment,
  not a weekend feature.** The moment GetBooqin stores a consultation
  transcript, it becomes a processor of GDPR Article 9 special-category
  health data — DPAs, EU hosting, sub-processor disclosure, retention limits,
  the works. That's the actual go/no-go gate, not the prompt's quality.
- **Don't try to out-scribe the category leaders.** Tandem Health/Juvoly
  already has 35% of Dutch primary care as an MDR-certified clinician-facing
  scribe. GetBooqin's edge is different: it already owns the
  pre/post-visit *patient communication channel* (confirmation emails,
  reminders) that none of the scribe vendors touch. Build the **patient
  letter**, not a clinical note, and distribute it through the channel
  GetBooqin already owns.
- **MVP is text-in, not audio-in.** Nothing in this codebase does
  audio-to-transcript today. Ship transcript paste/upload against the
  existing prompt first; treat live recording as a distinct, deferred
  project with its own vendor risk.
- **Gate hard, default off.** New setting, off by default, **not** added to
  `PRESET_CONTROLLED_KEYS` — no preset should silently switch on an
  AI-drafting-and-emailing-patients feature.
- **Pricing:** bundle a capped monthly quota into the existing Clinic-tier
  subscription with metered overage, rather than selling it as a separate
  SKU — this is a retention/upsell feature for existing customers, not an
  acquisition wedge.

---

## Part 1 — What's already in the repo

- **`core/src/booking/presets.ts`** defines the `clinic` preset: terms
  (Doctor/Patient/Appointment/Treatment), and defaults (15-min slots, phone
  required, waitlist on, a `consent_text` shown at booking time about
  missed-appointment fees). This is live and shipping, not a mock. The file's
  own header is explicit about the design constraint that matters most here:
  *"A preset only changes the words shown in the UI and a few sensible
  defaults — it never changes the schema."* A visit-summary feature breaks
  that constraint by design (new schema, new storage, new UI, an LLM call) —
  it's a new product surface gated by `preset === "clinic"`, not a preset
  tweak.
- **`docs/patient-summary-prompt.md`** is a fully-specified, not-yet-wired-up
  system prompt. No Anthropic/OpenAI client exists anywhere in this codebase
  today — this would be the first LLM integration in the product. Its design
  is unusually disciplined for the regulatory tightrope it's walking:
  documentation-only framing ("you are a documentation tool, not a clinical
  one"), mandatory human review before anything reaches a patient, null
  instead of generic filler when something wasn't discussed, verbatim
  ≤15-word source quotes on every populated field, numbers copied never
  normalized, and explicit `withheld[]`/`review_flags[]` logs. That
  discipline is doing real regulatory and trust work, not just polish — it
  shows up repeatedly below.
- Other presets (salon, automotive, legal, education, fitness, real estate,
  restaurant, home services) are unaffected — this plan is Clinic-only.

---

## Part 2 — Market & regulatory research

*(Business-analyst pass — web-researched, sources listed at the end of this
section.)*

### Competitive landscape

Two tiers, one uncomfortably close to GetBooqin's own segment:

**Enterprise / EHR-integrated** (irrelevant to GetBooqin's buyer, listed for
context): **Abridge** (~$812M raised, $5.3B valuation, $100M+ ARR, 250+
health systems; already ships a "Patient Visit Summary" feature — direct
validation that this artifact type is worth building, but as a companion to
their clinician-note product, not standalone); **Nuance DAX Copilot /
Microsoft Dragon Copilot** ($369–830/provider/month + setup fees); **Suki
AI** (~$299–399/provider/month, quote-based); **Ambience Healthcare**
($1.04B valuation). None have a self-serve small-practice on-ramp.

**Self-serve / small-practice** — GetBooqin's actual comparison set:
**Freed** ($39–119/month); **Heidi Health** (free tier with no BAA, Clinician
$150/month); **Sunoh.ai** ($149/user/month, 83% of reviewers are small
businesses per Capterra — closest analog); **Nabla** (had a free self-serve
tier, moved to demo/contract sales in 2026, drifting upmarket); **Corti**
(Copenhagen, usage-based API, markets itself as "Europe's sovereign
healthcare AI infrastructure," partners with regional practice-management
vendors rather than selling direct).

**The one that matters most: Tandem Health / Juvoly.** Tandem acquired
Juvoly, described as the Netherlands' leading AI medical scribe — **1,500+
Dutch GP practices (35% of all Dutch primary care)**, 200,000+
consultations/month, 100+ EHR/EMR integrations, from ~$133/month, and **MDR
Class IIa medical-device certification**. This is not hypothetical — it
already dominates the exact geography and exact customer size this feature
would target.

**What this means:** "AI documentation for small Dutch clinics" is not open
space — Juvoly closed it. The real gap is narrower: nobody in either tier is
a *booking/scheduling platform* bundling a *patient-facing* letter as a
value-add on top of a product the clinic already pays for daily. The scribe
vendors all live inside the clinician's in-visit documentation workflow and
write back to the EHR — a clinical-note product. This prompt targets a
different artifact (a patient letter) through a different channel (the
booking/patient-communication layer GetBooqin already owns — the same one
that sends `customer_created_pending_body` today). Real, defensible angle.
Trying to out-scribe Juvoly on clinician-facing documentation would not be.

### Market demand signal

Patient-facing visit summaries (vs. clinician-facing clinical notes) are
validated — but so far only as an add-on to an existing documentation
product, never sold standalone. Abridge's PVS is the clearest precedent. A
cited comparison study (via Medscape) found LLM-generated after-visit
summaries beat clinician-written ones on understandability, actionability,
readability, and accuracy, with no increased-harm signal. No vendor found
sells "patient summary generation" as an isolated paid product — this reads
as a retention/differentiation feature riding on an existing relationship,
not a customer-acquisition wedge on its own. GetBooqin's advantage is
distribution: it already owns the pre/post-visit patient-communication
channel none of these products touch.

### Regulatory landscape — the actual gate

- **GDPR.** Transcripts and summaries are Article 9 special-category health
  data. Needs an Article 6 lawful basis *and* a separate Art. 9(2) condition
  — explicit consent (9(2)(a)) is the most defensible path for a
  third-party SaaS vendor (the "necessary for healthcare provision"
  exemption is murkier when a software vendor, not the treating institution,
  does the processing). Concretely: a signed DPA with every clinic customer;
  the existing `consent_text` field is **not** sufficient as-is (it covers
  cancellation fees — bundling a second, unrelated special-category consent
  into it risks failing GDPR's specificity requirement); the LLM vendor
  becomes a disclosed sub-processor requiring its own DPA/SCCs; bounded
  retention (not indefinite), encryption, and EU-region hosting matter more
  than usual — Corti's entire "sovereign healthcare AI infrastructure"
  positioning signals EU health customers actively care about non-US
  model/infra dependencies.
- **EU AI Act.** The health-specific Annex III high-risk triggers are about
  emergency-call triage and insurance risk-scoring, not general clinical
  documentation. Whether a summary tool is high-risk in practice mostly
  turns on MDR medical-device classification (Class IIa+ → automatically
  high-risk under the AI Act). Purely administrative/documentation software
  that doesn't diagnose or recommend treatment generally sits outside MDR
  scope. This prompt is deliberately built for the safe side of that line —
  no diagnosis, no advice, mandatory clinician approval, refuses to fill
  gaps. **Confidence: medium, not high** — Juvoly, the closest real
  comparable in the same country, pursued MDR Class IIa certification
  anyway, likely because it includes decision-support-adjacent features
  (coding assistance, diagnosis-code suggestions) this prompt deliberately
  excludes. That actually *supports* "narrower documentation-only design =
  different risk tier," but Annex III guidance for this category isn't
  final until December 2027, and a self-assessment today isn't a permanent
  shield. **Get an actual legal opinion before shipping — this research
  isn't one.**
- **Recording consent.** The Netherlands is one-party consent (lawful to
  record a conversation you're a participant in), but GDPR's
  notification/purpose-limitation requirements for Art. 9 data push toward
  visible patient notice regardless of the criminal-law baseline — silent
  recording of special-category data is a weak position even where
  technically legal. If GetBooqin ever expands to the US: **13 states
  require two-party consent** (CA, CT, DE, FL, IL, MD, MA, MI*, MT, NV, NH,
  PA, WA) — a real patchwork, and a reason US expansion should be a distinct
  later decision, not baked into the MVP design.
- **HIPAA** (flag only, not a near-term build item): any cloud/LLM vendor
  touching PHI needs a signed BAA, and AWS/GCP/Azure only offer BAAs over a
  specific "HIPAA-eligible" service subset — a materially bigger lift than
  GDPR-only. Pattern seen across competitors: Heidi's free tier explicitly
  excludes BAA coverage, gating it behind a paid tier — vendors treat
  BAA-capability as a paid-tier feature, not baseline.

### Business model

Self-serve small-practice pricing clusters tightly: Freed $39–119/mo, Heidi
free–$150/mo, Sunoh $149/mo, Juvoly from ~$133/mo. Enterprise pricing
($200–800+/provider/month) is irrelevant to GetBooqin's segment — its clinic
customers chose a generic, lightweight booking tool over dedicated
practice-management software, and sit squarely in the self-serve band.
Marginal cost of *this specific prompt* (transcript→JSON, text-only) is low
— a few cents per summary at LLM API pricing. The real cost driver is the
not-yet-built audio→transcript step (medical-mode/diarization transcription
APIs run roughly $0.15–0.40/hour).

**Recommendation:** bundle a capped monthly quota into the existing
Clinic-preset subscription tier, metered overage beyond that — mirrors the
freemium-with-cap pattern nearly every competitor above uses. This is a
retention/upsell play for existing booking customers, not a net-new
acquisition wedge; a small clinic that chose GetBooqin for simplicity is
unlikely to want a second vendor relationship and a second bill for this.

### Risk assessment

1. **Trust/accuracy perception.** The prompt's conservatism is a genuinely
   good hallucination defense, but perception is separate from quality —
   research shows real trust gaps even among enthusiastic adopters (88.9%
   report enjoying AI scribes, yet many still keep their own notes). A small
   clinic evaluating a bolt-on from a *booking* vendor with no clinical-
   software track record likely has a **higher** trust bar to clear, not a
   lower one.
2. **Third-party transcription dependency.** This prompt only handles
   transcript→summary; audio→transcript is a separate, unbuilt pipeline with
   real accuracy variance on medical terms, accents, and overlapping
   speakers — arguably the harder, costlier half of the feature, not yet
   scoped.
3. **Clinician workflow friction/adoption.** Ambient-scribe adoption is
   growing (29% of physicians per a cited 2026 report, up from 20%) — a
   favorable tide, but that data is for dedicated clinical-workflow
   products, not a scheduling tool's bolt-on. Recommend an opt-in pilot
   cohort, not default-on rollout.
4. **Liability.** The signing clinician bears malpractice liability for an
   approved summary regardless of AI involvement — no legal mechanism shifts
   that to the vendor. GetBooqin's ToS needs explicit language that the
   review-and-approve step is what makes the output usable (the UX design in
   Part 3 already assumes this), but GetBooqin itself still carries
   product-liability/E&O exposure for defects in the tool (e.g., a bug that
   silently drops a `review_flag`) — a distinct exposure from the
   clinician's own malpractice risk.
5. **Regulatory drift.** EU AI Act guidance for this category isn't final
   until December 2027, and an MDR-certified incumbent already operating in
   this exact market normalizes formal device certification as the expected
   bar — a "documentation-only, therefore out of scope" self-assessment
   shouldn't be treated as permanent.

### Recommendation

**Build it — narrowly, as an opt-in retention feature for existing
Clinic-preset customers**, not a wedge to win clinics away from dedicated
scribe products. GetBooqin has no realistic path to beating Juvoly (35% of
Dutch GPs, MDR-certified, EHR-integrated) or Abridge on documentation depth
— the actual advantage is owning the patient-communication channel they
don't touch.

**Single biggest go/no-go factor:** whether GetBooqin is willing to become a
GDPR Article 9 health-data processor as a *standing operational commitment*
— DPAs with every clinic, EU-region hosting, disclosed sub-processor chain,
real retention policy, breach-notification readiness. This is a step-change
in regulatory posture for a company whose product today (even under the
clinic preset) is not health data. If that commitment isn't real, the
quality of the prompt doesn't matter — don't build this yet.

**Build first (if yes):** the consent-capture extension (§6 of Part 3) plus
the DPA/sub-processor paperwork — required regardless of LLM/transcription
vendor and unlocks everything downstream; then a text-transcript-only pilot
against a small cohort to validate clinician trust and workflow fit before
taking on audio.

**Defer:** audio capture/transcription vendor selection (separate build,
separate vendor risk); US expansion (HIPAA BAA chain + 13-state consent
patchwork, and an already-saturated, well-funded incumbent market); any
clinician-facing clinical note / EHR write-back (that's a different, larger,
more heavily regulated product — direct competition with Abridge/Juvoly/Suki
on their own turf).

<details>
<summary>Sources</summary>

- [AI Medical Scribe Pricing 2026 — Commure](https://www.commure.com/blog-scribe/scribe-pricing)
- [Nabla AI Review 2026 — Commure](https://www.commure.com/blog-scribe/nabla-ai-review)
- [Heidi's Pricing Plans — Heidi Health Help Center](https://support.heidihealth.com/en/articles/8885030-heidi-s-pricing-plans-cost-and-features)
- [Heidi Health Review 2026 — Commure](https://www.commure.com/blog-scribe/heidi-health-review)
- [Cost of AI Medical Scribes — Freed](https://www.getfreed.ai/resources/cost-of-ai-scribes)
- [Abridge revenue, valuation & funding — Sacra](https://sacra.com/c/abridge/)
- [Abridge Valuation 2026 — ValueAddVC](https://valueaddvc.com/blog/abridge-valuation-2026-5-3b-100m-arr-and-how-the-ai-scribe-beat-nuance-and-ambience)
- [Patient Visit Summaries — Now Generated in Real-Time — Abridge](https://www.abridge.com/blog/patient-visit-summaries--now-generated-in-real-time)
- [Suki vs Nuance DAX vs Abridge vs Freed — IntuitionLabs](https://intuitionlabs.ai/articles/suki-vs-nuance-dax-vs-abridge-vs-freed)
- [DAX Copilot Review 2026 — Commure](https://www.commure.com/blog-scribe/dax-ai-scribe)
- [Sunoh.ai pricing](https://sunoh.ai/pricing/)
- [Sunoh Software — Capterra](https://www.capterra.com/p/10016372/Sunoh/)
- [Corti Pioneers Europe's First Sovereign Healthcare AI Infrastructure](https://corti.ai/newsroom/corti-pioneers-europes-first-sovereign-healthcare-ai-infrastructure)
- [Corti and S3 Praxiscomputer — German medical practices](https://www.corti.ai/newsroom/corti-and-s3-praxiscomputer-bring-ai-powered-documentation-to-german-medical-practices)
- [Tandem Health acquires Juvoly](https://tandemhealth.ai/resources/news/tandem-health-acquires-leading-dutch-ai-medical-scribe-juvoly-to-scale-clinician-first-ai-documentation-across-europe)
- [Why AI scribes need to fall under EU MDR — Tandem Health](https://tandemhealth.ai/resources/knowledge/why-ai-scribes-need-to-fall-under-eu-mdr)
- [AI Beats Physicians After-Visit Summaries — Medscape](https://www.medscape.com/viewarticle/ai-beats-physicians-after-visit-summaries-hospital-patients-2026a1000g78)
- [GDPR Article 9: Processing Special Categories of Data — Legiscope](https://www.legiscope.com/blog/gdpr-article-9-special-categories.html)
- [Healthcare GDPR Compliance & Article 9 — Secure Privacy](https://support.secureprivacy.ai/article/industry-specific-dpo-guidance-healthcare/)
- [Annex III: High-Risk AI Systems — EU Artificial Intelligence Act](https://artificialintelligenceact.eu/annex/3/)
- [High-level summary of the AI Act](https://artificialintelligenceact.eu/high-level-summary/)
- [The Netherlands: Get the tape rolling — Littler](https://www.littler.com/news-analysis/asap/netherlands-get-tape-rolling)
- [Netherlands Audio and Video Recording Laws — RecordingLaw](https://recordinglaw.com/netherlands-recording-laws/)
- [Two-Party Consent States for Recording (2026) — RecordingLaw](https://www.recordinglaw.com/party-two-party-consent-states/)
- [HIPAA-Eligible Cloud Platforms: AWS, Azure & Google Cloud (2026) — Medcurity](https://medcurity.com/hipaa-cloud-compliance/)
- [Who's really liable when your AI scribe makes a mistake? — Medical Economics](https://www.medicaleconomics.com/view/who-s-really-liable-when-your-ai-scribe-makes-a-mistake-)
- [AI Scribes Pose Liability Risks — MICA Insurance](https://www.mica-insurance.com/blog/posts/ai-scribes-pose-liability-risks/)
- [AI Medical Scribe Software Market Report 2026 — Research and Markets](https://www.researchandmarkets.com/reports/6231842/ai-medical-scribe-software-market-report)
- [AI Clinical Documentation (Ambient Scribe) Market Size — Astute Analytica](https://www.astuteanalytica.com/industry-report/ai-clinical-documentation-ambient-scribe-market)
- [AI Scribes For Doctors Are Everywhere — Forbes](https://www.forbes.com/sites/jessepines/2026/03/06/medical-ai-scribes-are-everywhere-research-shows-benefits--risks/)
- [Speech-to-Text API Pricing — AssemblyAI](https://www.assemblyai.com/blog/speech-to-text-api-pricing)
- [Deepgram Pricing](https://deepgram.com/pricing)

</details>

---

## Part 3 — Product & UX design

*(UI/UX pass — grounded directly in `cloud/app/` and `core/src/booking/`.)*

### Conventions

- Feature name throughout: **"Visit Summary"** (plain, matches existing nav
  labels like "Booking rules"/"Notifications" — not "AI Scribe").
- All patient/doctor/appointment nouns render through `useVocabulary()`
  (`cloud/app/lib/presets.ts:266-269`) — never hardcoded, per the existing
  convention. The clinical schema labels (Medication, Safety netting,
  Clinician's assessment) are fixed English strings — clinic-only, not
  vocab-driven, since the schema itself is medically specific.
- **Clinic-only for now.** Gated on `settings.preset === "clinic"`. The
  schema (medication, clinician_assessment, safety_netting) doesn't
  generalize to other presets by swapping nouns; a future preset would need
  its own prompt+schema variant.
- **Booking status is the real gate.** `TRANSITIONS.completed = []` in
  `core/src/booking/bookingsShared.ts` — `completed` is a true terminal
  state, and today a completed appointment's action-button row renders
  empty (`dashboard.$connectionId.bookings.$bookingId.tsx:82-104`). That
  empty space is where this feature's entry point lands.
- **No per-staff login yet** — Settings → Team says "coming soon"
  (`cloud/app/components/settings.tsx:394-403`), one shared owner login per
  connection. This shapes the attribution design in §4 below.

### 1. Entry point — appointment detail page

New card in `dashboard.$connectionId.bookings.$bookingId.tsx`'s left column,
below "Details," visible only when `preset === "clinic"` **and** the new
`visit_summaries_enabled` setting is on **and** `booking.status ===
"completed"`.

```
┌────────────────────────────────────┐
│ Visit summary                       │
│                                      │
│ Turn today's consultation into a    │
│ plain-language summary Anna can     │
│ keep — reviewed and approved by     │
│ you before it's sent.               │
│                                      │
│        [ + Create visit summary ]   │
└────────────────────────────────────┘
```

Once a draft exists the card collapses to a one-line status + action,
keyed to workflow state:

```
Visit summary        [Needs review]      Visit summary          [Approved]
Drafted 4 minutes ago                    Approved by Dr. Hendriks, 11:02
                    [ Review now → ]                   [ Send to patient → ]
```

New nested route: `dashboard.$connectionId.bookings.$bookingId.summary.tsx`,
branching its rendered screen on summary state (none → intake, generating →
loading, draft/under_review → review & edit, approved → review-mostly-
read-only + Send, sent → read-only receipt).

### 2. Transcript intake screen

Segmented control (same pattern as `cloud/app/components/settings.tsx:207-222`):
**Paste text** / **Upload file** (`.txt` only for MVP — no audio, no
docx/pdf parsing). Placeholder text models the speaker-labelled format the
prompt expects (`ARTS:` / `PATIENT:`), with a live word count and a minimum
length before submit is enabled. A second segmented control for **summary
language**: Detect automatically (default) / Nederlands / English, mapping
directly to the prompt's `output_language` parameter — itself
clinic-configurable as a default in Settings (§6).

**No "Record" tab in MVP** — a visible-but-disabled tab would be a fake
door. Instead the architecture stays forward-compatible: both input methods
feed one shared `transcriptText` value, so a future "Record consultation"
capability slots in later as a third segment that populates the same field
via ASR, with no rework of anything downstream.

**In-flight state** — these are 20–40s LLM calls, not instant:

```
                          ◐  Drafting the summary…
                     Reading the transcript...
                     This usually takes 20–40 seconds for a typical visit.
                     Elapsed: 0:17

                        [ Cancel and edit transcript ]
```

Generation should run as a backend job the client polls, not a blocking
form POST — if the clinician navigates away mid-generation, the job keeps
running and the finished draft is discoverable from the booking-detail card
on return, never silently lost. On failure, the transcript is preserved and
"Try again"/"Edit transcript" are both offered.

### 3. Review & edit screen — the core screen

A direct translation of the prompt's philosophy into UI: **every field
visible, every null visible, every source verifiable at a glance, nothing
reaches a patient without explicit human sign-off.**

- **Review-flags banner**, directly under the header, warn-toned (parallel
  to `AlertError`'s `role="alert" aria-live="assertive"` pattern,
  `cloud/app/components/ui.tsx:173-183`). Each flag gets its own real
  checkbox + label — not one blanket "I've read this," which invites
  rubber-stamping. **Approve stays disabled until every flag is checked.**
- **Field-by-field cards** for every `Item = {text, source}`: fixed English
  label, editable draft text tagged `AI-drafted`, and the verbatim source
  quote directly beneath, labeled "From the transcript:" (screen-reader
  correct, not color/indent alone). Editing a field flips its tag to
  `Edited by Dr. Hendriks` with a `Revert to AI draft` action — the model's
  original output is never destructively lost.
- **Nulls are visible, never hidden.** Single nullable fields
  (`reason_for_visit`, `clinician_assessment`, `follow_up`,
  `safety_netting`) render with a `Not discussed` tag and a `+ Add manually`
  action (manual additions are tagged `Added by Dr. Hendriks`, no source
  quote, explicit "no transcript excerpt" note). Empty arrays
  (`discussed`, `examined_or_tested`, `plan.tests_ordered`, etc.) get the
  same treatment via `None mentioned` — an empty `.map()` would silently
  render nothing, which looks identical to "this section doesn't exist"
  rather than "confirmed empty."
- **Collapsible audit sections**, closed by default: *What was left out*
  (`withheld[]`, framed reassuringly — "the model excludes small talk,
  scheduling, reasoning set aside," not as a defect), *Unclear parts of the
  transcript* (`unclear_passages[]`), *Questions the patient asked*
  (`questions_answered[]`, same source-quote verification pattern).
- **Not attempted in MVP:** linking a specific `review_flags` string to the
  field it concerns — the schema emits a flat `string[]` with no field
  reference, so any mapping would be a guess. If this proves valuable, the
  fix belongs upstream in `docs/patient-summary-prompt.md`'s schema
  (`{field, message}` instead of a bare string), not faked in the UI layer.
- **Footer**, sticky, same pattern as `SettingsCard`'s footer
  (`cloud/app/components/settings.tsx:244-257`): status text left, actions
  right — Discard / Regenerate / Save draft / Approve & continue (disabled
  until flags acknowledged).

### 4. Workflow states

`(none)` → **Draft** → **Under review** → **Approved** → **Sent**, with
**Discarded** reachable from any pre-Sent state, and **Regenerate** resetting
Draft/Under-review content (deliberately harder to reach once Approved).

- **Approved is an integrity boundary, not a label** — editing an approved
  summary requires "Unlock to edit" first, which demotes it back to Under
  review, so an `[Approved]` badge can never coexist with text that differs
  from what was actually approved.
- **Sent is immutable** — a permanent record of what the patient actually
  received. A post-send correction creates a new revision seeded from the
  sent content (not a fresh LLM run), labeled "Revision 2" for the clinician
  and "This is an updated version of the summary sent on [date]" for the
  patient.
- **Attribution gap, called out explicitly:** since dashboard access is one
  shared owner login per connection (no per-staff auth yet), "Approved by
  Dr. Hendriks" can't be inferred from session identity — whoever's logged
  in could be a receptionist. The Approve action requires an explicit
  attestation step, defaulting to (and for MVP, locking to) the
  appointment's assigned doctor:

  ```
  Approving as: Dr. Marijke Hendriks

  [ ] I am Dr. Marijke Hendriks and I approve this summary to be sent to
      Anna de Vries.

                                    [ Cancel ]  [ Confirm approval ]
  ```

  This is a real gap this feature exposes, not a nice-to-have — it's the
  only thing standing between "the UI says a clinician reviewed this" and
  "someone with dashboard access clicked a button." Worth deciding whether
  MVP ships with this workaround or waits for Team accounts.

### 5. Patient-facing delivery

Both a hosted page and an email, following the existing tokened-URL pattern
(`core/src/booking/bookings.ts:538-541`, `manageUrl` /
`?getbooqin_booking=`) — new `?getbooqin_summary={{booking.uid}}` link,
same no-login trust model. New `TEMPLATE_DEFS` entry in
`core/src/booking/mailer.ts` (`customer_visit_summary`), through the
existing `sendToCustomer`/`tokens()` machinery. The email is a
*notification*, not the content itself — clinical detail lives only on the
tokened page.

**Strict subset of the reviewed data reaches the patient**: `review_flags`,
`withheld`, `unclear_passages`, and every `source` quote are clinician-facing
review artifacts and must never appear on the patient page — an explicit
server-side transform, not "just don't render those fields" client-side.

Trust signal is prominent, not fine print (unlike `consent_text` today,
which is `text-[11.5px] text-subtle` — cloud/app/routes/book.$connectionId.tsx:496):

```
┌───────────────────────────────────────────────────────────────────┐
│ Deze samenvatting is met AI-hulp opgesteld op basis van uw          │
│ gesprek, en gecontroleerd en goedgekeurd door dr. Marijke           │
│ Hendriks op 12 maart 2026.                                          │
└───────────────────────────────────────────────────────────────────┘
```

No reply/dispute mechanism on the patient page in MVP — "questions, contact
the clinic" reuses the existing phone/email channel.

### 6. Settings / consent surface

New "Visit summaries" entry in `SETTINGS_NAV`'s Business group
(`cloud/app/components/settings.tsx:24-38`), gated the same way `payments`
already is (`dashboard.$connectionId.settings.tsx:166`), extended to also
require `preset === "clinic"`.

- **Two-layer enablement**, mirroring `PAYMENTS_ENABLED`/`CHAT_ENABLED`
  (`core/src/booking/featureFlags.ts`): a global `VISIT_SUMMARIES_ENABLED`
  env var for rollout control, plus a per-clinic `ToggleRow`
  ("Enable visit summaries") — same component as `waitlist_enabled`.
- **Deliberately not in `PRESET_CONTROLLED_KEYS`**
  (`core/src/booking/presets.ts:393-407`) — no preset should silently turn
  this on. Off by default for every clinic, opt-in only.
- **Default summary language** — a `Segmented` row, pre-filling the intake
  screen's selector, still overridable per-summary.
- **Consent copy** — a new `RowTextarea` variant (none exists yet alongside
  `RowInput`/`RowSelect`): "Consultation consent notice," with an explicit
  hint that this is not legal advice and needs review before enabling for
  real patients. Since no recording-capture screen exists yet, the honest
  MVP placement is an optional, off-by-default merge token
  (`{{summary_consent_line}}`) insertable into the existing
  `customer_created`/`customer_created_pending` email templates — reusing
  the template-customization surface that already exists rather than
  inventing a new patient-facing screen for a moment the product doesn't
  support yet.

### 7. Bilingual UI handling

Dashboard chrome is English-only throughout; drafted content is in
`output_language` (nl/en) per the prompt. Three mechanisms:

1. One page-level language badge ("Summary language: Nederlands") — the
   schema's `output_language` is document-level, not per-field.
2. **Labels never translate** — "Doctor's assessment," "Follow-up," "Plan"
   stay fixed English regardless of content language. Primary defense
   against confusion.
3. `lang="nl"`/`lang="en"` on each content block, extending the existing
   precedent at `dashboard.$connectionId.bookings.$bookingId.tsx:150-155`
   (`lang="en-GB"` forces 24-hour time formatting) — real accessibility
   requirement (correct screen-reader pronunciation), not cosmetic.

**Subtle trap:** source quotes stay in whatever language was actually
spoken, *regardless* of `output_language` — if a clinic sets English output
but the consultation was in Dutch, every field pairs English drafted text
with a Dutch source quote. Correct per the schema, but looks like a bug if
unexplained — the source label should read "From the transcript (spoken in
Dutch):" whenever `detected_language !== output_language`.

### 8. Trust / accessibility cues

Clinician side: per-field `AI-drafted`/`Edited by [name]`/`Added by [name]`
tags with timestamps, the "Approving as" attestation step, `Revert to AI
draft`, and a lightweight collapsed version history across regenerations and
sent revisions. Patient side: the trust banner (§5), plainly stated, not
fine print. Both sides should hold to the accessibility bar the codebase
already sets elsewhere (`Row`'s wrapping `<label>` fix, `AlertError`'s
`role="alert"`, `CheckCard`'s real-checkbox pattern in
`cloud/app/components/ui.tsx`) rather than introducing new custom controls
that fall short of it.

---

## Part 4 — Technical integration plan

*(Synthesis — not part of either research pass; grounded in the same repo
facts.)*

### Data model

New Prisma model, e.g. `ConsultationSummary`, keyed to `Booking`:

- `id`, `bookingId` (FK), `platform`, `shop` (tenant columns, matching every
  other table's convention)
- `status`: `draft | under_review | approved | sent | discarded`
- `transcriptText`, `transcriptSource` (`paste | upload`)
- `outputLanguage`, `detectedLanguage`
- `draftJson` (the model's raw structured output — immutable record of what
  the LLM actually returned)
- `editedJson` (the clinician-edited version rendered/sent — starts equal to
  `draftJson`, diverges field by field as edits happen)
- `reviewFlagsAcknowledged` (which flags have been checked off)
- `approvedByResourceId`, `approvedAt` (the attestation from §4 of Part 3)
- `sentAt`
- `revisionOf` (self-relation, for post-send corrections)
- `retentionExpiresAt` (see retention note below)

Keep `draftJson` and `editedJson` separate rather than mutating in place —
that split is what makes the "AI-drafted" vs "Edited by Dr. X" tags and
`Revert to AI draft` (Part 3 §3) implementable without re-calling the model.

### Where the LLM call lives

New module, e.g. `core/src/ai/patientSummary.ts`, holding the system prompt
as a versioned TypeScript constant (not read from the markdown file at
runtime — `docs/patient-summary-prompt.md` stays the human-readable spec and
worked example; the code constant is what's actually sent, so the two need a
lint/test check that they're kept in sync, or the doc becomes generated from
the constant instead of the other way around). This is the first LLM
integration in the codebase — no Anthropic/OpenAI client exists yet, so this
also means adding API key/secrets handling that doesn't exist today.

### Async generation

The intake screen (Part 3 §2) needs generation to survive navigation, and
these are 20–40s calls — not a fit for a blocking Remix/React Router
`action()`. `shopify-openslot/app/routes/cron.waitlist.tsx` already
establishes a background-job pattern in this codebase (a cron-triggered
route); the same shape — enqueue on submit, a status column the detail route
polls/revalidates, a worker (cron-triggered or queue-driven) that calls the
LLM and writes the result — is the natural fit rather than introducing new
infrastructure.

### Settings & feature flags

- `core/src/booking/featureFlags.ts`: add `VISIT_SUMMARIES_ENABLED`
  alongside `PAYMENTS_ENABLED`/`CHAT_ENABLED`.
- Per-clinic `visit_summaries_enabled` boolean setting — **not** added to
  `PRESET_CONTROLLED_KEYS`, per Part 3 §6.
- `SETTINGS_NAV` gets a new "Visit summaries" entry, hidden unless
  `preset === "clinic"`.

### Mailer

New `TEMPLATE_DEFS` entry (`customer_visit_summary`) in
`core/src/booking/mailer.ts`, same customization/on-off machinery as every
other template. Optional `{{summary_consent_line}}` merge token, off by
default, insertable into existing confirmation templates per Part 3 §6.

### Retention (needs legal sign-off, not just an engineering default)

The business-analyst research (Part 2) flags bounded retention as a GDPR
baseline expectation, not optional. Recommend: raw `transcriptText` — the
single most sensitive artifact, and the one with the least ongoing value
once a summary is approved — auto-purged on a short, defined window after
`sentAt` (a retention sweep is another natural fit for the same cron
pattern noted above); `editedJson`/`draftJson` retained longer as part of
the patient's record, on whatever schedule GetBooqin's counsel sets for
medical-adjacent records. Concrete windows are a legal decision, not
engineering's to pick.

---

## Part 5 — Phased rollout

1. **Compliance foundation** (blocking, before any code): DPA template for
   clinic customers, sub-processor disclosure for the chosen LLM vendor,
   retention policy sign-off, actual legal opinion on the AI Act/MDR
   question in Part 2. Nothing below should ship to a real clinic before
   this is real.
2. **MVP — text-in pilot**: transcript paste/upload → review & edit → patient
   delivery, exactly as scoped in Part 3, gated to a small opt-in cohort of
   existing Clinic-preset customers. No audio. Validates clinician trust and
   workflow fit before any further investment.
3. **General availability (Clinic preset, EU/NL only)**: quota-bundled
   pricing per Part 2, self-serve enablement from Settings, full mailer
   integration.
4. **Deferred, separate projects, not part of this plan:** audio
   capture/transcription vendor selection; Team accounts (closes the
   attribution gap in Part 3 §4 properly); US expansion (HIPAA BAA chain +
   state consent patchwork); any clinician-facing clinical note or EHR
   write-back capability.

### Pilot-cohort mechanism — how step 2's "small opt-in cohort" is actually enforced

Before building any dedicated allowlist for step 2, it's worth naming what
already exists and checking whether it's enough: `VISIT_SUMMARIES_ENABLED`
(`core/src/booking/featureFlags.ts`, env-gated) and the per-clinic
`settings.visit_summaries_enabled` toggle (Cloud's Settings → Business →
Visit summaries page, `cloud/app/routes/dashboard.$connectionId.settings.tsx`)
are already a two-layer gate, and `consultationSummary.ts`'s
`assertEnabled()` requires **both** to be true before anything runs.

**Conclusion: this is sufficient for the MVP pilot. No third mechanism was
built.**

How the two layers map onto step 2 in practice:

- While `VISIT_SUMMARIES_ENABLED` is unset (the state this ships in), the
  "Visit summaries" nav entry doesn't render for *any* shop — the capability
  doesn't exist in the product yet, full stop. This is step 1's "nothing
  below should ship to a real clinic" boundary, enforced in code, not just
  process.
- To start the pilot, ops sets `VISIT_SUMMARIES_ENABLED=true` in production.
  This makes the Settings page reachable for every Clinic-preset shop, not
  only the intended handful — the env var is a single deployment-wide
  boolean, not a per-tenant switch, so it can't itself draw a line around a
  specific set of clinics.
- The actual cohort boundary is the per-clinic toggle, and during the pilot
  it's meant to be turned on by support for the chosen clinics one at a
  time (a direct settings write, prompted by outreach to those specific
  customers) rather than by the clinics discovering and self-enabling it.
  `visit_summary_consent_line` also ships empty by default, so even a shop
  that stumbles onto the toggle and flips it on gets an inert consent
  field and a plain, generic pricing line — not a live patient-facing
  workflow — until someone deliberately fills that in too.

**Honest caveat:** this is a soft boundary, not a hard one. Once the env
flag is live, nothing technically stops a non-pilot Clinic-preset customer
from finding Settings → Visit summaries and turning it on themselves —
there's no per-tenant allowlist behind the toggle. That's an accepted
trade-off for MVP, not an oversight: the toggle is off by default, unmarketed,
and gated behind a preset few shops use; and even self-enabled, the feature
still requires a clinician to review and approve every summary before
anything reaches a patient, and the consent copy is blank until someone
writes it. The blast radius of an off-schedule self-enable is low. If the
pilot needs a harder guarantee later (e.g. a specific clinic must never see
this before its onboarding call), that's a small, scoped follow-up — a
per-shop allowlist flag checked alongside the existing two layers — not a
default requirement for step 2, and shouldn't be built preemptively.

---

## Open questions / decisions needed

1. Is GetBooqin willing to take on the standing GDPR Article 9
   processor obligations in Part 2 — the actual go/no-go gate?
2. Ship the "attest as the assigned doctor" checkbox workaround for MVP, or
   wait for Team accounts to close the attribution gap properly (Part 3 §4)?
3. Is the email-merge-token stopgap for consent copy acceptable for MVP
   (Part 3 §6), given there's no live recording-consent moment in the
   product yet?
4. Should `review_flags` move from a flat `string[]` to `{field, message}`
   in `docs/patient-summary-prompt.md`'s schema, to enable inline
   field-level flag linking in the review UI (Part 3 §3)?
5. Which LLM vendor, and does that choice change the EU-hosting/sub-processor
   story in Part 2?
