// Renders the PWA icons in public/ from src/app/icon.svg (run after changing the logo: node scripts/make-icons.mjs).
// "any" icons are the logo as is; the maskable one adds a safe zone, since launchers may crop it to a circle.
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../src/app/icon.svg", import.meta.url));
const out = (name) => new URL(`../public/${name}`, import.meta.url).pathname;
for (const size of [192, 512]) {
  await sharp(svg, { density: 72 * (size / 24) }).resize(size, size).png().toFile(out(`icon-${size}.png`));
}
// maskable: the logo at 70% on the brand colour, so any crop shape keeps it whole
const inner = await sharp(svg, { density: 72 * (358 / 24) }).resize(358, 358).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#2f5bd3" } })
  .composite([{ input: inner, gravity: "center" }]).png().toFile(out("icon-maskable-512.png"));
console.log("icons written");
