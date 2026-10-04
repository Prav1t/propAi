"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ToolDisplay } from "@/server/ai/tools/registry";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form";
import { Icon } from "@/components/shell/icons";
import { cn } from "@/lib/cn";
import { MarkdownView } from "./markdown-view";

export type StepUi = { callId: string; tool: string; title: string; state: "running" | "done"; outcome?: string; summary?: string | null; display?: ToolDisplay | null };
export type TurnUi = {
  key: string; question: string; steps: StepUi[]; answer: string; state: "running" | "done" | "error" | "stopped";
  status?: string; notice?: string; error?: string; provider?: string | null;
};
export type ModeOption = { key: string; label: string; description: string; suggestions: string[] };


function ResultCards({ display }: { display: ToolDisplay }) {
  const [all, setAll] = useState(false);
  const recs = display.records ?? [];
  if (!recs.length && !display.metrics?.length) return null;
  const shown = all ? recs : recs.slice(0, 5);
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface">
      {display.metrics?.length ? (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border px-3 py-2 last:border-b-0">
          {display.metrics.map((m) => (
            <div key={m.label} className="flex items-baseline gap-1.5 text-xs">
              <dt className="text-muted">{m.label}</dt>
              <dd className={cn("font-semibold tabular-nums", m.tone === "danger" && "text-danger", m.tone === "warning" && "text-warning", m.tone === "success" && "text-success")}>{m.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {shown.length ? (
        <ul className="divide-y divide-border">
          {shown.map((r, i) => (
            <li key={`${r.href}-${i}`}>
              <Link href={r.href} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-subtle">
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium uppercase tracking-wide text-faint">{r.ref}</span>
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  {r.sub ? <span className="block truncate text-xs text-muted">{r.sub}</span> : null}
                </span>
                {r.badges?.length ? (
                  <span className="flex max-w-[45%] shrink-0 flex-wrap justify-end gap-1">
                    {r.badges.map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {recs.length > 5 && !all ? (
        <button type="button" onClick={() => setAll(true)} className="block w-full border-t border-border px-3 py-2 text-left text-[13px] text-accent hover:bg-subtle">Show all {recs.length}</button>
      ) : null}
      {display.more ? <Link href={display.more.href} className="block border-t border-border px-3 py-2 text-[13px] text-accent hover:bg-subtle">{display.more.label} →</Link> : null}
    </div>
  );
}

function StepLine({ s, answer }: { s: StepUi; answer: string }) {
  const failed = s.state === "done" && s.outcome !== "ok";
  // the demo model answers with the tool's own summary; don't print it twice
  const showSummary = !!s.summary && !answer.includes(s.summary);
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <span aria-hidden className={cn("mt-1 inline-block size-2 shrink-0 rounded-full", s.state === "running" ? "animate-pulse bg-accent" : failed ? "bg-warning" : "bg-success")} />
      <span className="min-w-0 text-muted">
        <span className="font-medium text-fg">{s.title}</span>
        {s.state === "running" ? "…" : showSummary ? <> — {s.summary}</> : null}
      </span>
    </li>
  );
}

export function TurnView({ t, assistantName }: { t: TurnUi; assistantName: string }) {
  const cards = t.steps.filter((s) => s.display && (s.display.records?.length || s.display.metrics?.length));
  return (
    <article className="space-y-3" aria-label={`Question: ${t.question}`}>
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-fg">{t.question}</p>
      </div>
      <div className="flex gap-3">
        <span aria-hidden className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Icon name="sparkle" /></span>
        <div className="min-w-0 flex-1 space-y-3">
          <span className="sr-only">{assistantName}:</span>
          {t.steps.length ? <ol aria-label="What was looked up" className="space-y-1">{t.steps.map((s) => <StepLine key={s.callId} s={s} answer={t.answer} />)}</ol> : null}
          {t.state === "running" && !t.answer ? <p role="status" className="animate-pulse text-[13px] text-muted">{t.status ?? "Thinking"}…</p> : null}
          {t.answer ? <MarkdownView text={t.answer} /> : null}
          {t.notice ? <FormAlert kind="info">{t.notice}</FormAlert> : null}
          {t.error ? <FormAlert>{t.error}</FormAlert> : null}
          {t.state === "stopped" ? <p className="text-xs text-faint">Stopped.</p> : null}
          {cards.length ? <div className="space-y-2">{cards.map((s) => <ResultCards key={s.callId} display={s.display!} />)}</div> : null}
          {t.provider === "demo" && t.state !== "running" ? (
            <p className="flex items-center gap-1.5 text-[11px] text-faint"><Badge tone="warning">Demo mode</Badge> Answered by fixed rules from live records — no language model.</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function AssistantChat(props: {
  orgSlug: string;
  assistantName: string;
  conversationId: string | null;
  title: string | null;
  initialTurns: TurnUi[];
  modes: ModeOption[];
  initialMode: string;
  demo: { on: boolean; reason: string | null };
  autoAsk?: string | null;
  resident: boolean;
  headerActions?: ReactNode;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<TurnUi[]>(props.initialTurns);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(props.initialMode);
  const convRef = useRef<string | null>(props.conversationId);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(false);
  const current = props.modes.find((m) => m.key === mode) ?? props.modes[0];

  const patch = (key: string, fn: (t: TurnUi) => TurnUi) => setTurns((ts) => ts.map((t) => (t.key === key ? fn(t) : t)));

  const send = useCallback(async (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    const key = `t${Date.now()}`;
    setTurns((ts) => [...ts, { key, question, steps: [], answer: "", state: "running", status: "Thinking" }]);
    setInput("");
    setBusy(true);
    const wasNew = !convRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
    try {
      const res = await fetch(`/o/${props.orgSlug}/assistant/stream`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ conversationId: convRef.current, message: question, mode }),
      });
      if (!res.ok || !res.body) {
        const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => null);
        patch(key, (t) => ({ ...t, state: "error", error: msg ?? "The assistant couldn't answer. Please try again." }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (ev: Record<string, unknown>) => {
        switch (ev.type) {
          case "start":
            convRef.current = ev.conversationId as string;
            patch(key, (t) => ({ ...t, provider: ev.provider as string }));
            break;
          case "status":
            patch(key, (t) => ({ ...t, status: ev.label as string }));
            break;
          case "tool_start":
            patch(key, (t) => ({ ...t, steps: [...t.steps, { callId: ev.callId as string, tool: ev.tool as string, title: ev.title as string, state: "running" }] }));
            break;
          case "tool_end":
            patch(key, (t) => ({ ...t, steps: t.steps.map((s) => (s.callId === ev.callId ? { ...s, state: "done", outcome: ev.outcome as string, summary: ev.summary as string | null, display: ev.display as ToolDisplay | null } : s)) }));
            break;
          case "text":
            patch(key, (t) => ({ ...t, answer: t.answer + (ev.delta as string) }));
            break;
          case "notice":
            patch(key, (t) => ({ ...t, notice: ev.message as string }));
            break;
          case "error":
            patch(key, (t) => ({ ...t, error: ev.message as string }));
            break;
          case "done":
            patch(key, (t) => ({ ...t, state: t.error ? "error" : "done" }));
            break;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handle(JSON.parse(line));
        }
      }
      patch(key, (t) => (t.state === "running" ? { ...t, state: t.error ? "error" : "done" } : t));
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      patch(key, (t) => ({ ...t, state: aborted ? "stopped" : "error", error: aborted ? undefined : "Connection lost. Please try again." }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
      // a new conversation gets its own URL; existing ones just refresh the history list
      if (wasNew && convRef.current) router.replace(`/o/${props.orgSlug}/assistant?c=${convRef.current}`, { scroll: false });
      else router.refresh();
    }
  }, [busy, mode, props.orgSlug, router]);

  useEffect(() => {
    if (props.autoAsk && !asked.current) {
      asked.current = true;
      void send(props.autoAsk);
    }
  }, [props.autoAsk, send]);

  const empty = turns.length === 0;
  return (
    <div className="flex min-h-[calc(100dvh-10rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{props.title ?? `Ask ${props.assistantName}`}</h1>
        <div className="flex items-center gap-2">
          {props.conversationId ? <Badge>{current?.label ?? "Assistant"}</Badge> : null}
          {props.demo.on ? <Badge tone="warning"><span title={props.demo.reason ?? undefined}>Demo mode</span></Badge> : null}
          {props.headerActions}
        </div>
      </div>

      <div className="flex-1 space-y-6 pb-4" aria-live="polite" aria-busy={busy}>
        {empty ? (
          <div className="py-8 text-center">
            <span aria-hidden className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent"><Icon name="sparkle" className="size-5" /></span>
            <p className="mt-3 text-base font-medium">How can I help?</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
              I look up live records you&apos;re allowed to see and answer from them, with links. In this version I can only read — I can&apos;t change anything yet.
            </p>
            {props.demo.on ? <p className="mx-auto mt-2 max-w-md text-[12px] text-faint">Demo mode: no language model is connected, so I understand a fixed set of questions like the ones below.</p> : null}
            <div className="mx-auto mt-5 flex max-w-xl flex-wrap justify-center gap-2">
              {(current?.suggestions ?? []).map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] hover:bg-subtle">{s}</button>
              ))}
            </div>
          </div>
        ) : turns.map((t) => <TurnView key={t.key} t={t} assistantName={props.assistantName} />)}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
        className={cn("sticky z-[5] -mx-1 bg-bg/95 px-1 pb-2 pt-2 backdrop-blur", props.resident ? "bottom-20 lg:bottom-0" : "bottom-0")}
      >
        {!props.conversationId && empty && props.modes.length > 1 ? (
          <div role="radiogroup" aria-label="Assistant mode" className="mb-2 flex flex-wrap gap-1">
            {props.modes.map((m) => (
              <button key={m.key} type="button" role="radio" aria-checked={m.key === mode} onClick={() => setMode(m.key)} title={m.description}
                className={cn("rounded-full px-2.5 py-1 text-xs", m.key === mode ? "bg-accent text-accent-fg" : "bg-subtle text-muted hover:text-fg")}>
                {m.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2 rounded-xl border border-border-strong bg-surface p-1.5 focus-within:ring-2 focus-within:ring-accent/40">
          <label htmlFor="assistant-input" className="sr-only">Ask {props.assistantName}</label>
          <textarea
            id="assistant-input" ref={inputRef} rows={1} value={input} maxLength={4000}
            onChange={(e) => { setInput(e.target.value); e.currentTarget.style.height = "auto"; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 160)}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
            placeholder={props.resident ? "Ask about your home…" : "Ask about your buildings…"}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-faint focus-visible:outline-none"
          />
          {busy ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => abortRef.current?.abort()} aria-label="Stop answering"><Icon name="stop" /></Button>
          ) : (
            <Button type="submit" size="sm" disabled={!input.trim()} aria-label="Send"><Icon name="send" /></Button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-faint">Answers come only from records you can access. Check important details on the linked record.</p>
      </form>
    </div>
  );
}
