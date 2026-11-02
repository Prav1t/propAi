"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form";
import { deviceName } from "@/lib/device";

type Device = { endpoint: string; userAgent: string | null; createdAt: string; lastSuccessAt: string | null };
type Status = "checking" | "unsupported" | "denied" | "off" | "on";

const key = (b64: string) => {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

// push on this device: asks the browser, subscribes through the service worker, and lists the person's devices
export function PushSettings({ publicKey, devices, subscribe, unsubscribe }: {
  publicKey: string | null; devices: Device[];
  subscribe: (sub: unknown) => Promise<ActionState>; unsubscribe: (endpoint: string) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [current, setCurrent] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return alive && setStatus("unsupported");
      if (Notification.permission === "denied") return alive && setStatus("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!alive) return;
      setCurrent(sub?.endpoint ?? null);
      setStatus(sub && devices.some((d) => d.endpoint === sub.endpoint) ? "on" : "off");
    })().catch(() => alive && setStatus("unsupported"));
    return () => { alive = false; };
  }, [devices]);

  const turnOn = () => start(async () => {
    setMessage(null);
    if (!publicKey) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { setStatus(permission === "denied" ? "denied" : "off"); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(publicKey) }));
      const r = await subscribe(sub.toJSON());
      setMessage(r.error ? { kind: "error", text: r.error } : { kind: "success", text: r.message ?? "On." });
      if (!r.error) { setCurrent(sub.endpoint); setStatus("on"); router.refresh(); }
    } catch {
      setMessage({ kind: "error", text: "This browser couldn't set up push notifications. Try again, or use another browser." });
    }
  });
  const turnOff = (endpoint: string, thisDevice: boolean) => start(async () => {
    setMessage(null);
    if (thisDevice) {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
    }
    const r = await unsubscribe(endpoint);
    setMessage(r.error ? { kind: "error", text: r.error } : { kind: "success", text: r.message ?? "Off." });
    if (thisDevice) setStatus("off");
    router.refresh();
  });

  return (
    <div className="space-y-3 p-4" data-testid="push-settings">
      {!publicKey ? (
        <p className="text-[13px] text-muted">Push notifications aren&apos;t set up for this installation yet. Your administrator can add VAPID keys to turn them on.</p>
      ) : status === "unsupported" ? (
        <p className="text-[13px] text-muted">This browser doesn&apos;t support push notifications. On an iPhone or iPad, add this app to your home screen first (Share → Add to Home Screen), then open it from there.</p>
      ) : status === "denied" ? (
        <p className="text-[13px] text-muted">Notifications are blocked for this site in your browser settings. Allow them there, then come back to turn push on.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">{status === "on" ? "Push notifications are on for this device." : status === "checking" ? "Checking this device…" : "Get notifications on this device even when the app is closed."}</p>
          {status === "off" ? <Button type="button" size="sm" disabled={pending} onClick={turnOn}>{pending ? "Turning on…" : "Turn on for this device"}</Button> : null}
          {status === "on" && current ? <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => turnOff(current, true)}>Turn off for this device</Button> : null}
        </div>
      )}
      {message ? <FormAlert kind={message.kind}>{message.text}</FormAlert> : null}
      {devices.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Devices getting push notifications</p>
          <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border">
            {devices.map((d) => (
              <li key={d.endpoint} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                <span>{deviceName(d.userAgent)}{d.endpoint === current ? <span className="ml-2 text-xs text-faint">this device</span> : null}
                  <span className="block text-xs text-faint">{d.lastSuccessAt ? `last delivered ${new Date(d.lastSuccessAt).toLocaleString()}` : `added ${new Date(d.createdAt).toLocaleDateString()}`}</span></span>
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => turnOff(d.endpoint, d.endpoint === current)}>Remove</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
