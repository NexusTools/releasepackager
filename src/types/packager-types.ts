/**
 * Target operating system platforms supported by Release Packager.
 */
export type TargetPlatform = 'win' | 'linux' | 'osx';

/**
 * Target CPU architectures supported by Release Packager.
 */
export type TargetArch = 'x64' | 'ia32' | 'arm64';

/**
 * Supported release output package formats across platforms.
 */
export type PackageFormat =
  | 'win-zip'
  | 'win-msi'
  | 'mac-dmg'
  | 'linux-deb'
  | 'linux-flatpak'
  | 'linux-zip';

/**
 * Specification for an additional or platform-specific file to inject into the packaged application.
 * Supports copying a physical file (`source`) or generating file contents (`content`) per target
 * platform and architecture, with template variable expansion:
 * - `{platform}`: 'win' | 'osx' | 'linux'
 * - `{nodePlatform}`: 'win32' | 'darwin' | 'linux'
 * - `{arch}`: 'x64' | 'ia32' | 'arm64'
 * - `{ext}`: '.exe' on win, '' on osx/linux
 */
export interface ExtraFileSpec {
  /** Source file path on disk (relative to projectDir or absolute). Supports `{platform}`, `{nodePlatform}`, `{arch}`, `{ext}`. */
  source?: string;
  /** Inline string content to write directly to `destination` (e.g., generated config like `ffmpegconfig.js`). Supports placeholders. */
  content?: string;
  /** Destination path relative to the packaged application root (e.g., `bin/ffmpeg{ext}` or `src/ffmpegconfig.js`). Supports placeholders. */
  destination: string;
  /** Optional filter: only include this file when building for these target platforms. */
  platforms?: TargetPlatform[];
  /** Optional filter: only include this file when building for these target architectures. */
  arch?: TargetArch[];
  /** Whether the file should be marked executable (`0o100755`) in the package. */
  executable?: boolean;
  /** If true, missing `source` file records a warning instead of throwing an error. */
  optional?: boolean;
}

/**
 * Windows-specific configuration options.
 */
