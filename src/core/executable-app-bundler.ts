import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ResolvedReleasePackagerConfig,
  TargetArch,
  TargetPlatform
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { PeResourceEditor } from '../codecs/pe-resource-editor.js';
import { IcnsCodec } from '../codecs/icns-codec.js';
import { ZipArchiveReader } from '../codecs/zip-archive-reader.js';
import { TarArchiveCodec } from '../codecs/tar-archive-codec.js';

/**
 * Stages any standalone executable binary, application directory, or `.app` bundle
 * for Windows (`.zip`, `.msi`), macOS (`.dmg`), and Linux (`.deb`, `.flatpak`, `.zip`).
 *
 * - Injects Windows PE32/PE32+ `.rsrc` icons (`RT_ICON`, `RT_GROUP_ICON`) and `VS_VERSIONINFO` (`RT_VERSION`).
 * - Wraps standalone macOS binaries or directories into a complete `<ProductName>.app` bundle
 *   (`Contents/MacOS/<executableName>`, `Contents/Info.plist`, `InfoPlist.strings`, `app.icns`),
 *   or customizes an existing `.app` bundle.
 * - Normalizes Linux executable permissions (`0755`) and applies platform/arch `extraFiles`.
 */
export class ExecutableAppBundler {
  /**
   * Expands `{platform}`, `{nodePlatform}`, `{arch}`, and `{ext}` placeholders in a path or template string.
   */
  public static expandTemplateVars(
    template: string,
    platform: TargetPlatform,
    arch: TargetArch
  ): string {
    const nodePlatform = platform === 'win' ? 'win32' : platform === 'osx' ? 'darwin' : 'linux';
    const ext = platform === 'win' ? '.exe' : '';
    return template
      .replace(/\{platform\}/g, platform)
      .replace(/\{nodePlatform\}/g, nodePlatform)
      .replace(/\{arch\}/g, arch)
      .replace(/\{ext\}/g, ext);
  }

