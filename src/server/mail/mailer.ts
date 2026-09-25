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
    const transport = nodemailer.createTransport(e.SMTP_URL);
    await transport.sendMail({ from: e.MAIL_FROM, to, subject: email.subject, text: email.text, html: email.html });
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
