import type { MetadataRoute } from "next";
import { BRAND } from "@/config/brand";

// installable on phones (add to home screen); offline support comes with the PWA work in Iteration 12
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name.length > 12 ? BRAND.name.slice(0, 12) : BRAND.name,
    description: "Building operations, requests, bookings and packages.",
    start_url: "/orgs",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2563eb",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
