// A minimal OpenID Connect provider for tests (discovery, authorize, token, JWKS) that can also misbehave on purpose:
// a wrong nonce, audience or issuer, an expired token, a signature from an unknown key.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export type MockUser = { sub: string; email: string; email_verified?: boolean; name?: string; amr?: string[] };
export type Misbehave = Partial<{ nonce: string; aud: string; iss: string; expired: boolean; foreignKey: boolean; noEmail: boolean }>;

export type MockIdp = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  setUser(u: MockUser): void;
  misbehave(m: Misbehave): void;
  // follows the authorization URL like a browser would, returning where the provider sends it back
  authorize(url: string): Promise<string>;
  tokenRequests: number;
  close(): Promise<void>;
};

export async function startMockIdp(opts: { clientId?: string; clientSecret?: string } = {}): Promise<MockIdp> {
  const clientId = opts.clientId ?? "propai-test-client";
  const clientSecret = opts.clientSecret ?? "test-secret-" + randomBytes(8).toString("hex");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let user: MockUser = { sub: "u-1", email: "someone@example.com", email_verified: true };
  let bad: Misbehave = {};
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: MockUser }>();
  let issuer = "";
  const state = { tokenRequests: 0 };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", issuer);
    if (u.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        scopes_supported: ["openid", "email", "profile"],
      });
    }
    if (u.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (u.pathname === "/authorize") {
      const p = u.searchParams;
      if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return json(res, 400, { error: "invalid_request" });
      const code = randomBytes(16).toString("hex");
      codes.set(code, { nonce: p.get("nonce") ?? "", challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")!, user });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        state.tokenRequests++;
        const p = new URLSearchParams(body);
        const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
        const [cid, secret] = basic ?? [p.get("client_id"), p.get("client_secret")];
        if (cid !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client" });
        const c = codes.get(p.get("code") ?? "");
        codes.delete(p.get("code") ?? "");
        if (!c || c.redirectUri !== p.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
        const verifier = p.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          nonce: bad.nonce ?? c.nonce, email: bad.noEmail ? undefined : c.user.email, email_verified: c.user.email_verified, name: c.user.name, amr: c.user.amr,
        };
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(bad.iss ?? issuer).setAudience(bad.aud ?? clientId).setSubject(c.user.sub)
          .setIssuedAt(bad.expired ? now - 7200 : now).setExpirationTime(bad.expired ? now - 3600 : now + 300)
          .sign(bad.foreignKey ? foreign.privateKey : privateKey);
        json(res, 200, { access_token: randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer, clientId, clientSecret,
    setUser: (u) => (user = u),
    misbehave: (m) => (bad = m),
    get tokenRequests() { return state.tokenRequests; },
    async authorize(url: string) {
      const res = await fetch(url, { redirect: "manual" });
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
      return loc;
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
