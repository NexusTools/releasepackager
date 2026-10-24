import { MsiFileEntry } from '../types/binary-types.js';

/**
 * Pure Node.js Microsoft Cabinet (`.cab`) archive writer (`MSCF`).
 * Packs installation files into a spec-compliant Cabinet stream for embedding inside `.msi` packages.
 */
export class CabArchiveWriter {
  private static readonly MAX_CHUNK_SIZE = 32768;

  /**
   * Builds a complete `.cab` binary buffer from a list of MSI file entries.
   */
  public static buildCabinet(files: MsiFileEntry[], mtime = new Date()): Buffer {
    const { dosDate, dosTime } = CabArchiveWriter.dateToDos(mtime);

    // Calculate CFFILE records and uncompressed folder stream
    const cfFileBuffers: Buffer[] = [];
    const uncompressedChunks: Buffer[] = [];
    let currentUncompressedOffset = 0;

    for (const file of files) {
      const nameBuf = Buffer.from(file.fileKey + '\0', 'utf8');
      const cfFile = Buffer.alloc(16 + nameBuf.length);
      cfFile.writeUInt32LE(file.data.length, 0); // cbFile
      cfFile.writeUInt32LE(currentUncompressedOffset, 4); // uoffFolderStart
      cfFile.writeUInt16LE(0, 8); // iFolder = 0
      cfFile.writeUInt16LE(dosDate, 10);
      cfFile.writeUInt16LE(dosTime, 12);
      cfFile.writeUInt16LE(0x20, 14); // _A_ARCH (Archive attribute)
      nameBuf.copy(cfFile, 16);

      cfFileBuffers.push(cfFile);
      uncompressedChunks.push(file.data);
      currentUncompressedOffset += file.data.length;
    }

    const fullUncompressed = Buffer.concat(uncompressedChunks);
    const cfDataBuffers: Buffer[] = [];

    for (let offset = 0; offset < fullUncompressed.length || (fullUncompressed.length === 0 && offset === 0); offset += CabArchiveWriter.MAX_CHUNK_SIZE) {
      const slice = fullUncompressed.subarray(
        offset,
        Math.min(fullUncompressed.length, offset + CabArchiveWriter.MAX_CHUNK_SIZE)
      );
      if (slice.length === 0 && fullUncompressed.length > 0) {
        break;
      }

      // Use tcompTYPE_NONE (0) for maximum compatibility and speed with zero external compression quirks
      const dataHeader = Buffer.alloc(8);
      dataHeader.writeUInt16LE(slice.length, 4); // cbData
      dataHeader.writeUInt16LE(slice.length, 6); // cbUncomp

      const payloadChecksum = CabArchiveWriter.computeCabChecksum(slice, 0);
      const fullChecksum = CabArchiveWriter.computeCabChecksum(
        dataHeader.subarray(4, 8),
        payloadChecksum
      );
      dataHeader.writeUInt32LE(fullChecksum >>> 0, 0); // csum

      cfDataBuffers.push(dataHeader, slice);
      if (fullUncompressed.length === 0) {
        break;
      }
    }

    const cfFilesConcat = Buffer.concat(cfFileBuffers);
    const cfDataConcat = Buffer.concat(cfDataBuffers);

    const coffFiles = 36 + 8; // CFHEADER (36) + 1 CFFOLDER (8)
    const coffCabStart = coffFiles + cfFilesConcat.length;
    const cbCabinet = coffCabStart + cfDataConcat.length;
    const numCfData = cfDataBuffers.length / 2;

    const cfHeader = Buffer.alloc(36, 0);
    cfHeader.write('MSCF', 0, 4, 'ascii');
    cfHeader.writeUInt32LE(0, 4); // reserved1
    cfHeader.writeUInt32LE(cbCabinet, 8); // cbCabinet
    cfHeader.writeUInt32LE(0, 12); // reserved2
    cfHeader.writeUInt32LE(coffFiles, 16); // coffFiles
    cfHeader.writeUInt32LE(0, 20); // reserved3
    cfHeader.writeUInt8(3, 24); // versionMinor = 3
    cfHeader.writeUInt8(1, 25); // versionMajor = 1
    cfHeader.writeUInt16LE(1, 26); // cFolders = 1
    cfHeader.writeUInt16LE(files.length, 28); // cFiles
    cfHeader.writeUInt16LE(0, 30); // flags = 0
    cfHeader.writeUInt16LE(1234, 32); // setID
    cfHeader.writeUInt16LE(0, 34); // iCabinet = 0

    const cfFolder = Buffer.alloc(8, 0);
    cfFolder.writeUInt32LE(coffCabStart, 0); // coffCabStart
    cfFolder.writeUInt16LE(numCfData, 4); // cCFData
    cfFolder.writeUInt16LE(0x0000, 6); // typeCompress = tcompTYPE_NONE (0)

    return Buffer.concat([cfHeader, cfFolder, cfFilesConcat, cfDataConcat]);
  }

  /**
   * Computes the MS-CAB `CHECKSUM` XOR-fold over a buffer.
   */
  public static computeCabChecksum(buf: Buffer, seed = 0): number {
    let csum = seed >>> 0;
    const fullWords = Math.floor(buf.length / 4);
    for (let i = 0; i < fullWords; i++) {
      csum = (csum ^ buf.readUInt32LE(i * 4)) >>> 0;
    }

    const rem = buf.length % 4;
    if (rem > 0) {
      let tail = 0;
      const base = fullWords * 4;
      for (let i = 0; i < rem; i++) {
        tail = ((tail << 8) | buf[base + i]) >>> 0;
      }
      csum = (csum ^ tail) >>> 0;
    }
    return csum >>> 0;
  }

  private static dateToDos(date: Date): { dosDate: number; dosTime: number } {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
    const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
    return { dosDate, dosTime };
  }
}
