import * as zlib from 'node:zlib';
import { Crc32Codec } from './crc32-codec.js';

/**
 * Pure Node.js generator for the default macOS `.dmg` installer background splash image (`600x400` PNG).
 * Renders a visual drag-and-drop layout with the Application badge/slot on the left (`x = 160, y = 200`),
 * a directional arrow in the center (`x = 300, y = 200`), and the Applications folder badge/slot on the
 * right (`x = 440, y = 200`) to instruct the user to drag the app into `/Applications`.
 */
export class DmgSplashGenerator {
  public static readonly WIDTH = 600;
  public static readonly HEIGHT = 400;

  /**
   * Generates a `600x400` RGBA PNG buffer for `.background/background.png` inside a macOS DMG volume.
   */
  public static generateDefaultSplashPng(): Buffer {
    const width = DmgSplashGenerator.WIDTH;
    const height = DmgSplashGenerator.HEIGHT;
    const rgba = Buffer.alloc(width * height * 4, 0);

    const setPixel = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const idx = (y * width + x) * 4;
      if (a >= 255) {
        rgba[idx] = r;
        rgba[idx + 1] = g;
        rgba[idx + 2] = b;
        rgba[idx + 3] = 255;
      } else if (a > 0) {
        const alpha = a / 255;
        const inv = 1 - alpha;
        rgba[idx] = Math.round(r * alpha + rgba[idx] * inv);
        rgba[idx + 1] = Math.round(g * alpha + rgba[idx + 1] * inv);
        rgba[idx + 2] = Math.round(b * alpha + rgba[idx + 2] * inv);
        rgba[idx + 3] = 255;
      }
    };

