"use client";
import { useActionState, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type Template = { id: string; name: string; text: string; warnings: string[] };

// reply box; staff can insert a rendered template (always editable before sending) or write an internal note
export function MessageComposer({ action, templates = [], staff }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; templates?: Template[]; staff: boolean }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [round, setRound] = useState(0);
  const [seen, setSeen] = useState(state);
  const [warn, setWarn] = useState<string[]>([]);
  if (seen !== state) { setSeen(state); if (state.ok) { setRound((r) => r + 1); setWarn([]); } }
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <form action={formAction} className="space-y-2" key={round}>
      <FormAlert>{state.error}</FormAlert>
      {state.ok && state.message ? <FormAlert kind="success">{state.message}</FormAlert> : null}
      {staff && templates.length ? (
        <div className="flex items-center gap-2">
          <label htmlFor="tpl" className="text-[13px] text-muted">Template</label>
          <Select id="tpl" className="h-8 w-auto text-[13px]" defaultValue="" onChange={(e) => {
            const t = templates.find((x) => x.id === e.target.value);
            if (t && box.current) { box.current.value = t.text; box.current.focus(); setWarn(t.warnings); }
            e.target.value = "";
          }}>
            <option value="">Insert…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </div>
      ) : null}
      {warn.length ? <p className="text-xs text-warning">{warn.join(" · ")} — edit before sending.</p> : null}
      <label htmlFor="msg-body" className="sr-only">Message</label>
      <textarea ref={box} id="msg-body" name="body" rows={4} required maxLength={5000} defaultValue={state.ok ? "" : state.values?.body ?? ""}
        placeholder={staff ? "Write a reply…" : "Write a message…"}
        className="block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {staff ? (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="internal" className="size-4 accent-[var(--color-accent)]" /> Internal note (the resident won&apos;t see it)
          </label>
        ) : <span />}
        <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
      </div>
    </form>
  );
}
