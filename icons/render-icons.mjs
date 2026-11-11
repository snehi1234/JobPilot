// render-icons.mjs — render the icon SVGs into the PNG sizes the extension and
// store need. icon-small.svg is a simplified mark that stays legible at 16 px.
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(__dirname, "icon.svg"));
const small = readFileSync(join(__dirname, "icon-small.svg"));

for (const [size, svg] of [[16, small], [48, full], [128, full]]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(join(__dirname, `icon${size}.png`));
  console.log(`✓ icon${size}.png`);
}
// Preview sheet (not shipped): every size side by side, enlarged.
const tiles = await Promise.all([16, 48, 128].map((s) => sharp(join(__dirname, `icon${s}.png`)).resize(128, 128, { kernel: "nearest" }).png().toBuffer()));
await sharp({ create: { width: 3 * 148, height: 148, channels: 4, background: "#ffffff" } })
  .composite(tiles.map((input, i) => ({ input, left: 10 + i * 148, top: 10 })))
  .png().toFile(join(__dirname, "preview.png"));
console.log("✓ preview.png");
