// Integration catalog (Iteration 10), shared by the settings page and the server. Secrets are encrypted at rest and
// never sent back to the browser; only a masked hint is shown.

export type IntegrationField = { key: string; label: string; secret: boolean; placeholder?: string; help?: string; optional?: boolean };
export type IntegrationKind = "chat" | "sms";

export const INTEGRATIONS = {
  slack: {
    name: "Slack", kind: "chat" as IntegrationKind,
    description: "Automation rules can post to a Slack channel (for example: emergencies to #on-call).",
    setup: "In Slack, create an app with an Incoming Webhook for the channel, then paste its URL here.",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", secret: true, placeholder: "https://hooks.slack.com/services/…" },
      { key: "channel", label: "Channel name (for your reference)", secret: false, placeholder: "#maintenance", optional: true },
    ] as IntegrationField[],
  },
  teams: {
    name: "Microsoft Teams", kind: "chat" as IntegrationKind,
    description: "Automation rules can post to a Teams channel.",
    setup: "In Teams, add the “Post to a channel when a webhook request is received” workflow to the channel, then paste the workflow URL here.",
    fields: [
      { key: "webhookUrl", label: "Workflow webhook URL", secret: true, placeholder: "https://….logic.azure.com/workflows/…" },
      { key: "channel", label: "Channel name (for your reference)", secret: false, placeholder: "Maintenance", optional: true },
    ] as IntegrationField[],
  },
  twilio: {
    name: "Twilio SMS", kind: "sms" as IntegrationKind,
    description: "Send text messages from your own Twilio number. Use “Send test SMS” to check the connection.",
    setup: "Copy the Account SID and Auth Token from the Twilio console, and a phone number from your Twilio account in +1… format.",
    fields: [
      { key: "accountSid", label: "Account SID", secret: false, placeholder: "AC…" },
      { key: "authToken", label: "Auth token", secret: true },
      { key: "fromNumber", label: "Sending number", secret: false, placeholder: "+16045550100" },
    ] as IntegrationField[],
  },
} as const;

export type IntegrationKey = keyof typeof INTEGRATIONS;
export const INTEGRATION_KEYS = Object.keys(INTEGRATIONS) as IntegrationKey[];
export const isIntegrationKey = (v: unknown): v is IntegrationKey => typeof v === "string" && v in INTEGRATIONS;
export const CHAT_PROVIDERS = ["slack", "teams"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

// connectors on the roadmap: listed honestly as not yet available (no connect button)
export const PLANNED_INTEGRATIONS = [
  { key: "google_calendar", name: "Google Calendar", description: "Appointments, inspections and bookings on staff calendars." },
  { key: "outlook_calendar", name: "Microsoft Outlook calendar", description: "The same, for Microsoft 365." },
  { key: "quickbooks", name: "QuickBooks Online", description: "Vendor bills from completed work orders." },
  { key: "xero", name: "Xero", description: "Vendor bills from completed work orders." },
  { key: "access_control", name: "Access control systems", description: "Visitor passes that open doors." },
];

const E164 = /^\+[1-9]\d{7,14}$/;

// field-level checks; returns an error per field
export function validateIntegration(key: IntegrationKey, v: Record<string, string>): Record<string, string> {
  const err: Record<string, string> = {};
  for (const f of INTEGRATIONS[key].fields) if (!f.optional && !v[f.key]?.trim()) err[f.key] = `Enter the ${f.label.toLowerCase()}.`;
  const url = v.webhookUrl?.trim();
  if (key === "slack" && url && !/^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[\w/-]+$/.test(url)) err.webhookUrl = "Use the https://hooks.slack.com/… URL Slack gives you.";
  if (key === "teams" && url) {
    let host = "";
    try { const u = new URL(url); host = u.protocol === "https:" ? u.hostname : ""; } catch { /* invalid */ }
    if (!/(\.logic\.azure\.com|\.webhook\.office\.com|\.powerplatform\.com|\.powerautomate\.com)$/i.test(host)) err.webhookUrl = "Use the https:// workflow URL Teams gives you.";
  }
  if (key === "twilio") {
    if (v.accountSid && !/^AC[0-9a-f]{32}$/i.test(v.accountSid.trim())) err.accountSid = "An Account SID starts with AC followed by 32 letters and digits.";
    if (v.authToken && !/^[0-9a-zA-Z]{32}$/.test(v.authToken.trim())) err.authToken = "An auth token is 32 letters and digits.";
    if (v.fromNumber && !E164.test(v.fromNumber.trim())) err.fromNumber = "Use international format, like +16045550100.";
  }
  return err;
}

export const isE164 = (s: string) => E164.test(s.trim());
