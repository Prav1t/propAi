"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";

const subscribeCoarse = (cb: () => void) => {
  const mq = window.matchMedia("(pointer: coarse)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

// Photos and files for a form: "Take photo" opens the camera on phones (several shots add up instead of replacing
// each other), thumbnails show what will be sent, and each one can be removed. The real <input name="files"> holds
// the chosen files, so the form posts exactly as a plain file input would.
export function PhotoPicker({ id, label, hint, accept = "image/*,application/pdf,video/mp4,video/quicktime", name = "files", maxFiles = 5, onFilesChange }: {
  id: string; label: string; hint?: string; accept?: string; name?: string; maxFiles?: number; onFilesChange?: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const touch = useSyncExternalStore(subscribeCoarse, () => window.matchMedia("(pointer: coarse)").matches, () => false);
  const urls = useMemo(() => files.map((f) => (f.type.startsWith("image/") && f.type !== "image/heic" ? URL.createObjectURL(f) : "")), [files]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  const onReset = useRef<(() => void) | undefined>(undefined);
  useEffect(() => { onReset.current = () => onFilesChange?.([]); });
  // React resets a form after its action succeeds; the thumbnails go with it
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const clear = () => { setFiles([]); setNote(null); onReset.current?.(); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  // keep the submitted input in step with what's shown
  const commit = (list: File[]) => {
    const capped = list.slice(0, maxFiles);
    setNote(list.length > maxFiles ? `Only ${maxFiles} files can be attached; the extra ones were left out.` : null);
    const dt = new DataTransfer();
    capped.forEach((f) => dt.items.add(f));
    if (input.current) input.current.files = dt.files;
    setFiles(capped);
    onFilesChange?.(capped);
  };
  const same = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  const add = (incoming: FileList | null, keep: File[]) => commit([...keep, ...[...(incoming ?? [])].filter((f) => !keep.some((k) => same(k, f)))]);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        {touch ? (
          <button type="button" onClick={() => camera.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 text-[13px] font-medium hover:bg-subtle">
            Take photo
          </button>
        ) : null}
        {/* the files that are submitted; choosing more adds to the list */}
        <input ref={input} id={id} name={name} type="file" multiple accept={accept}
          onChange={(e) => add(e.currentTarget.files, files)}
          className="block min-h-11 w-full text-[13px] file:mr-3 file:h-9 file:rounded-[var(--radius-md)] file:border file:border-border-strong file:bg-surface file:px-3 file:text-[13px] sm:min-h-0 sm:w-auto" />
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden
          onChange={(e) => { add(e.currentTarget.files, files); e.currentTarget.value = ""; }} />
      </div>
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
      {note ? <p role="status" className="text-xs text-warning">{note}</p> : null}
      {files.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="relative">
              {urls[i]
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={urls[i]} alt={f.name} className="size-16 rounded-[var(--radius-md)] border border-border object-cover" />
                : <span className="flex size-16 items-center justify-center rounded-[var(--radius-md)] border border-border bg-subtle px-1 text-center text-[10px] font-medium uppercase text-muted">{f.name.split(".").pop()}</span>}
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => commit(files.filter((_, j) => j !== i))}
                className={cn("absolute -right-2 -top-2 inline-flex size-6 items-center justify-center rounded-full border border-border-strong bg-surface text-[13px] leading-none shadow-sm hover:bg-subtle",
                  "pointer-coarse:size-8")}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
