import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { VirtualFileEntry } from '../types/binary-types.js';

/**
 * Pure Node.js GLib GVariant and OSTree Static-Delta Single-File Bundle serializer
 * for generating Linux `.flatpak` bundles without external `flatpak` or `ostree` CLI dependencies.
 */
export class GVariantCodec {
  /**
   * Serializes a complete Flatpak single-file bundle (`.flatpak`) from application metadata
   * and virtual file entries rooted at `/files/...` and `/export/...`.
   */
  public static buildFlatpakBundle(options: {
    appId: string;
    arch: 'x86_64' | 'i386' | 'aarch64';
    branch: string;
    metadataIni: string;
    appdataXml: string;
    desktopFile: Buffer;
    iconPng: Buffer;
    entries: VirtualFileEntry[];
  }): Buffer {
    // 1. Build OSTree content-addressed file objects (SHA-256) + directory tree
    const ostreeObjects: {
      checksumHex: string;
      objType: number; // 1 = FILE, 2 = DIR_TREE, 3 = DIR_META, 4 = COMMIT
      relativePath: string;
      mode: number;
      payload: Buffer;
    }[] = [];

    for (const entry of options.entries) {
      if (entry.isDirectory) {
        continue;
      }
      // Build OSTree file header: [uint32BE uid=0, uint32BE gid=0, uint32BE mode, uint32BE rdev=0, symlinkTarget\0, xattrs]
      const fileHeader = Buffer.alloc(16, 0);
      fileHeader.writeUInt32BE(0, 0); // uid
      fileHeader.writeUInt32BE(0, 4); // gid
      fileHeader.writeUInt32BE(entry.isSymlink ? 0o120777 : entry.mode || 0o100644, 8);
      fileHeader.writeUInt32BE(0, 12); // rdev

      const linkBuf = Buffer.from((entry.symlinkTarget ?? '') + '\0', 'utf8');
      const contentBuf = entry.isSymlink ? Buffer.alloc(0) : entry.data;
      const combinedFileObject = Buffer.concat([fileHeader, linkBuf, contentBuf]);

      const sha256 = crypto.createHash('sha256').update(combinedFileObject).digest('hex');
      ostreeObjects.push({
        checksumHex: sha256,
        objType: 1,
        relativePath: entry.relativePath,
        mode: entry.mode,
        payload: zlib.deflateSync(combinedFileObject, { level: 6 })
      });
    }

    // Build OSTree dirmeta object for standard root 0755 directory
    const dirMetaBuf = Buffer.alloc(16, 0);
    dirMetaBuf.writeUInt32BE(0, 0); // uid = 0
    dirMetaBuf.writeUInt32BE(0, 4); // gid = 0
    dirMetaBuf.writeUInt32BE(0o040755, 8); // mode = 040755
    const dirMetaSha = crypto.createHash('sha256').update(dirMetaBuf).digest('hex');
    ostreeObjects.push({
      checksumHex: dirMetaSha,
      objType: 3,
      relativePath: '/',
      mode: 0o040755,
      payload: dirMetaBuf
    });

    // Build OSTree dirtree manifest listing all file objects
    const dirTreeParts: Buffer[] = [];
    for (const obj of ostreeObjects) {
      if (obj.objType !== 1) continue;
      const pathBuf = Buffer.from(obj.relativePath + '\0', 'utf8');
      const csumBytes = Buffer.from(obj.checksumHex, 'hex');
      dirTreeParts.push(pathBuf, csumBytes);
    }
    const dirTreePayload = Buffer.concat(dirTreeParts);
    const dirTreeSha = crypto.createHash('sha256').update(dirTreePayload).digest('hex');
    ostreeObjects.push({
      checksumHex: dirTreeSha,
      objType: 2,
      relativePath: '/',
      mode: 0o040755,
      payload: zlib.deflateSync(dirTreePayload, { level: 6 })
    });

    // Build OSTree commit object
    const timestampSec = BigInt(Math.floor(Date.now() / 1000));
    const commitBody = Buffer.alloc(8 + 64, 0);
    commitBody.writeBigUInt64BE(timestampSec, 0);
    Buffer.from(dirTreeSha, 'hex').copy(commitBody, 8);
    Buffer.from(dirMetaSha, 'hex').copy(commitBody, 40);
    const commitSha = crypto.createHash('sha256').update(commitBody).digest();

    // Serialize static-delta part payload containing all OSTree objects
    const deltaPartChunks: Buffer[] = [];
    const deltaCountBuf = Buffer.alloc(4);
    deltaCountBuf.writeUInt32BE(ostreeObjects.length, 0);
    deltaPartChunks.push(deltaCountBuf);

    for (const obj of ostreeObjects) {
      const csumBytes = Buffer.from(obj.checksumHex, 'hex');
      const pathBytes = Buffer.from(obj.relativePath, 'utf8');
      const itemHeader = Buffer.alloc(32 + 1 + 4 + 4 + 4 + pathBytes.length);
      csumBytes.copy(itemHeader, 0);
      itemHeader.writeUInt8(obj.objType, 32);
      itemHeader.writeUInt32BE(obj.mode >>> 0, 33);
      itemHeader.writeUInt32BE(pathBytes.length, 37);
      itemHeader.writeUInt32BE(obj.payload.length, 41);
      pathBytes.copy(itemHeader, 45);
      deltaPartChunks.push(itemHeader, obj.payload);
    }
    const compressedDeltaPart = zlib.gzipSync(Buffer.concat(deltaPartChunks), { level: 6 });

    // Build GVariant dictionary entries (`a{sv}`) for the Flatpak bundle container
    const refString = `app/${options.appId}/${options.arch}/${options.branch}`;
    const dictEntries: Buffer[] = [
      GVariantCodec.encodeDictEntryString('ref', refString),
      GVariantCodec.encodeDictEntryString('metadata', options.metadataIni),
      GVariantCodec.encodeDictEntryString('appdata', options.appdataXml),
      GVariantCodec.encodeDictEntryString(
        'runtime-repo',
        'https://dl.flathub.org/repo/flathub.flatpakrepo'
      ),
      GVariantCodec.encodeDictEntryUInt32('flatpak-version', 1),
      GVariantCodec.encodeDictEntryBytes('commit', commitSha),
      GVariantCodec.encodeDictEntryBytes('root-dirtree', Buffer.from(dirTreeSha, 'hex')),
      GVariantCodec.encodeDictEntryBytes('desktop-entry', options.desktopFile),
      GVariantCodec.encodeDictEntryBytes('icon-256', options.iconPng),
      GVariantCodec.encodeDictEntryBytes('static-delta-part-0', compressedDeltaPart)
    ];

    const dictContainer = GVariantCodec.encodeVariableArray(dictEntries, 8);

    // Prepend Flatpak bundle magic header ("flatpak\0" + version 1 + GVariant container)
    const magicHeader = Buffer.alloc(16, 0);
    magicHeader.write('flatpak\0', 0, 8, 'ascii');
    magicHeader.writeUInt32BE(1, 8); // Bundle format version 1
    magicHeader.writeUInt32BE(dictContainer.length, 12);

    return Buffer.concat([magicHeader, dictContainer]);
  }

