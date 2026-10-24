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

/**
 * Packages a staged Windows application release into a distributable `.zip` archive.
 */
export class WindowsZipBuilder {
  /**
   * Generates `<appName>-<version>-win-<arch>.zip` in `config.outputDir`.
   */
  public static build(options: {
    config: Pick<ResolvedReleasePackagerConfig, 'appName' | 'version' | 'outputDir'>;
    arch: TargetArch;
    stagedEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const fileName = `${options.config.appName}-${options.config.version}-win-${options.arch}.zip`;
    const filePath = path.join(options.config.outputDir, fileName);
    const rootFolder = `${options.config.appName}-${options.config.version}-win-${options.arch}`;

    const writer = new ZipArchiveWriter();
    for (const entry of options.stagedEntries) {
      writer.addEntry({
        ...entry,
        relativePath: `${rootFolder}/${entry.relativePath}`
      });
    }

    const zipBuf = writer.toBuffer(6);
    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, zipBuf);

    return {
      platform: 'win',
      arch: options.arch,
      format: 'win-zip',
      filePath,
      fileName,
      sizeBytes: zipBuf.length,
      sha256: crypto.createHash('sha256').update(zipBuf).digest('hex')
    };
  }
}