    const fillRoundedRect = (
      cx: number,
      cy: number,
      w: number,
      h: number,
      radius: number,
      r: number,
      g: number,
      b: number,
      a = 255
    ): void => {
      const x0 = Math.round(cx - w / 2);
      const y0 = Math.round(cy - h / 2);
      const x1 = x0 + w;
      const y1 = y0 + h;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const dx = Math.max(x0 + radius - px, 0, px - (x1 - 1 - radius));
          const dy = Math.max(y0 + radius - py, 0, py - (y1 - 1 - radius));
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= radius) {
            setPixel(px, py, r, g, b, a);
          } else if (dist < radius + 1) {
            setPixel(px, py, r, g, b, Math.round(a * (radius + 1 - dist)));
          }
        }
      }
    };

    const strokeRoundedRect = (
      cx: number,
      cy: number,
      w: number,
      h: number,
      radius: number,
      thickness: number,
      r: number,
      g: number,
      b: number,
      a = 255
    ): void => {
      const x0 = Math.round(cx - w / 2);
      const y0 = Math.round(cy - h / 2);
      const x1 = x0 + w;
      const y1 = y0 + h;
      for (let py = y0 - 1; py <= y1; py++) {
        for (let px = x0 - 1; px <= x1; px++) {
          const dx = Math.max(x0 + radius - px, 0, px - (x1 - 1 - radius));
          const dy = Math.max(y0 + radius - py, 0, py - (y1 - 1 - radius));
          const dist = Math.sqrt(dx * dx + dy * dy);
          const innerRadius = Math.max(0, radius - thickness);
          const idxInner = Math.max(x0 + radius - px, 0, px - (x1 - 1 - radius));
          const idyInner = Math.max(y0 + radius - py, 0, py - (y1 - 1 - radius));
          const distInner = Math.sqrt(idxInner * idxInner + idyInner * idyInner);
          const inOuter =
            px >= x0 && px < x1 && py >= y0 && py < y1 && dist <= radius;
          const inInner =
            px >= x0 + thickness &&
            px < x1 - thickness &&
            py >= y0 + thickness &&
            py < y1 - thickness &&
            distInner <= innerRadius;
          if (inOuter && !inInner) {
            setPixel(px, py, r, g, b, a);
          }
        }
      }
    };

    // 1. Smooth dark slate gradient background (600x400)
    for (let y = 0; y < height; y++) {
      const t = y / (height - 1);
      const r = Math.round(18 + t * 10);
      const g = Math.round(24 + t * 14);
      const b = Math.round(36 + t * 20);
      for (let x = 0; x < width; x++) {
        setPixel(x, y, r, g, b, 255);
      }
    }

    // 2. Left Drop Zone & App Graphic at (160, 200)
    fillRoundedRect(160, 200, 136, 136, 22, 30, 41, 59, 220);
    strokeRoundedRect(160, 200, 136, 136, 22, 2, 56, 189, 248, 140);
    // Stylized App icon card on the left (x = 160, y = 192)
    fillRoundedRect(160, 192, 68, 68, 15, 14, 165, 233, 255);
    fillRoundedRect(160, 192, 60, 60, 12, 30, 58, 138, 255);
    // Play / App triangle inside left app icon
    for (let py = 176; py <= 208; py++) {
      const halfSpan = Math.max(0, 16 - Math.abs(py - 192));
      const xStart = 152;
      const xEnd = xStart + Math.round(halfSpan * 1.25);
      for (let px = xStart; px <= xEnd; px++) {
        setPixel(px, py, 240, 249, 255, 255);
      }
    }

    // 3. Center Directional Arrow at (300, 200) pointing from Left (App) to Right (Applications)
    // Arrow shaft: x = 252..322, y = 194..206
    fillRoundedRect(287, 200, 70, 12, 6, 56, 189, 248, 255);
    // Arrow head: triangle from x = 316 to x = 350 centered at y = 200
    const headStart = 316;
    const headEnd = 350;
    for (let px = headStart; px <= headEnd; px++) {
      const progress = (px - headStart) / (headEnd - headStart);
      const halfHeight = Math.round((1 - progress) * 24);
      for (let py = 200 - halfHeight; py <= 200 + halfHeight; py++) {
        setPixel(px, py, 56, 189, 248, 255);
      }
    }

    // 4. Right Drop Zone & Applications Folder Graphic at (440, 200)
    fillRoundedRect(440, 200, 136, 136, 22, 30, 41, 59, 220);
    strokeRoundedRect(440, 200, 136, 136, 22, 2, 56, 189, 248, 140);
    // Stylized macOS Applications Folder on the right (x = 440, y = 194)
    // Folder back tab
    fillRoundedRect(422, 168, 30, 14, 5, 2, 132, 199, 255);
    // Folder body
    fillRoundedRect(440, 196, 72, 54, 10, 56, 189, 248, 255);
    fillRoundedRect(440, 198, 66, 46, 8, 14, 165, 233, 255);
    // Stylized 'A' emblem inside the Applications folder
    for (let dy = -14; dy <= 14; dy++) {
      const py = 198 + dy;
      const t = (dy + 14) / 28; // 0 at top, 1 at bottom
      const spread = Math.round(t * 11);
      // Left leg of 'A'
      for (let w = -2; w <= 2; w++) {
        setPixel(440 - spread + w, py, 255, 255, 255, 245);
        setPixel(440 + spread + w, py, 255, 255, 255, 245);
      }
      // Crossbar of 'A'
      if (dy >= 2 && dy <= 5) {
        for (let px = 440 - spread; px <= 440 + spread; px++) {
          setPixel(px, py, 255, 255, 255, 245);
        }
      }
    }

    return DmgSplashGenerator.encodeRgbaToPng(width, height, rgba);
  }

  /**
   * Encodes a raw RGBA pixel buffer into a standard PNG image buffer.
   */
  public static encodeRgbaToPng(width: number, height: number, rgba: Buffer): Buffer {
    const stride = width * 4;
    const rawScanlines = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1);
      rawScanlines[rowStart] = 0; // Filter type 0 (None)
      rgba.copy(rawScanlines, rowStart + 1, y * stride, (y + 1) * stride);
    }

    const compressed = zlib.deflateSync(rawScanlines, { level: 6 });

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = 6; // Color type 6 = RGBA
    ihdr[10] = 0; // Compression method 0
    ihdr[11] = 0; // Filter method 0
    ihdr[12] = 0; // Interlace method 0

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
      signature,
      DmgSplashGenerator.buildPngChunk('IHDR', ihdr),
      DmgSplashGenerator.buildPngChunk('IDAT', compressed),
      DmgSplashGenerator.buildPngChunk('IEND', Buffer.alloc(0))
    ]);
  }

  private static buildPngChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    if (data.length > 0) {
      data.copy(chunk, 8);
    }
    const crc = Crc32Codec.compute(chunk.subarray(4, 8 + data.length));
    chunk.writeUInt32BE(crc >>> 0, 8 + data.length);
    return chunk;
  }
}
