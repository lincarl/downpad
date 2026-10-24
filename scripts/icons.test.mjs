import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { assets, encodeBmp, encodeIcns, encodeIco, encodePng, glyph, icnsMasks } from "./icons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const points = (pathData) => [...pathData.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);

/** Reverses PNG row filtering so tests can compare decoded pixels with the input. */
function decodePng(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), stride = width * 4;
  let offset = 8, compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed)), pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4] : 0, b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4] : 0, p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** Splits an ICNS file into its typed entries. */
function icnsEntries(icns) {
  const entries = [];
  for (let offset = 8; offset < icns.length; offset += icns.readUInt32BE(offset + 4)) {
    entries.push({ type: icns.toString("latin1", offset, offset + 4), data: icns.subarray(offset + 8, offset + icns.readUInt32BE(offset + 4)) });
  }
  return entries;
}

/** Expands ICNS run-length data into `channels` planes of `count` bytes each. */
function unpackBits(data, channels, count) {
  const planes = [];
  let index = 0;
  for (let channel = 0; channel < channels; channel++) {
    const plane = [];
    while (plane.length < count) {
      const control = data[index++];
      if (control < 0x80) {
        plane.push(...data.subarray(index, index + control + 1));
        index += control + 1;
      } else {
        plane.push(...Array(control - 0x80 + 3).fill(data[index++]));
      }
    }
    planes.push(plane);
  }
  assert.equal(index, data.length, "run-length data has no trailing bytes");
  return planes;
}

/** Reads the pixel size an image file declares in its header. */
function imageSize(file, data) {
  if (file.endsWith(".png")) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (file.endsWith(".bmp")) return { width: data.readInt32LE(18), height: data.readInt32LE(22) };
  throw new Error(`Unknown image type ${file}`);
}

test("small icons keep the M's straight edges on whole pixels", () => {
  for (let size = 16; size <= 64; size += 2) {
    const letter = points(glyph(size).letter);
    // Points 3, 8, 9 and 10 sit on the middle V's diagonals and are not snapped.
    const straight = letter.filter((_, index) => ![3, 8, 9, 10].includes(index));
    assert.ok(straight.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)), `M at ${size} px`);
    const arrow = points(glyph(size).arrow);
    assert.ok(Number.isInteger(arrow[0][1]), `chevron top at ${size} px`);
    assert.ok(arrow[0][1] > Math.max(...letter.map(([, y]) => y)), `chevron below the M at ${size} px`);
  }
  assert.ok(points(glyph(1024).letter).some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y)), "large icons do not snap");
});

test("the glyph is mirror symmetric", () => {
  for (const size of [16, 24, 48, 256]) {
    for (const shape of Object.values(glyph(size))) {
      const shapePoints = points(shape).map(([x, y]) => `${(size - x).toFixed(2)},${y.toFixed(2)}`).sort();
      const mirrored = points(shape).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).sort();
      assert.deepEqual(shapePoints, mirrored, `${size} px`);
    }
  }
});

test("PNG encoding round-trips every filter choice", () => {
  const width = 7, height = 5, rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  const decoded = decodePng(encodePng(width, height, rgba));
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width, height });
  assert.ok(decoded.pixels.equals(rgba));
  assert.ok(!decodePng(encodePng(width, height, Buffer.alloc(rgba.length))).pixels.equals(rgba), "different input decodes differently");
});

test("BMP encoding writes bottom-up rows composited over white", () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 128, 0, 255, 0, 255]);
  const bmp = encodeBmp(2, 2, rgba);
  assert.equal(bmp.toString("latin1", 0, 2), "BM");
  assert.deepEqual({ width: bmp.readInt32LE(18), height: bmp.readInt32LE(22), bits: bmp.readUInt16LE(28) }, { width: 2, height: 2, bits: 24 });
  // Rows are padded to four bytes, and the bottom row comes first in BGR order.
  assert.deepEqual([...bmp.subarray(54, 60)], [255, 127, 127, 0, 255, 0]);
  assert.deepEqual([...bmp.subarray(62, 68)], [0, 0, 255, 255, 255, 255]);
});

test("ICO and ICNS containers index their PNG images", () => {
  const png = (size) => encodePng(size, size, Buffer.alloc(size * size * 4, 200));
  const ico = encodeIco([{ size: 16, png: png(16) }, { size: 256, png: png(256) }]);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.deepEqual([ico[6], ico[22]], [16, 0], "256 px is stored as 0");
  for (const entry of [6, 22]) {
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico.toString("latin1", offset + 1, offset + 4), "PNG");
    assert.equal(offset + ico.readUInt32LE(entry + 8) <= ico.length, true);
  }
  // Long runs, short runs and literals longer than one 128-byte chunk.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 256; i++) pixels.set([i < 140 ? 7 : i * 3, i % 2 ? 9 : 200, i < 2 ? 1 : 5, i], i * 4);
  const icns = encodeIcns([{ type: "is32", pixels }, { type: "ic10", png: png(32) }]);
  assert.equal(icns.toString("latin1", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const entries = icnsEntries(icns);
  assert.deepEqual(entries.map(({ type }) => type), ["is32", "s8mk", "ic10"]);
  const channel = (offset) => [...pixels.filter((_, index) => index % 4 === offset)];
  assert.deepEqual(unpackBits(entries[0].data, 3, 256), [channel(0), channel(1), channel(2)]);
  assert.deepEqual([...entries[1].data], channel(3));
  assert.equal(entries[2].data.toString("latin1", 1, 4), "PNG");
});

test("committed icon and installer images match the generator's list", async () => {
  for (const asset of assets) {
    const data = await readFile(path.join(root, asset.file));
    // The Windows App Certification Kit rejects package images of 200 KiB or more.
    if (asset.file.startsWith("build/appx/")) assert.ok(data.length < 204_800, `${asset.file} is ${data.length} bytes`);
    if (asset.file.endsWith(".svg")) {
      assert.equal(data.toString("utf8"), asset.svg, `${asset.file} is current`);
    } else if (asset.file.endsWith(".ico")) {
      assert.equal(data.readUInt16LE(4), asset.images.length, asset.file);
      asset.images.forEach((image, index) => {
        assert.equal(data[6 + 16 * index] || 256, image.width, `${asset.file} frame ${index}`);
        const offset = data.readUInt32LE(6 + 16 * index + 12);
        assert.equal(data.readUInt32BE(offset + 16), image.width, `${asset.file} frame ${index} pixels`);
      });
    } else if (asset.file.endsWith(".icns")) {
      const entries = icnsEntries(data);
      assert.deepEqual(entries.map(({ type }) => type), asset.images.flatMap(({ type }) => icnsMasks[type] ? [type, icnsMasks[type]] : [type]), asset.file);
      for (const image of asset.images) {
        const entry = entries.find(({ type }) => type === image.type);
        if (icnsMasks[image.type]) {
          const mask = entries.find(({ type }) => type === icnsMasks[image.type]);
          assert.equal(mask.data.length, image.width * image.height, `${asset.file} ${mask.type} pixels`);
          unpackBits(entry.data, 3, image.width * image.height);
        } else {
          assert.equal(entry.data.readUInt32BE(16), image.width, `${asset.file} ${image.type} pixels`);
        }
      }
    } else {
      assert.deepEqual(imageSize(asset.file, data), { width: asset.width, height: asset.height }, asset.file);
    }
  }
});
