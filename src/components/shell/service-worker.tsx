"use client";
import { useEffect } from "react";

// registers public/sw.js (offline page, push notifications). Static assets are cached only in production builds,
// where their URLs are content-hashed.
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const url = process.env.NODE_ENV === "production" ? "/sw.js?static=1" : "/sw.js";
    navigator.serviceWorker.register(url, { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
