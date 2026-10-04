import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { getConversationView, listConversations } from "@/server/ai/store";
import { providerStatus } from "@/server/ai/providers";
import { ALL_TOOLS } from "@/server/ai/tools";
import { MODES, modesFor, pickMode } from "@/server/ai/modes";
import { BRAND } from "@/config/brand";
import { AssistantChat, type TurnUi } from "@/components/ai/assistant-chat";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/shell/icons";
import { cn } from "@/lib/cn";
import { relative } from "@/lib/time";
import { archiveConversationAction } from "./actions";

export const metadata = { title: `${BRAND.assistantName} · ${BRAND.name}` };

export default async function AssistantPage({ params, searchParams }: PageProps<"/o/[orgSlug]/assistant">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { principal, ctx } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("ai.use")) notFound();
  const conversationId = sp(q.c) ?? null;
  const [history, view] = await Promise.all([
    listConversations(ctx),
    conversationId ? orNotFound(getConversationView(ctx, conversationId)) : Promise.resolve(null),
  ]);
  const status = providerStatus();
  const modes = modesFor(principal).map((m) => ({ key: m, label: MODES[m].label, description: MODES[m].description, suggestions: MODES[m].suggestions }));
  const mode = view ? view.conversation.mode : pickMode(principal, sp(q.mode));
  const turns: TurnUi[] = (view?.turns ?? []).map((t): TurnUi => {
    const refused = t.outcome === "cap_reached" || t.outcome === "disabled";
    return {
      key: t.turnId, question: t.question, answer: refused ? "" : t.answer, provider: t.provider,
      state: t.outcome && !["ok", "cap_reached", "disabled", "step_limit"].includes(t.outcome) ? "error" : "done",
      notice: refused ? t.answer : undefined,
      error: t.outcome === "timeout" ? "That answer timed out." : t.outcome === "error" ? "This answer didn't finish." : undefined,
      steps: t.steps.map((s) => ({ callId: s.callId, tool: s.tool, title: TOOL_TITLE.get(s.tool) ?? s.tool, state: "done", outcome: s.outcome, summary: s.summary, display: s.display })),
    };
  });
  const base = `/o/${orgSlug}/assistant`;
  const now = new Date();

  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside aria-label="Conversations" className="order-2 lg:order-1">
        <details className="group lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] font-medium text-muted hover:bg-subtle">
            Recent conversations ({history.length}) <span aria-hidden className="group-open:rotate-180">▾</span>
          </summary>
          <HistoryList base={base} items={history} activeId={view?.conversation.id ?? null} now={now} />
        </details>
        <div className="hidden lg:block"><HistoryList base={base} items={history} activeId={view?.conversation.id ?? null} now={now} /></div>
      </aside>
      <section className="order-1 min-w-0 lg:order-2">
        <AssistantChat
          key={view?.conversation.id ?? "new"}
          orgSlug={orgSlug}
          assistantName={BRAND.assistantName}
          conversationId={view?.conversation.id ?? null}
          title={view?.conversation.title ?? null}
          initialTurns={turns}
          modes={modes}
          initialMode={mode}
          demo={{ on: status.demo, reason: status.reason }}
          autoAsk={view ? null : sp(q.q) ?? null}
          resident={principal.role.category === "resident"}
          headerActions={view ? (
            <ConfirmAction key="delete" action={archiveConversationAction} label="Delete" confirmLabel="Delete conversation" variant="secondary"
              description="Remove this conversation from your history? The usage log your organization's admins see isn't affected."
              hidden={{ orgSlug, conversationId: view.conversation.id }} />
          ) : null}
        />
      </section>
    </div>
  );
}

// status labels for stored tool calls (same wording as live runs)
const TOOL_TITLE = new Map<string, string>(ALL_TOOLS.map((t) => [t.name, t.title]));

type HistoryItem = { id: string; title: string; mode: string; lastMessageAt: Date };

function HistoryList({ base, items, activeId, now }: { base: string; items: HistoryItem[]; activeId: string | null; now: Date }) {
  return (
    <nav className="mt-2 space-y-1 lg:mt-0">
      <Link href={base} className={cn("flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] font-medium hover:bg-subtle", !activeId && "bg-subtle")}>
        <Icon name="plus" /> New conversation
      </Link>
      {items.length ? (
        <ul className="space-y-0.5">
          {items.map((c) => (
            <li key={c.id}>
              <Link href={`${base}?c=${c.id}`} aria-current={activeId === c.id ? "page" : undefined}
                className={cn("block rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-subtle", activeId === c.id && "bg-subtle")}>
                <span className="block truncate text-[13px]">{c.title}</span>
                <span className="block text-[11px] text-faint">{MODES[c.mode as keyof typeof MODES]?.label ?? c.mode} · {relative(c.lastMessageAt, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="px-2 py-1.5 text-[12px] text-faint">Your conversations appear here. Only you can see them.</p>}
    </nav>
  );
}
