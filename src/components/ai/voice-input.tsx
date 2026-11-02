"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/shell/icons";

// minimal Web Speech API types (not in TypeScript's DOM library)
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type RecognitionCtor = new () => Recognition;
const browserRecognition = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
const canRecord = () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
const noop = () => () => {};

const MAX_RECORDING_MS = 60_000;

// Dictation into the assistant's input. With a speech-to-text provider configured (`transcribeUrl`), audio is
// recorded and sent to it through the app, the same path as typed questions; otherwise the browser's own speech
// recognition is used where it exists (it may process audio with the browser vendor). Nothing is sent to the
// assistant until the person presses Send, so the words can be checked first.
export function VoiceInput({ transcribeUrl, onText, onStart, disabled }: { transcribeUrl: string | null; onText: (text: string) => void; onStart?: () => void; disabled?: boolean }) {
  const kind = useSyncExternalStore(noop, () => (transcribeUrl && canRecord() ? "server" : browserRecognition() ? "browser" : "none"), () => "none");
  const [state, setState] = useState<"idle" | "listening" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { rec.current?.abort(); recorder.current?.stream.getTracks().forEach((t) => t.stop()); if (timer.current) clearTimeout(timer.current); }, []);
  if (kind === "none") return null;

  const startBrowser = () => {
    const Ctor = browserRecognition()!;
    const r = new Ctor();
    r.lang = navigator.language || "en-CA";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onText(text.trim());
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone access is blocked for this site." : e.error === "no-speech" ? "Didn't catch that — try again." : "Dictation stopped.");
    r.onend = () => setState("idle");
    rec.current = r;
    r.start();
    setState("listening");
  };

  const startServer = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access is blocked for this site.");
      return;
    }
    const chunks: Blob[] = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearTimeout(timer.current);
      const audio = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      if (!audio.size) { setState("idle"); return; }
      setState("transcribing");
      try {
        const fd = new FormData();
        fd.append("audio", audio, `dictation.${(mr.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm"}`);
        const res = await fetch(transcribeUrl!, { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok || !body.text) setError(body.error ?? "Couldn't turn that into text. Try again or type instead.");
        else onText(body.text.trim());
      } catch {
        setError("Connection lost while sending the recording.");
      } finally {
        setState("idle");
      }
    };
    recorder.current = mr;
    mr.start();
    setState("listening");
    timer.current = setTimeout(() => mr.state === "recording" && mr.stop(), MAX_RECORDING_MS);
  };

  const toggle = () => {
    setError(null);
    if (state === "listening") {
      if (kind === "browser") rec.current?.stop();
      else if (recorder.current?.state === "recording") recorder.current.stop();
      return;
    }
    onStart?.();
    if (kind === "browser") startBrowser();
    else void startServer();
  };

  const label = state === "listening" ? "Stop dictation" : state === "transcribing" ? "Transcribing" : "Dictate";
  return (
    <>
      <button type="button" onClick={toggle} disabled={disabled || state === "transcribing"} aria-pressed={state === "listening"} aria-label={label} title={label}
        className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-muted hover:bg-subtle hover:text-fg disabled:opacity-50 pointer-coarse:size-11",
          state === "listening" && "bg-danger-soft text-danger hover:bg-danger-soft")}>
        {state === "transcribing"
          ? <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
          : <Icon name="mic" className={cn("size-4", state === "listening" && "animate-pulse motion-reduce:animate-none")} />}
      </button>
      <span className="sr-only" aria-live="polite">{state === "listening" ? "Listening" : state === "transcribing" ? "Turning your words into text" : error ?? ""}</span>
      {error ? <span role="alert" className="absolute -top-6 left-2 text-[11px] text-danger">{error}</span> : null}
    </>
  );
}
