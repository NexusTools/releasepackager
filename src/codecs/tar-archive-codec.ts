import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { VirtualFileEntry } from '../types/binary-types.js';

/**
 * Pure Node.js POSIX USTAR / GNU TAR and .tar.gz archive reader and writer.
 */
export class TarArchiveCodec {
  /**
   * Encodes an array of virtual file entries into an uncompressed POSIX TAR buffer.
   */
  public static encodeTar(entries: VirtualFileEntry[]): Buffer {
    const blocks: Buffer[] = [];

    for (const entry of entries) {
      let relPath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (entry.isDirectory && !relPath.endsWith('/')) {
        relPath += '/';
      }

      const pathBytes = Buffer.from(relPath, 'utf8');
      if (pathBytes.length > 100) {
        // Emit GNU ././@LongLink header block for paths > 100 bytes
        const longLinkData = Buffer.concat([pathBytes, Buffer.from([0])]);
        const longHeader = TarArchiveCodec.createHeaderBlock({
          name: '././@LongLink',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: longLinkData.length,
          mtime: entry.mtime,
          typeFlag: 'L',
          linkName: ''
        });
        blocks.push(longHeader);
        blocks.push(TarArchiveCodec.padTo512(longLinkData));
      }

      const payload = entry.isDirectory || entry.isSymlink ? Buffer.alloc(0) : entry.data;
      const typeFlag = entry.isSymlink ? '2' : entry.isDirectory ? '5' : '0';

      const header = TarArchiveCodec.createHeaderBlock({
        name: relPath.slice(0, 100),
        mode: entry.mode & 0o7777,
        uid: 0,
        gid: 0,
        size: payload.length,
        mtime: entry.mtime,
        typeFlag,
        linkName: entry.symlinkTarget ?? ''
      });

      blocks.push(header);
      if (payload.length > 0) {
        blocks.push(TarArchiveCodec.padTo512(payload));
      }
    }

    // Two 512-byte zero blocks mark end-of-archive
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  }

  /**
   * Encodes an array of virtual file entries into a GZIP-compressed .tar.gz buffer.
   */
  public static encodeTarGz(entries: VirtualFileEntry[], level = 6): Buffer {
    const tar = TarArchiveCodec.encodeTar(entries);
    return zlib.gzipSync(tar, { level });
  }

  /**
   * Decodes a .tar or .tar.gz buffer into virtual file entries.
   */
  public static decodeTar(tarOrGzBuffer: Buffer): VirtualFileEntry[] {
    const isGzip =
      tarOrGzBuffer.length >= 2 &&
      tarOrGzBuffer[0] === 0x1f &&
      tarOrGzBuffer[1] === 0x8b;
    const tar = isGzip ? zlib.gunzipSync(tarOrGzBuffer) : tarOrGzBuffer;

    const entries: VirtualFileEntry[] = [];
    let offset = 0;
    let nextLongName: string | null = null;
    let nextLongLink: string | null = null;

    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      offset += 512;

      if (header.every((b) => b === 0)) {
        break;
      }

      const rawName = TarArchiveCodec.readNullTerminated(header.subarray(0, 100));
      const mode = parseInt(TarArchiveCodec.readNullTerminated(header.subarray(100, 108)).trim() || '0', 8);
      const size = parseInt(TarArchiveCodec.readNullTerminated(header.subarray(124, 136)).trim() || '0', 8);
      const mtimeSec = parseInt(TarArchiveCodec.readNullTerminated(header.subarray(136, 148)).trim() || '0', 8);
      const typeFlag = String.fromCharCode(header[156] || 48);
      const rawLinkName = TarArchiveCodec.readNullTerminated(header.subarray(157, 257));
      const prefix = TarArchiveCodec.readNullTerminated(header.subarray(345, 500));

      const dataSlice = tar.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;

      if (typeFlag === 'L') {
        nextLongName = TarArchiveCodec.readNullTerminated(dataSlice);
        continue;
      }
      if (typeFlag === 'K') {
        nextLongLink = TarArchiveCodec.readNullTerminated(dataSlice);
        continue;
      }
      if (typeFlag === 'x' || typeFlag === 'g') {
        // PAX extended header; parse path/linkpath if present
        const paxText = dataSlice.toString('utf8');
        for (const line of paxText.split('\n')) {
          const sp = line.indexOf(' ');
          if (sp > 0) {
            const kv = line.slice(sp + 1);
            if (kv.startsWith('path=')) {
              nextLongName = kv.slice(5);
            } else if (kv.startsWith('linkpath=')) {
              nextLongLink = kv.slice(9);
            }
          }
        }
        continue;
      }

      const fullName =
        nextLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      const linkTarget = nextLongLink ?? rawLinkName;
      nextLongName = null;
      nextLongLink = null;

      const isDirectory = typeFlag === '5' || fullName.endsWith('/');
      const isSymlink = typeFlag === '2';

      entries.push({
        relativePath: fullName,
        data: Buffer.from(dataSlice),
        isDirectory,
        isSymlink,
        symlinkTarget: isSymlink ? linkTarget : undefined,
        mode: mode || (isDirectory ? 0o755 : 0o644),
        mtime: new Date(mtimeSec * 1000)
      });
    }

