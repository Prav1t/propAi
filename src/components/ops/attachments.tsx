"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";
import { initialActionState } from "@/lib/action-state";
import { FormAlert, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/button";

type F = { id: string; filename: string; contentType: string; sizeBytes: number; visibility: string };

const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.ceil(n / 1000)} KB`);

// thumbnails for images, links for other files; downloads go through the permission-checked route
export function AttachmentList({ files, base }: { files: F[]; base: string }) {
  if (!files.length) return <p className="px-4 py-3 text-[13px] text-faint">No files yet.</p>;
  return (
    <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
      {files.map((f) => (
        <li key={f.id} className="overflow-hidden rounded-[var(--radius-md)] border border-border">
          <a href={`${base}/files/${f.id}`} target="_blank" rel="noopener" className="block hover:bg-subtle">
            {f.contentType.startsWith("image/") && f.contentType !== "image/heic"
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={`${base}/files/${f.id}`} alt={f.filename} className="h-24 w-full bg-subtle object-cover" loading="lazy" />
              : <div className="flex h-24 items-center justify-center bg-subtle text-xs font-medium uppercase text-muted">{f.contentType.split("/")[1]}</div>}
            <div className="px-2 py-1.5"><p className="truncate text-xs">{f.filename}</p><p className="text-[11px] text-faint">{kb(f.sizeBytes)}</p></div>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function UploadForm({ action, levels }: { action: (s: ActionState, fd: FormData) => Promise<ActionState>; levels: string[] }) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-2 border-t border-border p-3">
      <FormAlert>{state.error}</FormAlert>
      <FormAlert kind="success">{state.ok ? state.message : null}</FormAlert>
      <label className="block text-[13px] font-medium" htmlFor="upload-files">Add photos or files</label>
      <input id="upload-files" name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/heic,application/pdf,video/mp4,video/quicktime"
        capture={undefined} className="block w-full text-[13px] file:mr-3 file:rounded-[var(--radius-md)] file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-[13px]" />
      <p className="text-xs text-faint">Up to 5 files · images 10 MB, PDFs 15 MB, video 25 MB.</p>
      <div className="flex items-center gap-2">
        {levels.length > 1 ? (
          <Select name="visibility" className="h-8 w-auto text-[13px]" defaultValue={levels.includes("vendor") ? "vendor" : levels[0]} aria-label="Who can see these files">
            {levels.includes("public") ? <option value="public">Everyone on this request</option> : null}
            {levels.includes("vendor") ? <option value="vendor">Staff & vendor</option> : null}
            {levels.includes("internal") ? <option value="internal">Staff only</option> : null}
          </Select>
        ) : <input type="hidden" name="visibility" value={levels[0]} />}
        <SubmitButton size="sm" variant="secondary" pendingLabel="Uploading…">Upload</SubmitButton>
      </div>
    </form>
  );
}
