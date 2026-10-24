import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleaseArtifact,
  ResolvedReleasePackagerConfig,
  TargetArch
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { GVariantCodec } from '../codecs/gvariant-codec.js';
import { IcoCodec } from '../codecs/ico-codec.js';

/**
 * Packages a staged Linux application release into a Flatpak single-file bundle (`.flatpak`)
 * containing GVariant metadata, OSTree content-addressed objects, Freedesktop `.desktop`
 * export, AppStream metainfo XML, and application icon.
 */
export class LinuxFlatpakBuilder {
  /**
   * Generates `<appId>-<version>-<flatpakArch>.flatpak` in `config.outputDir`.
   */
  public static build(options: {
    config: Pick<
      ResolvedReleasePackagerConfig,
      | 'appName'
      | 'productName'
      | 'version'
      | 'description'
      | 'appId'
      | 'license'
      | 'executableName'
      | 'outputDir'
      | 'linux'
    >;
    arch: TargetArch;
    stagedEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const flatpakArch =
      options.arch === 'x64' ? 'x86_64' : options.arch === 'arm64' ? 'aarch64' : 'i386';
    const appId = options.config.appId;
    const fileName = `${appId}-${options.config.version}-${flatpakArch}.flatpak`;
    const filePath = path.join(options.config.outputDir, fileName);

    let rawIcon: Buffer | undefined;
    if (options.config.linux.icon && fs.existsSync(options.config.linux.icon)) {
      rawIcon = fs.readFileSync(options.config.linux.icon);
    }
    const pngIcon = IcoCodec.toPngBuffer(rawIcon);

    const perms = options.config.linux.flatpakPermissions;
    const metadataIni = [
      '[Application]',
      `name=${appId}`,
      `runtime=${options.config.linux.flatpakRuntime}/${flatpakArch}/${options.config.linux.flatpakRuntimeVersion}`,
      `sdk=${options.config.linux.flatpakSdk}/${flatpakArch}/${options.config.linux.flatpakRuntimeVersion}`,
      `command=${options.config.executableName}`,
      '',
      '[Context]',
      `shared=${(perms.shared ?? ['network', 'ipc']).join(';')};`,
      `sockets=${(perms.sockets ?? ['x11', 'wayland', 'pulseaudio']).join(';')};`,
      `devices=${(perms.devices ?? ['dri']).join(';')};`,
      `filesystems=${(perms.filesystems ?? ['host']).join(';')};`,
      ''
    ].join('\n');

    const desktopContent = [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      `Name=${options.config.productName}`,
      `Comment=${options.config.description}`,
      `Exec=${options.config.executableName} %U`,
      `Icon=${appId}`,
      'Terminal=false',
      `Categories=${options.config.linux.categories.join(';')};`,
      `X-Flatpak=${appId}`,
      ''
    ].join('\n');
    const desktopBuf = Buffer.from(desktopContent, 'utf8');

    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const appdataXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<component type="desktop-application">',
      `  <id>${esc(appId)}</id>`,
      `  <name>${esc(options.config.productName)}</name>`,
      `  <summary>${esc(options.config.description)}</summary>`,
      '  <metadata_license>CC0-1.0</metadata_license>',
      `  <project_license>${esc(options.config.license)}</project_license>`,
      `  <launchable type="desktop-id">${esc(appId)}.desktop</launchable>`,
      '  <releases>',
      `    <release version="${esc(options.config.version)}" date="${new Date().toISOString().slice(0, 10)}"/>`,
      '  </releases>',
      '</component>\n'
    ].join('\n');

    const now = new Date();
    const bundleEntries: VirtualFileEntry[] = [];

    // 1. Application files in /files/lib/<appName>/
    for (const entry of options.stagedEntries) {
      bundleEntries.push({
        ...entry,
        relativePath: `files/lib/${options.config.appName}/${entry.relativePath}`
      });
    }

    // 2. Wrapper executable in /files/bin/<executableName>
    const extraArgs =
      options.config.linux.executableArgs && options.config.linux.executableArgs.length > 0
        ? ' ' + options.config.linux.executableArgs.join(' ')
        : '';
    const wrapperScript = [
      '#!/bin/sh',
      `exec "/app/lib/${options.config.appName}/${options.config.executableName}"${extraArgs} "$@"`,
      ''
    ].join('\n');
    bundleEntries.push({
      relativePath: `files/bin/${options.config.executableName}`,
      data: Buffer.from(wrapperScript, 'utf8'),
      isDirectory: false,
      isSymlink: false,
      mode: 0o100755,
      mtime: now
    });

    // 3. Exported desktop file, icon, and metainfo XML
    bundleEntries.push(
      {
        relativePath: 'metadata',
        data: Buffer.from(metadataIni, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: `export/share/applications/${appId}.desktop`,
        data: desktopBuf,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: `export/share/icons/hicolor/256x256/apps/${appId}.png`,
        data: pngIcon,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: `files/share/metainfo/${appId}.metainfo.xml`,
        data: Buffer.from(appdataXml, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      }
    );

    const flatpakBuf = GVariantCodec.buildFlatpakBundle({
      appId,
      arch: flatpakArch,
      branch: 'stable',
      metadataIni,
      appdataXml,
      desktopFile: desktopBuf,
      iconPng: pngIcon,
      entries: bundleEntries
    });

    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, flatpakBuf);

    return {
      platform: 'linux',
      arch: options.arch,
      format: 'linux-flatpak',
      filePath,
      fileName,
      sizeBytes: flatpakBuf.length,
      sha256: crypto.createHash('sha256').update(flatpakBuf).digest('hex')
    };
  }
}
