import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleaseArtifact,
  ResolvedReleasePackagerConfig,
  TargetArch
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { MsiDatabaseBuilder } from '../codecs/msi-database-builder.js';
import { IcoCodec } from '../codecs/ico-codec.js';

/**
 * Packages a staged Windows application release into a Windows Installer `.msi` database
 * with embedded Cabinet (`media1.cab`), Start Menu & Desktop shortcuts, and Add/Remove Programs icon.
 */
export class WindowsMsiBuilder {
  /**
   * Generates `<appName>-<version>-win-<arch>.msi` in `config.outputDir`.
   */
  public static build(options: {
    config: Pick<
      ResolvedReleasePackagerConfig,
      | 'appName'
      | 'productName'
      | 'version'
      | 'description'
      | 'homepage'
      | 'executableName'
      | 'outputDir'
      | 'win'
    >;
    arch: TargetArch;
    stagedEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const fileName = `${options.config.appName}-${options.config.version}-win-${options.arch}.msi`;
    const filePath = path.join(options.config.outputDir, fileName);

    let icoBuffer: Buffer | undefined;
    if (options.config.win.icon && fs.existsSync(options.config.win.icon)) {
      const rawIcon = fs.readFileSync(options.config.win.icon);
      icoBuffer = IcoCodec.toIcoBuffer(rawIcon);
    }

    const files = options.stagedEntries
      .filter((e) => !e.isDirectory && !e.isSymlink)
      .map((e) => ({
        relativePath: e.relativePath,
        data: e.data
      }));

    const msiBuf = MsiDatabaseBuilder.buildMsi({
      productName: options.config.productName,
      productVersion: options.config.version,
      manufacturer: options.config.win.manufacturer,
      description: options.config.win.description ?? options.config.description,
      installPath: options.config.win.installPath,
      upgradeCode: options.config.win.upgradeCode,
      arch: options.arch,
      executableName: options.config.executableName,
      iconBuffer: icoBuffer,
      createDesktopShortcut: options.config.win.createDesktopShortcut,
      createStartMenuShortcut: options.config.win.createStartMenuShortcut,
      helpLink: options.config.homepage,
      files
    });

    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, msiBuf);

    return {
      platform: 'win',
      arch: options.arch,
      format: 'win-msi',
      filePath,
      fileName,
      sizeBytes: msiBuf.length,
      sha256: crypto.createHash('sha256').update(msiBuf).digest('hex')
    };
  }
}
