// render-icons.mjs — one-off: render icon.svg into PNGs for the extension.
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(__dirname, "icon.svg"));
const sizes = [16, 48, 128];

for (const size of sizes) {
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(join(__dirname, `icon${size}.png`));
  console.log(`✓ icon${size}.png`);
}
