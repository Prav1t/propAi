import { BRAND } from "@/config/brand";

// placeholder mark + wordmark; replace with real brand assets
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" className="text-accent">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor" />
        <path d="M8 16V9.5l4-2.5 4 2.5V16" stroke="white" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
        <path d="M11 16v-3h2v3" stroke="white" strokeWidth="1.8" fill="none" />
      </svg>
      {compact ? null : <span className="text-sm">{BRAND.name}</span>}
    </span>
  );
}
