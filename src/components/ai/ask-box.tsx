import { BRAND } from "@/config/brand";
import { Icon } from "@/components/shell/icons";

// plain GET form: works before hydration and lands on the assistant, which asks the question straight away
export function AskBox({ base, placeholder, className }: { base: string; placeholder: string; className?: string }) {
  return (
    <form action={`${base}/assistant`} method="get" role="search" aria-label={`Ask ${BRAND.assistantName}`} className={className}>
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-border bg-surface px-3 py-1.5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
        <Icon name="sparkle" className="size-4 shrink-0 text-accent" />
        <label htmlFor="ask-box" className="sr-only">Ask {BRAND.assistantName}</label>
        <input id="ask-box" name="q" required maxLength={4000} autoComplete="off" placeholder={placeholder}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none" />
        <button type="submit" className="shrink-0 rounded-[var(--radius-md)] px-2 py-1 text-[13px] font-medium text-accent hover:bg-accent-soft">Ask</button>
      </div>
    </form>
  );
}
