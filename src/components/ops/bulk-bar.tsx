"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { Button, SubmitButton } from "@/components/ui/button";
import { FormAlert, Select } from "@/components/ui/form";

type Opt = { id: string; name: string };

// change several work orders at once: rows carry checkboxes tied to this form (form="bulk-wo")
export function WorkOrderBulkBar({ action, staff, vendors, priorities }: {
  action: (s: ActionState, fd: FormData) => Promise<ActionState>; staff: Opt[]; vendors: Opt[]; priorities: { value: string; label: string }[];
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [count, setCount] = useState(0);
  const [op, setOp] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][form="bulk-wo"][name="ids"]')];

  useEffect(() => {
    const recount = () => setCount(boxes().filter((b) => b.checked).length);
    document.addEventListener("change", recount);
    recount();
    return () => document.removeEventListener("change", recount);
  }, []);
  // after a change the list re-renders with fresh data; clear the selection
  useEffect(() => {
    if (!state.ok) return;
    for (const b of boxes()) b.checked = false;
    setCount(0); // eslint-disable-line react-hooks/set-state-in-effect -- the checkboxes live outside React's state
  }, [state]);

  const all = count > 0 && count === boxes().length;
  return (
    <form id="bulk-wo" ref={form} action={formAction} className="space-y-2 border-b border-border px-3 py-2" aria-label="Change selected work orders">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => { const v = !all; for (const b of boxes()) b.checked = v; setCount(v ? boxes().length : 0); }}>
          {all ? "Clear selection" : "Select all on this page"}
        </Button>
        <span className="text-[13px] text-muted" aria-live="polite">{count ? `${count} selected` : "Select requests to change several at once"}</span>
        {count ? (
          <>
            <label className="sr-only" htmlFor="bulk-op">Change</label>
            <Select id="bulk-op" name="op" value={op} onChange={(e) => setOp(e.target.value)} className="h-8 w-auto text-[13px]">
              <option value="">Choose a change…</option>
              <option value="assign">Assign to…</option>
              <option value="priority">Set priority…</option>
              <option value="acknowledge">Acknowledge new ones</option>
              <option value="close">Close completed ones</option>
            </Select>
            {op === "assign" ? (
              <>
                <label className="sr-only" htmlFor="bulk-target">Assign to</label>
                <Select id="bulk-target" name="target" defaultValue="" className="h-8 w-auto max-w-56 text-[13px]">
                  <option value="">Choose who…</option>
                  {staff.length ? <optgroup label="Staff">{staff.map((s) => <option key={s.id} value={`member:${s.id}`}>{s.name}</option>)}</optgroup> : null}
                  {vendors.length ? <optgroup label="Vendors">{vendors.map((v) => <option key={v.id} value={`vendor:${v.id}`}>{v.name}</option>)}</optgroup> : null}
                </Select>
              </>
            ) : op === "priority" ? (
              <>
                <label className="sr-only" htmlFor="bulk-priority">Priority</label>
                <Select id="bulk-priority" name="priority" defaultValue="" className="h-8 w-auto text-[13px]">
                  <option value="">Choose priority…</option>
                  {priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </Select>
              </>
            ) : null}
            <SubmitButton size="sm" disabled={!op} pendingLabel="Applying…">Apply to {count}</SubmitButton>
          </>
        ) : null}
      </div>
      {state.error ? <FormAlert>{state.fieldErrors?.target ?? state.fieldErrors?.priority ?? state.error}</FormAlert> : null}
      {state.ok && state.message ? <FormAlert kind={(state.data as { failed?: number } | undefined)?.failed ? "info" : "success"}>{state.message}</FormAlert> : null}
    </form>
  );
}
