/**
 * Shared "record a consultation" client-side state machine + widget UI —
 * the state machine, speaker-mapping toggle, and mic/transcription
 * error/recovery states from `docs/recording-poc-ux-spec.md` §2, originally
 * built and QA-verified inside the standalone harness route
 * (`dashboard.$connectionId.recording-poc.$bookingId.tsx`). Extracted here
 * so both that harness and the real, integrated intake screen
 * (`dashboard.$connectionId.bookings.$bookingId.summary.tsx`) share one
 * copy instead of maintaining two.
 *
 * `useRecordingCapture()` owns the state machine (idle -> recording ->
 * transcribing -> done, with mic-error/error branches) and drives Deepgram
 * transcription via a `useFetcher` POST to the *current* route's own action
 * with `_action=transcribe` (handled server-side by
 * `~/lib/deepgram.server.ts`'s `transcribeAudioFromForm()`). Each caller's
 * action must handle that intent the same way.
 *
 * `RecordingCapturePanel` renders the idle / recording / mic-error /
 * transcribing / error states (the mockups in spec §2.2-2.6) as a
 * self-contained `.card`. It deliberately renders nothing for the "done"
 * state — the two callers converge the finished transcript back into their
 * own, different "what happens with a finished transcript" UI (the
 * harness's own review-and-generate card vs. the real intake screen's
 * existing transcript field/language selector/submit button), so that part
 * stays with each caller rather than being forced into a shared shape.
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

export type RecordingCaptureState = "idle" | "recording" | "transcribing" | "mic-error" | "error" | "done";
export type FirstSpeaker = "doctor" | "patient";

// getUserMedia() can reject for several distinct reasons that all deserve
// different copy — lumping them into one "access is blocked" message is
// misleading when the real problem is "no microphone" or "device busy",
// not a permissions decision the user can fix in site settings.
export type MicErrorKind = "permission" | "not-found" | "in-use" | "other";

const MIC_ERROR_COPY: Record<MicErrorKind, { title: string; body: string }> = {
  permission: {
    title: "⚠ Microphone access is blocked",
    body: "This page needs microphone access to record. Enable it in your browser's site settings for this page, then try again.",
  },
  "not-found": {
    title: "⚠ No microphone found",
    body: "This device doesn't have a microphone available to record from. Connect one, then try again.",
  },
  "in-use": {
    title: "⚠ Microphone unavailable",
    body: "The microphone is already in use by another application or browser tab. Close it, then try again.",
  },
  other: {
    title: "⚠ Couldn't access the microphone",
    body: "Something went wrong accessing the microphone. Try again.",
  },
};

export function formatElapsed(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export interface RecordingCapture {
  state: RecordingCaptureState;
  firstSpeaker: FirstSpeaker;
  setFirstSpeaker: (v: FirstSpeaker) => void;
  elapsedRecording: number;
  micErrorKind: MicErrorKind;
  micErrorMessage: string;
  transcript: string;
  setTranscript: (v: string) => void;
  transcribeError?: string;
  startRecording: () => void;
  stopRecording: () => void;
  retryTranscription: () => void;
  /** Discards the captured transcript/audio and returns to "idle". Callers gate this behind a confirmation (real work would be lost), same as the harness's own Re-record dialog. */
  reRecord: () => void;
}

