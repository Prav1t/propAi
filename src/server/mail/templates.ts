import { BRAND } from "@/config/brand";

export type RenderedEmail = { template: string; subject: string; text: string; html: string; sensitive: boolean };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// minimal, client-safe HTML layout
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;padding:24px;color:#18181b">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:24px"><div style="font-weight:600;margin-bottom:16px">${esc(BRAND.name)}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<p><a href="${esc(href)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(label)}</a></p>
<p style="font-size:12px;color:#71717a">Or paste this link into your browser:<br>${esc(href)}</p>`;

export function verifyEmailTemplate(name: string, url: string): RenderedEmail {
  return {
    template: "verify_email",
    sensitive: true,
    subject: `Verify your email for ${BRAND.name}`,
    text: `Hi ${name},\n\nConfirm your email address:\n${url}\n\nThis link expires in 24 hours.`,
    html: layout("Verify your email", `<p>Hi ${esc(name)}, confirm your email address to finish setting up your account.</p>${button(url, "Verify email")}<p style="font-size:12px;color:#71717a">This link expires in 24 hours.</p>`),
  };
}

export function resetPasswordTemplate(name: string, url: string): RenderedEmail {
  return {
    template: "reset_password",
    sensitive: true,
    subject: `Reset your ${BRAND.name} password`,
    text: `Hi ${name},\n\nReset your password:\n${url}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.`,
    html: layout("Reset your password", `<p>Hi ${esc(name)}, use the button below to choose a new password.</p>${button(url, "Reset password")}<p style="font-size:12px;color:#71717a">This link expires in 1 hour. If you didn't request it, you can ignore this email.</p>`),
  };
}

export function invitationTemplate(orgName: string, roleName: string, inviterName: string, url: string): RenderedEmail {
  return {
    template: "invitation",
    sensitive: true,
    subject: `${inviterName} invited you to ${orgName} on ${BRAND.name}`,
    text: `${inviterName} invited you to join ${orgName} as ${roleName}.\n\nAccept the invitation:\n${url}\n\nThis invitation expires in 7 days.`,
    html: layout(`Join ${orgName}`, `<p>${esc(inviterName)} invited you to join <strong>${esc(orgName)}</strong> as <strong>${esc(roleName)}</strong>.</p>${button(url, "Accept invitation")}<p style="font-size:12px;color:#71717a">This invitation expires in 7 days.</p>`),
  };
}

export function newSignInTemplate(name: string, when: string, ip: string | null, ua: string | null, securityUrl: string): RenderedEmail {
  const where = [ip, ua].filter(Boolean).join(" · ") || "unknown device";
  return {
    template: "new_sign_in",
    sensitive: false,
    subject: `New sign-in to your ${BRAND.name} account`,
    text: `Hi ${name},\n\nWe noticed a sign-in from a new device at ${when}:\n${where}\n\nIf this wasn't you, reset your password and review your sessions: ${securityUrl}`,
    html: layout("New sign-in detected", `<p>Hi ${esc(name)}, we noticed a sign-in from a device we haven't seen before.</p><p style="font-size:13px"><strong>${esc(when)}</strong><br>${esc(where)}</p><p>If this wasn't you, change your password and sign out other sessions.</p>${button(securityUrl, "Review security")}`),
  };
}

export function notificationTemplate(title: string, body: string | null, url: string): RenderedEmail {
  return {
    template: "notification",
    sensitive: false,
    subject: title,
    text: `${title}\n\n${body ? `${body}\n\n` : ""}Open: ${url}\n\nYou can change which emails you get under Notifications in ${BRAND.name}.`,
    html: layout(title, `${body ? `<p style="white-space:pre-line">${esc(body)}</p>` : ""}${button(url, "Open")}<p style="font-size:12px;color:#71717a">Change which emails you get under Notifications in ${esc(BRAND.name)}.</p>`),
  };
}
