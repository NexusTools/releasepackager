import { IcoCodec } from './ico-codec.js';

/**
 * Pure Node.js Windows Portable Executable (PE32 / PE32+) resource editor.
 * Injects or replaces `RT_ICON` (3), `RT_GROUP_ICON` (14), and `RT_VERSION` (16 `VS_VERSIONINFO`)
 * in a Windows `.exe` binary without external tools.
 */
export class PeResourceEditor {
  /**
   * Updates or appends a `.rsrc` resource section in a Windows PE executable with custom
   * application icon and version metadata.
   */
  public static applyResources(
    exeBuffer: Buffer,
    options: {
      iconBuffer?: Buffer;
      productName: string;
      fileDescription: string;
      fileVersion: string;
      companyName: string;
      legalCopyright: string;
      originalFilename: string;
    }
  ): Buffer {
    // Validate MZ header
    if (exeBuffer.length < 0x40 || exeBuffer.readUInt16LE(0) !== 0x5a4d) {
      return exeBuffer;
    }

    const peOffset = exeBuffer.readUInt32LE(0x3c);
    if (peOffset + 24 > exeBuffer.length || exeBuffer.readUInt32LE(peOffset) !== 0x00004550) {
      return exeBuffer;
    }

    const numSections = exeBuffer.readUInt16LE(peOffset + 6);
    const sizeOfOptionalHeader = exeBuffer.readUInt16LE(peOffset + 20);
    const optionalHeaderOffset = peOffset + 24;
    const magic = exeBuffer.readUInt16LE(optionalHeaderOffset);
    const isPe32Plus = magic === 0x20b;
    const sectionAlignment = exeBuffer.readUInt32LE(optionalHeaderOffset + 32);
    const fileAlignment = exeBuffer.readUInt32LE(optionalHeaderOffset + 36);
    const dataDirectoryOffset = optionalHeaderOffset + (isPe32Plus ? 112 : 96);
    const resourceDirEntryOffset = dataDirectoryOffset + 2 * 8; // Index 2 = IMAGE_DIRECTORY_ENTRY_RESOURCE

    const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
    let maxVirtualEnd = 0;
    let maxRawEnd = exeBuffer.length;
    let rsrcSectionIndex = -1;

    for (let i = 0; i < numSections; i++) {
      const secOff = sectionTableOffset + i * 40;
      const name = exeBuffer
        .subarray(secOff, secOff + 8)
        .toString('ascii')
        .replace(/\0+$/, '');
      const virtualSize = exeBuffer.readUInt32LE(secOff + 8);
      const virtualAddress = exeBuffer.readUInt32LE(secOff + 12);
      const sizeOfRawData = exeBuffer.readUInt32LE(secOff + 16);
      const pointerToRawData = exeBuffer.readUInt32LE(secOff + 20);

      const vEnd = PeResourceEditor.alignUp(
        virtualAddress + Math.max(virtualSize, sizeOfRawData),
        sectionAlignment
      );
      if (vEnd > maxVirtualEnd) {
        maxVirtualEnd = vEnd;
      }
      const rEnd = pointerToRawData + sizeOfRawData;
      if (rEnd > maxRawEnd) {
        maxRawEnd = rEnd;
      }
      if (name === '.rsrc' && i === numSections - 1) {
        rsrcSectionIndex = i;
      }
    }

    const icoBuf = IcoCodec.toIcoBuffer(options.iconBuffer);
    const { grpIconDir, icons } = IcoCodec.parseIcoForPeResource(icoBuf);
    const versionInfoBuf = PeResourceEditor.buildVsVersionInfo(options);

    let targetRva = maxVirtualEnd;
    let baseExe = exeBuffer;

    if (rsrcSectionIndex >= 0) {
      const secOff = sectionTableOffset + rsrcSectionIndex * 40;
      targetRva = exeBuffer.readUInt32LE(secOff + 12);
      const rawPtr = exeBuffer.readUInt32LE(secOff + 20);
      baseExe = exeBuffer.subarray(0, rawPtr);
    }

    const rsrcPayload = PeResourceEditor.buildResourceSectionPayload(
      targetRva,
      icons,
      grpIconDir,
      versionInfoBuf
    );
    const alignedRawSize = PeResourceEditor.alignUp(rsrcPayload.length, fileAlignment);
    const paddedRsrc = Buffer.alloc(alignedRawSize, 0);
    rsrcPayload.copy(paddedRsrc, 0);

    if (rsrcSectionIndex >= 0) {
      const out = Buffer.concat([Buffer.from(baseExe), paddedRsrc]);
      const secOff = sectionTableOffset + rsrcSectionIndex * 40;
      out.writeUInt32LE(rsrcPayload.length, secOff + 8); // VirtualSize
      out.writeUInt32LE(alignedRawSize, secOff + 16); // SizeOfRawData
      out.writeUInt32LE(targetRva, resourceDirEntryOffset);
      out.writeUInt32LE(rsrcPayload.length, resourceDirEntryOffset + 4);
      const newSizeOfImage = PeResourceEditor.alignUp(
        targetRva + rsrcPayload.length,
        sectionAlignment
      );
      out.writeUInt32LE(newSizeOfImage, optionalHeaderOffset + 56);
      out.writeUInt32LE(0, optionalHeaderOffset + 64); // Clear PE checksum
      return out;
    }

    // Check if there is room in the section header table for a new .rsrc section header
    const newSecHeaderOffset = sectionTableOffset + numSections * 40;
    const sizeOfHeaders = exeBuffer.readUInt32LE(optionalHeaderOffset + 60);
    if (newSecHeaderOffset + 40 > sizeOfHeaders) {
      return exeBuffer;
    }

    const alignedExeLen = PeResourceEditor.alignUp(exeBuffer.length, fileAlignment);
    const exePadded = Buffer.alloc(alignedExeLen, 0);
    exeBuffer.copy(exePadded, 0);

    // Write new .rsrc section header
    exePadded.write('.rsrc\0\0\0', newSecHeaderOffset, 8, 'ascii');
    exePadded.writeUInt32LE(rsrcPayload.length, newSecHeaderOffset + 8); // VirtualSize
    exePadded.writeUInt32LE(targetRva, newSecHeaderOffset + 12); // VirtualAddress
    exePadded.writeUInt32LE(alignedRawSize, newSecHeaderOffset + 16); // SizeOfRawData
    exePadded.writeUInt32LE(alignedExeLen, newSecHeaderOffset + 20); // PointerToRawData
    exePadded.writeUInt32LE(0x40000040, newSecHeaderOffset + 36); // IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ

    exePadded.writeUInt16LE(numSections + 1, peOffset + 6);
    exePadded.writeUInt32LE(targetRva, resourceDirEntryOffset);
    exePadded.writeUInt32LE(rsrcPayload.length, resourceDirEntryOffset + 4);

    const newSizeOfImage = PeResourceEditor.alignUp(
      targetRva + rsrcPayload.length,
      sectionAlignment
    );
    exePadded.writeUInt32LE(newSizeOfImage, optionalHeaderOffset + 56);
    exePadded.writeUInt32LE(0, optionalHeaderOffset + 64); // Clear PE checksum

    return Buffer.concat([exePadded, paddedRsrc]);
  }