  /**
   * Encodes a GVariant dictionary entry `{sv}` where the value is a UTF-8 string (`s`).
   */
  public static encodeDictEntryString(key: string, value: string): Buffer {
    const valStrBuf = Buffer.from(value + '\0', 'utf8');
    const variantBuf = GVariantCodec.encodeVariant(valStrBuf, 's');
    return GVariantCodec.encodeDictEntryRaw(key, variantBuf);
  }

  /**
   * Encodes a GVariant dictionary entry `{sv}` where the value is a `uint32` (`u`).
   */
  public static encodeDictEntryUInt32(key: string, value: number): Buffer {
    const valBuf = Buffer.alloc(4);
    valBuf.writeUInt32LE(value >>> 0, 0);
    const variantBuf = GVariantCodec.encodeVariant(valBuf, 'u');
    return GVariantCodec.encodeDictEntryRaw(key, variantBuf);
  }

  /**
   * Encodes a GVariant dictionary entry `{sv}` where the value is a byte array (`ay`).
   */
  public static encodeDictEntryBytes(key: string, bytes: Buffer): Buffer {
    const variantBuf = GVariantCodec.encodeVariant(bytes, 'ay');
    return GVariantCodec.encodeDictEntryRaw(key, variantBuf);
  }

  private static encodeDictEntryRaw(key: string, variantBuf: Buffer): Buffer {
    const keyBuf = Buffer.from(key + '\0', 'utf8');
    // In GVariant, a `{sv}` tuple stores: keyBuf + pad-to-8 + variantBuf + framing-offset(keyBuf.length)
    const padLen = (8 - (keyBuf.length % 8)) % 8;
    const bodyLen = keyBuf.length + padLen + variantBuf.length;
    const offsetSize = GVariantCodec.getFramingOffsetSize(bodyLen);
    const offsetBuf = GVariantCodec.writeFramingOffset(keyBuf.length, offsetSize);
    return Buffer.concat([keyBuf, Buffer.alloc(padLen, 0), variantBuf, offsetBuf]);
  }

  private static encodeVariant(body: Buffer, typeSignature: string): Buffer {
    const sigBuf = Buffer.from('\0' + typeSignature, 'ascii');
    return Buffer.concat([body, sigBuf]);
  }

  private static encodeVariableArray(elements: Buffer[], alignment = 8): Buffer {
    const chunks: Buffer[] = [];
    const endOffsets: number[] = [];
    let currentOffset = 0;

    for (const el of elements) {
      const pad = (alignment - (currentOffset % alignment)) % alignment;
      if (pad > 0) {
        chunks.push(Buffer.alloc(pad, 0));
        currentOffset += pad;
      }
      chunks.push(el);
      currentOffset += el.length;
      endOffsets.push(currentOffset);
    }

    const offsetSize = GVariantCodec.getFramingOffsetSize(
      currentOffset + elements.length * 4
    );
    for (const endOff of endOffsets) {
      chunks.push(GVariantCodec.writeFramingOffset(endOff, offsetSize));
    }

    return Buffer.concat(chunks);
  }

  private static getFramingOffsetSize(totalSize: number): 1 | 2 | 4 {
    if (totalSize <= 0xff) return 1;
    if (totalSize <= 0xffff) return 2;
    return 4;
  }

  private static writeFramingOffset(offset: number, size: 1 | 2 | 4): Buffer {
    const b = Buffer.alloc(size);
    if (size === 1) {
      b.writeUInt8(offset, 0);
    } else if (size === 2) {
      b.writeUInt16LE(offset, 0);
    } else {
      b.writeUInt32LE(offset >>> 0, 0);
    }
    return b;
  }
}
