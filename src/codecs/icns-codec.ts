import { IcoCodec } from './ico-codec.js';

/**
 * Pure Node.js Apple Icon Image (`.icns`) codec.
 * Generates spec-compliant `.icns` files (`icns` magic header + `ic08` / `ic07` PNG elements)
 * for macOS `.app` bundles (`Contents/Resources/app.icns`).
 */
export class IcnsCodec {
  /**
   * Converts an input buffer (`.icns`, `.png`, or `.ico`) or generates a default icon
   * into a valid macOS `.icns` binary buffer.
   */
  public static toIcnsBuffer(inputBuffer?: Buffer): Buffer {
    if (inputBuffer && IcnsCodec.isIcns(inputBuffer)) {
      return inputBuffer;
    }

    const pngBuffer = IcoCodec.toPngBuffer(inputBuffer);
    // ic08 = 256x256 PNG, ic07 = 128x128 PNG
    const ic08Length = 8 + pngBuffer.length;
    const totalLength = 8 + ic08Length;

    const out = Buffer.alloc(totalLength);
    out.write('icns', 0, 4, 'ascii');
    out.writeUInt32BE(totalLength, 4);

    out.write('ic08', 8, 4, 'ascii');
    out.writeUInt32BE(ic08Length, 12);
    pngBuffer.copy(out, 16);

    return out;
  }

  /**
   * Checks whether a buffer begins with the `'icns'` magic signature.
   */
  public static isIcns(buf: Buffer): boolean {
    return (
      buf.length >= 8 &&
      buf[0] === 0x69 && // 'i'
      buf[1] === 0x63 && // 'c'
      buf[2] === 0x6e && // 'n'
      buf[3] === 0x73    // 's'
    );
  }
}
