import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleaseArtifact,
  ResolvedReleasePackagerConfig,
  TargetArch
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { ArArchiveWriter } from '../codecs/ar-archive-writer.js';
import { TarArchiveCodec } from '../codecs/tar-archive-codec.js';
import { IcoCodec } from '../codecs/ico-codec.js';

/**
 * Packages a staged Linux application release into a standard Debian `.deb` installer package
 * (`!<arch>\n` containing `debian-binary`, `control.tar.gz`, and `data.tar.gz`).
 */
export class LinuxDebBuilder {
  /**
   * Generates `<appName>_<version>_<debArch>.deb` in `config.outputDir`.
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
      | 'linux'
    >;
    arch: TargetArch;
    stagedEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const debArch =
      options.arch === 'x64' ? 'amd64' : options.arch === 'arm64' ? 'arm64' : 'i386';
    const pkgSlug =
      options.config.appName
        .toLowerCase()
        .replace(/[^a-z0-9.+-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'app';

    const fileName = `${pkgSlug}_${options.config.version}_${debArch}.deb`;
    const filePath = path.join(options.config.outputDir, fileName);

    let rawIcon: Buffer | undefined;
    if (options.config.linux.icon && fs.existsSync(options.config.linux.icon)) {
      rawIcon = fs.readFileSync(options.config.linux.icon);
    }
    const pngIcon = IcoCodec.toPngBuffer(rawIcon);

    const now = new Date();
    const dataEntries: VirtualFileEntry[] = [];

    // 1. Place application files under opt/<pkgSlug>/
    for (const entry of options.stagedEntries) {
      dataEntries.push({
        ...entry,
        relativePath: `./opt/${pkgSlug}/${entry.relativePath}`
      });
    }

    // 2. Launcher wrapper in /usr/bin/<pkgSlug>
    const extraArgs =
      options.config.linux.executableArgs && options.config.linux.executableArgs.length > 0
        ? ' ' + options.config.linux.executableArgs.join(' ')
        : '';
    const launcherScript = [
      '#!/bin/sh',
      `exec "/opt/${pkgSlug}/${options.config.executableName}"${extraArgs} "$@"`,
      ''
    ].join('\n');
    dataEntries.push({
      relativePath: `./usr/bin/${pkgSlug}`,
      data: Buffer.from(launcherScript, 'utf8'),
      isDirectory: false,
      isSymlink: false,
      mode: 0o100755,
      mtime: now
    });

    // 3. Freedesktop .desktop entry in /usr/share/applications/<pkgSlug>.desktop
    const desktopContent = [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      `Name=${options.config.productName}`,
      `Comment=${options.config.description}`,
      `Exec=/usr/bin/${pkgSlug} %U`,
      `Icon=${pkgSlug}`,
      'Terminal=false',
      `Categories=${options.config.linux.categories.join(';')};`,
      `StartupWMClass=${options.config.executableName}`,
      ''
    ].join('\n');
    dataEntries.push({
      relativePath: `./usr/share/applications/${pkgSlug}.desktop`,
      data: Buffer.from(desktopContent, 'utf8'),
      isDirectory: false,
      isSymlink: false,
      mode: 0o100644,
      mtime: now
    });

    // 4. Icon in /usr/share/icons/hicolor/256x256/apps/<pkgSlug>.png
    dataEntries.push({
      relativePath: `./usr/share/icons/hicolor/256x256/apps/${pkgSlug}.png`,
      data: pngIcon,
      isDirectory: false,
      isSymlink: false,
      mode: 0o100644,
      mtime: now
    });

    // Calculate Installed-Size (in KiB) and md5sums
    let totalBytes = 0;
    const md5Lines: string[] = [];
    for (const de of dataEntries) {
      if (!de.isDirectory && !de.isSymlink) {
        totalBytes += de.data.length;
        const md5 = crypto.createHash('md5').update(de.data).digest('hex');
        const cleanRel = de.relativePath.replace(/^\.\//, '');
        md5Lines.push(`${md5}  ${cleanRel}`);
      }
    }
    const installedSizeKb = Math.max(1, Math.ceil(totalBytes / 1024));

    const controlLines: string[] = [
      `Package: ${pkgSlug}`,
      `Version: ${options.config.version}`,
      `Section: ${options.config.linux.section}`,
      'Priority: optional',
      `Architecture: ${debArch}`
    ];
    if (options.config.linux.depends && options.config.linux.depends.length > 0) {
      controlLines.push(`Depends: ${options.config.linux.depends.join(', ')}`);
    }
    controlLines.push(
      `Installed-Size: ${installedSizeKb}`,
      `Maintainer: ${options.config.linux.maintainer}`,
      `Homepage: ${options.config.homepage}`,
      `Description: ${options.config.productName}`,
      ` ${options.config.description.replace(/\r?\n/g, ' ')}`,
      ''
    );
    const controlText = controlLines.join('\n');

    const postinstScript = [
      '#!/bin/sh',
      'set -e',
      `chmod 0755 "/opt/${pkgSlug}/${options.config.executableName}" 2>/dev/null || true`,
      `if [ -f "/opt/${pkgSlug}/chrome-sandbox" ]; then chmod 4755 "/opt/${pkgSlug}/chrome-sandbox" 2>/dev/null || true; fi`,
      'if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi',
      'exit 0',
      ''
    ].join('\n');

    const prermScript = ['#!/bin/sh', 'set -e', 'exit 0', ''].join('\n');

    const controlEntries: VirtualFileEntry[] = [
      {
        relativePath: './control',
        data: Buffer.from(controlText, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: './md5sums',
        data: Buffer.from(md5Lines.join('\n') + '\n', 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: './postinst',
        data: Buffer.from(postinstScript, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100755,
        mtime: now
      },
      {
        relativePath: './prerm',
        data: Buffer.from(prermScript, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100755,
        mtime: now
      }
    ];

    const controlTarGz = TarArchiveCodec.encodeTarGz(controlEntries, 6);
    const dataTarGz = TarArchiveCodec.encodeTarGz(dataEntries, 6);

    const ar = new ArArchiveWriter();
    ar.addMember('debian-binary', Buffer.from('2.0\n', 'ascii'), 0o100644, now);
    ar.addMember('control.tar.gz', controlTarGz, 0o100644, now);
    ar.addMember('data.tar.gz', dataTarGz, 0o100644, now);

    const debBuf = ar.toBuffer();
    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, debBuf);

    return {
      platform: 'linux',
      arch: options.arch,
      format: 'linux-deb',
      filePath,
      fileName,
      sizeBytes: debBuf.length,
      sha256: crypto.createHash('sha256').update(debBuf).digest('hex')
    };
  }
}
