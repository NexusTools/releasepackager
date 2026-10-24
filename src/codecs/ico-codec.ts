import * as zlib from 'node:zlib';
import { Crc32Codec } from './crc32-codec.js';

/**
 * Pure Node.js Windows `.ico` and PNG icon codec.
 * Supports wrapping PNGs into `.ico`, parsing `.ico` entries for PE `RT_ICON` / `RT_GROUP_ICON`,
 * and generating a default fallback PNG icon when none is provided.
 */
export class IcoCodec {
  /**
   * Ensures the returned buffer is a valid Windows `.ico` file.
   * If a PNG buffer is passed, wraps it in an ICONDIR container.
   */
  public static toIcoBuffer(inputBuffer?: Buffer): Buffer {
    const buf = inputBuffer ?? IcoCodec.createDefaultPngIcon(64);
    if (IcoCodec.isIco(buf)) {
      const entries = IcoCodec.parseIcoEntries(buf);
      const has32Dib = entries.some(
        (e) => e.width === 32 && e.height === 32 && !IcoCodec.isPng(e.imageData)
      );
      if (has32Dib) {
        return buf;
      }
      const pngEntry = entries.find((e) => IcoCodec.isPng(e.imageData));
      if (pngEntry) {
        return IcoCodec.buildMultiSizeIcoFromPng(pngEntry.imageData);
      }
      return buf;
    }
    if (IcoCodec.isPng(buf)) {
      return IcoCodec.buildMultiSizeIcoFromPng(buf);
    }
    // Fallback if unrecognized format
    return IcoCodec.buildMultiSizeIcoFromPng(IcoCodec.createDefaultPngIcon(64));
  }

  /**
   * Ensures the returned buffer is a valid PNG image (extracting from `.ico` or generating default if needed).
   */
  public static toPngBuffer(inputBuffer?: Buffer): Buffer {
    if (!inputBuffer) {
      return IcoCodec.createDefaultPngIcon(256);
    }
    if (IcoCodec.isPng(inputBuffer)) {
      return inputBuffer;
    }
    if (IcoCodec.isIco(inputBuffer)) {
      const entries = IcoCodec.parseIcoEntries(inputBuffer);
      for (const entry of entries) {
        if (IcoCodec.isPng(entry.imageData)) {
          return entry.imageData;
        }
      }
    }
    return IcoCodec.createDefaultPngIcon(256);
  }

  /**
   * Parses an `.ico` buffer into individual icon images and builds the `GRPICONDIR`
   * structure required for PE `RT_GROUP_ICON` resources.
   */
  public static parseIcoForPeResource(icoBuffer: Buffer): {
    grpIconDir: Buffer;
    icons: { id: number; data: Buffer }[];
  } {
    const entries = IcoCodec.parseIcoEntries(icoBuffer);
    const grpHeader = Buffer.alloc(6 + entries.length * 14);
    grpHeader.writeUInt16LE(0, 0);
    grpHeader.writeUInt16LE(1, 2);
    grpHeader.writeUInt16LE(entries.length, 4);

    const icons: { id: number; data: Buffer }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const iconId = i + 1;
      const offset = 6 + i * 14;
      grpHeader.writeUInt8(e.width, offset);
      grpHeader.writeUInt8(e.height, offset + 1);
      grpHeader.writeUInt8(e.colorCount, offset + 2);
      grpHeader.writeUInt8(0, offset + 3);
      grpHeader.writeUInt16LE(e.planes || 1, offset + 4);
      grpHeader.writeUInt16LE(e.bitCount || 32, offset + 6);
      grpHeader.writeUInt32LE(e.imageData.length, offset + 8);
      grpHeader.writeUInt16LE(iconId, offset + 12);

      icons.push({ id: iconId, data: e.imageData });
    }

