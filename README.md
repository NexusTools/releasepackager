# `@nexustools/releasepackager`

Pure Node.js, cross-platform **Executable & Application Release Packager** generating native installers and archives for **Windows**, **macOS**, and **Linux** from any host operating system with **zero external tool dependencies**.

Supports packaging **any executable** (compiled C/C++, Rust, Go, Zig, .NET, Python, Node SEA, custom runtimes, or multi-file application directories):

- **Windows**:
  - **`.zip` Release (`win-zip`)**: Portable application directory with renamed `<executable>.exe`, injected PE32/PE32+ `.rsrc` icons (`RT_ICON`, `RT_GROUP_ICON`) and `VS_VERSIONINFO` (`RT_VERSION`).
  - **`.msi` Installer (`win-msi`)**: Spec-compliant Windows Installer OLE2 Compound File (`.msi`) with embedded Microsoft Cabinet (`media1.cab`), interactive visual wizard (`WelcomeDlg` description & icon screen + `InstallDirDlg` & `BrowseDlg` folder picker), configurable `C:\Program Files\<installPath>` installation directory, Desktop & Start Menu shortcuts, and Add/Remove Programs metadata.
- **macOS**:
  - **Mountable `.dmg` Disk Image (`mac-dmg`)**: Apple Universal Disk Image Format (`koly` trailer + `blkx` `Mish` zlib-compressed blocks) wrapping a native **HFS+ (Mac OS Extended)** filesystem containing `<ProductName>.app` (automatically wrapping standalone Mach-O binaries or customizing existing `.app` bundles with `Contents/Info.plist`, `app.icns`, and `InfoPlist.strings`), a Finder `.DS_Store` icon-view layout, a `.background/background.png` splash image (customizable via `mac.splashBackground` or auto-generated with the app on the left, an arrow in the center, and Applications on the right), and a `/Applications` symbolic link for drag-and-drop installation into `Applications`.
- **Linux**:
  - **Debian `.deb` Package (`linux-deb`)**: Standard UNIX `ar` archive (`debian-binary`, `control.tar.gz`, `data.tar.gz`) installing into `/opt/<app>`, `/usr/bin/<app>`, `/usr/share/applications/<app>.desktop`, and `/usr/share/icons/hicolor/256x256/apps/<app>.png`.
  - **Flatpak Single-File Bundle (`linux-flatpak`)**: Self-contained `.flatpak` GVariant + OSTree static-delta bundle with sandbox permissions, `.desktop` export, and AppStream MetaInfo XML.
  - **`.zip` Release (`linux-zip`)**: Portable archive preserving POSIX `0755` executable mode bits in the ZIP central directory alongside a `.desktop` launcher.

---

## CLI Usage

```bash
# Generate a starter releasepackager.json config file
npx releasepackager --init

# Package any executable across Windows, macOS, and Linux
npx releasepackager --executable ./build/{platform}-{arch}/myapp{ext} --product-name "My App" --version 1.0.0

# Package an application directory for Windows (.zip, .msi)
npx releasepackager --input ./dist/win-x64 --platforms win --formats win-zip,win-msi
```

---

## Programmatic API

```typescript
import { ReleasePackager } from '@nexustools/releasepackager';

const packager = new ReleasePackager({
  projectDir: './my-project',
  outputDir: './release',
  appName: 'my-app',
  productName: 'My App',
  version: '1.0.0',
  appId: 'io.nexustools.myapp',
  executables: {
    'win-x64': './build/win-x64/my-app.exe',
    'osx-x64': './build/osx-x64/my-app',
    'osx-arm64': './build/osx-arm64/my-app',
    'linux-x64': './build/linux-x64/my-app'
  },
  platforms: ['win', 'osx', 'linux'],
  win: {
    arch: ['x64'],
    formats: ['win-zip', 'win-msi'],
    manufacturer: 'NexusTools',
    installPath: 'NexusTools\\MyApp',
    description: 'High-performance cross-platform desktop application',
    icon: './assets/icon.ico'
  },
  mac: {
    arch: ['x64', 'arm64'],
    formats: ['mac-dmg'],
    splashBackground: './assets/dmg-splash.png' // optional; auto-generated if omitted
  },
  linux: {
    arch: ['x64'],
    formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
  }
});

const result = await packager.packageAll();
console.log(result.artifacts);
```
