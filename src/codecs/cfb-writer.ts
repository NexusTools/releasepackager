/**
 * Pure Node.js Microsoft Compound File Binary Format (CFBF / OLE2 Structured Storage) writer.
 * Implements the MS-CFB specification (512-byte sectors, FAT, MiniFAT, DIFAT, and Red-Black
 * Directory Tree) required by Windows Installer `.msi` databases.
 */
export class CfbWriter {
  private static readonly SECTOR_SIZE = 512;
  private static readonly MINI_SECTOR_SIZE = 64;
  private static readonly MINI_STREAM_CUTOFF = 4096;
  private static readonly ENDOFCHAIN = 0xfffffffe;
  private static readonly FREESECT = 0xffffffff;
  private static readonly FATSECT = 0xfffffffd;
  private static readonly DIFSECT = 0xfffffffc;

  // Windows Installer Database Storage CLSID: {000C1084-0000-0000-C000-000000000046}
  private static readonly MSI_STORAGE_CLSID = Buffer.from([
    0x84, 0x10, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46
  ]);

  private readonly streams: { name: string; data: Buffer }[] = [];

  /**
   * Adds a named binary stream to the root storage of the Compound File.
   */
  public addStream(name: string, data: Buffer): void {
    this.streams.push({ name, data });
  }

