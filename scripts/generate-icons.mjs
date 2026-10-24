import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assets, encodeBmp, encodeIcns, encodeIco, encodePng, icnsMasks } from "./icons.mjs";

// Regenerates the app icon and installer images under build/, and the glyph the app
// draws itself in src/components/appGlyph.ts, from scripts/icons.mjs.
// Run `pnpm icons` after changing the artwork. Playwright's Chromium rasterizes the SVGs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Draws an SVG at its exact pixel size and returns the RGBA pixels. */
async function rasterize(page, svg, width, height) {
  const base64 = await page.evaluate(async ({ svg, width, height }) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    const bytes = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }, { svg, width, height });
  return Buffer.from(base64, "base64");
}

/** Renders one asset into the bytes of the file format its extension names. */
async function encode(page, asset) {
  const pixels = (image) => rasterize(page, image.svg, image.width, image.height);
  const png = async (image) => encodePng(image.width, image.height, await pixels(image));
  switch (path.extname(asset.file)) {
    case ".svg":
    case ".ts":
      return asset.text;
    case ".png":
      return png(asset);
    case ".bmp":
      return encodeBmp(asset.width, asset.height, await pixels(asset));
    case ".ico":
      return encodeIco(await Promise.all(asset.images.map(async (image) => ({ size: image.width, png: await png(image) }))));
    case ".icns":
      return encodeIcns(await Promise.all(asset.images.map(async (image) => icnsMasks[image.type]
        ? { type: image.type, pixels: await pixels(image) }
        : { type: image.type, png: await png(image) })));
    default:
      throw new Error(`No encoder for ${asset.file}`);
  }
}

/** Renders every asset and writes it to its file. */
async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const asset of assets) {
      const file = path.join(root, asset.file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, await encode(page, asset));
    }
    console.log(`Wrote ${assets.length} files.`);
  } finally {
    await browser.close();
  }
}

await main();
