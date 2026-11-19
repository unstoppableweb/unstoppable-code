import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { app } from 'electron';
import { constants } from 'node:fs';
import { access, lstat, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.string(),
});

async function assertExecutable(file: string): Promise<void> {
  if (!(await lstat(file)).isFile())
    throw new Error(
      `Bundled Node runtime member is not a regular file: ${file}`,
    );
  await access(file, constants.X_OK);
  const descriptor = await open(file, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead: length } = await descriptor.read(
      header,
      0,
      header.length,
      0,
    );
    let valid = false;
    if (hostOperatingSystem() === 'darwin')
      valid =
        length >= 32 &&
        header.readUInt32LE(0) === 0xfeedfacf &&
        header.readUInt32LE(4) ===
          (process.arch === 'arm64' ? 0x0100000c : 0x01000007);
    else if (hostOperatingSystem() === 'linux')
      valid =
        length >= 64 &&
        header.toString('hex', 0, 7) === '7f454c46020101' &&
        header.readUInt16LE(18) === (process.arch === 'arm64' ? 183 : 62);
    else if (hostOperatingSystem() === 'win32' && length >= 64) {
      const offset = header.readUInt32LE(0x3c);
      valid =
        offset <= length - 26 &&
        header.toString('hex', 0, 2) === '4d5a' &&
        header.toString('hex', offset, offset + 4) === '50450000' &&
        header.readUInt16LE(offset + 4) === 0x8664 &&
        header.readUInt16LE(offset + 24) === 0x20b;
    }
    if (!valid)
      throw new Error(
        `Bundled Node runtime has the wrong architecture: ${file}`,
      );
  } finally {
    await descriptor.close();
  }
}

/** Host-selected, private interpreter; never Electron, the SEA CLI or PATH. */
export async function getDesktopNodeRuntime(): Promise<{
  nodeProcess: { command: string };
  tsxCli: string;
}> {
  const target = `${hostOperatingSystem()}-${process.arch}`;
  if (
    ![
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
      'linux-x64',
      'linux-arm64',
    ].includes(target)
  )
    throw new Error(`Unsupported desktop Node target: ${target}`);
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'node-runtime')
    : resolve(process.cwd(), '.cache', 'desktop-node', target);
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Invalid runtime directory');
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(join(directory, 'node-runtime.json'), 'utf8')),
    );
    if (receipt.target !== target) throw new Error('Runtime target mismatch');
    const command = join(
      directory,
      hostOperatingSystem() === 'win32' ? 'node.exe' : 'node',
    );
    const tsxCli = join(directory, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    await assertExecutable(command);
    if (!(await lstat(tsxCli)).isFile()) throw new Error('Missing TSX CLI');
    return { nodeProcess: { command }, tsxCli };
  } catch {
    throw new Error(
      `Bundled Node/TSX runtime is unavailable at ${directory}; stage the desktop Node runtime before launching development builds.`,
    );
  }
}
