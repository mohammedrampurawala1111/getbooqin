/**
 * Visit Summary's LLM integration (Clinic preset only — see
 * docs/patient-summary-cloud-integration-plan.md and
 * docs/patient-summary-prompt.md). This is the first LLM integration in the
 * codebase, so the actual vendor call is deliberately isolated to this one
 * file — swapping providers later should only ever touch this module, not
 * core/src/booking/consultationSummary.ts (the business logic that calls
 * it) or anything upstream of that.
 *
 * The system prompt below is copied verbatim from
 * docs/patient-summary-prompt.md's ```SYSTEM PROMPT``` code block — that
 * markdown file stays the human-readable spec/worked-example, this constant
 * is what is actually sent to the model. Keep them in sync by hand for now
 * (see the integration plan's "Where the LLM call lives" section, which
 * flags this as needing a lint/test check eventually); if the prompt
 * changes, bump the version suffix so in-flight drafts stay attributable to
 * the prompt version that produced them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GetBooqinError } from "../booking/errors.js";

export const PATIENT_SUMMARY_SYSTEM_PROMPT_V1 = `You convert a transcript of a consultation between a clinician and a patient into a
structured draft summary written FOR THE PATIENT. A clinician reviews, edits and
approves every draft before it reaches the patient.

You are a documentation tool, not a clinical one. You report what was said. You do
not assess, advise, diagnose, or improve on it.

## ABSOLUTE RULES

1. ONLY REPORT WHAT WAS ACTUALLY SAID.
   Never add medical information, advice, explanation, dosage, warning sign, or
   context that does not appear in the transcript — even if it is standard practice,
   even if it is obviously correct, even if its absence looks like an oversight.
   If the clinician did not say it, it does not go in the summary.

2. NEVER FILL A GAP.
   If a section was not discussed, output null. Do not soften this with generic
   filler such as "Follow your doctor's instructions" or "Contact us if you are
   worried." An empty section is a signal to the reviewing clinician. A generic
   sentence hides the gap and defeats the review.

3. PRESERVE CERTAINTY EXACTLY.
   If the clinician said "probably", "possibly", "I doubt it", keep the hedge.
   Never upgrade a possibility into a conclusion, or downgrade a conclusion into a
   possibility. Attribute clinical statements to the clinician: "The doctor thinks…"
   / "De arts denkt…" — never "You have…" / "U heeft…".

4. DO NOT GUESS THROUGH UNCLEAR AUDIO.
   If a passage is garbled, inaudible or ambiguous and looks clinically relevant,
   record it in unclear_passages. Do not infer what was probably meant.

5. COPY NUMBERS VERBATIM.
   Dosages, frequencies, durations, dates and measurements are copied exactly as
   spoken. Never convert units, round, normalise, or correct. If a dose sounds
   implausible, still copy it exactly and add an entry to review_flags. Judging
   whether it is wrong is the clinician's job, not yours.

## WHAT TO LEAVE OUT

Exclude, and log each exclusion in \`withheld\` with a one-line reason:

- Differential diagnoses the clinician raised while thinking aloud and then set
  aside. These belong in the clinical note, not in a letter the patient takes home.
- Anything addressed to a third party in the room rather than to the patient.
- Small talk, scheduling, computer problems, interruptions.
- The clinician's uncertainty about their own reasoning process.
- Anything the clinician indicated should not be written down.

Logging the exclusion matters as much as making it. The reviewing clinician must be
able to see what you removed and put it back.

## LANGUAGE

- Detect the language of the consultation and write in that language, unless
  output_language is supplied in the user message.
- Dutch: B1 level. Short sentences, everyday words, "u" form. On first use give the
  lay term with the medical term in brackets: "keelontsteking (faryngitis)".
- English: plain English, roughly 8th-grade reading level.
- Translate meaning, not word order. Never mix languages inside a field, except for
  the bracketed medical term.
- Medication names, numbers and dosages are never translated or converted.

## SOURCE QUOTES

Every populated field carries a \`source\`: a verbatim quote of at most 15 words from
the transcript, in the language actually spoken. This lets the clinician verify the
claim at a glance. Never paraphrase into \`source\`. If you cannot produce a verbatim
quote supporting a field, the field must be null.

## OUTPUT

Return exactly one JSON object matching the schema below. No markdown, no code
fences, no commentary before or after.

{
  "detected_language": "nl" | "en" | "other",
  "output_language": "nl" | "en",

  "reason_for_visit":      Item | null,
  "discussed":             Item[],
  "examined_or_tested":    Item[],
  "clinician_assessment":  Item | null,

  "plan": {
    "medication":   Medication[],
    "tests_ordered": Item[],
    "referrals":     Item[],
    "self_care":     Item[]
  },

  "follow_up":      Item | null,
  "safety_netting": Item | null,

  "questions_answered": { "question": string, "answer": string, "source": string }[],
  "unclear_passages":   { "marker": string, "why_it_matters": string }[],
  "withheld":           { "content": string, "reason": string }[],
  "review_flags":       string[]
}

Item       = { "text": string, "source": string }
Medication = { "name": string, "dose": string | null, "frequency": string | null,
               "duration": string | null, "purpose": string | null,
               "source": string }

Field notes:

- safety_netting is ONLY populated when the clinician explicitly said what should
  prompt the patient to seek help, and when. Never construct it. Never generalise
  it. If the clinician did not give one, this field is null.
- follow_up is only populated for a concrete arrangement (an appointment, a
  callback, a timeframe). "See how it goes" alone is not a follow-up.
- review_flags is for anything you want the clinician to look at closely:
  implausible values, contradictions between two things the clinician said,
  a plan mentioned but never completed, poor audio over a medication name.`;

/* ------------------------------------------------------------------ Types */
// Mirrors docs/patient-summary-prompt.md's JSON schema exactly.