  /**
   * Builds a 3-level PE `.rsrc` tree containing `RT_ICON` (3), `RT_GROUP_ICON` (14),
   * and `RT_VERSION` (16).
   */
  private static buildResourceSectionPayload(
    sectionRva: number,
    icons: { id: number; data: Buffer }[],
    grpIconDir: Buffer,
    versionInfo: Buffer
  ): Buffer {
    // Resource Types: 3 (RT_ICON), 14 (RT_GROUP_ICON), 16 (RT_VERSION)
    const numIcons = icons.length;
    const totalLeafEntries = numIcons + 2; // icons + 1 group_icon + 1 version

    // Calculate deterministic offsets inside .rsrc
    // Level 1 (Root directory): 16 + 3 * 8 = 40 bytes
    const l1Size = 16 + 3 * 8;
    // Level 2 directories:
    // - Type 3 (RT_ICON): 16 + numIcons * 8
    // - Type 14 (RT_GROUP_ICON): 16 + 1 * 8 = 24
    // - Type 16 (RT_VERSION): 16 + 1 * 8 = 24
    const l2IconOffset = l1Size;
    const l2IconSize = 16 + numIcons * 8;
    const l2GrpOffset = l2IconOffset + l2IconSize;
    const l2GrpSize = 24;
    const l2VerOffset = l2GrpOffset + l2GrpSize;
    const l2VerSize = 24;

    // Level 3 (Language 1033 directories): totalLeafEntries * 24 bytes each
    const l3StartOffset = l2VerOffset + l2VerSize;
    const l3TotalSize = totalLeafEntries * 24;

    // IMAGE_RESOURCE_DATA_ENTRY records: totalLeafEntries * 16 bytes each
    const dataEntriesOffset = l3StartOffset + l3TotalSize;
    const dataEntriesTotalSize = totalLeafEntries * 16;

    const rawDataStartOffset = PeResourceEditor.alignUp(
      dataEntriesOffset + dataEntriesTotalSize,
      8
    );

    const payloads: Buffer[] = [
      ...icons.map((ic) => ic.data),
      grpIconDir,
      versionInfo
    ];

    let curPayloadOffset = rawDataStartOffset;
    const payloadOffsets: number[] = [];
    for (const p of payloads) {
      payloadOffsets.push(curPayloadOffset);
      curPayloadOffset = PeResourceEditor.alignUp(curPayloadOffset + p.length, 8);
    }

    const rsrc = Buffer.alloc(curPayloadOffset, 0);

    // Write Level 1 Root Directory
    rsrc.writeUInt16LE(3, 14); // NumberOfIdEntries = 3
    // Entry 0: Type 3 (RT_ICON)
    rsrc.writeUInt32LE(3, 16);
    rsrc.writeUInt32LE((0x80000000 | l2IconOffset) >>> 0, 20);
    // Entry 1: Type 14 (RT_GROUP_ICON)
    rsrc.writeUInt32LE(14, 24);
    rsrc.writeUInt32LE((0x80000000 | l2GrpOffset) >>> 0, 28);
    // Entry 2: Type 16 (RT_VERSION)
    rsrc.writeUInt32LE(16, 32);
    rsrc.writeUInt32LE((0x80000000 | l2VerOffset) >>> 0, 36);

    // Write Level 2: RT_ICON IDs
    rsrc.writeUInt16LE(numIcons, l2IconOffset + 14);
    for (let i = 0; i < numIcons; i++) {
      const l3Off = l3StartOffset + i * 24;
      rsrc.writeUInt32LE(icons[i].id, l2IconOffset + 16 + i * 8);
      rsrc.writeUInt32LE((0x80000000 | l3Off) >>> 0, l2IconOffset + 16 + i * 8 + 4);
    }

    // Write Level 2: RT_GROUP_ICON ID = 1
    const l3GrpOff = l3StartOffset + numIcons * 24;
    rsrc.writeUInt16LE(1, l2GrpOffset + 14);
    rsrc.writeUInt32LE(1, l2GrpOffset + 16);
    rsrc.writeUInt32LE((0x80000000 | l3GrpOff) >>> 0, l2GrpOffset + 20);

    // Write Level 2: RT_VERSION ID = 1
    const l3VerOff = l3StartOffset + (numIcons + 1) * 24;
    rsrc.writeUInt16LE(1, l2VerOffset + 14);
    rsrc.writeUInt32LE(1, l2VerOffset + 16);
    rsrc.writeUInt32LE((0x80000000 | l3VerOff) >>> 0, l2VerOffset + 20);

    // Write Level 3 Language (1033) directories & Data Entries & Raw Payloads
    for (let idx = 0; idx < totalLeafEntries; idx++) {
      const l3Off = l3StartOffset + idx * 24;
      const deOff = dataEntriesOffset + idx * 16;
      rsrc.writeUInt16LE(1, l3Off + 14);
      rsrc.writeUInt32LE(1033, l3Off + 16); // Locale 1033 (en-US)
      rsrc.writeUInt32LE(deOff, l3Off + 20);

      const pBuf = payloads[idx];
      const pOff = payloadOffsets[idx];
      rsrc.writeUInt32LE(sectionRva + pOff, deOff); // OffsetToData RVA
      rsrc.writeUInt32LE(pBuf.length, deOff + 4); // Size
      rsrc.writeUInt32LE(0, deOff + 8); // CodePage
      rsrc.writeUInt32LE(0, deOff + 12); // Reserved

      pBuf.copy(rsrc, pOff);
    }

    return rsrc;
  }

