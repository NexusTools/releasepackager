import { VirtualFileEntry } from '../types/binary-types.js';

interface CatalogNodeItem {
  parentCnid: number;
  nodeName: string;
  recordBuffer: Buffer;
}

/**
 * Pure Node.js Apple HFS+ (Mac OS Extended) volume image builder (`H+` / `0x482B`).
 * Creates a mountable HFS+ filesystem containing the `.app` bundle, POSIX permissions,
 * `/Applications` symbolic link for drag-and-drop installation, and `.DS_Store`.
 */
export class HfsPlusVolumeBuilder {
  private static readonly BLOCK_SIZE = 4096;
  private static readonly BTREE_NODE_SIZE = 8192;
  // Difference in seconds between HFS epoch (1904-01-01) and UNIX epoch (1970-01-01)
  private static readonly HFS_EPOCH_OFFSET = 2082844800;

  /**
   * Builds a complete raw HFS+ volume image Buffer from virtual file entries.
   */
  public static buildVolume(volumeName: string, entries: VirtualFileEntry[]): Buffer {
    const nowHfs = HfsPlusVolumeBuilder.dateToHfsTimestamp(new Date());

    // Ensure all intermediate directories exist and assign CNIDs
    // CNID 1 = Root Parent, CNID 2 = Root Folder (volumeName), CNID >= 16 = user items
    const dirCnidMap = new Map<string, number>();
    const dirChildrenCount = new Map<number, number>();
    dirCnidMap.set('', 2);
    dirChildrenCount.set(2, 0);

    let nextCnid = 16;

    const ensureDirectoryCnid = (relDirPath: string): number => {
      const clean = relDirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (dirCnidMap.has(clean)) {
        return dirCnidMap.get(clean)!;
      }
      const slashIdx = clean.lastIndexOf('/');
      const parentPath = slashIdx >= 0 ? clean.slice(0, slashIdx) : '';
      const parentCnid = ensureDirectoryCnid(parentPath);
      const cnid = nextCnid++;
      dirCnidMap.set(clean, cnid);
      dirChildrenCount.set(cnid, 0);
      dirChildrenCount.set(parentCnid, (dirChildrenCount.get(parentCnid) ?? 0) + 1);
      return cnid;
    };

    // Normalized entries
    const normalizedEntries: {
      cleanPath: string;
      name: string;
      parentCnid: number;
      cnid: number;
      entry: VirtualFileEntry;
    }[] = [];

    // First register all directories
    for (const e of entries) {
      const clean = e.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!clean) continue;
      if (e.isDirectory) {
        ensureDirectoryCnid(clean);
      } else {
        const slashIdx = clean.lastIndexOf('/');
        if (slashIdx >= 0) {
          ensureDirectoryCnid(clean.slice(0, slashIdx));
        }
      }
    }

    // Add any implicit directories to entries list so every directory has a Catalog Folder Record
    const allDirs = Array.from(dirCnidMap.entries())
      .filter(([p]) => p !== '')
      .sort((a, b) => a[0].localeCompare(b[0]));

    for (const [dirPath, cnid] of allDirs) {
      const slashIdx = dirPath.lastIndexOf('/');
      const parentPath = slashIdx >= 0 ? dirPath.slice(0, slashIdx) : '';
      const name = slashIdx >= 0 ? dirPath.slice(slashIdx + 1) : dirPath;
      const parentCnid = dirCnidMap.get(parentPath)!;

      normalizedEntries.push({
        cleanPath: dirPath,
        name,
        parentCnid,
        cnid,
        entry: {
          relativePath: dirPath,
          data: Buffer.alloc(0),
          isDirectory: true,
          isSymlink: false,
          mode: 0o040755,
          mtime: new Date()
        }
      });
    }

    // Add all non-directory files and symlinks
    const seenPaths = new Set<string>(allDirs.map(([p]) => p));
    for (const e of entries) {
      if (e.isDirectory) continue;
      const clean = e.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!clean || seenPaths.has(clean)) continue;
      seenPaths.add(clean);

