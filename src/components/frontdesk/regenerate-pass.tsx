"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";
import { PassCard, type PassCardData } from "./pass-card";

// passes are only shown once; this issues a fresh link (the old one stops working)
export function RegeneratePass({ action, base, guestName }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; base: string; guestName: string }) {
  const [state, formAction] = useActionState(action, initialActionState);
  const card = state.ok ? (state.data as PassCardData | null) : null;
  return (
    <div className="space-y-3">
      <FormAlert>{state.error}</FormAlert>
      {card ? <><FormAlert kind="success">{state.message}</FormAlert><PassCard card={card} guestName={guestName} base={base} /></> : (
        <form action={formAction} className="space-y-2">
          <p className="text-[13px] text-muted">For privacy, pass links are shown only once. Get a new link to share it again — the previous link stops working.</p>
          <SubmitButton size="sm" variant="secondary" pendingLabel="Creating…">Get a new pass link</SubmitButton>
        </form>
      )}
    </div>
  );
}
