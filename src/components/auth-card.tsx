import type { ReactNode } from "react";

export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        <div className="mt-5">{children}</div>
      </div>
      {footer ? <div className="mt-4 text-center text-[13px] text-muted">{footer}</div> : null}
    </>
  );
}