  /**
   * Resolves the application files for a specific target `(platform, arch)` by applying any matching
   * `extraFiles` specifications (copying platform-specific binaries such as `ffmpeg` or generating/overriding
   * platform configuration files).
   */
  public static resolvePlatformExtraFiles(
    baseFiles: VirtualFileEntry[],
    platform: TargetPlatform,
    arch: TargetArch,
    config: Pick<ResolvedReleasePackagerConfig, 'projectDir' | 'extraFiles' | 'win' | 'mac' | 'linux'>,
    warnings?: string[]
  ): VirtualFileEntry[] {
    const platformExtras =
      platform === 'win'
        ? config.win.extraFiles
        : platform === 'osx'
          ? config.mac.extraFiles
          : config.linux.extraFiles;

    const allSpecs = [...(config.extraFiles ?? []), ...(platformExtras ?? [])];
    if (allSpecs.length === 0) {
      return baseFiles;
    }

    const fileMap = new Map<string, VirtualFileEntry>();
    for (const f of baseFiles) {
      fileMap.set(f.relativePath, f);
    }

    for (const spec of allSpecs) {
      if (spec.platforms && spec.platforms.length > 0 && !spec.platforms.includes(platform)) {
        continue;
      }
      if (spec.arch && spec.arch.length > 0 && !spec.arch.includes(arch)) {
        continue;
      }

      const destRel = ExecutableAppBundler.expandTemplateVars(spec.destination, platform, arch)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      if (!destRel) {
        continue;
      }

      let data: Buffer;
      let mtime = new Date();
      let sourceMode = 0o100644;

      if (typeof spec.content === 'string') {
        const expandedContent = ExecutableAppBundler.expandTemplateVars(
          spec.content,
          platform,
          arch
        );
        data = Buffer.from(expandedContent, 'utf8');
      } else if (spec.source) {
        const expandedSource = ExecutableAppBundler.expandTemplateVars(
          spec.source,
          platform,
          arch
        );
        const fullSourcePath = path.resolve(config.projectDir, expandedSource);
        if (!fs.existsSync(fullSourcePath)) {
          if (spec.optional) {
            warnings?.push(
              `Optional extraFile source not found for ${platform}-${arch}: ${fullSourcePath}`
            );
            continue;
          }
          throw new Error(
            `Required extraFile source not found for ${platform}-${arch}: ${fullSourcePath}`
          );
        }
        const stat = fs.statSync(fullSourcePath);
        data = fs.readFileSync(fullSourcePath);
        mtime = stat.mtime;
        sourceMode = (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
      } else {
        continue;
      }

      const isExecutable =
        spec.executable === true ||
        (spec.executable !== false &&
          (sourceMode === 0o100755 ||
            destRel.endsWith('.exe') ||
            destRel.endsWith('.sh') ||
            destRel.startsWith('bin/') ||
            destRel.includes('/bin/')));

      fileMap.set(destRel, {
        relativePath: destRel,
        data,
        isDirectory: false,
        isSymlink: false,
        mode: isExecutable ? 0o100755 : 0o100644,
        mtime
      });
    }

    return Array.from(fileMap.values());
  }

  /**
   * Stages a complete Windows or Linux release directory for any executable or application directory.
   */
  public static stageWinOrLinuxRelease(options: {
    platform: 'win' | 'linux';
    arch: TargetArch;
    config: ResolvedReleasePackagerConfig;
    baseFiles?: VirtualFileEntry[];
    useSyntheticExecutableIfMissing?: boolean;
    warnings?: string[];
  }): VirtualFileEntry[] {
    const targetKey = `${options.platform}-${options.arch}`;
    const platformCfg = options.platform === 'win' ? options.config.win : options.config.linux;

    const rawInputDir =
      options.config.inputs[targetKey] ??
      options.config.inputs[options.platform] ??
      options.config.inputs['*'] ??
      platformCfg.inputDir ??
      options.config.inputDir;

    const rawExecutable =
      options.config.executables[targetKey] ??
      options.config.executables[options.platform] ??
      options.config.executables['*'] ??
      platformCfg.executable ??
      options.config.executable;

    const entries: VirtualFileEntry[] = [...(options.baseFiles ?? [])];

    // 1. Load files from inputDir (directory or archive) or projectDir if requested
    if (rawInputDir) {
      const expandedInput = ExecutableAppBundler.expandTemplateVars(
        rawInputDir,
        options.platform,
        options.arch
      );
      const resolvedInput = path.resolve(options.config.projectDir, expandedInput);
      if (fs.existsSync(resolvedInput)) {
        const loaded = ExecutableAppBundler.readInputPath(
          resolvedInput,
          options.config.excludePatterns
        );
        entries.push(...loaded);
      } else if (!options.useSyntheticExecutableIfMissing) {
        throw new Error(`Input path not found for ${targetKey}: ${resolvedInput}`);
      }
    } else if (options.config.includeProjectFiles && entries.length === 0) {
      const projectEntries = ExecutableAppBundler.readPhysicalDirectory(
        options.config.projectDir,
        options.config.excludePatterns
      );
      entries.push(...projectEntries);
    }

    const targetBinaryName =
      options.platform === 'win'
        ? `${options.config.executableName}.exe`
        : options.config.executableName;

    let mainExeData: Buffer | undefined;
    let mainExeMtime = new Date();

    // 2. Resolve explicit executable file or directory if specified
    if (rawExecutable) {
      const expandedExe = ExecutableAppBundler.expandTemplateVars(
        rawExecutable,
        options.platform,
        options.arch
      );
      const resolvedExe = path.resolve(options.config.projectDir, expandedExe);
      if (fs.existsSync(resolvedExe)) {
        const stat = fs.statSync(resolvedExe);
        if (stat.isDirectory()) {
          const dirEntries = ExecutableAppBundler.readPhysicalDirectory(
            resolvedExe,
            options.config.excludePatterns
          );
          entries.push(...dirEntries);
        } else {
          mainExeData = fs.readFileSync(resolvedExe);
          mainExeMtime = stat.mtime;
          // If the explicit executable was also inside entries under its original relative path, remove the duplicate
          if (rawInputDir) {
            const expandedInput = ExecutableAppBundler.expandTemplateVars(
              rawInputDir,
              options.platform,
              options.arch
            );
            const resolvedInput = path.resolve(options.config.projectDir, expandedInput);
            if (fs.existsSync(resolvedInput) && fs.statSync(resolvedInput).isDirectory()) {
              const relInInput = path.relative(resolvedInput, resolvedExe).replace(/\\/g, '/');
              const existingIdx = entries.findIndex((e) => e.relativePath === relInInput);
              if (existingIdx >= 0) {
                entries.splice(existingIdx, 1);
              }
            }
          }
        }
      } else {
        // Check if rawExecutable matches a relative path inside the already collected entries
        const normalizedRelExe = expandedExe.replace(/\\/g, '/').replace(/^\.\//, '');
        const matchIdx = entries.findIndex(
          (e) =>
            !e.isDirectory &&
            (e.relativePath === normalizedRelExe ||
              e.relativePath.toLowerCase() === normalizedRelExe.toLowerCase())
        );
        if (matchIdx >= 0) {
          mainExeData = entries[matchIdx].data;
          mainExeMtime = entries[matchIdx].mtime;
          entries.splice(matchIdx, 1);
        } else if (!options.useSyntheticExecutableIfMissing) {
          throw new Error(`Executable not found for ${targetKey}: ${resolvedExe}`);
        }
      }
    }

    // 3. If mainExeData was not explicitly loaded yet, locate it inside entries
    if (!mainExeData && entries.length > 0) {
      const candidateIdx = ExecutableAppBundler.findMainExecutableIndex(
        entries,
        options.platform,
        options.config.executableName,
        options.config.appName
      );
      if (candidateIdx >= 0) {
        mainExeData = entries[candidateIdx].data;
        mainExeMtime = entries[candidateIdx].mtime;
        entries.splice(candidateIdx, 1);
      }
    }

    // 4. Fallback to synthetic executable if enabled or throw error if no executable found
    if (!mainExeData) {
      if (options.useSyntheticExecutableIfMissing) {
        mainExeData = ExecutableAppBundler.createSyntheticExecutable(
          options.platform,
          options.arch
        );
      } else {
        throw new Error(
          `No executable binary found for ${targetKey}. Specify "executable", "executables", or "inputDir" containing an executable.`
        );
      }
    }

    // 5. Apply Windows PE resources (icon & VS_VERSIONINFO) if building for Windows
    if (options.platform === 'win' && options.config.win.modifyPeResources) {
      let customIconBuffer: Buffer | undefined;
      if (options.config.win.icon && fs.existsSync(options.config.win.icon)) {
        customIconBuffer = fs.readFileSync(options.config.win.icon);
      }
      mainExeData = PeResourceEditor.applyResources(mainExeData, {
        iconBuffer: customIconBuffer,
        productName: options.config.productName,
        fileDescription: options.config.description,
        fileVersion: options.config.version,
        companyName: options.config.win.manufacturer,
        legalCopyright: options.config.win.copyright,
        originalFilename: targetBinaryName
      });
    }

    const stagedWithExe: VirtualFileEntry[] = [
      {
        relativePath: targetBinaryName,
        data: mainExeData,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100755,
        mtime: mainExeMtime
      },
      ...entries.filter((e) => e.relativePath !== targetBinaryName)
    ];

    return ExecutableAppBundler.resolvePlatformExtraFiles(
      stagedWithExe,
      options.platform,
      options.arch,
      options.config,
      options.warnings
    );
  }

  /**
   * Stages a complete macOS `<ProductName>.app` bundle structure inside a virtual tree,
   * wrapping any Mach-O or script executable (or customizing an existing `.app` bundle)
   * with `Contents/Info.plist`, `InfoPlist.strings`, and `Contents/Resources/app.icns`.
   */
  public static stageMacAppBundle(options: {
    arch: TargetArch;
    config: ResolvedReleasePackagerConfig;
    baseFiles?: VirtualFileEntry[];
    useSyntheticExecutableIfMissing?: boolean;
    warnings?: string[];
  }): { appBundleName: string; entries: VirtualFileEntry[] } {
    const targetKey = `osx-${options.arch}`;
    const appBundleName = `${options.config.productName}.app`;

    let customIconBuf: Buffer | undefined;
    if (options.config.mac.icon && fs.existsSync(options.config.mac.icon)) {
      customIconBuf = fs.readFileSync(options.config.mac.icon);
    }
    const icnsBuffer = IcnsCodec.toIcnsBuffer(customIconBuf);

    const rawAppBundlePath = options.config.mac.appBundlePath;
    const rawInputDir =
      options.config.inputs[targetKey] ??
      options.config.inputs['osx'] ??
      options.config.inputs['*'] ??
      options.config.mac.inputDir ??
      options.config.inputDir;
    const rawExecutable =
      options.config.executables[targetKey] ??
      options.config.executables['osx'] ??
      options.config.executables['*'] ??
      options.config.mac.executable ??
      options.config.executable;

    // Check if an existing .app bundle directory was provided
    const candidateBundleSource = rawAppBundlePath ?? rawInputDir ?? rawExecutable;
    if (candidateBundleSource) {
      const expanded = ExecutableAppBundler.expandTemplateVars(
        candidateBundleSource,
        'osx',
        options.arch
      );
      const resolvedPath = path.resolve(options.config.projectDir, expanded);
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        // Check if resolvedPath is itself a .app bundle (contains Contents/) or contains a *.app directory
        const directContents = path.join(resolvedPath, 'Contents');
        const subItems = fs.readdirSync(resolvedPath);
        const childAppDirName = subItems.find((name) => name.endsWith('.app'));

        if (fs.existsSync(directContents) || childAppDirName) {
          const appRootDir = fs.existsSync(directContents)
            ? resolvedPath
            : path.join(resolvedPath, childAppDirName!);
          return ExecutableAppBundler.customizeExistingMacAppBundle({
            appRootDir,
            appBundleName,
            arch: options.arch,
            config: options.config,
            icnsBuffer,
            warnings: options.warnings
          });
        }
      }
    }

    // Otherwise, build a fresh `<ProductName>.app` bundle around the executable and companion files
    const companionEntries: VirtualFileEntry[] = [...(options.baseFiles ?? [])];
    if (rawInputDir) {
      const expandedInput = ExecutableAppBundler.expandTemplateVars(
        rawInputDir,
        'osx',
        options.arch
      );
      const resolvedInput = path.resolve(options.config.projectDir, expandedInput);
      if (fs.existsSync(resolvedInput)) {
        companionEntries.push(
          ...ExecutableAppBundler.readInputPath(resolvedInput, options.config.excludePatterns)
        );
      } else if (!options.useSyntheticExecutableIfMissing) {
        throw new Error(`Input path not found for ${targetKey}: ${resolvedInput}`);
      }
    } else if (options.config.includeProjectFiles && companionEntries.length === 0) {
      companionEntries.push(
        ...ExecutableAppBundler.readPhysicalDirectory(
          options.config.projectDir,
          options.config.excludePatterns
        )
      );
    }

    let mainExeData: Buffer | undefined;
    let mainExeMtime = new Date();

    if (rawExecutable) {
      const expandedExe = ExecutableAppBundler.expandTemplateVars(
        rawExecutable,
        'osx',
        options.arch
      );
      const resolvedExe = path.resolve(options.config.projectDir, expandedExe);
      if (fs.existsSync(resolvedExe) && fs.statSync(resolvedExe).isFile()) {
        const stat = fs.statSync(resolvedExe);
        mainExeData = fs.readFileSync(resolvedExe);
        mainExeMtime = stat.mtime;
        if (rawInputDir) {
          const expandedInput = ExecutableAppBundler.expandTemplateVars(
            rawInputDir,
            'osx',
            options.arch
          );
          const resolvedInput = path.resolve(options.config.projectDir, expandedInput);
          if (fs.existsSync(resolvedInput) && fs.statSync(resolvedInput).isDirectory()) {
            const relInInput = path.relative(resolvedInput, resolvedExe).replace(/\\/g, '/');
            const existingIdx = companionEntries.findIndex((e) => e.relativePath === relInInput);
            if (existingIdx >= 0) {
              companionEntries.splice(existingIdx, 1);
            }
          }
        }
      } else {
        const normalizedRelExe = expandedExe.replace(/\\/g, '/').replace(/^\.\//, '');
        const matchIdx = companionEntries.findIndex(
          (e) =>
            !e.isDirectory &&
            (e.relativePath === normalizedRelExe ||
              e.relativePath.toLowerCase() === normalizedRelExe.toLowerCase())
        );
        if (matchIdx >= 0) {
          mainExeData = companionEntries[matchIdx].data;
          mainExeMtime = companionEntries[matchIdx].mtime;
          companionEntries.splice(matchIdx, 1);
        } else if (!options.useSyntheticExecutableIfMissing) {
          throw new Error(`Executable not found for ${targetKey}: ${resolvedExe}`);
        }
      }
    }

    if (!mainExeData && companionEntries.length > 0) {
      const candidateIdx = ExecutableAppBundler.findMainExecutableIndex(
        companionEntries,
        'osx',
        options.config.executableName,
        options.config.appName
      );
      if (candidateIdx >= 0) {
        mainExeData = companionEntries[candidateIdx].data;
        mainExeMtime = companionEntries[candidateIdx].mtime;
        companionEntries.splice(candidateIdx, 1);
      }
    }

    if (!mainExeData) {
      if (options.useSyntheticExecutableIfMissing) {
        mainExeData = ExecutableAppBundler.createSyntheticExecutable('osx', options.arch);
      } else {
        throw new Error(
          `No macOS executable found for ${targetKey}. Specify "executable", "executables", "inputDir", or "mac.appBundlePath".`
        );
      }
    }

    const withExtras = ExecutableAppBundler.resolvePlatformExtraFiles(
      companionEntries,
      'osx',
      options.arch,
      options.config,
      options.warnings
    );

    const now = new Date();
    const plistText = ExecutableAppBundler.generateMacInfoPlist(options.config);
    const stringsText = [
      `CFBundleName = "${options.config.productName}";`,
      `CFBundleDisplayName = "${options.config.productName}";`,
      `CFBundleGetInfoString = "${options.config.productName} ${options.config.version}, ${options.config.mac.copyright}";`,
      `NSHumanReadableCopyright = "${options.config.mac.copyright}";`,
      ''
    ].join('\n');

    const outEntries: VirtualFileEntry[] = [
      {
        relativePath: `${appBundleName}/Contents/Info.plist`,
        data: Buffer.from(plistText, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: `${appBundleName}/Contents/MacOS/${options.config.executableName}`,
        data: mainExeData,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100755,
        mtime: mainExeMtime
      },
      {
        relativePath: `${appBundleName}/Contents/Resources/app.icns`,
        data: icnsBuffer,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      },
      {
        relativePath: `${appBundleName}/Contents/Resources/en.lproj/InfoPlist.strings`,
        data: Buffer.from(stringsText, 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: now
      }
    ];

    const contentsSubdir = options.config.mac.contentsSubdir
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');

    for (const item of withExtras) {
      let targetRel: string;
      if (item.relativePath.startsWith(`${appBundleName}/`)) {
        targetRel = item.relativePath;
      } else if (item.relativePath.startsWith('Contents/')) {
        targetRel = `${appBundleName}/${item.relativePath}`;
      } else {
        targetRel = contentsSubdir
          ? `${appBundleName}/${contentsSubdir}/${item.relativePath}`
          : `${appBundleName}/${item.relativePath}`;
      }

      if (!outEntries.some((e) => e.relativePath === targetRel)) {
        outEntries.push({
          ...item,
          relativePath: targetRel
        });
      }
    }

    return { appBundleName, entries: outEntries };
  }

  /**
   * Generates a complete macOS `Contents/Info.plist` XML document.
   */
  public static generateMacInfoPlist(
    config: Pick<ResolvedReleasePackagerConfig, 'productName' | 'executableName' | 'version' | 'mac'>
  ): string {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleDevelopmentRegion</key>',
      '  <string>en</string>',
      '  <key>CFBundleDisplayName</key>',
      `  <string>${esc(config.productName)}</string>`,
      '  <key>CFBundleExecutable</key>',
      `  <string>${esc(config.executableName)}</string>`,
      '  <key>CFBundleIconFile</key>',
      '  <string>app.icns</string>',
      '  <key>CFBundleIdentifier</key>',
      `  <string>${esc(config.mac.bundleId)}</string>`,
      '  <key>CFBundleInfoDictionaryVersion</key>',
      '  <string>6.0</string>',
      '  <key>CFBundleName</key>',
      `  <string>${esc(config.productName)}</string>`,
      '  <key>CFBundlePackageType</key>',
      '  <string>APPL</string>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${esc(config.version)}</string>`,
      '  <key>CFBundleVersion</key>',
      `  <string>${esc(config.version)}</string>`,
      '  <key>LSApplicationCategoryType</key>',
      `  <string>${esc(config.mac.category)}</string>`,
      '  <key>LSMinimumSystemVersion</key>',
      `  <string>${esc(config.mac.minimumSystemVersion ?? '10.15.0')}</string>`,
      '  <key>NSHighResolutionCapable</key>',
      '  <true/>',
      '  <key>NSHumanReadableCopyright</key>',
      `  <string>${esc(config.mac.copyright)}</string>`,
      '</dict>',
      '</plist>\n'
    ].join('\n');
  }

  /**
   * Reads all files, directories, and symbolic links from a physical directory on disk.
   */
  public static readPhysicalDirectory(
    rootDir: string,
    excludePatterns: string[] = []
  ): VirtualFileEntry[] {
    const list: VirtualFileEntry[] = [];
    const walk = (dir: string): void => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        if (
          excludePatterns.length > 0 &&
          ExecutableAppBundler.shouldExclude(relPath, item.name, excludePatterns)
        ) {
          continue;
        }
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          const target = fs.readlinkSync(fullPath);
          list.push({
            relativePath: relPath,
            data: Buffer.from(target, 'utf8'),
            isDirectory: false,
            isSymlink: true,
            symlinkTarget: target,
            mode: 0o120777,
            mtime: lstat.mtime
          });
        } else if (lstat.isDirectory()) {
          list.push({
            relativePath: relPath,
            data: Buffer.alloc(0),
            isDirectory: true,
            isSymlink: false,
            mode: 0o040755,
            mtime: lstat.mtime
          });
          walk(fullPath);
        } else if (lstat.isFile()) {
          const data = fs.readFileSync(fullPath);
          const isExe =
            (lstat.mode & 0o111) !== 0 ||
            item.name === 'nw' ||
            item.name === 'nwjs' ||
            item.name === 'chrome-sandbox' ||
            item.name.endsWith('.exe') ||
            item.name.endsWith('.sh') ||
            item.name.endsWith('.so') ||
            item.name.endsWith('.dylib') ||
            ExecutableAppBundler.isBinaryExecutableHeader(data);
          list.push({
            relativePath: relPath,
            data,
            isDirectory: false,
            isSymlink: false,
            mode: isExe ? 0o100755 : 0o100644,
            mtime: lstat.mtime
          });
        }
      }
    };
    walk(rootDir);
    return list;
  }

