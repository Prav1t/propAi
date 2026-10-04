"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type PassCardData = { visitorId: string; url: string; qr: string };

// the shareable guest pass: QR + link, shown once right after it's created
export function PassCard({ card, guestName, base }: { card: PassCardData; guestName?: string; base: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-border bg-subtle/50 p-4 sm:flex-row sm:items-center" aria-label="Guest pass">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={card.qr} alt="QR code for the guest pass" width={176} height={176} className="size-44 shrink-0 self-center rounded-[var(--radius-md)] bg-white p-2" />
      <div className="min-w-0 space-y-3">
        <div>
          <p className="font-medium">Guest pass{guestName ? ` for ${guestName}` : ""}</p>
          <p className="text-[13px] text-muted">Send this link to your guest. The front desk scans the QR code on their phone. Anyone with the link can show it, so share it only with them.</p>
        </div>
        <input readOnly value={card.url} aria-label="Pass link" onFocus={(e) => e.currentTarget.select()}
          className="block h-9 w-full truncate rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 font-mono text-xs" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={async () => { await navigator.clipboard?.writeText(card.url).catch(() => {}); setCopied(true); }}>{copied ? "Copied" : "Copy link"}</Button>
          {canShare ? <Button type="button" size="sm" variant="secondary" onClick={() => navigator.share({ title: "Guest pass", url: card.url }).catch(() => {})}>Share…</Button> : null}
          <Link href={`${base}/visitors/${card.visitorId}`} className="inline-flex h-8 items-center px-2 text-[13px] text-accent hover:underline">View visit</Link>
        </div>
      </div>
    </div>
  );
}
