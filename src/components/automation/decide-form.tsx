"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { SubmitButton } from "@/components/ui/button";
import { FormAlert, Input } from "@/components/ui/form";

// approve or decline a paused automation run, with an optional note kept on the run;
// on success the action redirects back to the run page, which shows the confirmation
export function DecideForm({ approve, decline }: { approve: (s: ActionState, fd: FormData) => Promise<ActionState>; decline: (s: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [a, approveAction] = useActionState(approve, initialActionState);
  const [d, declineAction] = useActionState(decline, initialActionState);
  return (
    <form className="space-y-2">
      <FormAlert>{a.error ?? d.error}</FormAlert>
      <label htmlFor="decide-note" className="block text-[13px] font-medium">Note (optional)</label>
      <Input id="decide-note" name="note" maxLength={500} placeholder="Kept on the run log" />
      <div className="flex gap-2">
        <SubmitButton formAction={approveAction} pendingLabel="Approving…">Approve</SubmitButton>
        <SubmitButton formAction={declineAction} variant="secondary" pendingLabel="Declining…">Decline</SubmitButton>
      </div>
    </form>
  );
}
