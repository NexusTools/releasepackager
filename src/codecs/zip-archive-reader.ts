import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { VirtualFileEntry } from '../types/binary-types.js';

/**
 * Pure Node.js ZIP archive reader and extractor supporting DEFLATE, STORE,
 * UNIX permissions, and symbolic links.
 */
export class ZipArchiveReader {
  /**
   * Parses all entries from a ZIP buffer.
   */
  public static readEntries(zipBuffer: Buffer): VirtualFileEntry[] {
    let eocdOffset = -1;
    const minEocdOffset = Math.max(0, zipBuffer.length - 65557);
    for (let i = zipBuffer.length - 22; i >= minEocdOffset; i--) {
      if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Invalid ZIP archive: End of Central Directory (EOCD) signature not found.');
    }

    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
    const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
    // Support self-extracting / binary-fused NW.js executables (`copy /b nw.exe+package.nw app.exe`)
    const zipBaseOffset = Math.max(0, eocdOffset - centralDirSize - centralDirOffset);

    const entries: VirtualFileEntry[] = [];
    let ptr = centralDirOffset + zipBaseOffset;

    for (let i = 0; i < totalEntries && ptr < eocdOffset; i++) {
      const sig = zipBuffer.readUInt32LE(ptr);
      if (sig !== 0x02014b50) {
        throw new Error(`Invalid Central Directory header signature at offset ${ptr}`);
      }

      const versionMadeBy = zipBuffer.readUInt16LE(ptr + 4);
      const method = zipBuffer.readUInt16LE(ptr + 10);
      const dosTime = zipBuffer.readUInt16LE(ptr + 12);
      const dosDate = zipBuffer.readUInt16LE(ptr + 14);
      const compressedSize = zipBuffer.readUInt32LE(ptr + 20);
      const nameLen = zipBuffer.readUInt16LE(ptr + 28);
      const extraLen = zipBuffer.readUInt16LE(ptr + 30);
      const commentLen = zipBuffer.readUInt16LE(ptr + 32);
      const externalAttr = zipBuffer.readUInt32LE(ptr + 38);
      const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42) + zipBaseOffset;

      const fileName = zipBuffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      ptr += 46 + nameLen + extraLen + commentLen;

      if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid Local File Header signature at offset ${localHeaderOffset}`);
      }
      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      let uncompressed: Buffer;
      if (method === 0) {
        uncompressed = Buffer.from(compressedSlice);
      } else if (method === 8) {
        uncompressed = zlib.inflateRawSync(compressedSlice);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} for entry ${fileName}`);
      }

      const hostOs = (versionMadeBy >> 8) & 0xff;
      const unixMode = hostOs === 3 ? (externalAttr >>> 16) & 0xffff : 0;
      const isSymlink = (unixMode & 0o170000) === 0o120000;
      const isDirectory =
        fileName.endsWith('/') ||
        (unixMode & 0o170000) === 0o040000 ||
        (!isSymlink && (externalAttr & 0x10) !== 0);

      const mode =
        unixMode !== 0
          ? unixMode
          : isDirectory
            ? 0o040755
            : 0o100644;

      entries.push({
        relativePath: fileName,
        data: uncompressed,
        isDirectory,
        isSymlink,
        symlinkTarget: isSymlink ? uncompressed.toString('utf8') : undefined,
        mode,
        mtime: ZipArchiveReader.dosToDate(dosDate, dosTime)
      });
    }

    return entries;
  }

  /**
   * Extracts a ZIP archive into a destination directory, optionally stripping a single top-level folder.
   */
  public static extractToDirectory(
    zipFilePathOrBuffer: string | Buffer,
    destDir: string,
    stripTopLevelDir = false
  ): void {
    const buf =
      typeof zipFilePathOrBuffer === 'string'
        ? fs.readFileSync(zipFilePathOrBuffer)
        : zipFilePathOrBuffer;
    const entries = ZipArchiveReader.readEntries(buf);

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
          // On Windows without symlink privileges, write a marker or copy raw target contents
          fs.writeFileSync(targetPath, entry.data);
        }
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.data);
        try {
          fs.chmodSync(targetPath, entry.mode & 0o777);
        } catch {
          // Ignore chmod errors on Windows
        }
      }
    }
  }

  private static dosToDate(dosDate: number, dosTime: number): Date {
    const year = ((dosDate >> 9) & 0x7f) + 1980;
    const month = Math.max(1, (dosDate >> 5) & 0x0f) - 1;
    const day = Math.max(1, dosDate & 0x1f);
    const hours = (dosTime >> 11) & 0x1f;
    const minutes = (dosTime >> 5) & 0x3f;
    const seconds = (dosTime & 0x1f) * 2;
    return new Date(year, month, day, hours, minutes, seconds);
  }
}
