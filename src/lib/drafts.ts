"use client";
// Requests written while offline, kept on this device (IndexedDB) until they can be sent. Each draft belongs to one
// person in one organization and carries the form's draft reference, so sending it twice creates one request.
// Drafts are cleared on sign-out; they never leave the device except by being submitted as the person who wrote them.

export type Draft = {
  id: string; // the form's clientRef
  userId: string;
  orgSlug: string;
  kind: "work_order";
  title: string;
  fields: [string, string][];
  files: { name: string; type: string; blob: Blob }[];
  createdAt: number;
  lastError?: string | null;
};

const DB = "drafts";
const STORE = "drafts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const draftsAvailable = () => typeof indexedDB !== "undefined";

export async function saveDraft(d: Draft) {
  await run("readwrite", (s) => s.put(d));
}

export async function listDrafts(userId: string, orgSlug: string): Promise<Draft[]> {
  const all = await run<Draft[]>("readonly", (s) => s.getAll() as IDBRequest<Draft[]>);
  return all.filter((d) => d.userId === userId && d.orgSlug === orgSlug).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteDraft(id: string) {
  await run("readwrite", (s) => s.delete(id));
}

export async function clearDrafts() {
  if (!draftsAvailable()) return;
  await run("readwrite", (s) => s.clear()).catch(() => {});
}

// a form's contents as a draft (files are kept as blobs; text fields as pairs, in order)
export function draftFromForm(fd: FormData, meta: { id: string; userId: string; orgSlug: string; kind: Draft["kind"] }): Draft {
  const fields: [string, string][] = [];
  const files: Draft["files"] = [];
  for (const [k, v] of fd) {
    if (typeof v === "string") fields.push([k, v]);
    else if (v.size > 0) files.push({ name: v.name, type: v.type, blob: v });
  }
  const title = fields.find(([k]) => k === "title")?.[1]?.trim() || "Maintenance request";
  return { ...meta, title, fields, files, createdAt: Date.now() };
}

export function formFromDraft(d: Draft): FormData {
  const fd = new FormData();
  for (const [k, v] of d.fields) fd.append(k, v);
  for (const f of d.files) fd.append("files", new File([f.blob], f.name, { type: f.type }));
  return fd;
}

// fetch failures (no connection, dropped connection) as opposed to the server answering with an error
export function isNetworkError(e: unknown) {
  return (typeof navigator !== "undefined" && !navigator.onLine) || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
}
