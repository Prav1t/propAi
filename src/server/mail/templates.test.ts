import { describe, expect, it } from "vitest";
import { invitationTemplate, verifyEmailTemplate } from "./templates";

describe("email templates", () => {
  it("escapes user-controlled values in HTML", () => {
    const t = invitationTemplate("<script>x</script> Corp", "Admin", "Eve \"><img src=x>", "https://app.test/invite/abc");
    expect(t.html).not.toContain("<script>");
    expect(t.html).not.toContain("<img src=x>");
    expect(t.html).toContain("&lt;script&gt;");
  });
  it("marks auth emails as sensitive and includes the link", () => {
    const t = verifyEmailTemplate("Sam", "https://app.test/verify-email?token=t");
    expect(t.sensitive).toBe(true);
    expect(t.text).toContain("https://app.test/verify-email?token=t");
  });
});
