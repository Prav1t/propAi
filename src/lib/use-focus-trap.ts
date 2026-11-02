"use client";
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("inert") && el.getClientRects().length > 0);
}

// keeps Tab inside an open dialog or drawer, closes it on Escape, and hands focus back to whatever opened it
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, opts: { onEscape?: () => void; initial?: RefObject<HTMLElement | null> } = {}) {
  // latest options without re-running the effect (which would move focus) on every render
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    // after paint, so a dialog that renders its input on open can take focus
    const raf = requestAnimationFrame(() => (latest.current.initial?.current ?? focusables(root)[0] ?? root).focus());
    const onKey = (e: KeyboardEvent) => {
      const onEscape = latest.current.onEscape;
      if (e.key === "Escape" && onEscape) {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const [head, tail] = [items[0], items[items.length - 1]];
      const current = document.activeElement;
      if (e.shiftKey && (current === head || !root.contains(current))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (current === tail || !root.contains(current))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [active, ref]);
}
