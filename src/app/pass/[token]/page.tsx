import type { Metadata } from "next";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { publicPass } from "@/server/modules/visitors/service";
import { rateLimiter } from "@/server/auth/rate-limit";
import { requestMeta } from "@/server/request-meta";
import { env } from "@/server/env";
import { Logo } from "@/components/brand/logo";
import { fmtRange } from "@/lib/time";

export const metadata: Metadata = { title: "Guest pass", robots: { index: false, follow: false }, referrer: "no-referrer" };

const STATE_TEXT: Record<string, { label: string; note: string; ok: boolean }> = {
  upcoming: { label: "Not valid yet", note: "This pass works from an hour before your visit.", ok: true },
  valid: { label: "Valid", note: "Show this screen at the front desk.", ok: true },
  on_site: { label: "Checked in", note: "Enjoy your visit.", ok: true },
  expired: { label: "Expired", note: "Ask your host to send a new pass.", ok: false },
};

// public page the guest opens on their phone; the token is the only credential and only minimal details are shown
export default async function PassPage({ params }: PageProps<"/pass/[token]">) {
  const { token } = await params;
  await headers();
  const meta = await requestMeta();
  const rl = await rateLimiter().hit(`pass:${meta.ip ?? "unknown"}`, 60, 10 * 60_000);
  const pass = rl.allowed ? await publicPass(token) : null;
  const state = pass ? STATE_TEXT[pass.state] : null;
  const qr = pass && state?.ok ? await QRCode.toDataURL(`${env().APP_URL}/pass/${token}`, { margin: 1, width: 280, errorCorrectionLevel: "M" }) : null;
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-8">
      <Logo />
      <main className="mt-6 w-full max-w-sm rounded-[var(--radius-lg)] border border-border bg-surface p-6 text-center shadow-sm">
        {!rl.allowed ? <p className="text-sm text-muted">Too many requests. Try again in a few minutes.</p> : !pass || !state ? (
          <>
            <h1 className="text-lg font-semibold">Pass not available</h1>
            <p className="mt-2 text-sm text-muted">This pass was cancelled, already used, or replaced with a new link. Ask your host for a new one.</p>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted">Guest pass</p>
            <h1 className="mt-1 text-xl font-semibold">{pass.guestName}</h1>
            <p className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${state.ok ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{state.label}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt="Pass QR code for the front desk" width={240} height={240} className="mx-auto mt-4 size-60 rounded-[var(--radius-md)] bg-white p-2" /> : null}
            <p className="mt-4 text-sm font-medium">{fmtRange(pass.expectedFrom, pass.expectedUntil, pass.tz)}</p>
            <p className="mt-1 text-sm">{pass.buildingName} · {pass.propertyName}</p>
            {pass.address ? <p className="text-[13px] text-muted">{pass.address}</p> : null}
            <p className="mt-4 text-[13px] text-muted">{state.note}</p>
            <p className="mt-6 text-xs text-faint">Issued by {pass.orgName}</p>
          </>
        )}
      </main>
    </div>
  );
}