  /**
   * Builds a binary `VS_VERSIONINFO` structure for `RT_VERSION` (16).
   */
  public static buildVsVersionInfo(options: {
    productName: string;
    fileDescription: string;
    fileVersion: string;
    companyName: string;
    legalCopyright: string;
    originalFilename: string;
  }): Buffer {
    const verParts = options.fileVersion
      .replace(/[^0-9.]/g, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
    const v1 = verParts[0] ?? 1;
    const v2 = verParts[1] ?? 0;
    const v3 = verParts[2] ?? 0;
    const v4 = verParts[3] ?? 0;
    const normalizedVerStr = `${v1}.${v2}.${v3}.${v4}`;

    // Build VS_FIXEDFILEINFO (52 bytes)
    const fixedInfo = Buffer.alloc(52, 0);
    fixedInfo.writeUInt32LE(0xfeef04bd, 0); // dwSignature
    fixedInfo.writeUInt32LE(0x00010000, 4); // dwStrucVersion
    fixedInfo.writeUInt32LE(((v1 << 16) | (v2 & 0xffff)) >>> 0, 8); // dwFileVersionMS
    fixedInfo.writeUInt32LE(((v3 << 16) | (v4 & 0xffff)) >>> 0, 12); // dwFileVersionLS
    fixedInfo.writeUInt32LE(((v1 << 16) | (v2 & 0xffff)) >>> 0, 16); // dwProductVersionMS
    fixedInfo.writeUInt32LE(((v3 << 16) | (v4 & 0xffff)) >>> 0, 20); // dwProductVersionLS
    fixedInfo.writeUInt32LE(0x3f, 24); // dwFileFlagsMask
    fixedInfo.writeUInt32LE(0x00, 28); // dwFileFlags
    fixedInfo.writeUInt32LE(0x00040004, 32); // VOS_NT_WINDOWS32
    fixedInfo.writeUInt32LE(0x01, 36); // VFT_APP

    const stringPairs: [string, string][] = [
      ['CompanyName', options.companyName],
      ['FileDescription', options.fileDescription],
      ['FileVersion', normalizedVerStr],
      ['InternalName', options.productName],
      ['LegalCopyright', options.legalCopyright],
      ['OriginalFilename', options.originalFilename],
      ['ProductName', options.productName],
      ['ProductVersion', normalizedVerStr]
    ];

    const stringChildren = stringPairs.map(([k, v]) =>
      PeResourceEditor.makeVersionNode(k, Buffer.from(v + '\0', 'utf16le'), 1, Math.ceil((v.length + 1)))
    );
    const stringTable = PeResourceEditor.makeVersionNode(
      '040904B0',
      Buffer.alloc(0),
      1,
      0,
      stringChildren
    );
    const stringFileInfo = PeResourceEditor.makeVersionNode(
      'StringFileInfo',
      Buffer.alloc(0),
      1,
      0,
      [stringTable]
    );

    const translationVal = Buffer.from([0x09, 0x04, 0xb0, 0x04]);
    const varNode = PeResourceEditor.makeVersionNode(
      'Translation',
      translationVal,
      0,
      translationVal.length
    );
    const varFileInfo = PeResourceEditor.makeVersionNode(
      'VarFileInfo',
      Buffer.alloc(0),
      1,
      0,
      [varNode]
    );

    return PeResourceEditor.makeVersionNode(
      'VS_VERSION_INFO',
      fixedInfo,
      0,
      fixedInfo.length,
      [stringFileInfo, varFileInfo]
    );
  }

  private static makeVersionNode(
    key: string,
    value: Buffer,
    wType: number,
    wValueLength: number,
    children: Buffer[] = []
  ): Buffer {
    const keyBuf = Buffer.from(key + '\0', 'utf16le');
    const headerPlusKey = 6 + keyBuf.length;
    const pad1 = (4 - (headerPlusKey % 4)) % 4;
    const afterValue = headerPlusKey + pad1 + value.length;
    const pad2 = children.length > 0 ? (4 - (afterValue % 4)) % 4 : 0;

    const childChunks: Buffer[] = [];
    for (let i = 0; i < children.length; i++) {
      childChunks.push(children[i]);
      if (i < children.length - 1) {
        const rem = children[i].length % 4;
        if (rem !== 0) {
          childChunks.push(Buffer.alloc(4 - rem, 0));
        }
      }
    }
    const childrenBuf = Buffer.concat(childChunks);
    const totalLen = afterValue + pad2 + childrenBuf.length;

    const out = Buffer.alloc(totalLen, 0);
    out.writeUInt16LE(totalLen, 0);
    out.writeUInt16LE(wValueLength, 2);
    out.writeUInt16LE(wType, 4);
    keyBuf.copy(out, 6);
    value.copy(out, headerPlusKey + pad1);
    childrenBuf.copy(out, afterValue + pad2);
    return out;
  }

  private static alignUp(val: number, align: number): number {
    if (align <= 0) {
      return val;
    }
    return Math.ceil(val / align) * align;
  }
}