  /**
   * Serializes the Compound File Binary Format container into a Buffer.
   */
  public toBuffer(): Buffer {
    // Sort streams according to MS-CFB red-black tree ordering:
    // 1. Shorter name length first
    // 2. Upper-case code-point comparison
    const sortedStreams = [...this.streams].sort((a, b) => CfbWriter.compareStreamNames(a.name, b.name));

    const miniStreams = sortedStreams.filter(
      (s) => s.data.length > 0 && s.data.length < CfbWriter.MINI_STREAM_CUTOFF
    );

    // Build MiniStream and MiniFAT
    const miniStreamChunks: Buffer[] = [];
    const miniFatEntries: number[] = [];
    const streamStartMiniSector = new Map<string, number>();

    for (const ms of miniStreams) {
      const startMiniSec = miniFatEntries.length;
      streamStartMiniSector.set(ms.name, startMiniSec);
      const numMiniSectors = Math.ceil(ms.data.length / CfbWriter.MINI_SECTOR_SIZE);
      const padded = CfbWriter.padBuffer(ms.data, numMiniSectors * CfbWriter.MINI_SECTOR_SIZE);
      miniStreamChunks.push(padded);

      for (let i = 0; i < numMiniSectors; i++) {
        miniFatEntries.push(
          i === numMiniSectors - 1 ? CfbWriter.ENDOFCHAIN : startMiniSec + i + 1
        );
      }
    }

    const miniStreamRaw = Buffer.concat(miniStreamChunks);
    const miniStreamPadded = CfbWriter.padBuffer(
      miniStreamRaw,
      Math.ceil(miniStreamRaw.length / CfbWriter.SECTOR_SIZE) * CfbWriter.SECTOR_SIZE
    );

    const miniFatRaw = Buffer.alloc(miniFatEntries.length * 4);
    for (let i = 0; i < miniFatEntries.length; i++) {
      miniFatRaw.writeUInt32LE(miniFatEntries[i] >>> 0, i * 4);
    }
    const numMiniFatSectors = Math.ceil(miniFatRaw.length / CfbWriter.SECTOR_SIZE);
    const miniFatPadded = CfbWriter.padBuffer(
      miniFatRaw,
      numMiniFatSectors * CfbWriter.SECTOR_SIZE
    );

    // Prepare regular sector chains
    const sectorBlocks: Buffer[] = [];
    const fat: number[] = [];

    const allocateChain = (paddedBuf: Buffer): number => {
      if (paddedBuf.length === 0) {
        return CfbWriter.ENDOFCHAIN;
      }
      const count = paddedBuf.length / CfbWriter.SECTOR_SIZE;
      const firstSec = sectorBlocks.length;
      for (let i = 0; i < count; i++) {
        sectorBlocks.push(
          paddedBuf.subarray(i * CfbWriter.SECTOR_SIZE, (i + 1) * CfbWriter.SECTOR_SIZE)
        );
        fat.push(i === count - 1 ? CfbWriter.ENDOFCHAIN : firstSec + i + 1);
      }
      return firstSec;
    };

    // 1. Allocate MiniStream sectors (owned by Root Entry)
    const miniStreamFirstSector = allocateChain(miniStreamPadded);

    // 2. Allocate MiniFAT sectors
    const miniFatFirstSector = allocateChain(miniFatPadded);

    // 3. Allocate regular streams (>= 4096 bytes)
    const streamFirstSector = new Map<string, number>();
    for (const s of sortedStreams) {
      if (s.data.length === 0) {
        streamFirstSector.set(s.name, CfbWriter.ENDOFCHAIN);
      } else if (s.data.length < CfbWriter.MINI_STREAM_CUTOFF) {
        streamFirstSector.set(s.name, streamStartMiniSector.get(s.name) ?? CfbWriter.ENDOFCHAIN);
      } else {
        const numSec = Math.ceil(s.data.length / CfbWriter.SECTOR_SIZE);
        const padded = CfbWriter.padBuffer(s.data, numSec * CfbWriter.SECTOR_SIZE);
        streamFirstSector.set(s.name, allocateChain(padded));
      }
    }

    // 4. Build Directory Entries (Root Entry + sortedStreams)
    const totalDirEntries = 1 + sortedStreams.length;
    const numDirSectors = Math.ceil((totalDirEntries * 128) / CfbWriter.SECTOR_SIZE);
    const totalDirSlots = numDirSectors * 4;
    const dirBuffer = Buffer.alloc(totalDirSlots * 128, 0);

    // Build balanced BST child links over sortedStreams indices [0 .. sortedStreams.length - 1]
    // Directory entry 0 is Root Entry; stream i is at directory index (i + 1).
    const buildTree = (low: number, high: number, depth: number): number => {
      if (low > high) {
        return 0xffffffff;
      }
      const mid = (low + high) >> 1;
      const dirIdx = mid + 1;
      const leftChild = buildTree(low, mid - 1, depth + 1);
      const rightChild = buildTree(mid + 1, high, depth + 1);

      const s = sortedStreams[mid];
      CfbWriter.writeDirectoryEntry(dirBuffer, dirIdx * 128, {
        name: s.name,
        objectType: 2, // Stream Object
        colorFlag: depth % 2 === 1 ? 0 : 1, // Alternate red/black by level
        leftSiblingId: leftChild,
        rightSiblingId: rightChild,
        childId: 0xffffffff,
        clsid: Buffer.alloc(16, 0),
        startingSectorLocation: streamFirstSector.get(s.name) ?? CfbWriter.ENDOFCHAIN,
        streamSize: s.data.length
      });

      return dirIdx;
    };

    const rootChildId = buildTree(0, sortedStreams.length - 1, 0);

    // Write Root Entry at index 0
    CfbWriter.writeDirectoryEntry(dirBuffer, 0, {
      name: 'Root Entry',
      objectType: 5, // Root Storage Object
      colorFlag: 1, // Black
      leftSiblingId: 0xffffffff,
      rightSiblingId: 0xffffffff,
      childId: rootChildId,
      clsid: CfbWriter.MSI_STORAGE_CLSID,
      startingSectorLocation: miniStreamFirstSector,
      streamSize: miniStreamRaw.length
    });

    // Mark unused directory slots with left/right/child = 0xffffffff
    for (let slot = totalDirEntries; slot < totalDirSlots; slot++) {
      const off = slot * 128;
      dirBuffer.writeUInt32LE(0xffffffff, off + 68);
      dirBuffer.writeUInt32LE(0xffffffff, off + 72);
      dirBuffer.writeUInt32LE(0xffffffff, off + 76);
    }

    const dirFirstSector = allocateChain(dirBuffer);

    // 5. Calculate FAT and DIFAT sectors needed
    const entriesPerFatSector = CfbWriter.SECTOR_SIZE / 4; // 128
    const difatEntriesPerSector = CfbWriter.SECTOR_SIZE / 4 - 1; // 127
    let numFatSectors = 1;
    let numDifatSectors = 0;

    while (true) {
      const totalSectors = sectorBlocks.length + numFatSectors + numDifatSectors;
      const requiredFatSectors = Math.ceil(totalSectors / entriesPerFatSector);
      const requiredDifatSectors =
        requiredFatSectors > 109
          ? Math.ceil((requiredFatSectors - 109) / difatEntriesPerSector)
          : 0;
      if (requiredFatSectors === numFatSectors && requiredDifatSectors === numDifatSectors) {
        break;
      }
      numFatSectors = requiredFatSectors;
      numDifatSectors = requiredDifatSectors;
    }

    const fatSectorNumbers: number[] = [];
    for (let i = 0; i < numFatSectors; i++) {
      const secNum = sectorBlocks.length + i;
      fatSectorNumbers.push(secNum);
      fat.push(CfbWriter.FATSECT);
    }

    const difatSectorNumbers: number[] = [];
    for (let i = 0; i < numDifatSectors; i++) {
      const secNum = sectorBlocks.length + numFatSectors + i;
      difatSectorNumbers.push(secNum);
      fat.push(CfbWriter.DIFSECT);
    }

    // Serialize FAT sectors
    const totalFatSlots = numFatSectors * entriesPerFatSector;
    const fatBuffer = Buffer.alloc(totalFatSlots * 4, 0xff);
    for (let i = 0; i < fat.length; i++) {
      fatBuffer.writeUInt32LE(fat[i] >>> 0, i * 4);
    }
    for (let i = 0; i < numFatSectors; i++) {
      sectorBlocks.push(
        fatBuffer.subarray(i * CfbWriter.SECTOR_SIZE, (i + 1) * CfbWriter.SECTOR_SIZE)
      );
    }

    // Serialize extra DIFAT sectors if numFatSectors > 109
    for (let i = 0; i < numDifatSectors; i++) {
      const difatSec = Buffer.alloc(CfbWriter.SECTOR_SIZE, 0xff);
      const startIdx = 109 + i * difatEntriesPerSector;
      for (let j = 0; j < difatEntriesPerSector; j++) {
        const fatIdx = startIdx + j;
        if (fatIdx < fatSectorNumbers.length) {
          difatSec.writeUInt32LE(fatSectorNumbers[fatIdx], j * 4);
        }
      }
      const nextDifat =
        i === numDifatSectors - 1 ? CfbWriter.ENDOFCHAIN : difatSectorNumbers[i + 1];
      difatSec.writeUInt32LE(nextDifat >>> 0, 508);
      sectorBlocks.push(difatSec);
    }

    // 6. Build 512-byte CFB Header
    const header = Buffer.alloc(CfbWriter.SECTOR_SIZE, 0);
    // Signature: D0 CF 11 E0 A1 B1 1A E1
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
    header.writeUInt16LE(0x003e, 24); // Minor Version 62
    header.writeUInt16LE(0x0003, 26); // Major Version 3 (512-byte sectors)
    header.writeUInt16LE(0xfffe, 28); // Little-endian byte order
    header.writeUInt16LE(9, 30); // Sector Shift = 9 (2^9 = 512)
    header.writeUInt16LE(6, 32); // Mini Sector Shift = 6 (2^6 = 64)
    header.writeUInt32LE(0, 40); // Number of Directory Sectors (0 for v3)
    header.writeUInt32LE(numFatSectors, 44);
    header.writeUInt32LE(dirFirstSector >>> 0, 48);
    header.writeUInt32LE(0, 52); // Transaction Signature
    header.writeUInt32LE(CfbWriter.MINI_STREAM_CUTOFF, 56);
    header.writeUInt32LE(miniFatFirstSector >>> 0, 60);
    header.writeUInt32LE(numMiniFatSectors, 64);
    header.writeUInt32LE(
      (difatSectorNumbers.length > 0 ? difatSectorNumbers[0] : CfbWriter.ENDOFCHAIN) >>> 0,
      68
    );
    header.writeUInt32LE(numDifatSectors, 72);

    // Fill header DIFAT array (109 entries starting at offset 76)
    for (let i = 0; i < 109; i++) {
      const sec = i < fatSectorNumbers.length ? fatSectorNumbers[i] : CfbWriter.FREESECT;
      header.writeUInt32LE(sec >>> 0, 76 + i * 4);
    }

    return Buffer.concat([header, ...sectorBlocks]);
  }

