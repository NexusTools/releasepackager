import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleasePackagerConfig,
  ResolvedReleasePackagerConfig,
  TargetPlatform
} from '../types/packager-types.js';

/**
 * Loads, merges, and validates generic executable release packager configuration from
 * target project's `package.json`, dedicated configuration files, and CLI/API overrides.
 */
export class ReleaseConfigLoader {
  private static readonly CONFIG_FILE_NAMES = [
    'releasepackager.json',
    '.releasepackagerrc.json',
    'release-packager.json'
  ];

  /**
   * Resolves a complete configuration by merging `package.json` (if present), optional config file,
   * and explicit overrides.
   */
  public static resolve(
    overrides: ReleasePackagerConfig = {},
    explicitConfigPath?: string
  ): ResolvedReleasePackagerConfig {
    const projectDir = path.resolve(overrides.projectDir ?? process.cwd());
    const pkgJsonPath = path.join(projectDir, 'package.json');

    let pkgJson: Record<string, unknown> = {};
    if (fs.existsSync(pkgJsonPath)) {
      const raw = fs.readFileSync(pkgJsonPath, 'utf8');
      pkgJson = JSON.parse(raw) as Record<string, unknown>;
    }

    const pkgEmbeddedConfig = (
      pkgJson.releasePackager ??
      pkgJson.releasepackager ??
      pkgJson.packager ??
      {}
    ) as Partial<ReleasePackagerConfig>;

    let fileConfig: Partial<ReleasePackagerConfig> = {};
    if (explicitConfigPath) {
      const resolvedConfigPath = path.resolve(projectDir, explicitConfigPath);
      if (!fs.existsSync(resolvedConfigPath)) {
        throw new Error(`Configuration file not found: ${resolvedConfigPath}`);
      }
      fileConfig = JSON.parse(
        fs.readFileSync(resolvedConfigPath, 'utf8')
      ) as Partial<ReleasePackagerConfig>;
    } else {
      for (const candidate of ReleaseConfigLoader.CONFIG_FILE_NAMES) {
        const candidatePath = path.join(projectDir, candidate);
        if (fs.existsSync(candidatePath)) {
          fileConfig = JSON.parse(
            fs.readFileSync(candidatePath, 'utf8')
          ) as Partial<ReleasePackagerConfig>;
          break;
        }
      }
    }

    const merged: ReleasePackagerConfig = {
      ...pkgEmbeddedConfig,
      ...fileConfig,
      ...overrides,
      executables: {
        ...(pkgEmbeddedConfig.executables ?? {}),
        ...(fileConfig.executables ?? {}),
        ...(overrides.executables ?? {})
      },
      inputs: {
        ...(pkgEmbeddedConfig.inputs ?? {}),
        ...(fileConfig.inputs ?? {}),
        ...(overrides.inputs ?? {})
      },
      win: {
        ...(pkgEmbeddedConfig.win ?? {}),
        ...(fileConfig.win ?? {}),
        ...(overrides.win ?? {})
      },
      mac: {
        ...(pkgEmbeddedConfig.mac ?? {}),
        ...(fileConfig.mac ?? {}),
        ...(overrides.mac ?? {})
      },
      linux: {
        ...(pkgEmbeddedConfig.linux ?? {}),
        ...(fileConfig.linux ?? {}),
        ...(overrides.linux ?? {})
      }
    };

    const rawName = typeof pkgJson.name === 'string' ? pkgJson.name : path.basename(projectDir);
    const unScopedName = rawName.replace(/^@[^/]+\//, '');
    const appName = ReleaseConfigLoader.sanitizeSlug(merged.appName ?? unScopedName);
    const productName =
      merged.productName ??
      (typeof pkgJson.productName === 'string' ? pkgJson.productName : undefined) ??
      unScopedName;
    const version =
      merged.version ??
      (typeof pkgJson.version === 'string' ? pkgJson.version : undefined) ??
      '1.0.0';
    const description =
      merged.description ??
      (typeof pkgJson.description === 'string' ? pkgJson.description : undefined) ??
      `${productName} Application`;

    const author =
      ReleaseConfigLoader.extractAuthor(merged.author ?? pkgJson.author) || productName;
    const authorSlug = ReleaseConfigLoader.sanitizeSlug(author).replace(/-/g, '') || 'app';
    const appSlugClean = appName.replace(/-/g, '') || 'app';
    const appId = merged.appId ?? `io.${authorSlug}.${appSlugClean}`;
    const homepage =
      merged.homepage ??
      (typeof pkgJson.homepage === 'string' ? pkgJson.homepage : undefined) ??
      'https://github.com/NexusTools';
    const license =
      merged.license ??
      (typeof pkgJson.license === 'string' ? pkgJson.license : undefined) ??
      'MIT';
    const executableName = merged.executableName ?? appName;

    const outputDir = path.resolve(projectDir, merged.outputDir ?? 'release');

    const defaultExcludes = [
      '.git',
      '.github',
      '.vscode',
      '.idea',
      '.nwjs-cache',
      'release',
      'node_modules/.cache',
      'node_modules/@nexustools/releasepackager',
      'node_modules/@nexustools/nwjsreleasepackager',
      '*.log',
      'releasepackager.json',
      '.releasepackagerrc.json',
      'release-packager.json',
      'nwjsreleasepackager.json',
      '.nwjspackagerrc.json'
    ];
    const excludePatterns = Array.from(
      new Set([...defaultExcludes, ...(merged.excludePatterns ?? [])])
    );

    const platforms: TargetPlatform[] = merged.platforms ?? ['win', 'osx', 'linux'];
    const copyright =
      merged.win?.copyright ??
      merged.mac?.copyright ??
      `Copyright (c) ${new Date().getFullYear()} ${author}`;

    const upgradeCode =
      merged.win?.upgradeCode ?? ReleaseConfigLoader.deterministicGuid(`msi-upgrade:${appId}`);

    const extraFiles = [
      ...(pkgEmbeddedConfig.extraFiles ?? []),
      ...(fileConfig.extraFiles ?? []),
      ...(overrides.extraFiles ?? [])
    ];

    return {
      projectDir,
      inputDir: merged.inputDir,
      outputDir,
      executable: merged.executable,
      executables: merged.executables ?? {},
      inputs: merged.inputs ?? {},
      includeProjectFiles: merged.includeProjectFiles ?? false,
      appName,
      productName,
      version,
      description,
      appId,
      author,
      homepage,
      license,
      executableName,
      excludePatterns,
      extraFiles,
      icon: merged.icon ? path.resolve(projectDir, merged.icon) : undefined,
      platforms,
      win: {
        arch: merged.win?.arch ?? ['x64'],
        formats: merged.win?.formats ?? ['win-zip', 'win-msi'],
        executable: merged.win?.executable,
        inputDir: merged.win?.inputDir,
        modifyPeResources: merged.win?.modifyPeResources ?? true,
        icon: merged.win?.icon
          ? path.resolve(projectDir, merged.win.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        description: merged.win?.description ?? description,
        installPath: merged.win?.installPath ?? productName,
        manufacturer: merged.win?.manufacturer ?? author,
        upgradeCode,
        createDesktopShortcut: merged.win?.createDesktopShortcut ?? true,
        createStartMenuShortcut: merged.win?.createStartMenuShortcut ?? true,
        copyright,
        extraFiles: [
          ...(pkgEmbeddedConfig.win?.extraFiles ?? []),
          ...(fileConfig.win?.extraFiles ?? []),
          ...(overrides.win?.extraFiles ?? [])
        ]
      },
      mac: {
        arch: merged.mac?.arch ?? ['x64'],
        formats: merged.mac?.formats ?? ['mac-dmg'],
        executable: merged.mac?.executable,
        inputDir: merged.mac?.inputDir,
        appBundlePath: merged.mac?.appBundlePath,
        contentsSubdir: merged.mac?.contentsSubdir ?? 'Contents/MacOS',
        icon: merged.mac?.icon
          ? path.resolve(projectDir, merged.mac.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        splashBackground: merged.mac?.splashBackground
          ? path.resolve(projectDir, merged.mac.splashBackground)
          : undefined,
        bundleId: merged.mac?.bundleId ?? appId,
        category: merged.mac?.category ?? 'public.app-category.utilities',
        minimumSystemVersion: merged.mac?.minimumSystemVersion ?? '10.15.0',
        volumeName: merged.mac?.volumeName ?? `${productName} ${version}`,
        copyright,
        extraFiles: [
          ...(pkgEmbeddedConfig.mac?.extraFiles ?? []),
          ...(fileConfig.mac?.extraFiles ?? []),
          ...(overrides.mac?.extraFiles ?? [])
        ]
      },
      linux: {
        arch: merged.linux?.arch ?? ['x64'],
        formats: merged.linux?.formats ?? ['linux-deb', 'linux-flatpak', 'linux-zip'],
        executable: merged.linux?.executable,
        inputDir: merged.linux?.inputDir,
        executableArgs: merged.linux?.executableArgs ?? [],
        icon: merged.linux?.icon
          ? path.resolve(projectDir, merged.linux.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        maintainer: merged.linux?.maintainer ?? `${author} <support@${authorSlug}.io>`,
        section: merged.linux?.section ?? 'utils',
        depends: merged.linux?.depends ?? [],
        categories: merged.linux?.categories ?? ['Utility', 'Application'],
        flatpakRuntime: merged.linux?.flatpakRuntime ?? 'org.freedesktop.Platform',
        flatpakRuntimeVersion: merged.linux?.flatpakRuntimeVersion ?? '23.08',
        flatpakSdk: merged.linux?.flatpakSdk ?? 'org.freedesktop.Sdk',
        flatpakPermissions: {
          shared: merged.linux?.flatpakPermissions?.shared ?? ['network', 'ipc'],
          sockets: merged.linux?.flatpakPermissions?.sockets ?? ['x11', 'wayland', 'pulseaudio'],
          devices: merged.linux?.flatpakPermissions?.devices ?? ['dri'],
          filesystems: merged.linux?.flatpakPermissions?.filesystems ?? ['host']
        },
        extraFiles: [
          ...(pkgEmbeddedConfig.linux?.extraFiles ?? []),
          ...(fileConfig.linux?.extraFiles ?? []),
          ...(overrides.linux?.extraFiles ?? [])
        ]
      },
      onProgress: merged.onProgress
    };
  }

  /**
   * Generates a deterministic uppercase GUID string `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`
   * from any seed string using SHA-256.
   */
  public static deterministicGuid(seed: string): string {
    const hash = crypto.createHash('sha256').update(seed, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex').toUpperCase();
    return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
  }

  /**
   * Sanitizes a string into a lowercase kebab-case slug safe for filenames and Debian package names.
   */
  public static sanitizeSlug(input: string): string {
    return (
      input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'app'
    );
  }

  /**
   * Extracts a clean author/organization display string from a package.json author field.
   */
  public static extractAuthor(rawAuthor: unknown): string {
    if (typeof rawAuthor === 'string') {
      return rawAuthor.replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').trim();
    }
    if (rawAuthor && typeof rawAuthor === 'object' && 'name' in rawAuthor) {
      const nameVal = (rawAuthor as { name?: unknown }).name;
      if (typeof nameVal === 'string') {
        return nameVal.trim();
      }
    }
    return '';
  }
}