/** bookingId/shop aren't inputs here — the transcribe fetcher posts to whatever route renders this hook, and that route's own action reads tenant/booking context from the request/params, not from client state. */
export function useRecordingCapture(): RecordingCapture {
  const transcribeFetcher = useFetcher<{ transcript?: string; error?: string }>();

  const [state, setState] = useState<RecordingCaptureState>("idle");
  const [firstSpeaker, setFirstSpeaker] = useState<FirstSpeaker>("doctor");
  const [elapsedRecording, setElapsedRecording] = useState(0);
  const [micErrorKind, setMicErrorKind] = useState<MicErrorKind>("other");
  const [micErrorMessage, setMicErrorMessage] = useState("");
  const [transcript, setTranscript] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioBlobRef = useRef<Blob | null>(null);

  // Elapsed-time ticker for the "recording" state only — mirrors
  // summary.tsx's own GeneratingScreen useEffect+setInterval pattern.
  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setElapsedRecording((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  function submitForTranscription(blob: Blob) {
    const fd = new FormData();
    fd.set("_action", "transcribe");
    fd.set("first_speaker", firstSpeaker);
    fd.set("audio", blob, "recording.webm");
    transcribeFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  async function startRecording() {
    setMicErrorMessage("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        audioBlobRef.current = blob;
        stream.getTracks().forEach((track) => track.stop());
        submitForTranscription(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setElapsedRecording(0);
      setState("recording");
    } catch (err) {
      const domName = err instanceof DOMException ? err.name : "";
      if (domName === "NotAllowedError" || domName === "PermissionDeniedError" || domName === "SecurityError") {
        setMicErrorKind("permission");
      } else if (domName === "NotFoundError" || domName === "DevicesNotFoundError") {
        setMicErrorKind("not-found");
      } else if (domName === "NotReadableError" || domName === "TrackStartError") {
        setMicErrorKind("in-use");
      } else {
        setMicErrorKind("other");
      }
      setMicErrorMessage(err instanceof Error ? err.message : "");
      setState("mic-error");
    }
  }

  function stopRecording() {
    setState("transcribing");
    mediaRecorderRef.current?.stop();
  }

  function retryTranscription() {
    if (!audioBlobRef.current) return;
    setState("transcribing");
    submitForTranscription(audioBlobRef.current);
  }

  useEffect(() => {
    if (transcribeFetcher.state !== "idle" || !transcribeFetcher.data) return;
    if (transcribeFetcher.data.transcript) {
      setTranscript(transcribeFetcher.data.transcript);
      setState("done");
    } else if (transcribeFetcher.data.error) {
      setState("error");
    }
  }, [transcribeFetcher.state, transcribeFetcher.data]);

  function reRecord() {
    setTranscript("");
    audioBlobRef.current = null;
    chunksRef.current = [];
    setElapsedRecording(0);
    setState("idle");
  }

  return {
    state, firstSpeaker, setFirstSpeaker, elapsedRecording, micErrorKind, micErrorMessage,
    transcript, setTranscript, transcribeError: transcribeFetcher.data?.error,
    startRecording, stopRecording, retryTranscription, reRecord,
  };
}

/* Controlled two-option switch for the speaker-first toggle — same visual
   pattern as settings.tsx's Segmented, but controlled (onChange) since the
   value has to be readable from JS the moment recording starts (to include
   in the transcribe FormData) and locked once recording begins. Kept local
   to this shared widget rather than a third copy of the ones already local
   to the harness/summary routes' own paste/upload/language selectors. */
function SpeakerToggle({ value, onChange }: { value: FirstSpeaker; onChange: (v: FirstSpeaker) => void }) {
  const options: { value: FirstSpeaker; label: string }[] = [
    { value: "doctor", label: "Doctor" },
    { value: "patient", label: "Patient" },
  ];
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
    </div>
  );
}

/** Structurally identical to summary.tsx's GeneratingScreen — same spinner, same centered layout, same elapsed counter, same absence of a Cancel button (no cancellation endpoint once the upload/Deepgram call is in flight). Only the copy differs. */
function TranscribingCard() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card">
      <div className="card-body flex flex-col items-center gap-3 py-16 text-center">
        <span
          className="h-9 w-9 animate-spin rounded-full border-[3px] border-line-strong border-t-brand-500"
          aria-hidden="true"
        />
        <h2 className="text-card font-semibold">Transcribing the recording…</h2>
        <p className="max-w-[360px] text-body text-muted">
          Uploading audio and waiting for Deepgram to process it — usually about as long as the recording itself.
        </p>
        <p className="num text-[12px] text-subtle">Elapsed: {formatElapsed(elapsed)}</p>
      </div>
    </div>
  );
}

/**
 * Renders the idle / recording / mic-error / transcribing / error states of
 * `capture` as a self-contained `.card` (spec §2.2-2.6's mockups). Returns
 * `null` for "done" — see this file's header comment for why that state is
 * left to each caller.
 */
export function RecordingCapturePanel({ capture }: { capture: RecordingCapture }) {
  const {
    state, firstSpeaker, setFirstSpeaker, elapsedRecording, micErrorKind, micErrorMessage,
    startRecording, stopRecording, retryTranscription, transcribeError,
  } = capture;

  if (state === "idle") {
    return (
      <div className="card">
        <div className="card-body flex flex-col items-center gap-5 py-10 text-center">
          <div className="flex flex-col items-center gap-2">
            <span className="text-[13px] font-medium">Who speaks first?</span>
            <SpeakerToggle value={firstSpeaker} onChange={setFirstSpeaker} />
            <p className="max-w-[320px] text-[12px] text-subtle">
              Deepgram can tell the two speakers apart but doesn&rsquo;t know which is which — this tells us.
            </p>
          </div>
          <button type="button" className="btn-pri" onClick={startRecording}>
            <span aria-hidden="true">⏺</span> Start recording
          </button>
        </div>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="card">
        <div className="card-body flex flex-col items-center gap-4 py-12 text-center">
          <span className="flex items-center gap-2 text-[15px] font-semibold text-danger">
            <span className="inline-block h-2 w-2 rounded-full bg-danger" aria-hidden="true" />
            Recording
          </span>
          <span className="num text-[28px] font-medium">{formatElapsed(elapsedRecording)}</span>
          <button type="button" className="btn-del" onClick={stopRecording}>
            ■ Stop recording
          </button>
          <p className="m-0 text-[12px] text-subtle">
            Speaking first: {firstSpeaker === "doctor" ? "Doctor" : "Patient"}
          </p>
        </div>
      </div>
    );
  }

  if (state === "mic-error") {
    const copy = MIC_ERROR_COPY[micErrorKind];
    return (
      <div className="card">
        <div className="card-body flex flex-col items-center gap-3 py-12 text-center">
          <span className="text-[15px] font-semibold text-danger">{copy.title}</span>
          <p className="max-w-[360px] text-body text-muted">
            {copy.body}
            {micErrorKind === "other" && micErrorMessage ? ` (${micErrorMessage})` : ""}
          </p>
          <button type="button" className="btn-sec" onClick={startRecording}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (state === "transcribing") {
    return <TranscribingCard />;
  }

  if (state === "error") {
    return (
      <div className="card">
        <div className="card-body flex flex-col items-center gap-3 py-12 text-center">
          <span className="text-[15px] font-semibold text-danger">⚠ Transcription failed</span>
          <p className="max-w-[380px] text-body text-muted">
            Recorded {formatElapsed(elapsedRecording)} of audio but couldn&rsquo;t get a transcript back.
            {transcribeError ? ` ${transcribeError}` : ""}
          </p>
          <button type="button" className="btn-sec" onClick={retryTranscription}>
            Retry transcription
          </button>
        </div>
      </div>
    );
  }

  return null;
}
