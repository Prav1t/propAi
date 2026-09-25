import { desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/server/db/client";
import { emailOutbox } from "@/server/db/schema";
import { PageHeader, Panel, EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dev mailbox" };

// development-only viewer for emails captured by the console mail provider
export default async function DevMailbox() {
  if (process.env.NODE_ENV === "production") notFound();
  const mails = await db().select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(50);
  const linkify = (t: string) =>
    t.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} className="break-all text-accent underline" href={part}>{part}</a> : part));
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader title="Dev mailbox" description="Emails captured by MAIL_PROVIDER=console. Not available in production." />
      <Panel>
        {mails.length === 0 ? <EmptyState title="No emails yet" /> : (
          <ul className="divide-y divide-border">
            {mails.map((m) => (
              <li key={m.id} className="px-4 py-3">
                <div className="flex flex-wrap justify-between gap-2 text-[13px] text-muted">
                  <span>To <strong className="text-fg">{m.to}</strong></span>
                  <time>{m.createdAt.toLocaleString("en-CA")}</time>
                </div>
                <p className="mt-1 text-sm font-medium">{m.subject}</p>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] text-muted">{linkify(m.text)}</pre>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
