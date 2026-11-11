// Renders every brand PNG from the SVG sources. Run: node branding/render.mjs
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const require = createRequire(path.join(root, "frontend", "package.json"));
const sharp = require("sharp");

const read = (f) => readFileSync(path.join(here, f), "utf8");
const strip = (svg) => svg.replace(/<svg[^>]*>/, "").replace("</svg>", "");
const out = path.join(here, "out");
mkdirSync(out, { recursive: true });

// Mark art spans roughly y 10..105 (centre 57.5) and x 26..94 (centre 60) in the 120 grid.
const placed = (art, size, artHeight) => {
  const k = artHeight / 95;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(-60 -57.5)">${art}</g></svg>`,
  );
};
const markArt = strip(read("gullak-mark.svg"));
const monoArt = strip(read("gullak-mono.svg"));
const png = (svg, size, file) =>
  sharp(svg, { density: 300 }).resize(size, size).png().toFile(file);

const A = path.join(root, "mobile", "assets");
await png(Buffer.from(read("gullak-icon.svg")), 1024, path.join(A, "icon.png"));
// Foreground must sit inside the centre 66% (676px) safe zone; 640px tall leaves a margin.
await png(placed(markArt, 1024, 640), 1024, path.join(A, "android-icon-foreground.png"));
await png(placed(monoArt, 1024, 640), 1024, path.join(A, "android-icon-monochrome.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#FFC800" } })
  .png()
  .toFile(path.join(A, "android-icon-background.png"));
await png(placed(markArt, 1024, 614), 1024, path.join(A, "splash-icon.png"));
await png(Buffer.from(read("gullak-favicon.svg")), 48, path.join(A, "favicon.png"));

// The "Gullak Dev" testing app: same mark on a blue tile with a DEV pill, so it can't be mistaken for the real app.
const DEV_BLUE = "#1CB0F6";
const devPill = (cx, cy, w, h, font) =>
  `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="#1A1A1A" stroke="#FFFFFF" stroke-width="${h / 12}"/>` +
  `<text x="${cx}" y="${cy + font * 0.35}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="${font}" fill="#FFFFFF">DEV</text>`;
const withPill = (svgBuffer, pill) => Buffer.from(svgBuffer.toString().replace("</svg>", `${pill}</svg>`));
const devIcon = read("gullak-icon.svg").replaceAll("#FFC800", DEV_BLUE);
await png(withPill(Buffer.from(devIcon), devPill(512, 860, 420, 130, 96)), 1024, path.join(A, "icon-dev.png"));
await png(withPill(placed(markArt, 1024, 640), devPill(512, 700, 300, 104, 76)), 1024, path.join(A, "android-icon-foreground-dev.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: DEV_BLUE } })
  .png()
  .toFile(path.join(A, "android-icon-background-dev.png"));

const web = path.join(root, "frontend", "src", "app");
await png(Buffer.from(read("gullak-icon.svg")), 180, path.join(web, "apple-icon.png"));
copyFileSync(path.join(here, "gullak-favicon.svg"), path.join(web, "icon.svg"));
for (const s of [16, 32, 48]) {
  await png(Buffer.from(read("gullak-favicon.svg")), s, path.join(out, `favicon-${s}.png`));
}
console.log("done");
