import "server-only";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// object storage behind one interface; keys are server-generated, never user input
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  // short-lived direct download URL when the backend supports it (S3); null = stream through the app
  signedUrl(key: string, filename: string, inline: boolean, ttlSeconds: number): Promise<string | null>;
}

const SAFE_KEY = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i;

export class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}
  private file(key: string) {
    if (!SAFE_KEY.test(key)) throw new Error("Invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key"); // no traversal
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: "wx" });
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.file(key)));
  }
  async delete(key: string) {
    await unlink(this.file(key)).catch(() => {});
  }
  async signedUrl() {
    return null;
  }
}

export class S3BlobStore implements BlobStore {
  private client: S3Client;
  private signer: S3Client;
  private sse: "AES256" | undefined;
  constructor(private bucket: string, opts: { endpoint?: string; publicEndpoint?: string; region: string; forcePathStyle: boolean; sse?: string }) {
    this.client = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle });
    // presigning is offline; a separate public endpoint lets the browser reach a bucket the app talks to over a private network
    this.signer = opts.publicEndpoint ? new S3Client({ region: opts.region, endpoint: opts.publicEndpoint, forcePathStyle: opts.forcePathStyle }) : this.client;
    // SSE-S3 by default; MinIO without a KMS rejects it, so S3_SSE=none turns it off for local stacks
    this.sse = opts.sse === "none" ? undefined : "AES256";
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ServerSideEncryption: this.sse }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return new Uint8Array(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async signedUrl(key: string, filename: string, inline: boolean, ttlSeconds: number) {
    const disposition = `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.-]/g, "_")}"`;
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: ttlSeconds });
  }
}

// FILE_STORAGE=local (default, ./.data/uploads) or s3 (S3_BUCKET, S3_REGION, optional S3_ENDPOINT / S3_PUBLIC_ENDPOINT for MinIO/R2)
const g = globalThis as unknown as { __blobStore?: BlobStore };
export function blobStore(): BlobStore {
  if (!g.__blobStore) {
    if (process.env.FILE_STORAGE === "s3") {
      if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required when FILE_STORAGE=s3");
      g.__blobStore = new S3BlobStore(process.env.S3_BUCKET, {
        region: process.env.S3_REGION ?? "us-east-1", endpoint: process.env.S3_ENDPOINT || undefined, publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT, sse: process.env.S3_SSE,
      });
    } else {
      g.__blobStore = new LocalBlobStore(process.env.FILE_STORAGE_DIR ?? path.join(process.cwd(), ".data", "uploads"));
    }
  }
  return g.__blobStore;
}

// malware-scanning hook; plug ClamAV or a cloud scanner in here
export interface FileScanner {
  scan(bytes: Uint8Array): Promise<"clean" | "infected" | "unscanned">;
}
export const noopScanner: FileScanner = { scan: async () => "unscanned" };
export const fileScanner = (): FileScanner => noopScanner;
