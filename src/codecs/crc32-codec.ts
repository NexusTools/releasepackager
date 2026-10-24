/**
 * Pure Node.js IEEE 802.3 CRC-32 calculator used by ZIP, PNG, GZIP, and Apple UDIF DMG headers.
 */
export class Crc32Codec {
  private static readonly TABLE: Uint32Array = Crc32Codec.buildTable();

  private static buildTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  }

  /**
   * Computes unsigned 32-bit CRC-32 checksum over a buffer.
   */
  public static compute(data: Buffer, initialCrc = 0): number {
    let crc = (initialCrc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < data.length; i++) {
      crc = Crc32Codec.TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
}
