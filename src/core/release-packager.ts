import {
  ReleaseArtifact,
  ReleasePackagerBuildResult,
  ReleasePackagerConfig,
  ResolvedReleasePackagerConfig
} from '../types/packager-types.js';
import { ReleaseConfigLoader } from '../config/release-config-loader.js';
import { ExecutableAppBundler } from './executable-app-bundler.js';
import { WindowsZipBuilder } from '../builders/windows-zip-builder.js';
import { WindowsMsiBuilder } from '../builders/windows-msi-builder.js';
import { MacDmgBuilder } from '../builders/mac-dmg-builder.js';
import { LinuxZipBuilder } from '../builders/linux-zip-builder.js';
import { LinuxDebBuilder } from '../builders/linux-deb-builder.js';
import { LinuxFlatpakBuilder } from '../builders/linux-flatpak-builder.js';

/**
 * Primary orchestrator for packaging any standalone executable, application directory,
 * or `.app` bundle across Windows (`.zip`, `.msi`), macOS (`.dmg` with drag-to-Applications `.app`),
 * and Linux (`.deb`, `.flatpak`, `.zip`).
 */
export class ReleasePackager {
  private readonly config: ResolvedReleasePackagerConfig;

  public constructor(options: ReleasePackagerConfig = {}, explicitConfigPath?: string) {
    this.config = ReleaseConfigLoader.resolve(options, explicitConfigPath);
  }

  /**
   * Returns the resolved release packager configuration.
   */
  public getResolvedConfig(): ResolvedReleasePackagerConfig {
    return this.config;
  }

  /**
   * Executes the full packaging pipeline across all configured platforms and output formats.
   */
  public async packageAll(options?: {
    useSyntheticExecutableIfMissing?: boolean;
  }): Promise<ReleasePackagerBuildResult> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const artifacts: ReleaseArtifact[] = [];

    // 1. Windows Releases (.zip, .msi)
    if (this.config.platforms.includes('win')) {
      for (const arch of this.config.win.arch) {
        this.config.onProgress?.('stage-win', `Staging Windows (${arch}) release bundle`);
        const stagedEntries = ExecutableAppBundler.stageWinOrLinuxRelease({
          platform: 'win',
          arch,
          config: this.config,
          useSyntheticExecutableIfMissing: options?.useSyntheticExecutableIfMissing,
          warnings
        });

        if (this.config.win.formats.includes('win-zip')) {
          this.config.onProgress?.('build-win-zip', `Building Windows (${arch}) ZIP release`);
          artifacts.push(
            WindowsZipBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.win.formats.includes('win-msi')) {
          this.config.onProgress?.('build-win-msi', `Building Windows (${arch}) MSI installer`);
          artifacts.push(
            WindowsMsiBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }
      }
    }

    // 2. macOS Releases (.dmg with .app and /Applications symlink)
    if (this.config.platforms.includes('osx')) {
      for (const arch of this.config.mac.arch) {
        this.config.onProgress?.('stage-mac', `Staging macOS (${arch}) .app bundle`);
        const { appBundleName, entries: stagedAppEntries } = ExecutableAppBundler.stageMacAppBundle({
          arch,
          config: this.config,
          useSyntheticExecutableIfMissing: options?.useSyntheticExecutableIfMissing,
          warnings
        });

        if (this.config.mac.formats.includes('mac-dmg')) {
          this.config.onProgress?.('build-mac-dmg', `Building macOS (${arch}) mountable DMG`);
          artifacts.push(
            MacDmgBuilder.build({
              config: this.config,
              arch,
              appBundleName,
              stagedAppEntries
            })
          );
        }
      }
    }

    // 3. Linux Releases (.deb, .flatpak, .zip)
    if (this.config.platforms.includes('linux')) {
      for (const arch of this.config.linux.arch) {
        this.config.onProgress?.('stage-linux', `Staging Linux (${arch}) release bundle`);
        const stagedEntries = ExecutableAppBundler.stageWinOrLinuxRelease({
          platform: 'linux',
          arch,
          config: this.config,
          useSyntheticExecutableIfMissing: options?.useSyntheticExecutableIfMissing,
          warnings
        });

        if (this.config.linux.formats.includes('linux-deb')) {
          this.config.onProgress?.('build-linux-deb', `Building Linux (${arch}) Debian .deb package`);
          artifacts.push(
            LinuxDebBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.linux.formats.includes('linux-flatpak')) {
          this.config.onProgress?.(
            'build-linux-flatpak',
            `Building Linux (${arch}) Flatpak .flatpak bundle`
          );
          artifacts.push(
            LinuxFlatpakBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.linux.formats.includes('linux-zip')) {
          this.config.onProgress?.('build-linux-zip', `Building Linux (${arch}) ZIP release`);
          artifacts.push(
            LinuxZipBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }
      }
    }

    return {
      appName: this.config.appName,
      productName: this.config.productName,
      version: this.config.version,
      artifacts,
      warnings,
      durationMs: Date.now() - startTime
    };
  }
}