export interface Item {
  text: string;
  source: string;
}

export interface Medication {
  name: string;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  purpose: string | null;
  source: string;
}

export interface QuestionAnswered {
  question: string;
  answer: string;
  source: string;
}

export interface UnclearPassage {
  marker: string;
  why_it_matters: string;
}

export interface WithheldItem {
  content: string;
  reason: string;
}

export interface PatientSummaryPlan {
  medication: Medication[];
  tests_ordered: Item[];
  referrals: Item[];
  self_care: Item[];
}

/** The full shape returned by the model — one JSON object, per the system prompt's OUTPUT section. */
export interface PatientSummaryDraft {
  detected_language: "nl" | "en" | "other";
  output_language: "nl" | "en";

  reason_for_visit: Item | null;
  discussed: Item[];
  examined_or_tested: Item[];
  clinician_assessment: Item | null;

  plan: PatientSummaryPlan;

  follow_up: Item | null;
  safety_netting: Item | null;

  questions_answered: QuestionAnswered[];
  unclear_passages: UnclearPassage[];
  withheld: WithheldItem[];
  review_flags: string[];
}

/* -------------------------------------------------------------- Generate */

export interface GeneratePatientSummaryArgs {
  transcript: string;
  outputLanguage: "nl" | "en" | "auto";
}

// Claude Sonnet 5 — current stable Sonnet model as of this writing. Bump
// this constant (and PATIENT_SUMMARY_SYSTEM_PROMPT_V1's version suffix, if
// the prompt itself also changes) when a newer model should take over;
// nothing else in this file should need to change.
const MODEL_ID = "claude-sonnet-5";

// Structured JSON output for a single consultation. 8192 proved too tight
// for a detailed visit (verbose Dutch B1 phrasing, source quotes on every
// field, medication/safety-netting/review_flags all populated) and truncated
// mid-JSON — Sonnet 5 supports up to 128k output tokens non-streaming, so
// this has plenty of headroom without needing to switch this blocking call
// to streaming.
const MAX_OUTPUT_TOKENS = 16000;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_not_configured",
      "Visit Summary is not configured — ANTHROPIC_API_KEY is not set.",
      500
    );
  }
  client = new Anthropic({ apiKey });
  return client;
}

function userMessage(args: GeneratePatientSummaryArgs): string {
  return `output_language: ${args.outputLanguage}\n\n<transcript>\n${args.transcript}\n</transcript>`;
}

/**
 * Calls the LLM to draft a patient-facing visit summary from a consultation
 * transcript. Throws GetBooqinError if ANTHROPIC_API_KEY is unset, or if the
 * model's response can't be parsed as the expected JSON shape — never
 * returns a fabricated/partial draft.
 */
export async function generatePatientSummary(args: GeneratePatientSummaryArgs): Promise<PatientSummaryDraft> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: PATIENT_SUMMARY_SYSTEM_PROMPT_V1,
    messages: [{ role: "user", content: userMessage(args) }],
  });

  if (response.stop_reason === "refusal") {
    const details = response.stop_details;
    throw new GetBooqinError(
      "getbooqin_visit_summary_refused",
      details?.explanation
        ? `The visit summary model declined to process this transcript: ${details.explanation}`
        : "The visit summary model declined to process this transcript.",
      502
    );
  }

  const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
  if (!textBlock || !textBlock.text.trim()) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_empty_response",
      "The visit summary model returned no text output.",
      502
    );
  }

  return parseDraft(textBlock.text, response.stop_reason);
}

// The prompt says "no markdown, no code fences", but models sometimes wrap
// structured JSON output in a ```json ... ``` fence anyway — strip one
// before giving up on JSON.parse.
function stripCodeFence(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : raw;
}

function parseDraft(raw: string, stopReason: string | null): PatientSummaryDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      console.error(
        `[getbooqin visit-summary] failed to parse model output as JSON (stop_reason=${stopReason}). ` +
          `First 500 chars: ${raw.slice(0, 500)}`
      );
      throw new GetBooqinError(
        "getbooqin_visit_summary_invalid_json",
        stopReason === "max_tokens"
          ? "The visit summary model's response was cut off before it finished — the transcript may be too long for the current output limit."
          : "The visit summary model did not return valid JSON.",
        502
      );
    }
  }

  if (!isPatientSummaryDraft(parsed)) {
    throw new GetBooqinError(
      "getbooqin_visit_summary_invalid_shape",
      "The visit summary model's response did not match the expected schema.",
      502
    );
  }

  return parsed;
}

/** Structural sanity check — not a full schema validator, just enough to catch a malformed/truncated response before it's stored as clinical content. */
function isPatientSummaryDraft(value: unknown): value is PatientSummaryDraft {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.detected_language === "string" &&
    typeof v.output_language === "string" &&
    Array.isArray(v.discussed) &&
    Array.isArray(v.examined_or_tested) &&
    !!v.plan &&
    typeof v.plan === "object" &&
    Array.isArray((v.plan as Record<string, unknown>).medication) &&
    Array.isArray((v.plan as Record<string, unknown>).tests_ordered) &&
    Array.isArray((v.plan as Record<string, unknown>).referrals) &&
    Array.isArray((v.plan as Record<string, unknown>).self_care) &&
    Array.isArray(v.questions_answered) &&
    Array.isArray(v.unclear_passages) &&
    Array.isArray(v.withheld) &&
    Array.isArray(v.review_flags)
  );
}
