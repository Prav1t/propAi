"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert, Input } from "@/components/ui/form";
import { Button, SubmitButton } from "@/components/ui/button";

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

// scan a guest's QR pass with the device camera, or paste the pass link
export function PassScanner({ action }: { action: (s: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const supported = typeof window !== "undefined" && !!(window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.current!.srcObject = stream;
        await video.current!.play();
        const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        const detector = new Ctor({ formats: ["qr_code"] });
        while (!stop) {
          const found = await detector.detect(video.current!).catch(() => []);
          if (found[0]?.rawValue) {
            input.current!.value = found[0].rawValue;
            setScanning(false);
            form.current?.requestSubmit();
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch {
        setNote("Couldn't open the camera. Paste the pass link, or search by name below.");
        setScanning(false);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]);

  return (
    <form ref={form} action={formAction} className="space-y-2">
      <FormAlert>{state.error}</FormAlert>
      <label htmlFor="pass-code" className="block text-[13px] font-medium">Guest pass</label>
      <div className="flex gap-2">
        <Input ref={input} id="pass-code" name="code" placeholder="Scan the QR code or paste the pass link" autoComplete="off" />
        {supported ? <Button type="button" variant="secondary" onClick={() => { setNote(null); setScanning((s) => !s); }}>{scanning ? "Stop" : "Scan"}</Button> : null}
        <SubmitButton variant="secondary" pendingLabel="…">Find</SubmitButton>
      </div>
      {scanning ? <video ref={video} className="aspect-video w-full max-w-sm rounded-[var(--radius-md)] bg-black object-cover" muted playsInline /> : null}
      <p className="text-xs text-faint" aria-live="polite">{note ?? (supported ? "Point the camera at the guest's phone." : "Handheld QR scanners type into this box.")}</p>
    </form>
  );
}
