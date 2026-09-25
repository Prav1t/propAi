import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control =
  "block w-full rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 h-9 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, "pr-8", className)} {...props}>
      {children}
    </select>
  );
}

// label + control + hint/error with correct aria wiring
export function Field({
  label, name, error, hint, children, className,
}: {
  label: string; name: string; error?: string; hint?: ReactNode; className?: string;
  children: (a: { id: string; name: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-fg">
        {label}
      </label>
      {children({ id, name, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormAlert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  const styles = {
    error: "bg-danger-soft text-danger border-danger/20",
    success: "bg-success-soft text-success border-success/20",
    info: "bg-accent-soft text-accent border-accent/20",
  }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cn("rounded-[var(--radius-md)] border px-3 py-2 text-[13px]", styles)}>
      {children}
    </div>
  );
}
