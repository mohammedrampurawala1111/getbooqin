/**
 * Deepgram (pre-recorded/batch) integration — shared server-side logic for
 * the "record a consultation" flow. Originally built and QA-verified inside
 * the standalone harness route
 * (`dashboard.$connectionId.recording-poc.$bookingId.tsx`, see
 * `docs/recording-poc-ux-spec.md` §1.4/§2.6) and extracted here so the real,
 * integrated intake screen
 * (`dashboard.$connectionId.bookings.$bookingId.summary.tsx`) can call the
 * exact same Deepgram request/response handling instead of duplicating it —
 * both routes' actions call `transcribeAudioFromForm()` for their
 * `_action === "transcribe"` intent.
 */

// Confirmed against Deepgram's live docs at build time (developers.deepgram.com):
// - Endpoint: POST https://api.deepgram.com/v1/listen
// - Auth: `Authorization: Token <key>` (not Bearer)
// - Raw audio bytes as the body, Content-Type set to the audio's own mime type
// - `diarize=true` + `utterances=true` returns results.utterances[], each a
//   chronologically-ordered, already-grouped per-speaker turn
//   ({ speaker, transcript, start, ... }) — exactly the "diarized utterances
//   in chronological order" shape the mapping algorithm below (spec §2.2)
//   assumes, so no word-level grouping is needed on our end.
// - `model=nova-3` + `detect_language=true`: nova-3 has native Dutch and
//   English monolingual support (the two languages this feature's test
//   scripts use), and detect_language picks whichever was actually spoken
//   instead of hard-coding one — falling back through lower model tiers only
//   if the detected language isn't available on nova-3.
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

export interface DeepgramUtterance {
  speaker: number;
  transcript: string;
  start: number;
}

interface DeepgramResponse {
  results?: { utterances?: DeepgramUtterance[] };
}

// Mirrors core/src/ai/patientSummary.ts's getClient() fail-fast pattern for
// a missing ANTHROPIC_API_KEY — same idea, just not a GetBooqinError since
// this file isn't part of core.
function getDeepgramApiKey(): string {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error("DEEPGRAM_API_KEY is not set — recording can't be transcribed without it.");
  }
  return key;
}

// "no indefinite spinner": a stalled/hung Deepgram request must fail loudly,
// not leave the tester/clinician stuck on the transcribing screen forever.
// 75s is comfortably above how long a normal short recording's
// upload+processing takes, while still guaranteeing a bounded wait.
const DEEPGRAM_TIMEOUT_MS = 75_000;

export async function transcribeWithDeepgram(audioFile: File): Promise<DeepgramUtterance[]> {
  const apiKey = getDeepgramApiKey();

  const url = new URL(DEEPGRAM_URL);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("detect_language", "true");
  url.searchParams.set("diarize", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("utterances", "true");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": audioFile.type || "audio/webm",
      },
      body: await audioFile.arrayBuffer(),
      signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout() aborts with a "TimeoutError" DOMException —
    // give that a clear, specific message rather than letting whatever
    // generic abort text the runtime produces surface to the user. Any
    // other fetch-level failure (DNS, connection refused, etc.) still
    // flows through the same catch in transcribeAudioFromForm()'s try/catch.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `Deepgram didn't respond within ${DEEPGRAM_TIMEOUT_MS / 1000}s — the request timed out.`
      );
    }
    throw err;
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errJson = (await response.json()) as { err_msg?: string };
      if (errJson.err_msg) detail = `: ${errJson.err_msg}`;
    } catch {
      // Non-JSON error body — fall through with just the status.
    }
    throw new Error(`Deepgram request failed (${response.status})${detail}`);
  }

  const json = (await response.json()) as DeepgramResponse;
  const utterances = json.results?.utterances ?? [];
  if (utterances.length === 0) {
    throw new Error("Deepgram returned no speech in this recording.");
  }
  // Should already be chronological; sort defensively rather than trust it.
  return [...utterances].sort((a, b) => a.start - b.start);
}

export type FirstSpeaker = "doctor" | "patient";
type Role = "ARTS" | "PATIENT";

/**
 * Speaker-mapping algorithm (UX spec §2.2), applied verbatim:
 * 1. First utterance's speaker id -> whichever role the toggle said goes first.
 * 2. Next distinct speaker id -> the other role.
 * 3. Reassemble in order as "ARTS: {text}" / "PATIENT: {text}" lines.
 * 4. Known limitation: a third distinct speaker id gets folded into
 *    whichever of the two mapped roles was active immediately before it —
 *    recomputed per occurrence, not given a permanent mapping of its own.
 */
export function assembleTranscript(utterances: DeepgramUtterance[], firstSpeaker: FirstSpeaker): string {
  const firstRole: Role = firstSpeaker === "doctor" ? "ARTS" : "PATIENT";
  const otherRole: Role = firstRole === "ARTS" ? "PATIENT" : "ARTS";

  const speakerToRole = new Map<number, Role>();
  const lines: string[] = [];
  let lastRole: Role | null = null;

  for (const u of utterances) {
    const text = u.transcript.trim();
    if (!text) continue;

    let role = speakerToRole.get(u.speaker);
    if (!role) {
      if (speakerToRole.size === 0) {
        role = firstRole;
        speakerToRole.set(u.speaker, role);
      } else if (speakerToRole.size === 1) {
        role = otherRole;
        speakerToRole.set(u.speaker, role);
      } else {
        role = lastRole ?? firstRole;
      }
    }

    lines.push(`${role}: ${text}`);
    lastRole = role;
  }

  return lines.join("\n");
}

/**
 * Full handler for the `_action === "transcribe"` intent shared by both the
 * harness route and the real intake screen's action: pulls the uploaded
 * audio Blob + first-speaker toggle out of the submitted FormData, calls
 * Deepgram, maps speakers, and returns either `{ transcript }` or
 * `{ error }` — never throws, so callers can `return` it directly.
 */
export async function transcribeAudioFromForm(
  form: FormData
): Promise<{ transcript: string } | { error: string }> {
  const audioFile = form.get("audio");
  if (!(audioFile instanceof File) || audioFile.size === 0) {
    return { error: "No audio was received by the server." };
  }
  const firstSpeaker: FirstSpeaker = String(form.get("first_speaker") ?? "doctor") === "patient" ? "patient" : "doctor";
  try {
    const utterances = await transcribeWithDeepgram(audioFile);
    const transcript = assembleTranscript(utterances, firstSpeaker);
    if (!transcript.trim()) {
      return { error: "Deepgram returned only silence/no attributable speech for this recording." };
    }
    return { transcript };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Transcription failed." };
  }
}