      const slashIdx = clean.lastIndexOf('/');
      const parentPath = slashIdx >= 0 ? clean.slice(0, slashIdx) : '';
      const name = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
      const parentCnid = dirCnidMap.get(parentPath) ?? 2;
      const cnid = nextCnid++;
      dirChildrenCount.set(parentCnid, (dirChildrenCount.get(parentCnid) ?? 0) + 1);

      normalizedEntries.push({
        cleanPath: clean,
        name,
        parentCnid,
        cnid,
        entry: e
      });
    }

    // Allocate data blocks for file & symlink payloads
    // Block 0: Volume Header (bytes 1024..1535)
    // Block 1: Allocation File
    // Block 2..3: Extents Overflow B-Tree (2 blocks = 8192 bytes)
    // Block 4..N: Catalog B-Tree
    // Subsequent blocks: File data payloads
    // Final block: Alternate Volume Header
    const filePayloadChunks: Buffer[] = [];
    const entryBlockPlacement = new Map<number, { blockOffset: number; blockCount: number; logicalSize: number }>();
    let relativeDataBlocks = 0;

    for (const item of normalizedEntries) {
      if (item.entry.isDirectory) {
        continue;
      }
      const rawBytes = item.entry.isSymlink
        ? Buffer.from(item.entry.symlinkTarget ?? item.entry.data.toString('utf8'), 'utf8')
        : item.entry.data;

      if (rawBytes.length === 0) {
        entryBlockPlacement.set(item.cnid, { blockOffset: 0, blockCount: 0, logicalSize: 0 });
        continue;
      }

      const numBlocks = Math.ceil(rawBytes.length / HfsPlusVolumeBuilder.BLOCK_SIZE);
      const padded = Buffer.alloc(numBlocks * HfsPlusVolumeBuilder.BLOCK_SIZE, 0);
      rawBytes.copy(padded, 0);
      filePayloadChunks.push(padded);

      entryBlockPlacement.set(item.cnid, {
        blockOffset: relativeDataBlocks,
        blockCount: numBlocks,
        logicalSize: rawBytes.length
      });
      relativeDataBlocks += numBlocks;
    }

    // First pass to determine Catalog B-tree size so we know exact start block of file payloads
    const dummyCatalog = HfsPlusVolumeBuilder.buildCatalogBTree(
      volumeName,
      nowHfs,
      dirChildrenCount,
      normalizedEntries,
      entryBlockPlacement,
      0
    );
    const catalogBlocks = Math.ceil(dummyCatalog.length / HfsPlusVolumeBuilder.BLOCK_SIZE);
    const dataStartBlock = 1 + 1 + 2 + catalogBlocks; // Block 0 (VH) + Block 1 (Alloc) + 2 (Extents) + Catalog

    // Second pass with exact dataStartBlock
    const catalogBTreeRaw = HfsPlusVolumeBuilder.buildCatalogBTree(
      volumeName,
      nowHfs,
      dirChildrenCount,
      normalizedEntries,
      entryBlockPlacement,
      dataStartBlock
    );
    const catalogPadded = Buffer.alloc(catalogBlocks * HfsPlusVolumeBuilder.BLOCK_SIZE, 0);
    catalogBTreeRaw.copy(catalogPadded, 0);

    const extentsBTreePadded = HfsPlusVolumeBuilder.buildEmptyExtentsBTree(); // 8192 bytes (2 blocks)

    const totalBlocks = dataStartBlock + relativeDataBlocks + 1; // +1 for Alternate Volume Header block
    const usedBlocksBeforeEnd = totalBlocks - 1;

    // Build Allocation Bitmap (1 bit per block, MSB first)
    const allocFileBlock = Buffer.alloc(HfsPlusVolumeBuilder.BLOCK_SIZE, 0);
    for (let b = 0; b < totalBlocks; b++) {
      // Mark all blocks except nothing as allocated
      const byteIdx = b >> 3;
      const bitIdx = 7 - (b & 7);
      if (byteIdx < allocFileBlock.length) {
        allocFileBlock[byteIdx] |= 1 << bitIdx;
      }
    }

    const totalFiles = normalizedEntries.filter((e) => !e.entry.isDirectory).length;
    const totalFolders = normalizedEntries.filter((e) => e.entry.isDirectory).length;

    // Build Volume Header (512 bytes) placed at offset 1024 inside Block 0
    const vh = HfsPlusVolumeBuilder.buildVolumeHeader({
      nowHfs,
      fileCount: totalFiles,
      folderCount: totalFolders,
      blockSize: HfsPlusVolumeBuilder.BLOCK_SIZE,
      totalBlocks,
      freeBlocks: 0,
      nextCatalogId: nextCnid,
      allocStartBlock: 1,
      allocBlocks: 1,
      extentsStartBlock: 2,
      extentsBlocks: 2,
      catalogStartBlock: 4,
      catalogBlocks
    });

    const block0 = Buffer.alloc(HfsPlusVolumeBuilder.BLOCK_SIZE, 0);
    vh.copy(block0, 1024);

    // Final block contains Alternate Volume Header at 1024 bytes before end of volume
    const lastBlock = Buffer.alloc(HfsPlusVolumeBuilder.BLOCK_SIZE, 0);
    vh.copy(lastBlock, HfsPlusVolumeBuilder.BLOCK_SIZE - 1024);

    return Buffer.concat([
      block0,
      allocFileBlock,
      extentsBTreePadded,
      catalogPadded,
      ...filePayloadChunks,
      lastBlock
    ]);
  }

  private static buildVolumeHeader(opts: {
    nowHfs: number;
    fileCount: number;
    folderCount: number;
    blockSize: number;
    totalBlocks: number;
    freeBlocks: number;
    nextCatalogId: number;
    allocStartBlock: number;
    allocBlocks: number;
    extentsStartBlock: number;
    extentsBlocks: number;
    catalogStartBlock: number;
    catalogBlocks: number;
  }): Buffer {
    const vh = Buffer.alloc(512, 0);
    vh.write('H+', 0, 2, 'ascii'); // Signature 0x482B
    vh.writeUInt16BE(4, 2); // Version = 4 (HFS+)
    vh.writeUInt32BE(0x00000100, 4); // Attributes: kHFSVolumeUnmountedBit (bit 8)
    vh.write('HFSJ', 8, 4, 'ascii'); // lastMountedVersion
    vh.writeUInt32BE(0, 12); // journalInfoBlock
    vh.writeUInt32BE(opts.nowHfs, 16); // createDate
    vh.writeUInt32BE(opts.nowHfs, 20); // modifyDate
    vh.writeUInt32BE(0, 24); // backupDate
    vh.writeUInt32BE(opts.nowHfs, 28); // checkedDate
    vh.writeUInt32BE(opts.fileCount, 32); // fileCount
    vh.writeUInt32BE(opts.folderCount, 36); // folderCount
    vh.writeUInt32BE(opts.blockSize, 40); // blockSize
    vh.writeUInt32BE(opts.totalBlocks, 44); // totalBlocks
    vh.writeUInt32BE(opts.freeBlocks, 48); // freeBlocks
    vh.writeUInt32BE(opts.totalBlocks, 52); // nextAllocation
    vh.writeUInt32BE(opts.blockSize * 4, 56); // rsrcClumpSize
    vh.writeUInt32BE(opts.blockSize * 4, 60); // dataClumpSize
    vh.writeUInt32BE(opts.nextCatalogId, 64); // nextCatalogID
    vh.writeUInt32BE(1, 68); // writeCount
    vh.writeBigUInt64BE(1n, 72); // encodingsBitmap

    // allocationFile HFSPlusForkData at offset 112 (80 bytes)
    HfsPlusVolumeBuilder.writeForkData(
      vh,
      112,
      opts.allocBlocks * opts.blockSize,
      opts.allocBlocks,
      opts.allocStartBlock
    );

    // extentsFile HFSPlusForkData at offset 192 (80 bytes)
    HfsPlusVolumeBuilder.writeForkData(
      vh,
      192,
      opts.extentsBlocks * opts.blockSize,
      opts.extentsBlocks,
      opts.extentsStartBlock
    );

    // catalogFile HFSPlusForkData at offset 272 (80 bytes)
    HfsPlusVolumeBuilder.writeForkData(
      vh,
      272,
      opts.catalogBlocks * opts.blockSize,
      opts.catalogBlocks,
      opts.catalogStartBlock
    );

    return vh;
  }

  private static buildCatalogBTree(
    volumeName: string,
    nowHfs: number,
    dirChildrenCount: Map<number, number>,
    normalizedEntries: {
      cleanPath: string;
      name: string;
      parentCnid: number;
      cnid: number;
      entry: VirtualFileEntry;
    }[],
    entryBlockPlacement: Map<number, { blockOffset: number; blockCount: number; logicalSize: number }>,
    dataStartBlock: number
  ): Buffer {
    const items: CatalogNodeItem[] = [];

    // Root Folder Record (parentCnid = 1, name = volumeName, cnid = 2)
    items.push({
      parentCnid: 1,
      nodeName: volumeName,
      recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
        1,
        volumeName,
        HfsPlusVolumeBuilder.buildFolderPayload(
          2,
          dirChildrenCount.get(2) ?? 0,
          nowHfs,
          0o040755
        )
      )
    });

    // Root Folder Thread Record (parentCnid = 2, name = '')
    items.push({
      parentCnid: 2,
      nodeName: '',
      recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
        2,
        '',
        HfsPlusVolumeBuilder.buildThreadPayload(true, 1, volumeName)
      )
    });

    for (const item of normalizedEntries) {
      const mtimeHfs = HfsPlusVolumeBuilder.dateToHfsTimestamp(item.entry.mtime);
      if (item.entry.isDirectory) {
        items.push({
          parentCnid: item.parentCnid,
          nodeName: item.name,
          recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
            item.parentCnid,
            item.name,
            HfsPlusVolumeBuilder.buildFolderPayload(
              item.cnid,
              dirChildrenCount.get(item.cnid) ?? 0,
              mtimeHfs,
              0o040755
            )
          )
        });
        items.push({
          parentCnid: item.cnid,
          nodeName: '',
          recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
            item.cnid,
            '',
            HfsPlusVolumeBuilder.buildThreadPayload(true, item.parentCnid, item.name)
          )
        });
      } else {
        const placement = entryBlockPlacement.get(item.cnid) ?? {
          blockOffset: 0,
          blockCount: 0,
          logicalSize: 0
        };
        const absStartBlock =
          placement.blockCount > 0 ? dataStartBlock + placement.blockOffset : 0;

        items.push({
          parentCnid: item.parentCnid,
          nodeName: item.name,
          recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
            item.parentCnid,
            item.name,
            HfsPlusVolumeBuilder.buildFilePayload({
              cnid: item.cnid,
              mtimeHfs,
              mode: item.entry.isSymlink ? 0o120777 : item.entry.mode || 0o100644,
              isSymlink: item.entry.isSymlink,
              logicalSize: placement.logicalSize,
              startBlock: absStartBlock,
              blockCount: placement.blockCount
            })
          )
        });
        items.push({
          parentCnid: item.cnid,
          nodeName: '',
          recordBuffer: HfsPlusVolumeBuilder.buildCatalogRecord(
            item.cnid,
            '',
            HfsPlusVolumeBuilder.buildThreadPayload(false, item.parentCnid, item.name)
          )
        });
      }
    }

    // Sort catalog items by (parentCnid ASC, case-insensitive nodeName ASC) per HFS+ Catalog B-tree specification
    items.sort((a, b) => {
      if (a.parentCnid !== b.parentCnid) {
        return a.parentCnid - b.parentCnid;
      }
      return a.nodeName.toLowerCase().localeCompare(b.nodeName.toLowerCase());
    });

    // Pack items into 8192-byte Leaf Nodes
    const leafNodes: Buffer[] = [];
    let currentLeafRecords: Buffer[] = [];
    let currentLeafBytes = 14 + 2; // 14-byte BTNodeDescriptor + 2-byte free-space offset

    for (const item of items) {
      const recLen = item.recordBuffer.length;
      if (
        currentLeafRecords.length > 0 &&
        currentLeafBytes + recLen + 2 > HfsPlusVolumeBuilder.BTREE_NODE_SIZE
      ) {
        leafNodes.push(HfsPlusVolumeBuilder.serializeBTreeNode(-1, 1, currentLeafRecords));
        currentLeafRecords = [];
        currentLeafBytes = 14 + 2;
      }
      currentLeafRecords.push(item.recordBuffer);
      currentLeafBytes += recLen + 2;
    }
    if (currentLeafRecords.length > 0 || leafNodes.length === 0) {
      leafNodes.push(HfsPlusVolumeBuilder.serializeBTreeNode(-1, 1, currentLeafRecords));
    }

    // Link fLink and bLink across leaf nodes (Node 0 is Header Node, Leaf Nodes start at Node 1)
    for (let i = 0; i < leafNodes.length; i++) {
      const nodeNum = i + 1;
      const fLink = i < leafNodes.length - 1 ? nodeNum + 1 : 0;
      const bLink = i > 0 ? nodeNum - 1 : 0;
      leafNodes[i].writeUInt32BE(fLink, 0);
      leafNodes[i].writeUInt32BE(bLink, 4);
    }

    const totalNodes = 1 + leafNodes.length;
    const headerNode = HfsPlusVolumeBuilder.buildBTreeHeaderNode({
      treeDepth: 1,
      rootNode: 1,
      leafRecords: items.length,
      firstLeafNode: 1,
      lastLeafNode: leafNodes.length,
      nodeSize: HfsPlusVolumeBuilder.BTREE_NODE_SIZE,
      maxKeyLength: 516,
      totalNodes,
      freeNodes: 0
    });

    return Buffer.concat([headerNode, ...leafNodes]);
  }

  private static buildEmptyExtentsBTree(): Buffer {
    const headerNode = HfsPlusVolumeBuilder.buildBTreeHeaderNode({
      treeDepth: 0,
      rootNode: 0,
      leafRecords: 0,
      firstLeafNode: 0,
      lastLeafNode: 0,
      nodeSize: HfsPlusVolumeBuilder.BTREE_NODE_SIZE,
      maxKeyLength: 10,
      totalNodes: 1,
      freeNodes: 0
    });
    return headerNode;
  }

  private static buildBTreeHeaderNode(opts: {
    treeDepth: number;
    rootNode: number;
    leafRecords: number;
    firstLeafNode: number;
    lastLeafNode: number;
    nodeSize: number;
    maxKeyLength: number;
    totalNodes: number;
    freeNodes: number;
  }): Buffer {
    // Record 0: BTHeaderRec (106 bytes)
    const headerRec = Buffer.alloc(106, 0);
    headerRec.writeUInt16BE(opts.treeDepth, 0);
    headerRec.writeUInt32BE(opts.rootNode, 2);
    headerRec.writeUInt32BE(opts.leafRecords, 6);
    headerRec.writeUInt32BE(opts.firstLeafNode, 10);
    headerRec.writeUInt32BE(opts.lastLeafNode, 14);
    headerRec.writeUInt16BE(opts.nodeSize, 18);
    headerRec.writeUInt16BE(opts.maxKeyLength, 20);
    headerRec.writeUInt32BE(opts.totalNodes, 22);
    headerRec.writeUInt32BE(opts.freeNodes, 26);
    headerRec.writeUInt16BE(0, 30); // reserved1
    headerRec.writeUInt32BE(opts.nodeSize, 32); // clumpSize
    headerRec.writeUInt8(0, 36); // btreeType = kHFSBTreeType
    headerRec.writeUInt8(0xcf, 37); // keyCompareType = kHFSCaseFolding
    headerRec.writeUInt32BE(0x00000006, 38); // attributes: kBTBigKeysMask | kBTVariableIndexKeysMask

    // Record 1: User Data Record (128 bytes)
    const userDataRec = Buffer.alloc(128, 0);

    // Record 2: Map Record (256 bytes)
    const mapRec = Buffer.alloc(256, 0);
    for (let i = 0; i < opts.totalNodes; i++) {
      const byteIdx = i >> 3;
      const bitIdx = 7 - (i & 7);
      if (byteIdx < mapRec.length) {
        mapRec[byteIdx] |= 1 << bitIdx;
      }
    }

    return HfsPlusVolumeBuilder.serializeBTreeNode(1, 0, [headerRec, userDataRec, mapRec]);
  }

  private static serializeBTreeNode(
    kind: number,
    height: number,
    records: Buffer[]
  ): Buffer {
    const node = Buffer.alloc(HfsPlusVolumeBuilder.BTREE_NODE_SIZE, 0);
    node.writeUInt32BE(0, 0); // fLink
    node.writeUInt32BE(0, 4); // bLink
    node.writeInt8(kind, 8); // kind (1 = header, -1 = leaf)
    node.writeUInt8(height, 9); // height
    node.writeUInt16BE(records.length, 10); // numRecords
    node.writeUInt16BE(0, 12); // reserved

    let offset = 14;
    const offsets: number[] = [];
    for (const rec of records) {
      offsets.push(offset);
      rec.copy(node, offset);
      offset += rec.length;
    }
    offsets.push(offset); // Free space offset

    // Write offset table at end of node in reverse order
    for (let i = 0; i < offsets.length; i++) {
      const offPos = HfsPlusVolumeBuilder.BTREE_NODE_SIZE - (i + 1) * 2;
      node.writeUInt16BE(offsets[i], offPos);
    }

    return node;
  }

  private static buildCatalogRecord(
    parentCnid: number,
    name: string,
    payload: Buffer
  ): Buffer {
    const nameUtf16Be = HfsPlusVolumeBuilder.encodeUtf16Be(name);
    const keyLength = 6 + nameUtf16Be.length;
    const keyBuf = Buffer.alloc(2 + keyLength, 0);
    keyBuf.writeUInt16BE(keyLength, 0);
    keyBuf.writeUInt32BE(parentCnid, 2);
    keyBuf.writeUInt16BE(name.length, 6);
    nameUtf16Be.copy(keyBuf, 8);

    // Align payload start to 2-byte boundary
    const padKey = keyBuf.length % 2 !== 0 ? Buffer.from([0]) : Buffer.alloc(0);
    const combined = Buffer.concat([keyBuf, padKey, payload]);
    if (combined.length % 2 !== 0) {
      return Buffer.concat([combined, Buffer.from([0])]);
    }
    return combined;
  }

  private static buildFolderPayload(
    folderId: number,
    valence: number,
    timestampHfs: number,
    mode: number
  ): Buffer {
    // HFSPlusCatalogFolder = 88 bytes
    const buf = Buffer.alloc(88, 0);
    buf.writeInt16BE(0x0001, 0); // recordType = kHFSPlusFolderRecord
    buf.writeUInt16BE(0, 2); // flags
    buf.writeUInt32BE(valence, 4); // valence
    buf.writeUInt32BE(folderId, 8); // folderID
    buf.writeUInt32BE(timestampHfs, 12); // createDate
    buf.writeUInt32BE(timestampHfs, 16); // contentModDate
    buf.writeUInt32BE(timestampHfs, 20); // attributeModDate
    buf.writeUInt32BE(timestampHfs, 24); // accessDate
    buf.writeUInt32BE(0, 28); // backupDate
    // BSDInfo (16 bytes at offset 32)
    buf.writeUInt32BE(0, 32); // ownerID
    buf.writeUInt32BE(0, 36); // groupID
    buf.writeUInt8(0, 40); // adminFlags
    buf.writeUInt8(0, 41); // ownerFlags
    buf.writeUInt16BE(mode, 42); // fileMode
    buf.writeUInt32BE(0, 44); // special
    return buf;
  }

  private static buildFilePayload(opts: {
    cnid: number;
    mtimeHfs: number;
    mode: number;
    isSymlink: boolean;
    logicalSize: number;
    startBlock: number;
    blockCount: number;
  }): Buffer {
    // HFSPlusCatalogFile = 248 bytes
    const buf = Buffer.alloc(248, 0);
    buf.writeInt16BE(0x0002, 0); // recordType = kHFSPlusFileRecord
    buf.writeUInt16BE(0x0002, 2); // flags = kHFSThreadExistsMask
    buf.writeUInt32BE(0, 4); // reserved1
    buf.writeUInt32BE(opts.cnid, 8); // fileID
    buf.writeUInt32BE(opts.mtimeHfs, 12); // createDate
    buf.writeUInt32BE(opts.mtimeHfs, 16); // contentModDate
    buf.writeUInt32BE(opts.mtimeHfs, 20); // attributeModDate
    buf.writeUInt32BE(opts.mtimeHfs, 24); // accessDate
    buf.writeUInt32BE(0, 28); // backupDate
    // BSDInfo (16 bytes at offset 32)
    buf.writeUInt32BE(0, 32); // ownerID
    buf.writeUInt32BE(0, 36); // groupID
    buf.writeUInt8(0, 40); // adminFlags
    buf.writeUInt8(0, 41); // ownerFlags
    buf.writeUInt16BE(opts.mode, 42); // fileMode
    buf.writeUInt32BE(1, 44); // linkCount = 1

    if (opts.isSymlink) {
      // Finder FileInfo for symbolic links: fileType = 'slnk', fileCreator = 'rhap'
      buf.write('slnk', 48, 4, 'ascii');
      buf.write('rhap', 52, 4, 'ascii');
    }

    // dataFork HFSPlusForkData at offset 88 (80 bytes)
    HfsPlusVolumeBuilder.writeForkData(
      buf,
      88,
      opts.logicalSize,
      opts.blockCount,
      opts.startBlock
    );

    return buf;
  }

  private static buildThreadPayload(
    isFolder: boolean,
    parentCnid: number,
    nodeName: string
  ): Buffer {
    const nameUtf16Be = HfsPlusVolumeBuilder.encodeUtf16Be(nodeName);
    const buf = Buffer.alloc(10 + nameUtf16Be.length, 0);
    buf.writeInt16BE(isFolder ? 0x0003 : 0x0004, 0);
    buf.writeInt16BE(0, 2); // reserved
    buf.writeUInt32BE(parentCnid, 4);
    buf.writeUInt16BE(nodeName.length, 8);
    nameUtf16Be.copy(buf, 10);
    return buf;
  }

  private static writeForkData(
    target: Buffer,
    offset: number,
    logicalSize: number,
    totalBlocks: number,
    startBlock: number
  ): void {
    target.writeBigUInt64BE(BigInt(logicalSize), offset);
    target.writeUInt32BE(0, offset + 8); // clumpSize
    target.writeUInt32BE(totalBlocks, offset + 12); // totalBlocks
    // Extent 0: startBlock, blockCount
    target.writeUInt32BE(totalBlocks > 0 ? startBlock : 0, offset + 16);
    target.writeUInt32BE(totalBlocks, offset + 20);
  }

  private static dateToHfsTimestamp(date: Date): number {
    return (Math.floor(date.getTime() / 1000) + HfsPlusVolumeBuilder.HFS_EPOCH_OFFSET) >>> 0;
  }

  private static encodeUtf16Be(str: string): Buffer {
    const le = Buffer.from(str, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    return be;
  }
}
