import * as zlib from 'node:zlib';
import { Crc32Codec } from './crc32-codec.js';

/**
 * Pure Node.js Apple Universal Disk Image Format (`.dmg`) writer.
 * Compresses an HFS+ volume image into zlib-compressed `blkx` chunks (`0x80000005`),
 * builds the `Mish` block descriptor table and XML property list, and appends the
 * 512-byte `koly` UDIF trailer.
 */
export class UdifDmgWriter {
  private static readonly SECTOR_SIZE = 512;
  private static readonly CHUNK_SECTORS = 2048; // 1 MB per compressed chunk

  /**
   * Encapsulates a raw HFS+ partition buffer into a compressed, mountable `.dmg` disk image.
   */
  public static buildDmgFromHfsVolume(hfsVolume: Buffer, volumeName = 'Disk Image'): Buffer {
    const totalSectors = Math.ceil(hfsVolume.length / UdifDmgWriter.SECTOR_SIZE);
    const paddedVolume =
      hfsVolume.length === totalSectors * UdifDmgWriter.SECTOR_SIZE
        ? hfsVolume
        : Buffer.concat([
            hfsVolume,
            Buffer.alloc(totalSectors * UdifDmgWriter.SECTOR_SIZE - hfsVolume.length, 0)
          ]);

    const compressedChunks: Buffer[] = [];
    const blkxEntries: {
      entryType: number;
      sectorNumber: number;
      sectorCount: number;
      compressedOffset: number;
      compressedLength: number;
    }[] = [];

    let currentCompressedOffset = 0;
    for (let sector = 0; sector < totalSectors; sector += UdifDmgWriter.CHUNK_SECTORS) {
      const count = Math.min(UdifDmgWriter.CHUNK_SECTORS, totalSectors - sector);
      const byteStart = sector * UdifDmgWriter.SECTOR_SIZE;
      const byteEnd = (sector + count) * UdifDmgWriter.SECTOR_SIZE;
      const slice = paddedVolume.subarray(byteStart, byteEnd);

      const isAllZero = slice.every((b) => b === 0);
      if (isAllZero) {
        blkxEntries.push({
          entryType: 0x00000002, // BT_ZERO (Zero-fill run)
          sectorNumber: sector,
          sectorCount: count,
          compressedOffset: currentCompressedOffset,
          compressedLength: 0
        });
      } else {
        const deflated = zlib.deflateSync(slice, { level: 6 });
        compressedChunks.push(deflated);
        blkxEntries.push({
          entryType: 0x80000005, // BT_ZLIB (Zlib-compressed run)
          sectorNumber: sector,
          sectorCount: count,
          compressedOffset: currentCompressedOffset,
          compressedLength: deflated.length
        });
        currentCompressedOffset += deflated.length;
      }
    }

    // Add terminator run (0xFFFFFFFF)
    blkxEntries.push({
      entryType: 0xffffffff,
      sectorNumber: totalSectors,
      sectorCount: 0,
      compressedOffset: currentCompressedOffset,
      compressedLength: 0
    });

    const dataFork = Buffer.concat(compressedChunks);
    const dataForkCrc = Crc32Codec.compute(dataFork);

    // Build Mish block descriptor structure (204-byte header + 40 bytes per blkx entry)
    const mish = Buffer.alloc(204 + blkxEntries.length * 40, 0);
    mish.write('mish', 0, 4, 'ascii'); // Signature
    mish.writeUInt32BE(1, 4); // Version = 1
    mish.writeBigUInt64BE(0n, 8); // First sector number
    mish.writeBigUInt64BE(BigInt(totalSectors), 16); // Sector count
    mish.writeBigUInt64BE(0n, 24); // Data offset
    mish.writeUInt32BE(UdifDmgWriter.CHUNK_SECTORS, 32); // Buffers needed
    mish.writeUInt32BE(0, 36); // Block descriptors = 0
    // Checksum structure at offset 64: type = 2 (CRC32), bitSize = 32, data[0] = dataForkCrc
    mish.writeUInt32BE(2, 64);
    mish.writeUInt32BE(32, 68);
    mish.writeUInt32BE(dataForkCrc, 72);
    mish.writeUInt32BE(blkxEntries.length, 200); // Number of block chunks

    for (let i = 0; i < blkxEntries.length; i++) {
      const e = blkxEntries[i];
      const off = 204 + i * 40;
      mish.writeUInt32BE(e.entryType >>> 0, off);
      mish.writeUInt32BE(0, off + 4); // Comment
      mish.writeBigUInt64BE(BigInt(e.sectorNumber), off + 8);
      mish.writeBigUInt64BE(BigInt(e.sectorCount), off + 16);
      mish.writeBigUInt64BE(BigInt(e.compressedOffset), off + 24);
      mish.writeBigUInt64BE(BigInt(e.compressedLength), off + 32);
    }

    const mishBase64 = mish.toString('base64');
    const safeVolName = volumeName
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const xmlPlist = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>resource-fork</key>',
        '  <dict>',
        '    <key>blkx</key>',
        '    <array>',
        '      <dict>',
        '        <key>Attributes</key>',
        '        <string>0x0050</string>',
        '        <key>CFName</key>',
        `        <string>${safeVolName} (Apple_HFS : 0)</string>`,
        '        <key>Data</key>',
        `        <data>${mishBase64}</data>`,
        '        <key>ID</key>',
        '        <string>-1</string>',
        '        <key>Name</key>',
        `        <string>${safeVolName} (Apple_HFS : 0)</string>`,
        '      </dict>',
        '    </array>',
        '  </dict>',
        '</dict>',
        '</plist>\n'
      ].join('\n'),
      'utf8'
    );

    // Build 512-byte koly trailer
    const koly = Buffer.alloc(512, 0);
    koly.write('koly', 0, 4, 'ascii'); // Signature 0x6B6F6C79
    koly.writeUInt32BE(4, 4); // Version = 4
    koly.writeUInt32BE(512, 8); // HeaderSize = 512
    koly.writeUInt32BE(1, 12); // Flags = 1 (flattened)
    koly.writeBigUInt64BE(0n, 16); // RunningDataForkOffset
    koly.writeBigUInt64BE(0n, 24); // DataForkOffset = 0
    koly.writeBigUInt64BE(BigInt(dataFork.length), 32); // DataForkLength
    koly.writeBigUInt64BE(0n, 40); // RsrcForkOffset
    koly.writeBigUInt64BE(0n, 48); // RsrcForkLength
    koly.writeUInt32BE(1, 56); // SegmentNumber = 1
    koly.writeUInt32BE(1, 60); // SegmentCount = 1
    // DataForkChecksum at offset 80
    koly.writeUInt32BE(2, 80); // Type 2 = CRC32
    koly.writeUInt32BE(32, 84); // 32 bits
    koly.writeUInt32BE(dataForkCrc, 88);
    // XMLOffset and XMLLength at offsets 216 and 224
    koly.writeBigUInt64BE(BigInt(dataFork.length), 216);
    koly.writeBigUInt64BE(BigInt(xmlPlist.length), 224);
    // MasterChecksum at offset 352
    const mishCrc = Crc32Codec.compute(mish.subarray(200));
    koly.writeUInt32BE(2, 352);
    koly.writeUInt32BE(32, 356);
    koly.writeUInt32BE(mishCrc, 360);
    // ImageVariant = 1 (UDIF device image) at offset 488
    koly.writeUInt32BE(1, 488);
    // SectorCount at offset 492
    koly.writeBigUInt64BE(BigInt(totalSectors), 492);

    return Buffer.concat([dataFork, xmlPlist, koly]);
  }
}
