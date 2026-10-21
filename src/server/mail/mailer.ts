import "server-only";
import nodemailer from "nodemailer";
import { db } from "../db/client";
import { emailOutbox } from "../db/schema";
import { env, isProd } from "../env";
import { log } from "../log";
import type { RenderedEmail } from "./templates";

// every email goes through here; provider chosen by MAIL_PROVIDER
export async function sendEmail(to: string, email: RenderedEmail): Promise<void> {
  const e = env();
  // auth emails carry secrets; never persist their bodies in production
  const storedText = isProd() && email.sensitive ? "[redacted]" : email.text;
  const storedHtml = isProd() && email.sensitive ? null : email.html;

  if (e.MAIL_PROVIDER === "console") {
    await db().insert(emailOutbox).values({
      to, subject: email.subject, text: storedText, html: storedHtml, template: email.template, status: "logged",
    });
    log.info("email.logged", { to, template: email.template });
    return;
  }

  try {
    if (e.MAIL_PROVIDER === "resend" || e.MAIL_PROVIDER === "sendgrid") {
      // HTTP email APIs (Iteration 10): same outbox record either way
      const req = e.MAIL_PROVIDER === "resend" ? resendRequest(e.RESEND_API_KEY ?? "", e.MAIL_FROM, to, email) : sendgridRequest(e.SENDGRID_API_KEY ?? "", e.MAIL_FROM, to, email);
      const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${e.MAIL_PROVIDER} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    } else {
      const transport = nodemailer.createTransport(e.SMTP_URL);
      await transport.sendMail({ from: e.MAIL_FROM, to, subject: email.subject, text: email.text, html: email.html });
    }
    await db().insert(emailOutbox).values({
      to, subject: email.subject, text: storedText, html: storedHtml, template: email.template, status: "sent", sentAt: new Date(),
    });
  } catch (err) {
    log.error("email.failed", { to, template: email.template, err });
    await db().insert(emailOutbox).values({
      to, subject: email.subject, text: storedText, template: email.template, status: "failed", error: String(err),
    });
  }
}

// "Name <address>" → parts
function splitFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { email: m[2], ...(m[1] ? { name: m[1].replace(/^"|"$/g, "") } : {}) } : { email: from.trim() };
}

export function resendRequest(apiKey: string, from: string, to: string, email: RenderedEmail) {
  return {
    url: "https://api.resend.com/emails",
    init: { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ from, to: [to], subject: email.subject, text: email.text, html: email.html }) },
  };
}

export function sendgridRequest(apiKey: string, from: string, to: string, email: RenderedEmail) {
  return {
    url: "https://api.sendgrid.com/v3/mail/send",
    init: {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: splitFrom(from), subject: email.subject, content: [{ type: "text/plain", value: email.text }, { type: "text/html", value: email.html }] }),
    },
  };
}
