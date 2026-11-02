import type { MetadataRoute } from "next";
import { BRAND } from "@/config/brand";

// installable app (Iteration 12): the service worker (public/sw.js) adds an offline page and push notifications
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: BRAND.name,
    short_name: BRAND.name.length > 12 ? BRAND.name.slice(0, 12) : BRAND.name,
    description: "Building operations, requests, bookings and packages.",
    start_url: "/orgs",
    scope: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#2f5bd3",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
