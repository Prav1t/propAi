import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkUrlShape, isPrivateAddress, resolveSafe, safePost, UnsafeTargetError } from "./safe-fetch";

describe("private address detection", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2001:db8::1", "ff02::1", "not-an-ip",
  ])("%s is refused", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("URL checks", () => {
  it("requires https, no credentials and no private hosts", () => {
    expect(checkUrlShape("https://example.com/hook").hostname).toBe("example.com");
    expect(() => checkUrlShape("http://example.com/hook")).toThrow(UnsafeTargetError);
    expect(() => checkUrlShape("ftp://example.com")).toThrow(UnsafeTargetError);
    expect(() => checkUrlShape("https://user:pw@example.com")).toThrow(/username/);
    expect(() => checkUrlShape("https://127.0.0.1/x")).toThrow(/private/);
    expect(() => checkUrlShape("https://[::1]/x")).toThrow(/private/);
    expect(() => checkUrlShape("https://metadata.internal/x")).toThrow(/private/);
    expect(() => checkUrlShape("https://localhost:8080/x")).toThrow(/private/);
    expect(checkUrlShape("http://127.0.0.1:9/x", { allowPrivate: true, allowHttp: true }).port).toBe("9");
  });
  it("refuses a host when any resolved address is private (no mixed answers)", async () => {
    const resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    await expect(resolveSafe(new URL("https://rebind.example"), {}, resolver)).rejects.toThrow(/private network/);
    await expect(resolveSafe(new URL("https://ok.example"), {}, async () => [{ address: "93.184.216.34", family: 4 }])).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });
});

describe("safePost", () => {
  let server: http.Server;
  let port = 0;
  const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: b });
        if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/elsewhere" }); return res.end(); }
        if (req.url === "/slow") return setTimeout(() => { res.writeHead(200); res.end("late"); }, 1_500);
        if (req.url === "/big") { res.writeHead(200); return res.end("x".repeat(100_000)); }
        res.writeHead(201);
        res.end("created");
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
  const local = { allowPrivate: true, allowHttp: true };

  it("posts the body with its headers when private targets are allowed", async () => {
    const r = await safePost(`http://127.0.0.1:${port}/hook`, '{"a":1}', { "content-type": "application/json", "x-test": "1" }, local);
    expect(r.status).toBe(201);
    expect(r.body).toBe("created");
    expect(seen.at(-1)).toMatchObject({ body: '{"a":1}', headers: { "x-test": "1", "content-type": "application/json" } });
  });
  it("refuses the same target by default", async () => {
    await expect(safePost(`http://127.0.0.1:${port}/hook`, "{}", {})).rejects.toThrow(UnsafeTargetError);
    await expect(safePost(`https://127.0.0.1:${port}/hook`, "{}", {})).rejects.toThrow(/private/);
  });
  it("doesn't follow redirects, caps the response and times out", async () => {
    expect((await safePost(`http://127.0.0.1:${port}/redirect`, "{}", {}, local)).status).toBe(302);
    expect((await safePost(`http://127.0.0.1:${port}/big`, "{}", {}, { ...local, maxResponseBytes: 1_000 })).body.length).toBeLessThanOrEqual(1_000);
    await expect(safePost(`http://127.0.0.1:${port}/slow`, "{}", {}, { ...local, timeoutMs: 200 })).rejects.toThrow(/Timed out/);
  });
});
