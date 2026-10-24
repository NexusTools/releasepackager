/**
 * Pure Node.js UNIX `ar` archive writer (`!<arch>\n`) used for building Debian `.deb` packages.
 */
export class ArArchiveWriter {
  private readonly members: { name: string; data: Buffer; mtimeSec: number; mode: number }[] = [];

  /**
   * Appends a member file to the `ar` archive.
   */
  public addMember(name: string, data: Buffer, mode = 0o100644, mtime = new Date()): void {
    this.members.push({
      name,
      data,
      mode,
      mtimeSec: Math.floor(mtime.getTime() / 1000)
    });
  }

  /**
   * Serializes the complete `ar` archive into a Buffer.
   */
  public toBuffer(): Buffer {
    const chunks: Buffer[] = [Buffer.from('!<arch>\n', 'ascii')];

    for (const member of this.members) {
      const header = Buffer.alloc(60, 0x20); // Fill with ASCII space
      const cleanName = member.name.slice(0, 16);
      header.write(cleanName.padEnd(16, ' '), 0, 16, 'ascii');
      header.write(String(member.mtimeSec).padEnd(12, ' '), 16, 12, 'ascii');
      header.write('0'.padEnd(6, ' '), 28, 6, 'ascii'); // Owner UID 0
      header.write('0'.padEnd(6, ' '), 34, 6, 'ascii'); // Group GID 0
      header.write(member.mode.toString(8).padEnd(8, ' '), 40, 8, 'ascii');
      header.write(String(member.data.length).padEnd(10, ' '), 48, 10, 'ascii');
      header[58] = 0x60; // '`'
      header[59] = 0x0a; // '\n'

      chunks.push(header);
      chunks.push(member.data);
      if (member.data.length % 2 !== 0) {
        chunks.push(Buffer.from('\n', 'ascii'));
      }
    }

    return Buffer.concat(chunks);
  }
}
