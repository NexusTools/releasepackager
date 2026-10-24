import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Crc32Codec } from './crc32-codec.js';
import { VirtualFileEntry } from '../types/binary-types.js';

/**
 * Pure Node.js ZIP archive writer supporting DEFLATE and STORE compression,
 * UTF-8 filenames, and UNIX external file attributes (permissions & symlinks).
 */
export class ZipArchiveWriter {
  private readonly entries: VirtualFileEntry[] = [];

  /**
   * Adds a virtual file, directory, or symlink entry to the ZIP archive.
   */
  public addEntry(entry: VirtualFileEntry): void {
    const normalizedPath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath) {
      return;
    }
    this.entries.push({
      ...entry,
      relativePath: entry.isDirectory && !normalizedPath.endsWith('/')
        ? `${normalizedPath}/`
        : normalizedPath
    });
  }

  /**
   * Recursively adds all files, directories, and symlinks from a physical directory on disk.
   */
  public addDirectory(rootDir: string, archivePrefix = ''): void {
    const walk = (currentDir: string): void => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        const relFromRoot = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        const archivePath = archivePrefix
          ? `${archivePrefix.replace(/\/+$/, '')}/${relFromRoot}`
          : relFromRoot;
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          const target = fs.readlinkSync(fullPath);
          this.addEntry({
            relativePath: archivePath,
            data: Buffer.from(target, 'utf8'),
            isDirectory: false,
            isSymlink: true,
            symlinkTarget: target,
            mode: 0o120777,
            mtime: lstat.mtime
          });
        } else if (lstat.isDirectory()) {
          this.addEntry({
            relativePath: `${archivePath}/`,
            data: Buffer.alloc(0),
            isDirectory: true,
            isSymlink: false,
            mode: 0o040755,
            mtime: lstat.mtime
          });
          walk(fullPath);
        } else if (lstat.isFile()) {
          const isExecutable =
            (lstat.mode & 0o111) !== 0 ||
            item.name.endsWith('.exe') ||
            item.name.endsWith('.sh') ||
            item.name === 'nw' ||
            item.name === 'chrome-sandbox';
          this.addEntry({
            relativePath: archivePath,
            data: fs.readFileSync(fullPath),
            isDirectory: false,
            isSymlink: false,
            mode: isExecutable ? 0o100755 : 0o100644,
            mtime: lstat.mtime
          });
        }
      }
    };

    walk(rootDir);
  }

  /**
   * Serializes the complete ZIP archive into a Buffer.
   */
  public toBuffer(compressionLevel = 6): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let currentOffset = 0;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.relativePath, 'utf8');
      const rawData = entry.isSymlink
        ? Buffer.from(entry.symlinkTarget ?? entry.data.toString('utf8'), 'utf8')
        : entry.data;
      const crc = Crc32Codec.compute(rawData);

      let method = 0; // STORE
      let compressedData = rawData;

      if (!entry.isDirectory && !entry.isSymlink && rawData.length > 0 && compressionLevel > 0) {
        const deflated = zlib.deflateRawSync(rawData, { level: compressionLevel });
        if (deflated.length < rawData.length) {
          method = 8; // DEFLATE
          compressedData = deflated;
        }
      }

      const { dosTime, dosDate } = ZipArchiveWriter.dateToDos(entry.mtime);
      const generalPurposeFlags = 0x0800; // UTF-8 filename flag
      const versionMadeBy = (3 << 8) | 20; // UNIX (3), ZIP spec 2.0 (20)
      const versionNeeded = 20;

      const localHeader = Buffer.alloc(30 + nameBuf.length);
      localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
      localHeader.writeUInt16LE(versionNeeded, 4);
      localHeader.writeUInt16LE(generalPurposeFlags, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(compressedData.length, 18);
      localHeader.writeUInt32LE(rawData.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28); // Extra field length
      nameBuf.copy(localHeader, 30);

      let unixMode = entry.mode;
      if (entry.isSymlink) {
        unixMode = 0o120777;
      } else if (entry.isDirectory) {
        unixMode = 0o040755;
      } else if ((unixMode & 0o170000) === 0) {
        unixMode = 0o100000 | (unixMode & 0o7777);
      }
      const dosAttr = entry.isDirectory ? 0x10 : 0x00;
      const externalAttr = (((unixMode & 0xffff) << 16) | dosAttr) >>> 0;

      const centralHeader = Buffer.alloc(46 + nameBuf.length);
      centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
      centralHeader.writeUInt16LE(versionMadeBy, 4);
      centralHeader.writeUInt16LE(versionNeeded, 6);
      centralHeader.writeUInt16LE(generalPurposeFlags, 8);
      centralHeader.writeUInt16LE(method, 10);
      centralHeader.writeUInt16LE(dosTime, 12);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(compressedData.length, 20);
      centralHeader.writeUInt32LE(rawData.length, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30); // Extra field length
      centralHeader.writeUInt16LE(0, 32); // File comment length
      centralHeader.writeUInt16LE(0, 34); // Disk number start
      centralHeader.writeUInt16LE(0, 36); // Internal file attributes
      centralHeader.writeUInt32LE(externalAttr, 38);
      centralHeader.writeUInt32LE(currentOffset, 42);
      nameBuf.copy(centralHeader, 46);

      localParts.push(localHeader, compressedData);
      centralParts.push(centralHeader);
      currentOffset += localHeader.length + compressedData.length;
    }

    const centralDirBuffer = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
    eocd.writeUInt16LE(0, 4); // Number of this disk
    eocd.writeUInt16LE(0, 6); // Disk where central directory starts
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralDirBuffer.length, 12);
    eocd.writeUInt32LE(currentOffset, 16);
    eocd.writeUInt16LE(0, 20); // Comment length

    return Buffer.concat([...localParts, centralDirBuffer, eocd]);
  }

  /**
   * Writes the ZIP archive directly to a file on disk.
   */
  public writeToFile(filePath: string, compressionLevel = 6): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.toBuffer(compressionLevel));
  }

  private static dateToDos(date: Date): { dosTime: number; dosDate: number } {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
    return { dosTime, dosDate };
  }
}
