import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleaseArtifact,
  ResolvedReleasePackagerConfig,
  TargetArch
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { ZipArchiveWriter } from '../codecs/zip-archive-writer.js';
import { IcoCodec } from '../codecs/ico-codec.js';

/**
 * Packages a staged Linux application release into a `.zip` archive preserving UNIX executable
 * permissions (`0755`) and bundling a `.desktop` launcher file.
 */
export class LinuxZipBuilder {
  /**
   * Generates `<appName>-<version>-linux-<arch>.zip` in `config.outputDir`.
   */
  public static build(options: {
    config: Pick<
      ResolvedReleasePackagerConfig,
      | 'appName'
      | 'productName'
      | 'version'
      | 'description'
      | 'executableName'
      | 'outputDir'
      | 'linux'
    >;
    arch: TargetArch;
    stagedEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const fileName = `${options.config.appName}-${options.config.version}-linux-${options.arch}.zip`;
    const filePath = path.join(options.config.outputDir, fileName);
    const rootFolder = `${options.config.appName}-${options.config.version}-linux-${options.arch}`;

    let rawIcon: Buffer | undefined;
    if (options.config.linux.icon && fs.existsSync(options.config.linux.icon)) {
      rawIcon = fs.readFileSync(options.config.linux.icon);
    }
    const pngIcon = IcoCodec.toPngBuffer(rawIcon);

    const desktopContent = [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      `Name=${options.config.productName}`,
      `Comment=${options.config.description}`,
      `Exec=./${options.config.executableName}`,
      'Icon=./icon.png',
      'Terminal=false',
      `Categories=${options.config.linux.categories.join(';')};`,
      ''
    ].join('\n');

    const writer = new ZipArchiveWriter();
    for (const entry of options.stagedEntries) {
      writer.addEntry({
        ...entry,
        relativePath: `${rootFolder}/${entry.relativePath}`
      });
    }

    writer.addEntry({
      relativePath: `${rootFolder}/icon.png`,
      data: pngIcon,
      isDirectory: false,
      isSymlink: false,
      mode: 0o100644,
      mtime: new Date()
    });

    writer.addEntry({
      relativePath: `${rootFolder}/${options.config.appName}.desktop`,
      data: Buffer.from(desktopContent, 'utf8'),
      isDirectory: false,
      isSymlink: false,
      mode: 0o100755,
      mtime: new Date()
    });

    const zipBuf = writer.toBuffer(6);
    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, zipBuf);

    return {
      platform: 'linux',
      arch: options.arch,
      format: 'linux-zip',
      filePath,
      fileName,
      sizeBytes: zipBuf.length,
      sha256: crypto.createHash('sha256').update(zipBuf).digest('hex')
    };
  }
}
