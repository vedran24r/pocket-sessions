// Draws the app icon (a ">_" prompt on Claude orange) straight to PNG, so the repo needs no image tooling.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

function icon(size) {
  const s = (v) => v * size; // design on a unit square
  const stroke = s(0.065);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const chevron = Math.min(
        distToSegment(x, y, s(0.3), s(0.33), s(0.48), s(0.5)),
        distToSegment(x, y, s(0.48), s(0.5), s(0.3), s(0.67)),
      );
      const underscore = x >= s(0.53) && x <= s(0.72) && Math.abs(y - s(0.67)) <= stroke / 2 + 0.5;
      const ink = Math.max(Math.min(1, Math.max(0, stroke / 2 + 0.5 - chevron)), underscore ? 1 : 0);
      const [r, g, b] = [217, 119, 87].map((bg) => Math.round(bg + (255 - bg) * ink));
      row.set([r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(new URL(`../web/public/icon-${size}.png`, import.meta.url), icon(size));
console.log("icons written");
