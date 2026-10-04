"use client";
import { useEffect, useRef, useState } from "react";
import { detectCarrier } from "@/server/modules/packages/carrier";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
declare global { interface Window { BarcodeDetector?: new (o?: { formats?: string[] }) => Detector } }

// tracking number with camera scanning (where the browser supports it) and carrier auto-detection
export function TrackingInput({ carriers, error }: { carriers: readonly string[]; error?: string }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [touchedCarrier, setTouchedCarrier] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== "undefined" && !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia;

  const onTracking = (v: string) => {
    setTracking(v);
    const d = detectCarrier(v);
    if (d && !touchedCarrier) setCarrier(d.carrier);
  };

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.current!.srcObject = stream;
        await video.current!.play();
        const detector = new window.BarcodeDetector!({ formats: ["code_128", "code_39", "qr_code", "data_matrix", "ean_13", "upc_a", "itf", "pdf417"] });
        while (!stop) {
          const found = await detector.detect(video.current!).catch(() => []);
          if (found[0]?.rawValue) { onTracking(found[0].rawValue); setScanning(false); setNote("Scanned."); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setNote("Couldn't open the camera. Type the number or use a USB scanner.");
        setScanning(false);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor="pkg-tracking" className="block text-[13px] font-medium">Tracking number</label>
        <div className="flex gap-2">
          <Input id="pkg-tracking" name="trackingNumber" value={tracking} onChange={(e) => onTracking(e.target.value)} placeholder="Scan or type" autoComplete="off" aria-invalid={error ? true : undefined} />
          {supported ? <Button type="button" variant="secondary" onClick={() => { setNote(null); setScanning((s) => !s); }}>{scanning ? "Stop" : "Scan"}</Button> : null}
        </div>
        {scanning ? <video ref={video} className="mt-2 aspect-video w-full rounded-[var(--radius-md)] bg-black object-cover" muted playsInline /> : null}
        <p className="text-xs text-faint" aria-live="polite">{note ?? (supported ? "Camera scanning works on most phones. USB scanners type into this box." : "USB scanners type into this box.")}</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pkg-carrier" className="block text-[13px] font-medium">Carrier</label>
        <Select id="pkg-carrier" name="carrier" value={carrier} onChange={(e) => { setCarrier(e.target.value); setTouchedCarrier(true); }}>
          <option value="">Unknown</option>
          {carriers.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <p className="text-xs text-faint">Detected from the tracking number when possible.</p>
      </div>
    </div>
  );
}
