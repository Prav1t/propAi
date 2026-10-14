import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/mini-markdown";

function inline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return <Fragment key={k}>{n.v}</Fragment>;
      case "b":
        return <strong key={k} className="font-semibold">{inline(n.c, `${k}-`)}</strong>;
      case "code":
        return <code key={k} className="rounded bg-subtle px-1 py-0.5 text-[0.85em]">{n.v}</code>;
      case "link":
        return <Link key={k} href={n.href} className="font-medium text-accent underline-offset-2 hover:underline">{inline(n.c, `${k}-`)}</Link>;
    }
  });
}

// renders assistant text as React elements from a parsed tree — no HTML from the model ever reaches the DOM
export function MarkdownView({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((b, i) =>
        b.t === "p" ? <p key={i}>{inline(b.c)}</p>
        : b.t === "h" ? <p key={i} className="font-semibold">{inline(b.c)}</p>
        : b.t === "q" ? <blockquote key={i} className="border-l-2 border-accent/40 pl-3 text-fg/90">{inline(b.c)}</blockquote>
        : b.t === "ul" ? <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        : <ol key={i} className="list-decimal space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>,
      )}
    </div>
  );
}
