/**
 * Represents a single entry in a virtual archive or filesystem tree.
 */
export interface VirtualFileEntry {
  /** Relative POSIX path inside the archive/volume (no leading slash) */
  relativePath: string;
  /** File content buffer (empty for directories/symlinks) */
  data: Buffer;
  /** Whether this entry is a directory */
  isDirectory: boolean;
  /** Whether this entry is a symbolic link */
  isSymlink: boolean;
  /** Target path if isSymlink is true */
  symlinkTarget?: string;
  /** POSIX file mode (e.g., 0o755, 0o644, 0o120777) */
  mode: number;
  /** Last modified timestamp */
  mtime: Date;
}

/**
 * Metadata for a file entry inside an MSI installation database and Cabinet archive.
 */
export interface MsiFileEntry {
  /** Unique MSI identifier (e.g., 'File_0001') */
  fileKey: string;
  /** Component identifier owning this file */
  componentKey: string;
  /** Directory identifier in the MSI Directory table */
  directoryKey: string;
  /** Short 8.3 filename + '|' + Long filename for MSI File table */
  fileNameField: string;
  /** Actual long filename */
  longFileName: string;
  /** Relative path from application root */
  relativePath: string;
  /** File size in bytes */
  fileSize: number;
  /** File content buffer */
  data: Buffer;
  /** 1-based sequence number in the cabinet */
  sequence: number;
  /** Whether this file is the main executable (for shortcuts) */
  isMainExecutable: boolean;
}
