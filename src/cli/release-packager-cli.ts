import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PackageFormat,
  ReleasePackagerConfig,
  TargetPlatform
} from '../types/packager-types.js';
import { ReleasePackager } from '../core/release-packager.js';

/**
 * Command-line interface runner for `@nexustools/releasepackager`.
 */
export class ReleasePackagerCli {
  /**
   * Parses CLI arguments and executes the generic release packager.
   */
  public static async run(argv: string[]): Promise<number> {
    const args = argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      ReleasePackagerCli.printHelp();
      return 0;
    }

    let explicitConfigPath: string | undefined;
    let initConfig = false;
    let useSyntheticExe = false;
    const overrides: ReleasePackagerConfig = {};
    let selectedFormats: PackageFormat[] | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const next = (): string => {
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for flag ${arg}`);
        }
        return args[++i];
      };

      switch (arg) {
        case '--init':
          initConfig = true;
          break;
        case '--project':
        case '-p':
          overrides.projectDir = next();
          break;
        case '--input':
        case '-i':
          overrides.inputDir = next();
          break;
        case '--executable':
        case '-e':
          overrides.executable = next();
          break;
        case '--config':
        case '-c':
          explicitConfigPath = next();
          break;
        case '--output':
        case '-o':
          overrides.outputDir = next();
          break;
        case '--version':
        case '-v':
          overrides.version = next();
          break;
        case '--platforms':
          overrides.platforms = next()
            .split(',')
            .map((s) => s.trim() as TargetPlatform)
            .filter(Boolean);
          break;
        case '--formats':
          selectedFormats = next()
            .split(',')
            .map((s) => s.trim() as PackageFormat)
            .filter(Boolean);
          break;
        case '--icon':
          overrides.icon = next();
          break;
        case '--app-name':
          overrides.appName = next();
          break;
        case '--product-name':
          overrides.productName = next();
          break;
        case '--executable-name':
          overrides.executableName = next();
          break;
        case '--app-id':
          overrides.appId = next();
          break;
        case '--synthetic-executable':
          useSyntheticExe = true;
          break;
        default:
          if (!arg.startsWith('-') && !overrides.projectDir) {
            overrides.projectDir = arg;
          }
          break;
      }
    }

    if (initConfig) {
      const targetDir = path.resolve(overrides.projectDir ?? process.cwd());
      const outPath = path.join(targetDir, 'releasepackager.json');
      const starterConfig: ReleasePackagerConfig = {
        executable: './build/{platform}-{arch}/app{ext}',
        outputDir: 'release',
        platforms: ['win', 'osx', 'linux'],
        win: {
          arch: ['x64'],
          formats: ['win-zip', 'win-msi'],
          createDesktopShortcut: true,
          createStartMenuShortcut: true
        },
        mac: {
          arch: ['x64', 'arm64'],
          formats: ['mac-dmg']
        },
        linux: {
          arch: ['x64'],
          formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
        }
      };
      fs.writeFileSync(outPath, JSON.stringify(starterConfig, null, 2) + '\n', 'utf8');
      console.log(`Created starter configuration at ${outPath}`);
      return 0;
    }

    if (selectedFormats && selectedFormats.length > 0) {
      const winFormats = selectedFormats.filter(
        (f): f is 'win-zip' | 'win-msi' => f === 'win-zip' || f === 'win-msi'
      );
      const macFormats = selectedFormats.filter((f): f is 'mac-dmg' => f === 'mac-dmg');
      const linuxFormats = selectedFormats.filter(
        (f): f is 'linux-deb' | 'linux-flatpak' | 'linux-zip' =>
          f === 'linux-deb' || f === 'linux-flatpak' || f === 'linux-zip'
      );
      overrides.win = { ...(overrides.win ?? {}), formats: winFormats };
      overrides.mac = { ...(overrides.mac ?? {}), formats: macFormats };
      overrides.linux = { ...(overrides.linux ?? {}), formats: linuxFormats };
    }

    overrides.onProgress = (stage: string, detail: string) => {
      console.log(`[${stage}] ${detail}`);
    };

    const packager = new ReleasePackager(overrides, explicitConfigPath);
    const result = await packager.packageAll({
      useSyntheticExecutableIfMissing: useSyntheticExe
    });

    if (result.warnings.length > 0) {
      console.warn('\nWarnings:');
      for (const w of result.warnings) {
        console.warn(`  - ${w}`);
      }
    }

    console.log(
      `\nPackaged ${result.productName} v${result.version} in ${result.durationMs}ms:`
    );
    for (const artifact of result.artifacts) {
      const kb = (artifact.sizeBytes / 1024).toFixed(1);
      console.log(
        `  - [${artifact.format}] ${artifact.fileName} (${kb} KB) sha256:${artifact.sha256.slice(0, 16)}...`
      );
    }

    return 0;
  }

  private static printHelp(): void {
    console.log(`
@nexustools/releasepackager - Pure Node.js Cross-Platform Executable & Application Release Packager

Usage:
  releasepackager [projectDir] [options]

Options:
  -p, --project <dir>         Path to project root directory (default: current directory)
  -e, --executable <path>     Path to executable binary (supports {platform}, {arch}, {ext})
  -i, --input <dir|archive>   Path to application directory or archive to package
  -c, --config <file>         Path to explicit config JSON file
  -o, --output <dir>          Output directory for release packages (default: ./release)
  -v, --version <ver>         Application version (default: from package.json or 1.0.0)
  --platforms <list>          Comma-separated platforms: win,osx,linux
  --formats <list>            Comma-separated formats: win-zip,win-msi,mac-dmg,linux-deb,linux-flatpak,linux-zip
  --icon <file>               Default application icon (.png, .ico, .icns)
  --app-name <slug>           Override application internal name
  --product-name <name>       Override human-readable display name
  --executable-name <name>    Override output executable binary base name
  --app-id <id>               Override reverse-DNS application ID (e.g. io.nexustools.app)
  --synthetic-executable      Fallback to synthetic native executable if missing
  --init                      Generate a starter releasepackager.json in projectDir
  -h, --help                  Display this help message
`);
  }
}
