import { describe, expect, it, vi } from "vitest";
import { chatPayload, postChatMessage, sendSms, twilioRequest } from "./adapters";
import { validateIntegration } from "@/lib/integrations";
import { resendRequest, sendgridRequest } from "../mail/mailer";

describe("integration settings validation", () => {
  it("checks each provider's credentials format", () => {
    expect(validateIntegration("slack", { webhookUrl: "https://hooks.slack.com/services/T0/B0/xyz" })).toEqual({});
    expect(validateIntegration("slack", { webhookUrl: "https://evil.example/hook" })).toHaveProperty("webhookUrl");
    expect(validateIntegration("teams", { webhookUrl: "https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke" })).toEqual({});
    expect(validateIntegration("teams", { webhookUrl: "http://prod-12.westus.logic.azure.com/x" })).toHaveProperty("webhookUrl");
    expect(validateIntegration("twilio", { accountSid: `AC${"a".repeat(32)}`, authToken: "b".repeat(32), fromNumber: "+16045550100" })).toEqual({});
    expect(Object.keys(validateIntegration("twilio", { accountSid: "nope", authToken: "short", fromNumber: "604-555-0100" })).sort()).toEqual(["accountSid", "authToken", "fromNumber"]);
  });
});

describe("chat adapters", () => {
  it("formats Slack text and a Teams adaptive card", () => {
    expect(chatPayload("slack", "Hi")).toEqual({ text: "Hi" });
    const t = chatPayload("teams", "Hi") as { attachments: { content: { body: { text: string }[] } }[] };
    expect(t.attachments[0].content.body[0].text).toBe("Hi");
  });
  it("treats a non-2xx answer as a failure", async () => {
    const ok = vi.fn(async () => ({ status: 200, body: "ok", durationMs: 1 }));
    await postChatMessage("slack", "https://hooks.slack.com/services/x", "Leak in unit 1204", ok);
    expect(ok).toHaveBeenCalledWith("https://hooks.slack.com/services/x", JSON.stringify({ text: "Leak in unit 1204" }), { "content-type": "application/json" });
    await expect(postChatMessage("teams", "https://x.logic.azure.com/w", "Hi", async () => ({ status: 400, body: "bad card", durationMs: 1 }))).rejects.toThrow(/Teams answered 400: bad card/);
  });
});

describe("Twilio", () => {
  const c = { accountSid: `AC${"1".repeat(32)}`, authToken: "t".repeat(32), fromNumber: "+16045550100" };
  it("builds the Messages API request with basic auth", () => {
    const r = twilioRequest(c, "+16045550199", "Test");
    expect(r.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`);
    expect(r.init.headers.authorization).toBe(`Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`);
    expect(new URLSearchParams(r.init.body).get("To")).toBe("+16045550199");
  });
  it("reports Twilio's error message", async () => {
    await expect(sendSms(c, "+1604", "x", async () => ({ ok: false, status: 400, json: async () => ({ message: "Invalid 'To' number" }) }))).rejects.toThrow(/Invalid 'To' number/);
    await expect(sendSms(c, "+16045550199", "x", async () => ({ ok: true, status: 201, json: async () => ({ sid: "SM1" }) }))).resolves.toEqual({ sid: "SM1" });
  });
});

describe("email providers", () => {
  const email = { template: "t", subject: "Hello", text: "Plain", html: "<p>Html</p>", sensitive: false };
  it("Resend: bearer key and a JSON message", () => {
    const r = resendRequest("re_key", "Acme <no-reply@acme.test>", "a@b.test", email);
    expect(r.url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(r.init.body)).toEqual({ from: "Acme <no-reply@acme.test>", to: ["a@b.test"], subject: "Hello", text: "Plain", html: "<p>Html</p>" });
  });
  it("SendGrid: personalizations and a split sender", () => {
    const r = sendgridRequest("sg_key", "Acme <no-reply@acme.test>", "a@b.test", email);
    const b = JSON.parse(r.init.body);
    expect(b.from).toEqual({ email: "no-reply@acme.test", name: "Acme" });
    expect(b.personalizations[0].to).toEqual([{ email: "a@b.test" }]);
    expect(b.content.map((x: { type: string }) => x.type)).toEqual(["text/plain", "text/html"]);
  });
});
