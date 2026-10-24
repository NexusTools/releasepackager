/**
 * Pure Node.js macOS Finder `.DS_Store` (`Bud1` Buddy Allocator + `DSDB` B-Tree) generator.
 * Configures the mounted DMG window in Icon View (`icnv`) with `<AppName>.app` positioned on the
 * left and the `Applications` symlink positioned on the right for drag-and-drop installation.
 */
export class DsStoreBuilder {
  /**
   * Builds a binary `.DS_Store` file buffer for the DMG root folder.
   */
  public static buildDmgDsStore(
    appBundleName: string,
    backgroundRelPath = '.background/background.png'
  ): Buffer {
    const icvpPlist = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
        `<plist version="1.0"><dict>` +
        `<key>backgroundType</key><integer>2</integer>` +
        `<key>backgroundImagePath</key><string>${backgroundRelPath}</string>` +
        `<key>iconSize</key><real>80</real>` +
        `<key>gridSpacing</key><real>100</real>` +
        `<key>textSize</key><real>13</real>` +
        `<key>showIconPreview</key><true/>` +
        `</dict></plist>`,
      'utf8'
    );

    const bwspPlist = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
        `<plist version="1.0"><dict>` +
        `<key>WindowBounds</key><string>{{200, 120}, {600, 400}}</string>` +
        `<key>ShowToolbar</key><false/>` +
        `<key>ShowSidebar</key><false/>` +
        `<key>ShowStatusBar</key><false/>` +
        `<key>ShowPathbar</key><false/>` +
        `</dict></plist>`,
      'utf8'
    );

    const records: { filename: string; code: string; type: string; data: Buffer }[] = [
      {
        filename: '.',
        code: 'bwsp',
        type: 'blob',
        data: bwspPlist
      },
      {
        filename: '.',
        code: 'icvp',
        type: 'blob',
        data: icvpPlist
      },
      {
        filename: '.',
        code: 'vstl',
        type: 'type',
        data: Buffer.from('icnv', 'ascii')
      },
      {
        filename: '.background',
        code: 'Iloc',
        type: 'blob',
        data: DsStoreBuilder.encodeIloc(160, 680)
      },
      {
        filename: appBundleName,
        code: 'Iloc',
        type: 'blob',
        data: DsStoreBuilder.encodeIloc(160, 200)
      },
      {
        filename: 'Applications',
        code: 'Iloc',
        type: 'blob',
        data: DsStoreBuilder.encodeIloc(440, 200)
      }
    ];

    records.sort((a, b) => {
      const cmp = a.filename.toLowerCase().localeCompare(b.filename.toLowerCase());
      return cmp !== 0 ? cmp : a.code.localeCompare(b.code);
    });

    const serializedRecords = records.map((r) => {
      const nameUtf16Be = DsStoreBuilder.encodeUtf16Be(r.filename);
      const charLen = r.filename.length;
      const header = Buffer.alloc(4 + nameUtf16Be.length + 8);
      header.writeUInt32BE(charLen, 0);
      nameUtf16Be.copy(header, 4);
      header.write(r.code, 4 + nameUtf16Be.length, 4, 'ascii');
      header.write(r.type, 4 + nameUtf16Be.length + 4, 4, 'ascii');

      if (r.type === 'blob') {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(r.data.length, 0);
        return Buffer.concat([header, lenBuf, r.data]);
      }
      return Buffer.concat([header, r.data]);
    });

    // Build leaf B-tree node (4096 bytes) at offset 0x1000 (after 4-byte prelude + 4092-byte block)
    const leafNode = Buffer.alloc(4096, 0);
    leafNode.writeUInt32BE(0, 0); // P = 0 (leaf node)
    leafNode.writeUInt32BE(serializedRecords.length, 4); // Record count
    let recOffset = 8;
    for (const sr of serializedRecords) {
      sr.copy(leafNode, recOffset);
      recOffset += sr.length;
    }

    // Build DSDB superblock (32 bytes) at offset 0x0040
    const dsdb = Buffer.alloc(32, 0);
    dsdb.writeUInt32BE(1, 0); // Root block number = 1
    dsdb.writeUInt32BE(0, 4); // Tree height = 0 (single leaf node)
    dsdb.writeUInt32BE(serializedRecords.length, 8); // Record count
    dsdb.writeUInt32BE(1, 12); // Node count = 1
    dsdb.writeUInt32BE(4096, 16); // Page size = 4096

    // Build Buddy Allocator directory block at offset 0x0800
    const tocBlock = Buffer.alloc(2048, 0);
    // 2 allocated blocks:
    // Block 0: offset 0x0040, size 32 (2^5 => 0x00000045)
    // Block 1: offset 0x1000, size 4096 (2^12 => 0x0000100c)
    // Block 2: offset 0x0800, size 2048 (2^11 => 0x0000080b)
    tocBlock.writeUInt32BE(3, 0); // Offset count = 3
    tocBlock.writeUInt32BE(0, 4); // Unknown = 0
    tocBlock.writeUInt32BE(0x00000045, 8); // Block 0 (DSDB)
    tocBlock.writeUInt32BE(0x0000100c, 12); // Block 1 (Root Leaf Node)
    tocBlock.writeUInt32BE(0x0000080b, 16); // Block 2 (TOC itself)

    // TOC directory entry for 'DSDB' -> Block 0
    const tocOffset = 8 + 256 * 4;
    tocBlock.writeUInt32BE(1, tocOffset); // 1 TOC entry
    tocBlock.writeUInt8(4, tocOffset + 4);
    tocBlock.write('DSDB', tocOffset + 5, 4, 'ascii');
    tocBlock.writeUInt32BE(0, tocOffset + 9); // Points to Block 0

    // Assemble complete 8196-byte .DS_Store file
    const fileBuf = Buffer.alloc(4 + 0x2000, 0);
    // 4-byte alignment prelude = 0x00000001
    fileBuf.writeUInt32BE(1, 0);
    // 32-byte Bud1 header at offset 4
    fileBuf.write('Bud1', 4, 4, 'ascii');
    fileBuf.writeUInt32BE(0x0800, 8); // Offset to allocator block
    fileBuf.writeUInt32BE(0x0800, 12); // Size of allocator block
    fileBuf.writeUInt32BE(0x0800, 16); // Duplicate offset
    // Copy DSDB at 4 + 0x0040
    dsdb.copy(fileBuf, 4 + 0x0040);
    // Copy TOC block at 4 + 0x0800
    tocBlock.copy(fileBuf, 4 + 0x0800);
    // Copy Leaf B-tree node at 4 + 0x1000
    leafNode.copy(fileBuf, 4 + 0x1000);

    return fileBuf;
  }

  private static encodeIloc(x: number, y: number): Buffer {
    const b = Buffer.alloc(16, 0xff);
    b.writeUInt32BE(x, 0);
    b.writeUInt32BE(y, 4);
    b.writeUInt32BE(0xffffffff, 8);
    b.writeUInt32BE(0xffff0000, 12);
    return b;
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
