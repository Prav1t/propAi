"use client";
import { useEffect, useRef, useState } from "react";

// draws with mouse, pen or finger; the PNG data URL is posted in a hidden input named `name`
export function SignaturePad({ name = "signature", label = "Signature (optional)" }: { name?: string; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [data, setData] = useState("");

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        {data ? <button type="button" className="text-xs text-accent hover:underline" onClick={() => {
          const c = canvas.current!;
          c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          setData("");
        }}>Clear</button> : null}
      </div>
      <canvas ref={canvas} aria-label="Signature area: draw with your finger or mouse" role="img"
        className="h-28 w-full touch-none rounded-[var(--radius-md)] border border-dashed border-border-strong bg-white"
        onPointerDown={(e) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); const ctx = e.currentTarget.getContext("2d")!; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const ctx = e.currentTarget.getContext("2d")!; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }}
        onPointerUp={(e) => { drawing.current = false; setData(e.currentTarget.toDataURL("image/png")); }}
        onPointerLeave={() => { drawing.current = false; }} />
      <input type="hidden" name={name} value={data} />
    </div>
  );
}