    return entries;
  }

  /**
   * Extracts a .tar or .tar.gz archive into a destination directory.
   */
  public static extractToDirectory(
    filePathOrBuffer: string | Buffer,
    destDir: string,
    stripTopLevelDir = false
  ): void {
    const buf =
      typeof filePathOrBuffer === 'string'
        ? fs.readFileSync(filePathOrBuffer)
        : filePathOrBuffer;
    const entries = TarArchiveCodec.decodeTar(buf);

    let commonPrefix = '';
    if (stripTopLevelDir && entries.length > 0) {
      const firstSlash = entries[0].relativePath.indexOf('/');
      if (firstSlash > 0) {
        const candidate = entries[0].relativePath.slice(0, firstSlash + 1);
        if (entries.every((e) => e.relativePath.startsWith(candidate))) {
          commonPrefix = candidate;
        }
      }
    }

    fs.mkdirSync(destDir, { recursive: true });

    for (const entry of entries) {
      const relPath = commonPrefix
        ? entry.relativePath.slice(commonPrefix.length)
        : entry.relativePath;
      const cleanRel = relPath.replace(/^\/+/, '');
      if (!cleanRel) {
        continue;
      }

      const targetPath = path.join(destDir, cleanRel);
      if (entry.isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true });
      } else if (entry.isSymlink && entry.symlinkTarget) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        try {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          fs.symlinkSync(entry.symlinkTarget, targetPath);
        } catch {
          fs.writeFileSync(targetPath, Buffer.from(entry.symlinkTarget, 'utf8'));
        }
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.data);
        try {
          fs.chmodSync(targetPath, entry.mode & 0o777);
        } catch {
          // Ignore chmod error on Windows
        }
      }
    }
  }

  private static createHeaderBlock(opts: {
    name: string;
    mode: number;
    uid: number;
    gid: number;
    size: number;
    mtime: Date;
    typeFlag: string;
    linkName: string;
  }): Buffer {
    const header = Buffer.alloc(512, 0);
    header.write(opts.name.slice(0, 100), 0, 100, 'utf8');
    header.write(opts.mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write(opts.uid.toString(8).padStart(7, '0') + '\0', 108, 8, 'ascii');
    header.write(opts.gid.toString(8).padStart(7, '0') + '\0', 116, 8, 'ascii');
    header.write(opts.size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    const mtimeOctal = Math.floor(opts.mtime.getTime() / 1000)
      .toString(8)
      .padStart(11, '0');
    header.write(mtimeOctal + '\0', 136, 12, 'ascii');
    // Placeholder spaces for checksum field
    header.write('        ', 148, 8, 'ascii');
    header.write(opts.typeFlag, 156, 1, 'ascii');
    header.write(opts.linkName.slice(0, 100), 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 32, 'ascii');
    header.write('root', 297, 32, 'ascii');

    let chksum = 0;
    for (let i = 0; i < 512; i++) {
      chksum += header[i];
    }
    header.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return header;
  }

  private static padTo512(data: Buffer): Buffer {
    const rem = data.length % 512;
    if (rem === 0) {
      return data;
    }
    return Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
  }

  private static readNullTerminated(buf: Buffer): string {
    const idx = buf.indexOf(0);
    return (idx >= 0 ? buf.subarray(0, idx) : buf).toString('utf8');
  }
}
