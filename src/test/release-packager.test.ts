import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import {
  ReleasePackager,
  ExecutableAppBundler,
  ZipArchiveReader,
  TarArchiveCodec,
  IcoCodec,
  IcnsCodec
} from '../index.js';

describe('@nexustools/releasepackager end-to-end suite', () => {
  it('packages any standalone executable into win-zip, win-msi, mac-dmg, linux-deb, linux-flatpak, and linux-zip in pure Node.js', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-packager-test-'));

    try {
      const projectDir = path.join(tmpRoot, 'native-app');
      const buildDir = path.join(projectDir, 'build');
      const outputDir = path.join(tmpRoot, 'release');
      fs.mkdirSync(path.join(buildDir, 'win-x64'), { recursive: true });
      fs.mkdirSync(path.join(buildDir, 'osx-x64'), { recursive: true });
      fs.mkdirSync(path.join(buildDir, 'linux-x64'), { recursive: true });

      // Create standalone native executables for Windows (PE32+), macOS (Mach-O), and Linux (ELF)
      const winExePath = path.join(buildDir, 'win-x64', 'my-native-tool.exe');
      const macBinPath = path.join(buildDir, 'osx-x64', 'my-native-tool');
      const linuxBinPath = path.join(buildDir, 'linux-x64', 'my-native-tool');

      fs.writeFileSync(winExePath, ExecutableAppBundler.createMinimalPeExecutable(true));
      fs.writeFileSync(macBinPath, ExecutableAppBundler.createMinimalMachOExecutable());
      fs.writeFileSync(linuxBinPath, ExecutableAppBundler.createMinimalElfExecutable(true));

      const customIconPath = path.join(projectDir, 'icon.png');
      fs.writeFileSync(customIconPath, IcoCodec.createDefaultPngIcon(64));

      const packager = new ReleasePackager({
        projectDir,
        outputDir,
        appName: 'my-native-tool',
        productName: 'NativeStudio',
        version: '3.2.0',
        description: 'Cross-platform Standalone Executable Application',
        appId: 'io.nexustools.nativestudio',
        author: 'NexusTools',
        license: 'MIT',
        icon: customIconPath,
        executable: './build/{platform}-{arch}/my-native-tool{ext}',
        extraFiles: [
          {
            content: 'platform={platform}\narch={arch}\n',
            destination: 'config/target-info.txt'
          }
        ],
        platforms: ['win', 'osx', 'linux'],
        win: {
          arch: ['x64'],
          formats: ['win-zip', 'win-msi'],
          installPath: 'NexusTools\\NativeStudio',
          description: 'Custom MSI Welcome Screen Description for Standalone Executable'
        },
        mac: {
          arch: ['x64'],
          formats: ['mac-dmg']
        },
        linux: {
          arch: ['x64'],
          formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
        }
      });

      const result = await packager.packageAll();
      assert.equal(result.artifacts.length, 6);
      assert.equal(result.warnings.length, 0);

      // 1. Verify Windows ZIP
      const winZip = result.artifacts.find((a) => a.format === 'win-zip');
      assert.ok(winZip, 'win-zip artifact should be generated');
      const winZipEntries = ZipArchiveReader.readEntries(fs.readFileSync(winZip.filePath));
      const exeEntry = winZipEntries.find((e) => e.relativePath.endsWith('/my-native-tool.exe'));
      assert.ok(exeEntry, 'Windows ZIP should contain my-native-tool.exe');
      assert.equal(exeEntry.data.readUInt16LE(0), 0x5a4d, 'Windows EXE should have MZ header');
      assert.ok(
        exeEntry.data.includes(Buffer.from('.rsrc', 'ascii')),
        'Windows EXE should have injected .rsrc PE resource section'
      );
      const winTargetInfo = winZipEntries.find((e) =>
        e.relativePath.endsWith('/config/target-info.txt')
      );
      assert.ok(winTargetInfo, 'Windows ZIP should include expanded extraFile');
      assert.equal(winTargetInfo.data.toString('utf8'), 'platform=win\narch=x64\n');

      // 2. Verify Windows MSI
      const winMsi = result.artifacts.find((a) => a.format === 'win-msi');
      assert.ok(winMsi, 'win-msi artifact should be generated');
      const msiBuf = fs.readFileSync(winMsi.filePath);
      assert.deepEqual(
        msiBuf.subarray(0, 8),
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        'MSI should start with OLE2 CFBF signature'
      );
      assert.ok(
        msiBuf.includes(Buffer.from('MSCF', 'ascii')),
        'MSI should embed MSCF Cabinet stream'
      );
      assert.ok(
        msiBuf.includes(Buffer.from('WelcomeDlg', 'utf8')),
        'MSI should include initial WelcomeDlg description screen'
      );
      assert.ok(
        msiBuf.includes(
          Buffer.from('Custom MSI Welcome Screen Description for Standalone Executable', 'utf8')
        ),
        'MSI should include custom description text'
      );
      assert.ok(
        msiBuf.includes(Buffer.from('INSTALLPARENT_1', 'utf8')),
        'MSI should configure custom Program Files subdirectory hierarchy'
      );

      // 3. Verify macOS DMG (wrapping standalone Mach-O binary into NativeStudio.app)
      const macDmg = result.artifacts.find((a) => a.format === 'mac-dmg');
      assert.ok(macDmg, 'mac-dmg artifact should be generated');
      const dmgBuf = fs.readFileSync(macDmg.filePath);
      const kolyFooter = dmgBuf.subarray(dmgBuf.length - 512);
      assert.equal(
        kolyFooter.subarray(0, 4).toString('ascii'),
        'koly',
        'DMG must end with 512-byte koly UDIF trailer'
      );
      const xmlOffset = Number(kolyFooter.readBigUInt64BE(216));
      const xmlLength = Number(kolyFooter.readBigUInt64BE(224));
      const plistStr = dmgBuf.subarray(xmlOffset, xmlOffset + xmlLength).toString('utf8');
      assert.ok(plistStr.includes('<key>blkx</key>'), 'DMG XML plist must contain blkx table');

      const decompressedFirstChunk = zlib.inflateSync(dmgBuf.subarray(0, xmlOffset));
      assert.equal(
        decompressedFirstChunk.subarray(1024, 1026).toString('ascii'),
        'H+',
        'DMG HFS+ partition must have H+ Volume Header at offset 1024'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('/Applications', 'utf8')),
        'DMG HFS+ volume must contain /Applications symlink target'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('.background/background.png', 'utf8')),
        'DMG .DS_Store must reference .background/background.png splash image'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('io.nexustools.nativestudio', 'utf8')),
        'DMG HFS+ volume must contain customized Info.plist bundle identifier'
      );

      // 4. Verify Linux DEB
      const linuxDeb = result.artifacts.find((a) => a.format === 'linux-deb');
      assert.ok(linuxDeb, 'linux-deb artifact should be generated');
      const debBuf = fs.readFileSync(linuxDeb.filePath);
      assert.equal(
        debBuf.subarray(0, 8).toString('ascii'),
        '!<arch>\n',
        'DEB must start with UNIX ar signature'
      );
      assert.ok(
        debBuf.includes(Buffer.from('debian-binary', 'ascii')),
        'DEB must contain debian-binary member'
      );
      assert.ok(
        debBuf.includes(Buffer.from('control.tar.gz', 'ascii')),
        'DEB must contain control.tar.gz member'
      );
      assert.ok(
        debBuf.includes(Buffer.from('data.tar.gz', 'ascii')),
        'DEB must contain data.tar.gz member'
      );

      // 5. Verify Linux Flatpak
      const linuxFlatpak = result.artifacts.find((a) => a.format === 'linux-flatpak');
      assert.ok(linuxFlatpak, 'linux-flatpak artifact should be generated');
      const flatpakBuf = fs.readFileSync(linuxFlatpak.filePath);
      assert.equal(
        flatpakBuf.subarray(0, 8).toString('ascii'),
        'flatpak\0',
        'Flatpak bundle must start with flatpak\\0 header'
      );
      assert.ok(
        flatpakBuf.includes(Buffer.from('app/io.nexustools.nativestudio/x86_64/stable', 'utf8')),
        'Flatpak bundle must contain GVariant ref entry'
      );

      // 6. Verify Linux ZIP
      const linuxZip = result.artifacts.find((a) => a.format === 'linux-zip');
      assert.ok(linuxZip, 'linux-zip artifact should be generated');
      const linuxZipEntries = ZipArchiveReader.readEntries(fs.readFileSync(linuxZip.filePath));
      const linuxExe = linuxZipEntries.find((e) => e.relativePath.endsWith('/my-native-tool'));
      assert.ok(linuxExe, 'Linux ZIP must contain executable');
      assert.equal(
        linuxExe.mode & 0o755,
        0o755,
        'Linux executable in ZIP must preserve 0755 permissions'
      );
      assert.ok(
        linuxZipEntries.some((e) => e.relativePath.endsWith('.desktop')),
        'Linux ZIP must include a .desktop entry file'
      );

      // 7. Verify TarArchiveCodec and IcnsCodec round-trip
      const tarGz = TarArchiveCodec.encodeTarGz([
        {
          relativePath: 'folder/test.sh',
          data: Buffer.from('#!/bin/sh\necho ok\n', 'utf8'),
          isDirectory: false,
          isSymlink: false,
          mode: 0o100755,
          mtime: new Date()
        }
      ]);
      const decodedTar = TarArchiveCodec.decodeTar(tarGz);
      assert.equal(decodedTar.length, 1);
      assert.equal(decodedTar[0].relativePath, 'folder/test.sh');
      assert.equal(decodedTar[0].mode & 0o755, 0o755);

      const icns = IcnsCodec.toIcnsBuffer();
      assert.ok(IcnsCodec.isIcns(icns));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