  private static writeDirectoryEntry(
    buf: Buffer,
    offset: number,
    entry: {
      name: string;
      objectType: number;
      colorFlag: number;
      leftSiblingId: number;
      rightSiblingId: number;
      childId: number;
      clsid: Buffer;
      startingSectorLocation: number;
      streamSize: number;
    }
  ): void {
    const nameUtf16 = Buffer.from(entry.name + '\0', 'utf16le');
    const nameLen = Math.min(64, nameUtf16.length);
    nameUtf16.copy(buf, offset, 0, nameLen);
    buf.writeUInt16LE(nameLen, offset + 64);
    buf.writeUInt8(entry.objectType, offset + 66);
    buf.writeUInt8(entry.colorFlag, offset + 67);
    buf.writeUInt32LE(entry.leftSiblingId >>> 0, offset + 68);
    buf.writeUInt32LE(entry.rightSiblingId >>> 0, offset + 72);
    buf.writeUInt32LE(entry.childId >>> 0, offset + 76);
    entry.clsid.copy(buf, offset + 80, 0, 16);
    buf.writeUInt32LE(entry.startingSectorLocation >>> 0, offset + 116);
    buf.writeBigUInt64LE(BigInt(entry.streamSize), offset + 120);
  }

  private static compareStreamNames(a: string, b: string): number {
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    const upperA = a.toUpperCase();
    const upperB = b.toUpperCase();
    for (let i = 0; i < upperA.length; i++) {
      const diff = upperA.charCodeAt(i) - upperB.charCodeAt(i);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }

  private static padBuffer(buf: Buffer, targetLength: number): Buffer {
    if (buf.length === targetLength) {
      return buf;
    }
    const out = Buffer.alloc(targetLength, 0);
    buf.copy(out, 0);
    return out;
  }
}