export interface WindowsTargetConfig {
  /** Architectures to build for Windows (default: ['x64']) */
  arch?: ('x64' | 'ia32' | 'arm64')[];
  /** Formats to produce for Windows (default: ['win-zip', 'win-msi']) */
  formats?: ('win-zip' | 'win-msi')[];
  /** Optional path to Windows executable binary (supports `{arch}` placeholder) */
  executable?: string;
  /** Optional path to Windows application directory or archive to package (supports `{arch}` placeholder) */
  inputDir?: string;
  /** Whether to inject custom icon and VS_VERSIONINFO into the Windows PE .exe (default: true) */
  modifyPeResources?: boolean;
  /** Path to .ico or .png icon file (optional; embedded into exe and MSI UI/shortcuts when provided) */
  icon?: string;
  /** Optional MSI-specific description shown on the initial Welcome/Description screen of the MSI installer */
  description?: string;
  /**
   * Default installation subdirectory path inside `C:\Program Files\` for the MSI installer
   * (e.g., `'NexusTools\\NXTConvert'`). Defaults to `productName` (`C:\Program Files\<productName>`).
   */
  installPath?: string;
  /** Company / Manufacturer name for PE version info and MSI installer */
  manufacturer?: string;
  /** Windows Installer UpgradeCode GUID (deterministic UUID generated from appId if omitted) */
  upgradeCode?: string;
  /** Create a Desktop shortcut during MSI installation (default: true) */
  createDesktopShortcut?: boolean;
  /** Create a Start Menu shortcut during MSI installation (default: true) */
  createStartMenuShortcut?: boolean;
  /** Legal copyright string embedded in PE resource and MSI */
  copyright?: string;
  /** Additional or generated files specific to Windows builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * macOS-specific configuration options.
 */
export interface MacTargetConfig {
  /** Architectures to build for macOS (default: ['x64', 'arm64']) */
  arch?: ('x64' | 'arm64')[];
  /** Formats to produce for macOS (default: ['mac-dmg']) */
  formats?: 'mac-dmg'[];
  /** Optional path to macOS executable binary (supports `{arch}` placeholder) */
  executable?: string;
  /** Optional path to macOS application directory, `.app` bundle, or archive (supports `{arch}` placeholder) */
  inputDir?: string;
  /** Optional path to an existing `<App>.app` bundle directory (supports `{arch}` placeholder) */
  appBundlePath?: string;
  /** Subdirectory inside `<ProductName>.app/` where companion files are placed (default: 'Contents/MacOS') */
  contentsSubdir?: string;
  /** Path to .icns or .png icon file */
  icon?: string;
  /**
   * Optional path to a custom PNG splash background image for the `.dmg` installer window.
   * When omitted, a default 600x400 splash background is generated showing the app on the left,
   * a directional arrow in the center, and the Applications folder on the right.
   */
  splashBackground?: string;
  /** macOS CFBundleIdentifier (e.g. 'com.example.myapp') */
  bundleId?: string;
  /** macOS LSApplicationCategoryType (default: 'public.app-category.utilities') */
  category?: string;
  /** macOS LSMinimumSystemVersion (default: '10.15.0') */
  minimumSystemVersion?: string;
  /** Custom volume name for the mounted .dmg image */
  volumeName?: string;
  /** Copyright string for Info.plist NSHumanReadableCopyright */
  copyright?: string;
  /** Additional or generated files specific to macOS builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * Linux-specific configuration options.
 */
export interface LinuxTargetConfig {
  /** Architectures to build for Linux (default: ['x64']) */
  arch?: ('x64' | 'ia32' | 'arm64')[];
  /** Formats to produce for Linux (default: ['linux-deb', 'linux-flatpak', 'linux-zip']) */
  formats?: ('linux-deb' | 'linux-flatpak' | 'linux-zip')[];
  /** Optional path to Linux executable binary (supports `{arch}` placeholder) */
  executable?: string;
  /** Optional path to Linux application directory or archive (supports `{arch}` placeholder) */
  inputDir?: string;
  /** Optional default command-line arguments passed by wrapper scripts to the executable */
  executableArgs?: string[];
  /** Path to .png icon file */
  icon?: string;
  /** Debian package maintainer (e.g. 'Name <email@example.com>') */
  maintainer?: string;
  /** Debian package section (default: 'utils') */
  section?: string;
  /** Debian package dependencies (default: []) */
  depends?: string[];
  /** Freedesktop .desktop categories (default: ['Utility', 'Application']) */
  categories?: string[];
  /** Flatpak runtime ID (default: 'org.freedesktop.Platform') */
  flatpakRuntime?: string;
  /** Flatpak runtime version (default: '23.08') */
  flatpakRuntimeVersion?: string;
  /** Flatpak SDK ID (default: 'org.freedesktop.Sdk') */
  flatpakSdk?: string;
  /** Flatpak finish-args / sandbox permissions */
  flatpakPermissions?: {
    shared?: string[];
    sockets?: string[];
    devices?: string[];
    filesystems?: string[];
  };
  /** Additional or generated files specific to Linux builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * Top-level configuration for the generic `@nexustools/releasepackager`.
 */
export interface ReleasePackagerConfig {
  /** Base project root directory used to resolve relative paths and package.json metadata (default: process.cwd()) */
  projectDir?: string;
  /** Optional directory containing application files and/or executables to package */
  inputDir?: string;
  /** Output directory for generated release artifacts (default: '<projectDir>/release') */
  outputDir?: string;
  /**
   * Path to the executable binary to package (relative to `projectDir` or absolute).
   * Supports `{platform}`, `{nodePlatform}`, `{arch}`, `{ext}` placeholders.
   */
  executable?: string;
  /**
   * Map of platform/architecture keys (`'<platform>-<arch>'`, `'<platform>'`, or `'*'`)
   * to executable binary paths.
   */
  executables?: Record<string, string>;
  /**
   * Map of platform/architecture keys (`'<platform>-<arch>'`, `'<platform>'`, or `'*'`)
   * to input directories, `.app` bundles, or `.zip`/`.tar.gz` archives.
   */
  inputs?: Record<string, string>;
  /**
   * Whether to also bundle files from `projectDir` when `executable` is a standalone file
   * and no explicit `inputDir` was provided (default: false).
   */
  includeProjectFiles?: boolean;
  /** Application internal name / slug (defaults to package.json name) */
  appName?: string;
  /** Human-readable product display name (defaults to package.json productName or appName) */
  productName?: string;
  /** Application version (defaults to package.json version) */
  version?: string;
  /** Application description (defaults to package.json description) */
  description?: string;
  /** Reverse-DNS application ID (e.g., 'io.nexustools.myapp') */
  appId?: string;
  /** Author / Publisher name */
  author?: string;
  /** Homepage URL */
  homepage?: string;
  /** License identifier (default: 'MIT') */
  license?: string;
  /** Executable binary base name without extension (defaults to sanitized appName) */
  executableName?: string;
  /** Glob/prefix patterns of project files to exclude from packaging */
  excludePatterns?: string[];
  /** Additional or generated files to inject into packaged releases across platforms/architectures */
  extraFiles?: ExtraFileSpec[];
  /** Default icon path (.png, .ico, or .icns) used if platform-specific icon is not set */
  icon?: string;
  /** Target platforms to build (default: ['win', 'osx', 'linux']) */
  platforms?: TargetPlatform[];
  /** Windows target configuration */
  win?: WindowsTargetConfig;
  /** macOS target configuration */
  mac?: MacTargetConfig;
  /** Linux target configuration */
  linux?: LinuxTargetConfig;
  /** Optional progress callback invoked during packaging stages */
  onProgress?: (stage: string, detail: string) => void;
}

/**
 * Fully resolved and normalized configuration used by `@nexustools/releasepackager` builders.
 */
export interface ResolvedReleasePackagerConfig {
  projectDir: string;
  inputDir?: string;
  outputDir: string;
  executable?: string;
  executables: Record<string, string>;
  inputs: Record<string, string>;
  includeProjectFiles: boolean;
  appName: string;
  productName: string;
  version: string;
  description: string;
  appId: string;
  author: string;
  homepage: string;
  license: string;
  executableName: string;
  excludePatterns: string[];
  extraFiles: ExtraFileSpec[];
  icon?: string;
  platforms: TargetPlatform[];
  win: Required<
    Omit<WindowsTargetConfig, 'icon' | 'description' | 'executable' | 'inputDir'>
  > & {
    icon?: string;
    description?: string;
    executable?: string;
    inputDir?: string;
  };
  mac: Required<
    Omit<MacTargetConfig, 'icon' | 'splashBackground' | 'executable' | 'inputDir' | 'appBundlePath'>
  > & {
    icon?: string;
    splashBackground?: string;
    executable?: string;
    inputDir?: string;
    appBundlePath?: string;
  };
  linux: Required<Omit<LinuxTargetConfig, 'icon' | 'executable' | 'inputDir'>> & {
    icon?: string;
    executable?: string;
    inputDir?: string;
  };
  onProgress?: (stage: string, detail: string) => void;
}

/**
 * Details of a single generated release artifact.
 */
export interface ReleaseArtifact {
  platform: TargetPlatform;
  arch: TargetArch;
  format: PackageFormat;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Result of running the generic Release Packager across all requested targets.
 */
export interface ReleasePackagerBuildResult {
  appName: string;
  productName: string;
  version: string;
  artifacts: ReleaseArtifact[];
  warnings: string[];
  durationMs: number;
}