    return { grpIconDir: grpHeader, icons };
  }

  /**
   * Synthesizes a valid RGBA PNG icon in pure Node.js (gradient rounded badge).
   */
  public static createDefaultPngIcon(size = 64): Buffer {
    const rawScanlines = Buffer.alloc(size * (1 + size * 4));
    const center = (size - 1) / 2;
    const radius = size * 0.45;

    for (let y = 0; y < size; y++) {
      const rowOffset = y * (1 + size * 4);
      rawScanlines[rowOffset] = 0; // Filter type 0 (None)
      for (let x = 0; x < size; x++) {
        const pxOffset = rowOffset + 1 + x * 4;
        const dx = x - center;
        const dy = y - center;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius) {
          const t = y / size;
          rawScanlines[pxOffset] = Math.round(28 + t * 20); // R
          rawScanlines[pxOffset + 1] = Math.round(135 - t * 35); // G
          rawScanlines[pxOffset + 2] = Math.round(230 - t * 40); // B
          rawScanlines[pxOffset + 3] = 255; // A
        } else {
          rawScanlines[pxOffset] = 0;
          rawScanlines[pxOffset + 1] = 0;
          rawScanlines[pxOffset + 2] = 0;
          rawScanlines[pxOffset + 3] = 0;
        }
      }
    }

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8); // Bit depth 8
    ihdr.writeUInt8(6, 9); // Color type 6 (RGBA)
    ihdr.writeUInt8(0, 10); // Compression
    ihdr.writeUInt8(0, 11); // Filter
    ihdr.writeUInt8(0, 12); // Interlace

    const idatPayload = zlib.deflateSync(rawScanlines, { level: 6 });

    return Buffer.concat([
      signature,
      IcoCodec.makePngChunk('IHDR', ihdr),
      IcoCodec.makePngChunk('IDAT', idatPayload),
      IcoCodec.makePngChunk('IEND', Buffer.alloc(0))
    ]);
  }

  public static isPng(buf: Buffer): boolean {
    return (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }

  public static isIco(buf: Buffer): boolean {
    return (
      buf.length >= 22 &&
      buf.readUInt16LE(0) === 0 &&
      buf.readUInt16LE(2) === 1 &&
      buf.readUInt16LE(4) >= 1
    );
  }

  private static readPngDimensions(png: Buffer): { width: number; height: number } {
    if (!IcoCodec.isPng(png)) {
      return { width: 256, height: 256 };
    }
    return {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20)
    };
  }

  private static parseIcoEntries(ico: Buffer): {
    width: number;
    height: number;
    colorCount: number;
    planes: number;
    bitCount: number;
    imageData: Buffer;
  }[] {
    const count = ico.readUInt16LE(4);
    const list: {
      width: number;
      height: number;
      colorCount: number;
      planes: number;
      bitCount: number;
      imageData: Buffer;
    }[] = [];

    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      if (base + 16 > ico.length) {
        break;
      }
      const width = ico.readUInt8(base);
      const height = ico.readUInt8(base + 1);
      const colorCount = ico.readUInt8(base + 2);
      const planes = ico.readUInt16LE(base + 4);
      const bitCount = ico.readUInt16LE(base + 6);
      const size = ico.readUInt32LE(base + 8);
      const offset = ico.readUInt32LE(base + 12);
      const imageData = ico.subarray(offset, offset + size);
      list.push({ width, height, colorCount, planes, bitCount, imageData });
    }
    return list;
  }

  private static makePngChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    const crc = Crc32Codec.compute(chunk.subarray(4, 8 + data.length));
    chunk.writeUInt32BE(crc, 8 + data.length);
    return chunk;
  }

  /**
   * Builds a multi-resolution Windows `.ico` containing 16x16, 32x32, and 48x48
   * uncompressed 32-bit BGRA DIB (`BITMAPINFOHEADER`) frames (required by Win32 / Windows Installer
   * `Icon` controls) plus the original PNG frame.
   */
  private static buildMultiSizeIcoFromPng(pngBuf: Buffer): Buffer {
    const decoded = IcoCodec.decodePngToRgba(pngBuf);
    const dibSizes = [16, 32, 48];
    const frames: { width: number; height: number; data: Buffer }[] = [];

    for (const targetSize of dibSizes) {
      const scaledRgba = IcoCodec.resampleRgba(
        decoded.rgba,
        decoded.width,
        decoded.height,
        targetSize,
        targetSize
      );
      frames.push({
        width: targetSize,
        height: targetSize,
        data: IcoCodec.encodeRgbaToDibFrame(scaledRgba, targetSize, targetSize)
      });
    }

    const { width: origW, height: origH } = IcoCodec.readPngDimensions(pngBuf);
    frames.push({
      width: origW >= 256 ? 0 : origW,
      height: origH >= 256 ? 0 : origH,
      data: pngBuf
    });

    const headerSize = 6 + frames.length * 16;
    const header = Buffer.alloc(headerSize, 0);
    header.writeUInt16LE(0, 0); // Reserved
    header.writeUInt16LE(1, 2); // Type 1 = ICO
    header.writeUInt16LE(frames.length, 4);

    let currentOffset = headerSize;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const entryOffset = 6 + i * 16;
      header.writeUInt8(f.width, entryOffset);
      header.writeUInt8(f.height, entryOffset + 1);
      header.writeUInt8(0, entryOffset + 2); // Color count
      header.writeUInt8(0, entryOffset + 3); // Reserved
      header.writeUInt16LE(1, entryOffset + 4); // Planes
      header.writeUInt16LE(32, entryOffset + 6); // BitCount
      header.writeUInt32LE(f.data.length, entryOffset + 8);
      header.writeUInt32LE(currentOffset, entryOffset + 12);
      currentOffset += f.data.length;
    }

    return Buffer.concat([header, ...frames.map((f) => f.data)]);
  }

  private static encodeRgbaToDibFrame(rgba: Buffer, width: number, height: number): Buffer {
    const xorSize = width * height * 4;
    const andRowBytes = Math.ceil(width / 32) * 4;
    const andSize = andRowBytes * height;
    const dib = Buffer.alloc(40 + xorSize + andSize, 0);

    // 40-byte BITMAPINFOHEADER
    dib.writeUInt32LE(40, 0); // biSize
    dib.writeInt32LE(width, 4); // biWidth
    dib.writeInt32LE(height * 2, 8); // biHeight (doubled for XOR + AND masks)
    dib.writeUInt16LE(1, 12); // biPlanes
    dib.writeUInt16LE(32, 14); // biBitCount
    dib.writeUInt32LE(0, 16); // biCompression = BI_RGB
    dib.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

    // Write bottom-up BGRA XOR mask and 1-bit AND mask
    const xorStart = 40;
    const andStart = 40 + xorSize;
    for (let y = 0; y < height; y++) {
      const srcY = height - 1 - y; // Bottom-up row order
      for (let x = 0; x < width; x++) {
        const srcIdx = (srcY * width + x) * 4;
        const dstIdx = xorStart + (y * width + x) * 4;
        const r = rgba[srcIdx];
        const g = rgba[srcIdx + 1];
        const b = rgba[srcIdx + 2];
        const a = rgba[srcIdx + 3];
        dib[dstIdx] = b;
        dib[dstIdx + 1] = g;
        dib[dstIdx + 2] = r;
        dib[dstIdx + 3] = a;

        if (a < 128) {
          const byteIdx = andStart + y * andRowBytes + (x >> 3);
          const bitIdx = 7 - (x & 7);
          dib[byteIdx] |= 1 << bitIdx;
        }
      }
    }

    return dib;
  }

  private static decodePngToRgba(png: Buffer): { width: number; height: number; rgba: Buffer } {
    try {
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const bitDepth = png.readUInt8(24);
      const colorType = png.readUInt8(25);

      const idatChunks: Buffer[] = [];
      let pos = 8;
      while (pos + 8 <= png.length) {
        const len = png.readUInt32BE(pos);
        const type = png.toString('ascii', pos + 4, pos + 8);
        if (type === 'IDAT') {
          idatChunks.push(png.subarray(pos + 8, pos + 8 + len));
        } else if (type === 'IEND') {
          break;
        }
        pos += 12 + len;
      }

      if (bitDepth === 8 && (colorType === 6 || colorType === 2)) {
        const bpp = colorType === 6 ? 4 : 3;
        const stride = width * bpp;
        const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
        const unfiltered = Buffer.alloc(width * height * bpp);
        const rgba = Buffer.alloc(width * height * 4);

        const paeth = (a: number, b: number, c: number): number => {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          if (pa <= pb && pa <= pc) return a;
          if (pb <= pc) return b;
          return c;
        };

        for (let y = 0; y < height; y++) {
          const filterType = inflated[y * (stride + 1)];
          const rowIn = y * (stride + 1) + 1;
          const rowOut = y * stride;
          for (let i = 0; i < stride; i++) {
            const raw = inflated[rowIn + i];
            const left = i >= bpp ? unfiltered[rowOut + i - bpp] : 0;
            const up = y > 0 ? unfiltered[rowOut - stride + i] : 0;
            const upLeft = y > 0 && i >= bpp ? unfiltered[rowOut - stride + i - bpp] : 0;
            let val = raw;
            if (filterType === 1) val = (raw + left) & 0xff;
            else if (filterType === 2) val = (raw + up) & 0xff;
            else if (filterType === 3) val = (raw + ((left + up) >> 1)) & 0xff;
            else if (filterType === 4) val = (raw + paeth(left, up, upLeft)) & 0xff;
            unfiltered[rowOut + i] = val;
          }
        }

        if (bpp === 4) {
          return { width, height, rgba: unfiltered };
        }
        for (let p = 0; p < width * height; p++) {
          rgba[p * 4] = unfiltered[p * 3];
          rgba[p * 4 + 1] = unfiltered[p * 3 + 1];
          rgba[p * 4 + 2] = unfiltered[p * 3 + 2];
          rgba[p * 4 + 3] = 255;
        }
        return { width, height, rgba };
      }
    } catch {}

    // Fallback 32x32 gradient icon
    const fallbackSize = 32;
    const rgba = Buffer.alloc(fallbackSize * fallbackSize * 4);
    for (let y = 0; y < fallbackSize; y++) {
      for (let x = 0; x < fallbackSize; x++) {
        const idx = (y * fallbackSize + x) * 4;
        rgba[idx] = 14;
        rgba[idx + 1] = 165;
        rgba[idx + 2] = 233;
        rgba[idx + 3] = 255;
      }
    }
    return { width: fallbackSize, height: fallbackSize, rgba };
  }

  private static resampleRgba(
    src: Buffer,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number
  ): Buffer {
    const dst = Buffer.alloc(dstW * dstH * 4);
    const scaleX = srcW / dstW;
    const scaleY = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(srcH, Math.ceil((y + 1) * scaleY));
      for (let x = 0; x < dstW; x++) {
        const sx0 = Math.floor(x * scaleX);
        const sx1 = Math.min(srcW, Math.ceil((x + 1) * scaleX));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let sy = sy0; sy < Math.max(sy0 + 1, sy1); sy++) {
          for (let sx = sx0; sx < Math.max(sx0 + 1, sx1); sx++) {
            const idx = (sy * srcW + sx) * 4;
            r += src[idx];
            g += src[idx + 1];
            b += src[idx + 2];
            a += src[idx + 3];
            count++;
          }
        }
        const dIdx = (y * dstW + x) * 4;
        dst[dIdx] = Math.round(r / count);
        dst[dIdx + 1] = Math.round(g / count);
        dst[dIdx + 2] = Math.round(b / count);
        dst[dIdx + 3] = Math.round(a / count);
      }
    }
    return dst;
  }
}