  /**
   * Checks whether a relative path or basename matches any exclusion pattern.
   */
  public static shouldExclude(
    relPath: string,
    baseName: string,
    patterns: string[]
  ): boolean {
    for (const pat of patterns) {
      const cleanPat = pat.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!cleanPat) continue;
      if (cleanPat.startsWith('*.')) {
        const ext = cleanPat.slice(1);
        if (baseName.endsWith(ext)) return true;
      } else if (
        relPath === cleanPat ||
        relPath.startsWith(`${cleanPat}/`) ||
        baseName === cleanPat
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Builds a minimal valid Windows PE32/PE32+ executable buffer with `.text` section and
   * space in the section table for `PeResourceEditor` to inject `.rsrc`.
   */
  public static createMinimalPeExecutable(is64Bit = true): Buffer {
    const buf = Buffer.alloc(1024, 0);
    // DOS Header ('MZ')
    buf.writeUInt16LE(0x5a4d, 0);
    buf.writeUInt32LE(0x80, 0x3c); // e_lfanew = 0x80

    // PE Signature ('PE\0\0') at 0x80
    buf.writeUInt32LE(0x00004550, 0x80);
    // COFF File Header (20 bytes at 0x84)
    buf.writeUInt16LE(is64Bit ? 0x8664 : 0x014c, 0x84); // Machine
    buf.writeUInt16LE(1, 0x86); // NumberOfSections = 1
    const optHeaderSize = is64Bit ? 240 : 224;
    buf.writeUInt16LE(optHeaderSize, 0x94); // SizeOfOptionalHeader
    buf.writeUInt16LE(0x0022, 0x96); // Characteristics (EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE)

    // Optional Header at 0x98
    const optOff = 0x98;
    buf.writeUInt16LE(is64Bit ? 0x020b : 0x010b, optOff); // Magic
    buf.writeUInt32LE(0x1000, optOff + 16); // AddressOfEntryPoint
    buf.writeUInt32LE(0x1000, optOff + 20); // BaseOfCode
    if (is64Bit) {
      buf.writeBigUInt64LE(0x0000000140000000n, optOff + 24); // ImageBase
    } else {
      buf.writeUInt32LE(0x00400000, optOff + 28); // ImageBase
    }
    buf.writeUInt32LE(0x1000, optOff + 32); // SectionAlignment
    buf.writeUInt32LE(0x0200, optOff + 36); // FileAlignment
    buf.writeUInt16LE(6, optOff + 40); // MajorOperatingSystemVersion
    buf.writeUInt16LE(6, optOff + 48); // MajorSubsystemVersion
    buf.writeUInt32LE(0x2000, optOff + 56); // SizeOfImage
    buf.writeUInt32LE(0x0200, optOff + 60); // SizeOfHeaders
    buf.writeUInt16LE(2, optOff + 68); // Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI
    buf.writeUInt32LE(16, optOff + (is64Bit ? 108 : 92)); // NumberOfRvaAndSizes = 16

    // Section 0 (.text) header at optOff + optHeaderSize
    const sec0 = optOff + optHeaderSize;
    buf.write('.text\0\0\0', sec0, 8, 'ascii');
    buf.writeUInt32LE(16, sec0 + 8); // VirtualSize
    buf.writeUInt32LE(0x1000, sec0 + 12); // VirtualAddress
    buf.writeUInt32LE(0x0200, sec0 + 16); // SizeOfRawData
    buf.writeUInt32LE(0x0200, sec0 + 20); // PointerToRawData
    buf.writeUInt32LE(0x60000020, sec0 + 36); // Characteristics

    // Write x86/x64 `xor eax, eax; ret` at offset 0x200
    buf[0x200] = 0x31;
    buf[0x201] = 0xc0;
    buf[0x202] = 0xc3;

    return buf;
  }

  /**
   * Builds a minimal valid Linux ELF binary header buffer.
   */
  public static createMinimalElfExecutable(is64Bit = true): Buffer {
    const elfBuf = Buffer.alloc(64, 0);
    elfBuf[0] = 0x7f;
    elfBuf[1] = 0x45; // 'E'
    elfBuf[2] = 0x4c; // 'L'
    elfBuf[3] = 0x46; // 'F'
    elfBuf[4] = is64Bit ? 2 : 1; // 64-bit or 32-bit
    elfBuf[5] = 1; // Little endian
    elfBuf[6] = 1; // ELF version
    return elfBuf;
  }

  /**
   * Builds a minimal valid macOS Mach-O 64-bit binary header buffer.
   */
  public static createMinimalMachOExecutable(): Buffer {
    const machoBuf = Buffer.alloc(64, 0);
    machoBuf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
    return machoBuf;
  }

  /**
   * Creates a synthetic platform-native executable buffer (`PE32+`, `ELF`, or `Mach-O`).
   */
  public static createSyntheticExecutable(
    platform: TargetPlatform,
    arch: TargetArch = 'x64'
  ): Buffer {
    if (platform === 'win') {
      return ExecutableAppBundler.createMinimalPeExecutable(arch !== 'ia32');
    }
    if (platform === 'osx') {
      return ExecutableAppBundler.createMinimalMachOExecutable();
    }
    return ExecutableAppBundler.createMinimalElfExecutable(arch !== 'ia32');
  }

  private static customizeExistingMacAppBundle(options: {
    appRootDir: string;
    appBundleName: string;
    arch: TargetArch;
    config: ResolvedReleasePackagerConfig;
    icnsBuffer: Buffer;
    warnings?: string[];
  }): { appBundleName: string; entries: VirtualFileEntry[] } {
    const rawEntries = ExecutableAppBundler.readPhysicalDirectory(
      options.appRootDir,
      options.config.excludePatterns
    );
    const outEntries: VirtualFileEntry[] = [];

    const macosFiles = rawEntries.filter(
      (e) => !e.isDirectory && e.relativePath.startsWith('Contents/MacOS/')
    );
    const primaryMacOsBin =
      macosFiles.find(
        (e) => path.basename(e.relativePath) === options.config.executableName
      ) ??
      macosFiles.find((e) => path.basename(e.relativePath) === 'nwjs') ??
      macosFiles[0];

    for (const entry of rawEntries) {
      if (entry.relativePath === '.nwjs-ready') {
        continue;
      }
      const rel = `${options.appBundleName}/${entry.relativePath}`;

      if (primaryMacOsBin && entry.relativePath === primaryMacOsBin.relativePath) {
        outEntries.push({
          ...entry,
          relativePath: `${options.appBundleName}/Contents/MacOS/${options.config.executableName}`,
          mode: 0o100755
        });
      } else if (entry.relativePath === 'Contents/Info.plist') {
        const updatedPlist = ExecutableAppBundler.generateMacInfoPlist(options.config);
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: Buffer.from(updatedPlist, 'utf8'),
          mode: 0o100644
        });
      } else if (entry.relativePath.endsWith('/InfoPlist.strings')) {
        const stringsContent = [
          `CFBundleName = "${options.config.productName}";`,
          `CFBundleDisplayName = "${options.config.productName}";`,
          `CFBundleGetInfoString = "${options.config.productName} ${options.config.version}, ${options.config.mac.copyright}";`,
          `NSHumanReadableCopyright = "${options.config.mac.copyright}";`,
          ''
        ].join('\n');
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: Buffer.from(stringsContent, 'utf8'),
          mode: 0o100644
        });
      } else if (
        entry.relativePath === 'Contents/Resources/app.icns' ||
        entry.relativePath === 'Contents/Resources/document.icns'
      ) {
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: options.icnsBuffer,
          mode: 0o100644
        });
      } else {
        outEntries.push({
          ...entry,
          relativePath: rel
        });
      }
    }

    const appIcnsRel = `${options.appBundleName}/Contents/Resources/app.icns`;
    if (!outEntries.some((e) => e.relativePath === appIcnsRel)) {
      outEntries.push({
        relativePath: appIcnsRel,
        data: options.icnsBuffer,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      });
    }

    const infoPlistRel = `${options.appBundleName}/Contents/Info.plist`;
    if (!outEntries.some((e) => e.relativePath === infoPlistRel)) {
      outEntries.push({
        relativePath: infoPlistRel,
        data: Buffer.from(ExecutableAppBundler.generateMacInfoPlist(options.config), 'utf8'),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      });
    }

    const extraEntries = ExecutableAppBundler.resolvePlatformExtraFiles(
      [],
      'osx',
      options.arch,
      options.config,
      options.warnings
    );
    const contentsSubdir = options.config.mac.contentsSubdir
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');

    for (const extra of extraEntries) {
      let targetRel: string;
      if (extra.relativePath.startsWith(`${options.appBundleName}/`)) {
        targetRel = extra.relativePath;
      } else if (extra.relativePath.startsWith('Contents/')) {
        targetRel = `${options.appBundleName}/${extra.relativePath}`;
      } else {
        targetRel = contentsSubdir
          ? `${options.appBundleName}/${contentsSubdir}/${extra.relativePath}`
          : `${options.appBundleName}/${extra.relativePath}`;
      }
      const existingIdx = outEntries.findIndex((e) => e.relativePath === targetRel);
      if (existingIdx >= 0) {
        outEntries[existingIdx] = { ...extra, relativePath: targetRel };
      } else {
        outEntries.push({ ...extra, relativePath: targetRel });
      }
    }

    return { appBundleName: options.appBundleName, entries: outEntries };
  }

  private static readInputPath(
    resolvedInput: string,
    excludePatterns: string[]
  ): VirtualFileEntry[] {
    const stat = fs.statSync(resolvedInput);
    if (stat.isDirectory()) {
      return ExecutableAppBundler.readPhysicalDirectory(resolvedInput, excludePatterns);
    }
    const lower = resolvedInput.toLowerCase();
    if (lower.endsWith('.zip')) {
      return ZipArchiveReader.readEntries(fs.readFileSync(resolvedInput));
    }
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
      return TarArchiveCodec.decodeTar(fs.readFileSync(resolvedInput));
    }
    return [
      {
        relativePath: path.basename(resolvedInput),
        data: fs.readFileSync(resolvedInput),
        isDirectory: false,
        isSymlink: false,
        mode: 0o100755,
        mtime: stat.mtime
      }
    ];
  }

  private static findMainExecutableIndex(
    entries: VirtualFileEntry[],
    platform: TargetPlatform,
    executableName: string,
    appName: string
  ): number {
    const expectedNames =
      platform === 'win'
        ? [`${executableName}.exe`, `${appName}.exe`, 'nw.exe']
        : [executableName, appName, 'nw', 'nwjs'];

    for (const expected of expectedNames) {
      const idx = entries.findIndex(
        (e) =>
          !e.isDirectory &&
          !e.isSymlink &&
          (e.relativePath === expected ||
            e.relativePath.toLowerCase() === expected.toLowerCase())
      );
      if (idx >= 0) {
        return idx;
      }
    }

    // Look for any root-level binary executable
    if (platform === 'win') {
      const rootExeIdx = entries.findIndex(
        (e) =>
          !e.isDirectory &&
          !e.isSymlink &&
          !e.relativePath.includes('/') &&
          e.relativePath.toLowerCase().endsWith('.exe')
      );
      if (rootExeIdx >= 0) {
        return rootExeIdx;
      }
    } else {
      const rootBinIdx = entries.findIndex(
        (e) =>
          !e.isDirectory &&
          !e.isSymlink &&
          !e.relativePath.includes('/') &&
          (ExecutableAppBundler.isBinaryExecutableHeader(e.data) || (e.mode & 0o111) !== 0)
      );
      if (rootBinIdx >= 0) {
        return rootBinIdx;
      }
    }

    return -1;
  }

  private static isBinaryExecutableHeader(buf: Buffer): boolean {
    if (buf.length < 4) return false;
    // ELF: 0x7F 'E' 'L' 'F'
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return true;
    }
    // Mach-O 64-bit / 32-bit / Universal (Fat) binary
    const magicLE = buf.readUInt32LE(0);
    if (
      magicLE === 0xfeedfacf ||
      magicLE === 0xfeedface ||
      magicLE === 0xcffaedfe ||
      magicLE === 0xcefaedfe ||
      magicLE === 0xbebafeca ||
      magicLE === 0xcafebabe
    ) {
      return true;
    }
    // PE ('MZ')
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return true;
    }
    // Shebang ('#!')
    if (buf[0] === 0x23 && buf[1] === 0x21) {
      return true;
    }
    return false;
  }
}
