import { CfbWriter } from './cfb-writer.js';
import { CabArchiveWriter } from './cab-archive-writer.js';
import { ReleaseConfigLoader } from '../config/release-config-loader.js';
import { MsiFileEntry } from '../types/binary-types.js';
import { TargetArch } from '../types/packager-types.js';

interface MsiColumnDef {
  name: string;
  /** 's' = string, 'i2' = 16-bit int, 'i4' = 32-bit int, 'v' = binary stream */
  kind: 's' | 'i2' | 'i4' | 'v';
  typeCode: number;
  isPrimaryKey?: boolean;
}

interface MsiTableDef {
  name: string;
  columns: MsiColumnDef[];
  rows: (string | number | null)[][];
}

/**
 * Pure Node.js Windows Installer (`.msi`) relational database and OLE2 package builder.
 * Generates `_Tables`, `_Columns`, `_StringPool`, `_StringData`, standard MSI installer tables,
 * `\x05SummaryInformation` property set stream, and embedded `media1.cab` archive.
 */
export class MsiDatabaseBuilder {
  /**
   * Builds a complete `.msi` installer binary Buffer for a packaged Windows application directory.
   */
  public static buildMsi(options: {
    productName: string;
    productVersion: string;
    manufacturer: string;
    description?: string;
    installPath?: string;
    upgradeCode: string;
    arch: TargetArch;
    executableName: string;
    iconBuffer?: Buffer;
    createDesktopShortcut: boolean;
    createStartMenuShortcut: boolean;
    helpLink?: string;
    files: { relativePath: string; data: Buffer }[];
  }): Buffer {
    const descriptionText =
      options.description && options.description.trim().length > 0
        ? options.description.trim()
        : `${options.productName} Application`;
    const hasIcon = Boolean(options.iconBuffer && options.iconBuffer.length > 0);
    const is64Bit = options.arch === 'x64' || options.arch === 'arm64';

    const productCode = ReleaseConfigLoader.deterministicGuid(
      `msi-product:${options.upgradeCode}:${options.productVersion}:${options.arch}`
    );
    const packageCode = ReleaseConfigLoader.deterministicGuid(
      `msi-package:${productCode}:${Date.now()}`
    );

    const programFilesRootKey = is64Bit ? 'ProgramFiles64Folder' : 'ProgramFilesFolder';

    // Parse installPath (e.g., "NexusTools\\NXTConvert" or default to productName)
    const rawInstallPath = (options.installPath ?? options.productName)
      .replace(/\\/g, '/')
      .replace(/^[A-Za-z]:\/Program Files(?: \(x86\))?\//i, '')
      .replace(/^Program\s*Files(?:64Folder|Folder)?\//i, '')
      .replace(/^\/+|\/+$/g, '');
    const installSegments = rawInstallPath
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (installSegments.length === 0) {
      installSegments.push(options.productName);
    }

    const installParentDirs: { key: string; parentKey: string; defaultDir: string }[] = [];
    let currentInstallParentKey = programFilesRootKey;
    for (let i = 0; i < installSegments.length - 1; i++) {
      const parentKey = `INSTALLPARENT_${i + 1}`;
      installParentDirs.push({
        key: parentKey,
        parentKey: currentInstallParentKey,
        defaultDir: MsiDatabaseBuilder.formatDefaultDir(installSegments[i], 900 + i)
      });
      currentInstallParentKey = parentKey;
    }
    const leafInstallFolderName = installSegments[installSegments.length - 1];

    // Organize directories and files into MSI Directory / Component / File records
    const dirMap = new Map<string, { key: string; parentKey: string; defaultDir: string }>();
    dirMap.set('', {
      key: 'INSTALLDIR',
      parentKey: currentInstallParentKey,
      defaultDir: MsiDatabaseBuilder.formatDefaultDir(leafInstallFolderName, 1)
    });

    let dirCounter = 1;
    const ensureDirKey = (relDir: string): string => {
      const normalized = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (dirMap.has(normalized)) {
        return dirMap.get(normalized)!.key;
      }
      const parts = normalized.split('/');
      const leafName = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parentKey = ensureDirKey(parentPath);
      const key = `DIR_${String(dirCounter++).padStart(4, '0')}`;
      dirMap.set(normalized, {
        key,
        parentKey,
        defaultDir: MsiDatabaseBuilder.formatDefaultDir(leafName, dirCounter)
      });
      return key;
    };

    const msiFiles: MsiFileEntry[] = [];
    const mainExeTarget = `${options.executableName}.exe`.toLowerCase();

    for (let i = 0; i < options.files.length; i++) {
      const f = options.files[i];
      const rel = f.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const lastSlash = rel.lastIndexOf('/');
      const relDir = lastSlash >= 0 ? rel.slice(0, lastSlash) : '';
      const baseName = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;

      const directoryKey = ensureDirKey(relDir);
      const seq = i + 1;
      const fileKey = `File_${String(seq).padStart(4, '0')}`;
      const componentKey = `Comp_${String(seq).padStart(4, '0')}`;
      const fileNameField = MsiDatabaseBuilder.formatDefaultDir(baseName, seq);

      msiFiles.push({
        fileKey,
        componentKey,
        directoryKey,
        fileNameField,
        longFileName: baseName,
        relativePath: rel,
        fileSize: f.data.length,
        data: f.data,
        sequence: seq,
        isMainExecutable: relDir === '' && baseName.toLowerCase() === mainExeTarget
      });
    }

    const mainExeEntry = msiFiles.find((f) => f.isMainExecutable) ?? msiFiles[0];

    // Build relational tables using exact Windows Installer _Columns typeCode flags:
    // - 0x2000 = Primary Key
    // - 0x1000 = Nullable
    // - 0x0800 = String / Object
    // - 0x0400 = Short (2-byte integer) or Fixed-length string
    // - 0x0200 = Localizable string
    // - 0x0100 = Persistent table column
    const tables: MsiTableDef[] = [];

    // 1. Property table
    const propertyRows: (string | number | null)[][] = [
      ['ALLUSERS', '1'],
      ['MSIFASTINSTALL', '7'],
      ['DefaultUIFont', 'DlgFont8'],
      ['ErrorDialog', 'ErrorDlg'],
      ['_BrowseProperty', 'INSTALLDIR'],
      ['ARPHELPLINK', options.helpLink ?? 'https://github.com/NexusTools'],
      ['Manufacturer', options.manufacturer],
      ['ProductCode', productCode],
      ['ProductLanguage', '1033'],
      ['ProductName', options.productName],
      ['ProductVersion', MsiDatabaseBuilder.normalizeMsiVersion(options.productVersion)],
      ['UpgradeCode', options.upgradeCode]
    ];
    if (hasIcon) {
      propertyRows.push(['ARPPRODUCTICON', 'AppIcon.ico']);
    }
    tables.push({
      name: 'Property',
      columns: [
        { name: 'Property', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Value', kind: 's', typeCode: 0x0f00 }
      ],
      rows: propertyRows
    });

    // 2. Directory table
    const directoryRows: (string | number | null)[][] = [
      ['TARGETDIR', null, 'SourceDir'],
      [programFilesRootKey, 'TARGETDIR', '.'],
      ['ProgramMenuFolder', 'TARGETDIR', '.'],
      [
        'ApplicationProgramsFolder',
        'ProgramMenuFolder',
        MsiDatabaseBuilder.formatDefaultDir(options.productName, 999)
      ],
      ['DesktopFolder', 'TARGETDIR', '.']
    ];
    for (const pDir of installParentDirs) {
      directoryRows.push([pDir.key, pDir.parentKey, pDir.defaultDir]);
    }
    for (const d of dirMap.values()) {
      directoryRows.push([d.key, d.parentKey, d.defaultDir]);
    }
    tables.push({
      name: 'Directory',
      columns: [
        { name: 'Directory', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Directory_Parent', kind: 's', typeCode: 0x1d48 },
        { name: 'DefaultDir', kind: 's', typeCode: 0x0fff }
      ],
      rows: directoryRows
    });

    // 3. Component table
    const compAttr = is64Bit ? 256 : 0; // msidbComponentAttributes64bit = 256
    const componentRows: (string | number | null)[][] = msiFiles.map((f) => [
      f.componentKey,
      ReleaseConfigLoader.deterministicGuid(`msi-comp:${productCode}:${f.relativePath}`),
      f.directoryKey,
      compAttr,
      null,
      f.fileKey
    ]);
    tables.push({
      name: 'Component',
      columns: [
        { name: 'Component', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'ComponentId', kind: 's', typeCode: 0x1d26 },
        { name: 'Directory_', kind: 's', typeCode: 0x0d48 },
        { name: 'Attributes', kind: 'i2', typeCode: 0x0502 },
        { name: 'Condition', kind: 's', typeCode: 0x1dff },
        { name: 'KeyPath', kind: 's', typeCode: 0x1d48 }
      ],
      rows: componentRows
    });

    // 4. File table
    const fileRows: (string | number | null)[][] = msiFiles.map((f) => [
      f.fileKey,
      f.componentKey,
      f.fileNameField,
      f.fileSize,
      null,
      null,
      512, // msidbFileAttributesVital
      f.sequence
    ]);
    tables.push({
      name: 'File',
      columns: [
        { name: 'File', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Component_', kind: 's', typeCode: 0x0d48 },
        { name: 'FileName', kind: 's', typeCode: 0x0fff },
        { name: 'FileSize', kind: 'i4', typeCode: 0x0104 },
        { name: 'Version', kind: 's', typeCode: 0x1d48 },
        { name: 'Language', kind: 's', typeCode: 0x1d14 },
        { name: 'Attributes', kind: 'i2', typeCode: 0x1502 },
        { name: 'Sequence', kind: 'i2', typeCode: 0x0502 }
      ],
      rows: fileRows
    });

    // 5. Feature table
    tables.push({
      name: 'Feature',
      columns: [
        { name: 'Feature', kind: 's', typeCode: 0x2d26, isPrimaryKey: true },
        { name: 'Feature_Parent', kind: 's', typeCode: 0x1d26 },
        { name: 'Title', kind: 's', typeCode: 0x1f40 },
        { name: 'Description', kind: 's', typeCode: 0x1fff },
        { name: 'Display', kind: 'i2', typeCode: 0x1502 },
        { name: 'Level', kind: 'i2', typeCode: 0x0502 },
        { name: 'Directory_', kind: 's', typeCode: 0x1d48 },
        { name: 'Attributes', kind: 'i2', typeCode: 0x0502 }
      ],
      rows: [
        [
          'MainFeature',
          null,
          options.productName,
          descriptionText,
          1,
          1,
          'INSTALLDIR',
          0
        ]
      ]
    });

    // 6. FeatureComponents table
    tables.push({
      name: 'FeatureComponents',
      columns: [
        { name: 'Feature_', kind: 's', typeCode: 0x2d26, isPrimaryKey: true },
        { name: 'Component_', kind: 's', typeCode: 0x2d48, isPrimaryKey: true }
      ],
      rows: msiFiles.map((f) => ['MainFeature', f.componentKey])
    });

    // 7. Media table
    tables.push({
      name: 'Media',
      columns: [
        { name: 'DiskId', kind: 'i2', typeCode: 0x2502, isPrimaryKey: true },
        { name: 'LastSequence', kind: 'i2', typeCode: 0x0502 },
        { name: 'DiskPrompt', kind: 's', typeCode: 0x1f40 },
        { name: 'Cabinet', kind: 's', typeCode: 0x1dff },
        { name: 'VolumeLabel', kind: 's', typeCode: 0x1d20 },
        { name: 'Source', kind: 's', typeCode: 0x1d48 }
      ],
      rows: [[1, msiFiles.length, null, '#media1.cab', null, null]]
    });

    // 8. Icon and Binary tables (optional: included when iconBuffer is provided)
    // - Icon table is used by Shortcut and ARPPRODUCTICON
    // - Binary table is used by Dialog Icon controls (`SELECT Data FROM Binary WHERE Name=?`)
    if (hasIcon) {
      tables.push({
        name: 'Icon',
        columns: [
          { name: 'Name', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
          { name: 'Data', kind: 'v', typeCode: 0x0900 }
        ],
        rows: [['AppIcon.ico', 1]]
      });
      tables.push({
        name: 'Binary',
        columns: [
          { name: 'Name', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
          { name: 'Data', kind: 'v', typeCode: 0x0900 }
        ],
        rows: [['AppIcon.ico', 1]]
      });
    }

    // 9. Shortcut table
    const shortcutRows: (string | number | null)[][] = [];
    if (mainExeEntry) {
      if (options.createStartMenuShortcut) {
        shortcutRows.push([
          'StartMenuShortcut',
          'ApplicationProgramsFolder',
          MsiDatabaseBuilder.formatDefaultDir(options.productName, 101),
          mainExeEntry.componentKey,
          `[#${mainExeEntry.fileKey}]`,
          null,
          descriptionText,
          0,
          hasIcon ? 'AppIcon.ico' : null,
          0,
          1,
          'INSTALLDIR'
        ]);
      }
      if (options.createDesktopShortcut) {
        shortcutRows.push([
          'DesktopShortcut',
          'DesktopFolder',
          MsiDatabaseBuilder.formatDefaultDir(options.productName, 102),
          mainExeEntry.componentKey,
          `[#${mainExeEntry.fileKey}]`,
          null,
          descriptionText,
          0,
          hasIcon ? 'AppIcon.ico' : null,
          0,
          1,
          'INSTALLDIR'
        ]);
      }
    }
    if (shortcutRows.length > 0) {
      tables.push({
        name: 'Shortcut',
        columns: [
          { name: 'Shortcut', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
          { name: 'Directory_', kind: 's', typeCode: 0x0d48 },
          { name: 'Name', kind: 's', typeCode: 0x0f80 },
          { name: 'Component_', kind: 's', typeCode: 0x0d48 },
          { name: 'Target', kind: 's', typeCode: 0x0d48 },
          { name: 'Arguments', kind: 's', typeCode: 0x1dff },
          { name: 'Description', kind: 's', typeCode: 0x1fff },
          { name: 'Hotkey', kind: 'i2', typeCode: 0x1502 },
          { name: 'Icon_', kind: 's', typeCode: 0x1d48 },
          { name: 'IconIndex', kind: 'i2', typeCode: 0x1502 },
          { name: 'ShowCmd', kind: 'i2', typeCode: 0x1502 },
          { name: 'WkDir', kind: 's', typeCode: 0x1d48 }
        ],
        rows: shortcutRows
      });
    }

    // 10. InstallExecuteSequence table
    tables.push({
      name: 'InstallExecuteSequence',
      columns: [
        { name: 'Action', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Condition', kind: 's', typeCode: 0x1dff },
        { name: 'Sequence', kind: 'i2', typeCode: 0x1502 }
      ],
      rows: [
        ['LaunchConditions', null, 100],
        ['CostInitialize', null, 800],
        ['FileCost', null, 900],
        ['CostFinalize', null, 1000],
        ['InstallValidate', null, 1400],
        ['InstallInitialize', null, 1500],
        ['ProcessComponents', null, 1600],
        ['UnpublishFeatures', null, 1800],
        ['RemoveShortcuts', null, 3200],
        ['RemoveFiles', null, 3500],
        ['InstallFiles', null, 4000],
        ['CreateShortcuts', null, 4500],
        ['RegisterUser', null, 6000],
        ['RegisterProduct', null, 6100],
        ['PublishFeatures', null, 6300],
        ['PublishProduct', null, 6400],
        ['InstallFinalize', null, 6600]
      ]
    });

    // 11. InstallUISequence table
    // WelcomeDlg (1240) is the initial visual screen showing the icon and description,
    // which transitions to InstallDirDlg via NewDialog when the user clicks Next.
    tables.push({
      name: 'InstallUISequence',
      columns: [
        { name: 'Action', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Condition', kind: 's', typeCode: 0x1dff },
        { name: 'Sequence', kind: 'i2', typeCode: 0x1502 }
      ],
      rows: [
        ['LaunchConditions', null, 100],
        ['CostInitialize', null, 800],
        ['FileCost', null, 900],
        ['CostFinalize', null, 1000],
        ['WelcomeDlg', 'NOT Installed', 1240],
        ['MaintenanceDlg', 'Installed', 1260],
        ['ProgressDlg', null, 1280],
        ['ExecuteAction', null, 1300],
        ['ExitDlg', null, -1],
        ['UserExit', null, -2],
        ['FatalError', null, -3]
      ]
    });

    // 12. TextStyle table (fonts for visual MSI dialogs)
    tables.push({
      name: 'TextStyle',
      columns: [
        { name: 'TextStyle', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'FaceName', kind: 's', typeCode: 0x0d20 },
        { name: 'Size', kind: 'i2', typeCode: 0x0502 },
        { name: 'Color', kind: 'i4', typeCode: 0x1104 },
        { name: 'StyleBits', kind: 'i2', typeCode: 0x1502 }
      ],
      rows: [
        ['DlgFont8', 'Tahoma', 8, null, 0],
        ['DlgFontBold8', 'Tahoma', 8, null, 1],
        ['TitleFont', 'Segoe UI', 12, null, 1],
        ['VerdanaBold13', 'Verdana', 13, null, 1]
      ]
    });

    // 13. UIText table (standard UI strings for DirectoryList / BrowseDlg / Costing)
    tables.push({
      name: 'UIText',
      columns: [
        { name: 'Key', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Text', kind: 's', typeCode: 0x1fff }
      ],
      rows: [
        ['AbsentPath', null],
        ['bytes', 'bytes'],
        ['GB', 'GB'],
        ['KB', 'KB'],
        ['MB', 'MB'],
        ['MenuAbsent', 'Entire feature will be unavailable'],
        ['MenuAllCD', 'Entire feature will be installed to run from CD'],
        ['MenuAllLocal', 'Entire feature will be installed on local hard drive'],
        ['MenuAllNetwork', 'Entire feature will be installed to run from network'],
        ['MenuCD', 'Will be installed to run from CD'],
        ['MenuLocal', 'Will be installed on local hard drive'],
        ['MenuNetwork', 'Will be installed to run from network'],
        ['NewFolder', 'New Folder'],
        ['SelAbsentAbsent', 'This feature will remain uninstalled'],
        ['SelAbsentLocal', 'This feature will be set to be installed on the local hard drive'],
        ['TimeRemaining', 'Time remaining: {[1] minutes }{[2] seconds}'],
        ['VolumeCostAvailable', 'Available'],
        ['VolumeCostDifference', 'Difference'],
        ['VolumeCostRequired', 'Required'],
        ['VolumeCostSize', 'Disk Size'],
        ['VolumeCostVolume', 'Volume']
      ]
    });

    // 14. ActionText table (status descriptions shown on ProgressDlg)
    tables.push({
      name: 'ActionText',
      columns: [
        { name: 'Action', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Description', kind: 's', typeCode: 0x1f00 },
        { name: 'Template', kind: 's', typeCode: 0x1f00 }
      ],
      rows: [
        ['CostInitialize', 'Computing space requirements...', null],
        ['FileCost', 'Computing space requirements...', null],
        ['CostFinalize', 'Computing space requirements...', null],
        ['InstallValidate', 'Validating install...', null],
        ['InstallFiles', 'Copying application files...', 'File: [1], Directory: [9], Size: [6]'],
        ['CreateShortcuts', 'Creating application shortcuts...', 'Shortcut: [1]'],
        ['RemoveFiles', 'Removing application files...', 'File: [1], Directory: [9]'],
        ['RemoveShortcuts', 'Removing application shortcuts...', 'Shortcut: [1]'],
        ['PublishFeatures', 'Publishing product features...', 'Feature: [1]'],
        ['PublishProduct', 'Publishing product information...', null],
        ['RegisterProduct', 'Registering product...', '[1]'],
        ['RegisterUser', 'Registering user...', '[1]']
      ]
    });

    // 15. Dialog table (Visual MSI Wizard with initial Welcome/Description screen + Install Path screen)
    tables.push({
      name: 'Dialog',
      columns: [
        { name: 'Dialog', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'HCentering', kind: 'i2', typeCode: 0x0502 },
        { name: 'VCentering', kind: 'i2', typeCode: 0x0502 },
        { name: 'Width', kind: 'i2', typeCode: 0x0502 },
        { name: 'Height', kind: 'i2', typeCode: 0x0502 },
        { name: 'Attributes', kind: 'i4', typeCode: 0x1104 },
        { name: 'Title', kind: 's', typeCode: 0x1f80 },
        { name: 'Control_First', kind: 's', typeCode: 0x0d32 },
        { name: 'Control_Default', kind: 's', typeCode: 0x1d32 },
        { name: 'Control_Cancel', kind: 's', typeCode: 0x1d32 }
      ],
      rows: [
        [
          'WelcomeDlg',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'NextButton',
          'NextButton',
          'CancelButton'
        ],
        [
          'InstallDirDlg',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'InstallButton',
          'InstallButton',
          'CancelButton'
        ],
        [
          'BrowseDlg',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] - Change Destination Folder',
          'PathEdit',
          'OKButton',
          'CancelButton'
        ],
        [
          'MaintenanceDlg',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'RemoveButton',
          'RemoveButton',
          'CancelButton'
        ],
        [
          'ProgressDlg',
          50,
          50,
          370,
          270,
          1,
          '[ProductName] Setup',
          'CancelButton',
          'CancelButton',
          'CancelButton'
        ],
        [
          'CancelDlg',
          50,
          50,
          260,
          85,
          3,
          '[ProductName] Setup',
          'NoButton',
          'NoButton',
          'NoButton'
        ],
        [
          'ExitDlg',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'FinishButton',
          'FinishButton',
          'FinishButton'
        ],
        [
          'UserExit',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'FinishButton',
          'FinishButton',
          'FinishButton'
        ],
        [
          'FatalError',
          50,
          50,
          370,
          270,
          3,
          '[ProductName] Setup',
          'FinishButton',
          'FinishButton',
          'FinishButton'
        ],
        [
          'ErrorDlg',
          50,
          50,
          270,
          105,
          65539,
          'Installer Information',
          'ErrorText',
          null,
          null
        ]
      ]
    });

    // 16. Control table
    const headerTextX = hasIcon ? 56 : 15;
    const headerTextWidth = hasIcon ? 300 : 340;
    // Icon control attributes: Visible (1) | Enabled (2) | IconSize32 (0x100000) | FixedSize (0x400000) = 5242883
    const iconControlAttrs = 5242883;

    const controlRows: (string | number | null)[][] = [
      // --- WelcomeDlg Controls (Initial Visual Screen with Icon & Description) ---
      ...(hasIcon
        ? [['WelcomeDlg', 'AppIcon', 'Icon', 15, 10, 32, 32, iconControlAttrs, null, 'AppIcon.ico', null, null]]
        : []),
      ['WelcomeDlg', 'TitleText', 'Text', headerTextX, 10, headerTextWidth, 20, 196611, null, '{\\TitleFont}Welcome to the [ProductName] Setup Wizard', null, null],
      ['WelcomeDlg', 'SubtitleText', 'Text', headerTextX, 30, headerTextWidth, 15, 196611, null, 'Version [ProductVersion] — Published by [Manufacturer]', null, null],
      ['WelcomeDlg', 'HeaderLine', 'Line', 0, 48, 370, 0, 1, null, null, null, null],
      ['WelcomeDlg', 'AboutLabel', 'Text', 20, 62, 330, 14, 3, null, '{\\DlgFontBold8}Application Description:', null, null],
      ['WelcomeDlg', 'DescriptionBox', 'Text', 20, 80, 330, 70, 3, null, descriptionText, null, null],
      ['WelcomeDlg', 'InstructionsText', 'Text', 20, 165, 330, 40, 3, null, 'This wizard will guide you through the installation of [ProductName] on your computer. Click Next to select the destination installation folder, or click Cancel to exit.', null, null],
      ['WelcomeDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['WelcomeDlg', 'NextButton', 'PushButton', 230, 243, 60, 18, 3, null, '&Next >', 'CancelButton', null],
      ['WelcomeDlg', 'CancelButton', 'PushButton', 298, 243, 56, 18, 3, null, 'Cancel', 'NextButton', null],

      // --- InstallDirDlg Controls (Destination Installation Folder Screen) ---
      ...(hasIcon
        ? [['InstallDirDlg', 'AppIcon', 'Icon', 15, 10, 32, 32, iconControlAttrs, null, 'AppIcon.ico', null, null]]
        : []),
      ['InstallDirDlg', 'TitleText', 'Text', headerTextX, 10, headerTextWidth, 20, 196611, null, '{\\TitleFont}Destination Installation Folder', null, null],
      ['InstallDirDlg', 'SubtitleText', 'Text', headerTextX, 30, headerTextWidth, 15, 196611, null, 'Select the folder where [ProductName] [ProductVersion] will be installed.', null, null],
      ['InstallDirDlg', 'HeaderLine', 'Line', 0, 48, 370, 0, 1, null, null, null, null],
      ['InstallDirDlg', 'DescriptionText', 'Text', 20, 62, 330, 36, 3, null, 'The Setup Wizard will install [ProductName] to the folder shown below. You may keep the default Program Files path, edit the path directly, or click Browse to choose another folder.', null, null],
      ['InstallDirDlg', 'FolderLabel', 'Text', 20, 112, 330, 14, 3, null, '{\\DlgFontBold8}Destination Installation Folder:', null, null],
      ['InstallDirDlg', 'PathEdit', 'PathEdit', 20, 128, 255, 18, 3, 'INSTALLDIR', null, 'BrowseButton', null],
      ['InstallDirDlg', 'BrowseButton', 'PushButton', 282, 127, 68, 20, 3, null, '&Browse...', 'BackButton', null],
      ['InstallDirDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['InstallDirDlg', 'BackButton', 'PushButton', 166, 243, 60, 18, 3, null, '< &Back', 'InstallButton', null],
      ['InstallDirDlg', 'InstallButton', 'PushButton', 230, 243, 60, 18, 3, null, '&Install', 'PathEdit', null],
      ['InstallDirDlg', 'CancelButton', 'PushButton', 298, 243, 56, 18, 3, null, 'Cancel', 'InstallButton', null],

      // --- BrowseDlg Controls ---
      ['BrowseDlg', 'TitleText', 'Text', 15, 10, 340, 20, 196611, null, '{\\TitleFont}Change Destination Folder', null, null],
      ['BrowseDlg', 'ComboLabel', 'Text', 20, 42, 60, 14, 3, null, '&Look in:', null, null],
      ['BrowseDlg', 'DirectoryCombo', 'DirectoryCombo', 75, 40, 205, 80, 458763, '_BrowseProperty', null, 'UpButton', null],
      ['BrowseDlg', 'UpButton', 'PushButton', 286, 39, 32, 18, 3, null, '&Up', 'NewFolderButton', null],
      ['BrowseDlg', 'NewFolderButton', 'PushButton', 322, 39, 34, 18, 3, null, '&New', 'DirectoryList', null],
      ['BrowseDlg', 'DirectoryList', 'DirectoryList', 20, 64, 336, 122, 11, '_BrowseProperty', null, 'PathEdit', null],
      ['BrowseDlg', 'PathLabel', 'Text', 20, 196, 85, 14, 3, null, '&Folder path:', null, null],
      ['BrowseDlg', 'PathEdit', 'PathEdit', 95, 194, 261, 18, 11, '_BrowseProperty', null, 'OKButton', null],
      ['BrowseDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['BrowseDlg', 'OKButton', 'PushButton', 236, 243, 56, 18, 3, null, 'OK', 'CancelButton', null],
      ['BrowseDlg', 'CancelButton', 'PushButton', 298, 243, 56, 18, 3, null, 'Cancel', 'DirectoryCombo', null],

      // --- MaintenanceDlg Controls ---
      ...(hasIcon
        ? [['MaintenanceDlg', 'AppIcon', 'Icon', 15, 10, 32, 32, iconControlAttrs, null, 'AppIcon.ico', null, null]]
        : []),
      ['MaintenanceDlg', 'TitleText', 'Text', headerTextX, 10, headerTextWidth, 20, 196611, null, '{\\TitleFont}[ProductName] Maintenance', null, null],
      ['MaintenanceDlg', 'SubtitleText', 'Text', headerTextX, 30, headerTextWidth, 15, 196611, null, 'Modify, repair, or remove [ProductName].', null, null],
      ['MaintenanceDlg', 'HeaderLine', 'Line', 0, 48, 370, 0, 1, null, null, null, null],
      ['MaintenanceDlg', 'DescriptionText', 'Text', 20, 70, 330, 45, 3, null, '[ProductName] is currently installed. Click Remove to uninstall [ProductName] from your computer, or click Cancel to exit the wizard.', null, null],
      ['MaintenanceDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['MaintenanceDlg', 'RemoveButton', 'PushButton', 226, 243, 64, 18, 3, null, '&Remove', 'CancelButton', null],
      ['MaintenanceDlg', 'CancelButton', 'PushButton', 298, 243, 56, 18, 3, null, 'Cancel', 'RemoveButton', null],

      // --- ProgressDlg Controls ---
      ...(hasIcon
        ? [['ProgressDlg', 'AppIcon', 'Icon', 15, 10, 32, 32, iconControlAttrs, null, 'AppIcon.ico', null, null]]
        : []),
      ['ProgressDlg', 'TitleText', 'Text', headerTextX, 10, headerTextWidth, 20, 196611, null, '{\\TitleFont}Installing [ProductName]', null, null],
      ['ProgressDlg', 'SubtitleText', 'Text', headerTextX, 30, headerTextWidth, 15, 196611, null, 'Please wait while the Setup Wizard installs [ProductName].', null, null],
      ['ProgressDlg', 'HeaderLine', 'Line', 0, 48, 370, 0, 1, null, null, null, null],
      ['ProgressDlg', 'StatusLabel', 'Text', 20, 75, 55, 14, 3, null, 'Status:', null, null],
      ['ProgressDlg', 'ActionText', 'Text', 75, 75, 275, 14, 3, null, 'Preparing installation...', null, null],
      ['ProgressDlg', 'ProgressBar', 'ProgressBar', 20, 100, 330, 16, 65537, null, null, null, null],
      ['ProgressDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['ProgressDlg', 'CancelButton', 'PushButton', 298, 243, 56, 18, 3, null, 'Cancel', 'CancelButton', null],

      // --- CancelDlg Controls ---
      ['CancelDlg', 'MessageText', 'Text', 20, 18, 220, 30, 3, null, 'Are you sure you want to cancel [ProductName] installation?', null, null],
      ['CancelDlg', 'YesButton', 'PushButton', 72, 55, 56, 18, 3, null, '&Yes', 'NoButton', null],
      ['CancelDlg', 'NoButton', 'PushButton', 136, 55, 56, 18, 3, null, '&No', 'YesButton', null],

      // --- ExitDlg Controls ---
      ...(hasIcon
        ? [['ExitDlg', 'AppIcon', 'Icon', 20, 22, 32, 32, iconControlAttrs, null, 'AppIcon.ico', null, null]]
        : []),
      ['ExitDlg', 'TitleText', 'Text', hasIcon ? 62 : 20, 25, hasIcon ? 288 : 330, 24, 196611, null, '{\\VerdanaBold13}Completed the [ProductName] Setup Wizard', null, null],
      ['ExitDlg', 'DescriptionText', 'Text', 20, 68, 330, 50, 3, null, '[ProductName] has been successfully installed on your computer. Click Finish to exit the Setup Wizard.', null, null],
      ['ExitDlg', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['ExitDlg', 'FinishButton', 'PushButton', 298, 243, 56, 18, 3, null, '&Finish', 'FinishButton', null],

      // --- UserExit Controls ---
      ['UserExit', 'TitleText', 'Text', 20, 25, 330, 24, 196611, null, '{\\VerdanaBold13}[ProductName] Setup Wizard Was Interrupted', null, null],
      ['UserExit', 'DescriptionText', 'Text', 20, 65, 330, 50, 3, null, '[ProductName] setup was cancelled before installation completed. Your system has not been modified.', null, null],
      ['UserExit', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['UserExit', 'FinishButton', 'PushButton', 298, 243, 56, 18, 3, null, '&Finish', 'FinishButton', null],

      // --- FatalError Controls ---
      ['FatalError', 'TitleText', 'Text', 20, 25, 330, 24, 196611, null, '{\\VerdanaBold13}[ProductName] Setup Wizard Ended Prematurely', null, null],
      ['FatalError', 'DescriptionText', 'Text', 20, 65, 330, 50, 3, null, '[ProductName] setup ended prematurely because of an error. Your system has not been modified.', null, null],
      ['FatalError', 'BottomLine', 'Line', 0, 234, 370, 0, 1, null, null, null, null],
      ['FatalError', 'FinishButton', 'PushButton', 298, 243, 56, 18, 3, null, '&Finish', 'FinishButton', null],

      // --- ErrorDlg Controls ---
      ['ErrorDlg', 'ErrorText', 'Text', 20, 15, 230, 50, 3, null, 'Information text', null, null],
      ['ErrorDlg', 'O', 'PushButton', 100, 75, 56, 18, 3, null, 'OK', null, null],
      ['ErrorDlg', 'C', 'PushButton', 100, 75, 56, 18, 3, null, 'Cancel', null, null],
      ['ErrorDlg', 'A', 'PushButton', 100, 75, 56, 18, 3, null, 'Abort', null, null],
      ['ErrorDlg', 'R', 'PushButton', 100, 75, 56, 18, 3, null, 'Retry', null, null],
      ['ErrorDlg', 'I', 'PushButton', 100, 75, 56, 18, 3, null, 'Ignore', null, null],
      ['ErrorDlg', 'Y', 'PushButton', 100, 75, 56, 18, 3, null, 'Yes', null, null],
      ['ErrorDlg', 'N', 'PushButton', 100, 75, 56, 18, 3, null, 'No', null, null]
    ];

    tables.push({
      name: 'Control',
      columns: [
        { name: 'Dialog_', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Control', kind: 's', typeCode: 0x2d32, isPrimaryKey: true },
        { name: 'Type', kind: 's', typeCode: 0x0d14 },
        { name: 'X', kind: 'i2', typeCode: 0x0502 },
        { name: 'Y', kind: 'i2', typeCode: 0x0502 },
        { name: 'Width', kind: 'i2', typeCode: 0x0502 },
        { name: 'Height', kind: 'i2', typeCode: 0x0502 },
        { name: 'Attributes', kind: 'i4', typeCode: 0x1104 },
        { name: 'Property', kind: 's', typeCode: 0x1d32 },
        { name: 'Text', kind: 's', typeCode: 0x1f00 },
        { name: 'Control_Next', kind: 's', typeCode: 0x1d32 },
        { name: 'Help', kind: 's', typeCode: 0x1f32 }
      ],
      rows: controlRows
    });

    // 17. ControlEvent table
    tables.push({
      name: 'ControlEvent',
      columns: [
        { name: 'Dialog_', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Control_', kind: 's', typeCode: 0x2d32, isPrimaryKey: true },
        { name: 'Event', kind: 's', typeCode: 0x2d32, isPrimaryKey: true },
        { name: 'Argument', kind: 's', typeCode: 0x2dff, isPrimaryKey: true },
        { name: 'Condition', kind: 's', typeCode: 0x3dff, isPrimaryKey: true },
        { name: 'Ordering', kind: 'i2', typeCode: 0x1502 }
      ],
      rows: [
        // WelcomeDlg events
        ['WelcomeDlg', 'NextButton', 'NewDialog', 'InstallDirDlg', '1', 1],
        ['WelcomeDlg', 'CancelButton', 'SpawnDialog', 'CancelDlg', '1', 1],

        // InstallDirDlg events
        ['InstallDirDlg', 'BackButton', 'NewDialog', 'WelcomeDlg', '1', 1],
        ['InstallDirDlg', 'InstallButton', 'SetTargetPath', 'INSTALLDIR', '1', 1],
        ['InstallDirDlg', 'InstallButton', 'EndDialog', 'Return', '1', 2],
        ['InstallDirDlg', 'BrowseButton', '[_BrowseProperty]', 'INSTALLDIR', '1', 1],
        ['InstallDirDlg', 'BrowseButton', 'SpawnDialog', 'BrowseDlg', '1', 2],
        ['InstallDirDlg', 'CancelButton', 'SpawnDialog', 'CancelDlg', '1', 1],

        // BrowseDlg events
        ['BrowseDlg', 'OKButton', 'SetTargetPath', '[_BrowseProperty]', '1', 1],
        ['BrowseDlg', 'OKButton', 'EndDialog', 'Return', '1', 2],
        ['BrowseDlg', 'CancelButton', 'Reset', '0', '1', 1],
        ['BrowseDlg', 'CancelButton', 'EndDialog', 'Return', '1', 2],
        ['BrowseDlg', 'UpButton', 'DirectoryListUp', '0', '1', 1],
        ['BrowseDlg', 'NewFolderButton', 'DirectoryListNew', '0', '1', 1],

        // MaintenanceDlg events
        ['MaintenanceDlg', 'RemoveButton', 'Remove', 'ALL', '1', 1],
        ['MaintenanceDlg', 'RemoveButton', 'EndDialog', 'Return', '1', 2],
        ['MaintenanceDlg', 'CancelButton', 'SpawnDialog', 'CancelDlg', '1', 1],

        // ProgressDlg events
        ['ProgressDlg', 'CancelButton', 'SpawnDialog', 'CancelDlg', '1', 1],

        // CancelDlg events
        ['CancelDlg', 'NoButton', 'EndDialog', 'Return', '1', 1],
        ['CancelDlg', 'YesButton', 'EndDialog', 'Exit', '1', 1],

        // Completion / Exit Dialogs
        ['ExitDlg', 'FinishButton', 'EndDialog', 'Return', '1', 1],
        ['UserExit', 'FinishButton', 'EndDialog', 'Return', '1', 1],
        ['FatalError', 'FinishButton', 'EndDialog', 'Return', '1', 1],

        // ErrorDlg events
        ['ErrorDlg', 'O', 'EndDialog', 'ErrorOk', '1', 1],
        ['ErrorDlg', 'C', 'EndDialog', 'ErrorCancel', '1', 1],
        ['ErrorDlg', 'A', 'EndDialog', 'ErrorAbort', '1', 1],
        ['ErrorDlg', 'R', 'EndDialog', 'ErrorRetry', '1', 1],
        ['ErrorDlg', 'I', 'EndDialog', 'ErrorIgnore', '1', 1],
        ['ErrorDlg', 'Y', 'EndDialog', 'ErrorYes', '1', 1],
        ['ErrorDlg', 'N', 'EndDialog', 'ErrorNo', '1', 1]
      ]
    });

    // 18. EventMapping table (subscribes ProgressDlg controls to installer progress events)
    tables.push({
      name: 'EventMapping',
      columns: [
        { name: 'Dialog_', kind: 's', typeCode: 0x2d48, isPrimaryKey: true },
        { name: 'Control_', kind: 's', typeCode: 0x2d32, isPrimaryKey: true },
        { name: 'Event', kind: 's', typeCode: 0x2d32, isPrimaryKey: true },
        { name: 'Attribute', kind: 's', typeCode: 0x0d32 }
      ],
      rows: [
        ['ProgressDlg', 'ProgressBar', 'SetProgress', 'Progress'],
        ['ProgressDlg', 'ActionText', 'ActionText', 'Text']
      ]
    });

    // Pre-collect all unique strings and assign string pool IDs in lexicographical order
    // so sorting rows by string value is identical to sorting by string pool ID.
    const uniqueStrings = new Set<string>();
    for (const t of tables) {
      uniqueStrings.add(t.name);
      for (const col of t.columns) {
        uniqueStrings.add(col.name);
      }
      for (const row of t.rows) {
        for (let c = 0; c < t.columns.length; c++) {
          if (t.columns[c].kind === 's') {
            const val = row[c];
            if (val !== null && val !== undefined && String(val) !== '') {
              uniqueStrings.add(String(val));
            }
          }
        }
      }
    }

    const sortedUniqueStrings = Array.from(uniqueStrings).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const stringPool = new Map<string, { id: number; refCount: number }>();
    const stringList: string[] = [];

    for (const str of sortedUniqueStrings) {
      const id = stringList.length + 1;
      stringList.push(str);
      stringPool.set(str, { id, refCount: 0 });
    }

    const internString = (str: string | null): number => {
      if (str === null || str === '') {
        return 0;
      }
      const existing = stringPool.get(str);
      if (existing) {
        existing.refCount++;
        return existing.id;
      }
      const id = stringList.length + 1;
      stringList.push(str);
      stringPool.set(str, { id, refCount: 1 });
      return id;
    };

    const cfb = new CfbWriter();

    // _Tables stream (1 column of string pool IDs sorted by string pool ID)
    const sortedTables = [...tables].sort(
      (a, b) => (stringPool.get(a.name)?.id ?? 0) - (stringPool.get(b.name)?.id ?? 0)
    );
    const tablesStreamBuf = Buffer.alloc(sortedTables.length * 2);
    for (let i = 0; i < sortedTables.length; i++) {
      const strId = internString(sortedTables[i].name);
      tablesStreamBuf.writeUInt16LE(strId, i * 2);
    }
    cfb.addStream(MsiDatabaseBuilder.encodeMsiStreamName('_Tables', true), tablesStreamBuf);

    // _Columns stream (sorted by Table string ID, then Column Number)
    const allColumns: { table: string; number: number; name: string; typeCode: number }[] = [];
    for (const t of sortedTables) {
      for (let c = 0; c < t.columns.length; c++) {
        allColumns.push({
          table: t.name,
          number: c + 1,
          name: t.columns[c].name,
          typeCode: t.columns[c].typeCode
        });
      }
    }
    const numCols = allColumns.length;
    const colsStreamBuf = Buffer.alloc(numCols * 8);
    for (let i = 0; i < numCols; i++) {
      const col = allColumns[i];
      colsStreamBuf.writeUInt16LE(internString(col.table), i * 2);
      colsStreamBuf.writeUInt16LE((col.number + 0x8000) & 0xffff, numCols * 2 + i * 2);
      colsStreamBuf.writeUInt16LE(internString(col.name), numCols * 4 + i * 2);
      colsStreamBuf.writeUInt16LE((col.typeCode + 0x8000) & 0xffff, numCols * 6 + i * 2);
    }
    cfb.addStream(MsiDatabaseBuilder.encodeMsiStreamName('_Columns', true), colsStreamBuf);

    // Serialize each table stream in column-major order with rows sorted by Primary Key(s)
    for (const t of sortedTables) {
      const pkIndices: number[] = [];
      for (let c = 0; c < t.columns.length; c++) {
        if (t.columns[c].isPrimaryKey) {
          pkIndices.push(c);
        }
      }
      if (pkIndices.length === 0) {
        pkIndices.push(0);
      }

      const sortedRows = [...t.rows].sort((rowA, rowB) => {
        for (const pkIdx of pkIndices) {
          const colDef = t.columns[pkIdx];
          if (colDef.kind === 's') {
            const idA = rowA[pkIdx] ? (stringPool.get(String(rowA[pkIdx]))?.id ?? 0) : 0;
            const idB = rowB[pkIdx] ? (stringPool.get(String(rowB[pkIdx]))?.id ?? 0) : 0;
            if (idA !== idB) return idA - idB;
          } else {
            const numA = Number(rowA[pkIdx] ?? 0);
            const numB = Number(rowB[pkIdx] ?? 0);
            if (numA !== numB) return numA - numB;
          }
        }
        return 0;
      });

      const numRows = sortedRows.length;
      const colBuffers: Buffer[] = [];

      for (let c = 0; c < t.columns.length; c++) {
        const colDef = t.columns[c];
        if (colDef.kind === 'i4') {
          const b = Buffer.alloc(numRows * 4);
          for (let r = 0; r < numRows; r++) {
            const val = sortedRows[r][c];
            const encoded =
              val === null || val === undefined ? 0 : ((Number(val) + 0x80000000) >>> 0);
            b.writeUInt32LE(encoded, r * 4);
          }
          colBuffers.push(b);
        } else if (colDef.kind === 'i2') {
          const b = Buffer.alloc(numRows * 2);
          for (let r = 0; r < numRows; r++) {
            const val = sortedRows[r][c];
            const encoded =
              val === null || val === undefined ? 0 : ((Number(val) + 0x8000) & 0xffff);
            b.writeUInt16LE(encoded, r * 2);
          }
          colBuffers.push(b);
        } else if (colDef.kind === 'v') {
          // OBJECT binary stream column stores 0x0001 when stream is present, 0x0000 when null
          const b = Buffer.alloc(numRows * 2);
          for (let r = 0; r < numRows; r++) {
            const val = sortedRows[r][c];
            b.writeUInt16LE(val === null || val === undefined ? 0 : 1, r * 2);
          }
          colBuffers.push(b);
        } else {
          const b = Buffer.alloc(numRows * 2);
          for (let r = 0; r < numRows; r++) {
            const val = sortedRows[r][c];
            const strId = internString(val === null || val === undefined ? null : String(val));
            b.writeUInt16LE(strId & 0xffff, r * 2);
          }
          colBuffers.push(b);
        }
      }

      cfb.addStream(
        MsiDatabaseBuilder.encodeMsiStreamName(t.name, true),
        Buffer.concat(colBuffers)
      );
    }

    // Build _StringPool and _StringData streams
    const stringDataChunks: Buffer[] = [];
    const stringPoolBuf = Buffer.alloc((stringList.length + 1) * 4, 0);
    // Entry 0 in _StringPool is the codepage header (0 = neutral/default)
    stringPoolBuf.writeUInt16LE(0, 0);
    stringPoolBuf.writeUInt16LE(0, 2);

    for (let i = 0; i < stringList.length; i++) {
      const s = stringList[i];
      const entry = stringPool.get(s)!;
      const utf8Buf = Buffer.from(s, 'utf8');
      stringDataChunks.push(utf8Buf);
      stringPoolBuf.writeUInt16LE(utf8Buf.length, (i + 1) * 4);
      stringPoolBuf.writeUInt16LE(entry.refCount, (i + 1) * 4 + 2);
    }

    cfb.addStream(MsiDatabaseBuilder.encodeMsiStreamName('_StringPool', true), stringPoolBuf);
    cfb.addStream(
      MsiDatabaseBuilder.encodeMsiStreamName('_StringData', true),
      Buffer.concat(stringDataChunks)
    );

    // Add Icon and Binary streams when icon is provided
    if (hasIcon && options.iconBuffer) {
      cfb.addStream(
        MsiDatabaseBuilder.encodeMsiStreamName('Icon.AppIcon.ico', false),
        options.iconBuffer
      );
      cfb.addStream(
        MsiDatabaseBuilder.encodeMsiStreamName('Binary.AppIcon.ico', false),
        options.iconBuffer
      );
    }

    // Build and add embedded media1.cab stream
    const cabBuffer = CabArchiveWriter.buildCabinet(msiFiles);
    cfb.addStream(MsiDatabaseBuilder.encodeMsiStreamName('media1.cab', false), cabBuffer);

    // Build and add \x05SummaryInformation stream
    const summaryInfo = MsiDatabaseBuilder.buildSummaryInformationStream({
      title: 'Installation Database',
      subject: options.productName,
      author: options.manufacturer,
      keywords: 'Installer, MSI, Database',
      comments: descriptionText,
      template:
        options.arch === 'arm64' ? 'Arm64;1033' : options.arch === 'x64' ? 'x64;1033' : 'Intel;1033',
      revisionNumber: packageCode,
      creatingApp: '@nexustools/releasepackager'
    });
    cfb.addStream('\x05SummaryInformation', summaryInfo);

    return cfb.toBuffer();
  }

  /**
   * Builds the OLE `\x05SummaryInformation` Property Set stream per MS-OLEPS / MSI specification.
   */
  public static buildSummaryInformationStream(info: {
    title: string;
    subject: string;
    author: string;
    keywords: string;
    comments: string;
    template: string;
    revisionNumber: string;
    creatingApp: string;
  }): Buffer {
    // FMTID_SummaryInformation: {F29F85E0-4FF9-1068-AB91-08002B27B3D9}
    const fmtid = Buffer.from([
      0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10,
      0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9
    ]);

    const encodeI2 = (val: number): Buffer => {
      const b = Buffer.alloc(8, 0);
      b.writeUInt32LE(2, 0); // VT_I2
      b.writeInt16LE(val, 4);
      return b;
    };

    const encodeI4 = (val: number): Buffer => {
      const b = Buffer.alloc(8, 0);
      b.writeUInt32LE(3, 0); // VT_I4
      b.writeInt32LE(val, 4);
      return b;
    };

    const encodeLpstr = (val: string): Buffer => {
      const strBytes = Buffer.from(val + '\0', 'utf8');
      const paddedLen = Math.ceil(strBytes.length / 4) * 4;
      const b = Buffer.alloc(8 + paddedLen, 0);
      b.writeUInt32LE(30, 0); // VT_LPSTR
      b.writeUInt32LE(strBytes.length, 4);
      strBytes.copy(b, 8);
      return b;
    };

    const properties: { pid: number; data: Buffer }[] = [
      { pid: 1, data: encodeI2(1252) }, // PID_CODEPAGE
      { pid: 2, data: encodeLpstr(info.title) }, // PID_TITLE
      { pid: 3, data: encodeLpstr(info.subject) }, // PID_SUBJECT
      { pid: 4, data: encodeLpstr(info.author) }, // PID_AUTHOR
      { pid: 5, data: encodeLpstr(info.keywords) }, // PID_KEYWORDS
      { pid: 6, data: encodeLpstr(info.comments) }, // PID_COMMENTS
      { pid: 7, data: encodeLpstr(info.template) }, // PID_TEMPLATE
      { pid: 9, data: encodeLpstr(info.revisionNumber) }, // PID_REVNUMBER
      { pid: 14, data: encodeI4(200) }, // PID_PAGECOUNT (MSI 2.0)
      { pid: 15, data: encodeI4(2) }, // PID_WORDCOUNT (Compressed cabinet)
      { pid: 18, data: encodeLpstr(info.creatingApp) }, // PID_APPNAME
      { pid: 19, data: encodeI4(2) } // PID_SECURITY
    ];

    const sectionHeaderSize = 8 + properties.length * 8;
    let currentPropOffset = sectionHeaderSize;
    const propOffsets: number[] = [];
    for (const p of properties) {
      propOffsets.push(currentPropOffset);
      currentPropOffset += p.data.length;
    }

    const sectionSize = currentPropOffset;
    const sectionHeader = Buffer.alloc(sectionHeaderSize, 0);
    sectionHeader.writeUInt32LE(sectionSize, 0);
    sectionHeader.writeUInt32LE(properties.length, 4);
    for (let i = 0; i < properties.length; i++) {
      sectionHeader.writeUInt32LE(properties[i].pid, 8 + i * 8);
      sectionHeader.writeUInt32LE(propOffsets[i], 8 + i * 8 + 4);
    }

    const streamHeader = Buffer.alloc(48, 0);
    streamHeader.writeUInt16LE(0xfffe, 0); // ByteOrder
    streamHeader.writeUInt16LE(0, 2); // Version
    streamHeader.writeUInt32LE(0x00020005, 4); // SystemIdentifier (Windows)
    streamHeader.writeUInt32LE(1, 24); // NumPropertySets = 1
    fmtid.copy(streamHeader, 28);
    streamHeader.writeUInt32LE(48, 44); // Offset to section 0

    return Buffer.concat([
      streamHeader,
      sectionHeader,
      ...properties.map((p) => p.data)
    ]);
  }

  /**
   * Encodes an MSI stream or table name using Windows Installer's 6-bit Unicode compression.
   */
  public static encodeMsiStreamName(name: string, isTable: boolean): string {
    const mapChar = (ch: number): number => {
      if (ch >= 0x30 && ch <= 0x39) return ch - 0x30; // '0'-'9' -> 0..9
      if (ch >= 0x41 && ch <= 0x5a) return ch - 0x41 + 10; // 'A'-'Z' -> 10..35
      if (ch >= 0x61 && ch <= 0x7a) return ch - 0x61 + 36; // 'a'-'z' -> 36..61
      if (ch === 0x2e) return 62; // '.' -> 62
      if (ch === 0x5f) return 63; // '_' -> 63
      return -1;
    };

    const outChars: number[] = [];
    if (isTable) {
      outChars.push(0x4840);
    }

    let i = 0;
    while (i < name.length) {
      const c0 = mapChar(name.charCodeAt(i));
      const c1 = i + 1 < name.length ? mapChar(name.charCodeAt(i + 1)) : -1;
      if (c0 >= 0 && c1 >= 0) {
        outChars.push(0x3800 + c0 + (c1 << 6));
        i += 2;
      } else if (c0 >= 0) {
        outChars.push(0x4800 + c0);
        i += 1;
      } else {
        outChars.push(name.charCodeAt(i));
        i += 1;
      }
    }
    return String.fromCharCode(...outChars);
  }

  private static formatDefaultDir(longName: string, index: number): string {
    const extIdx = longName.lastIndexOf('.');
    const base = extIdx > 0 ? longName.slice(0, extIdx) : longName;
    const ext = extIdx > 0 ? longName.slice(extIdx + 1) : '';
    const cleanBase = base.replace(/[^A-Za-z0-9_]/g, '').toUpperCase() || 'FILE';
    const cleanExt = ext.replace(/[^A-Za-z0-9_]/g, '').toUpperCase().slice(0, 3);
    const shortPrefix = cleanBase.slice(0, 4);
    const shortName = `${shortPrefix}~${index % 999}${cleanExt ? '.' + cleanExt : ''}`;
    return `${shortName}|${longName}`;
  }

  private static normalizeMsiVersion(version: string): string {
    const nums = version
      .replace(/[^0-9.]/g, '')
      .split('.')
      .filter(Boolean)
      .map((n) => Math.min(65535, Math.max(0, parseInt(n, 10) || 0)));
    return `${nums[0] ?? 1}.${nums[1] ?? 0}.${nums[2] ?? 0}`;
  }
}
