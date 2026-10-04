import { describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3BlobStore } from "@/server/files/storage";

// runs against any S3-compatible endpoint (MinIO, moto, LocalStack); skipped unless S3_TEST_ENDPOINT is set
const endpoint = process.env.S3_TEST_ENDPOINT;
const d = endpoint ? describe : describe.skip;

d("S3BlobStore against a real S3-compatible endpoint", () => {
  const bucket = `propai-test-${Date.now()}`;
  const creds = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" };
  process.env.AWS_ACCESS_KEY_ID ??= creds.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY ??= creds.secretAccessKey;

  it("puts, presigns, gets and deletes objects", async () => {
    await new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: creds }).send(new CreateBucketCommand({ Bucket: bucket }));
    const store = new S3BlobStore(bucket, { region: "us-east-1", endpoint, forcePathStyle: true, sse: process.env.S3_TEST_SSE });
    const key = "org/document/abc";
    const bytes = new TextEncoder().encode("%PDF-1.4 hello");
    await store.put(key, bytes, "application/pdf");
    expect(new TextDecoder().decode(await store.get(key))).toBe("%PDF-1.4 hello");
    const url = await store.signedUrl(key, "Bylaws 2026.pdf", false, 60);
    expect(url).toMatch(/X-Amz-Signature=/);
    const res = await fetch(url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.4 hello");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Bylaws_2026.pdf"');
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  });

  it("signs download links for the public endpoint while talking to the private one", async () => {
    // same server under a second host name, standing in for minio:9000 (private) vs localhost:9000 (browser)
    const pub = new URL(endpoint!);
    pub.hostname = pub.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const store = new S3BlobStore(bucket, { region: "us-east-1", endpoint, publicEndpoint: pub.origin, forcePathStyle: true, sse: process.env.S3_TEST_SSE });
    await store.put("org/document/pub", new TextEncoder().encode("hello"), "text/plain");
    const url = new URL((await store.signedUrl("org/document/pub", "a.txt", false, 60))!);
    expect(url.host).toBe(pub.host);
    expect(await (await fetch(url)).text()).toBe("hello");
    await store.delete("org/document/pub");
  });
});
