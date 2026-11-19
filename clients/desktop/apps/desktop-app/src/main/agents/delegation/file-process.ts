import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  DELEGATION_FILE_DEFAULT_BYTES,
  NativeDelegationFiles,
  validDelegationFileBytes,
  type DelegationFileLimits,
} from '@canopy/desktop-shared/node/delegation/file-access';
import { getBundledDelegationFileBrokerPath } from '../../pipelines/config-paths';
import { spawnClaudeCodeProcessOffMain } from '../claude-process-host-runner';
import { delegationStopSignal } from './stop-signal';

/** Actionable copy when the staged helper is missing, non-executable, or
 * otherwise invalid. Kept identical to the parent discovery disabled reason. */
export const DELEGATION_FILE_HELPER_MISSING_MESSAGE =
  'The bundled delegated file helper is missing or invalid. Reinstall the app to restore it.';

export function delegationFileBinary(): string {
  return getBundledDelegationFileBrokerPath();
}

/** The helper at the fixed bundled path must be a non-empty regular file that
 * is neither a symlink nor hard-linked (nlink === 1). On POSIX hosts it must
 * also carry an execute bit; Windows has no execute permission bit. An
 * unsupported host is never eligible. */
export async function delegationFileBoundaryAvailable(): Promise<boolean> {
  const hostOs = hostOperatingSystem();
  if (!hostOs) return false;
  try {
    const stat = await fs.lstat(delegationFileBinary());
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0) return false;
    return hostOs === 'win32' || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The filesystem calls root canonicalization needs; injectable for tests. */
export interface DelegationRootFileSystem {
  realpath(directory: string): Promise<string>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean }>;
}

/** Resolve a delegation root, refusing one that traverses a link. POSIX roots
 * must equal their realpath (after macOS /var and /tmp aliases). Windows
 * realpath also expands 8.3 short names and normalizes case, so a Windows root
 * is instead checked component by component: no symlink or junction from the
 * drive root down. The native broker repeats this per component. */
export async function canonicalDelegationRoot(
  directory: string,
  platform: NodeJS.Platform = hostPlatformOperatingSystem(),
  fsApi: DelegationRootFileSystem = fs,
  pathApi: Pick<typeof path, 'resolve' | 'dirname'> = path,
): Promise<string> {
  const canonical = await fsApi.realpath(directory);
  const absolute = pathApi.resolve(directory);
  if (platform === 'win32') {
    for (let current = absolute; ; current = pathApi.dirname(current)) {
      if ((await fsApi.lstat(current)).isSymbolicLink())
        throw new Error('Delegation roots cannot traverse symbolic links');
      if (pathApi.dirname(current) === current) break;
    }
    return canonical;
  }
  const expected =
    platform === 'darwin'
      ? absolute.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1')
      : absolute;
  if (canonical !== expected)
    throw new Error('Delegation roots cannot traverse symbolic links');
  return canonical;
}

/** Fixed packaged helper, launched through the existing off-main process host.
 * The helper enforces the same per-file bound as the returned client. */
export async function openDelegationFiles(
  directory: string,
  signal: AbortSignal,
  limits: DelegationFileLimits = {},
): Promise<NativeDelegationFiles> {
  if (!validDelegationFileBytes(limits.fileBytes))
    throw new Error('Invalid delegated file bound.');
  return openNativeFiles(directory, signal, limits);
}

async function openNativeFiles(
  directory: string,
  signal: AbortSignal,
  limits: DelegationFileLimits,
): Promise<NativeDelegationFiles> {
  const canonical = await canonicalDelegationRoot(directory);
  if (signal.aborted)
    throw new Error('The delegated file boundary is unavailable');
  if (!(await delegationFileBoundaryAvailable()))
    throw new Error(DELEGATION_FILE_HELPER_MISSING_MESSAGE);
  // Host selection goes through core-platform (platform boundary check).
  const hostOs = hostPlatformOperatingSystem();
  const environment: Record<string, string> = {
    PATH: '',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    TMP: os.tmpdir(),
    TEMP: os.tmpdir(),
  };
  if (hostOs === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot))
      throw new Error('Windows system directory is unavailable');
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }
  const child = spawnClaudeCodeProcessOffMain({
    command: delegationFileBinary(),
    args:
      limits.fileBytes === undefined ||
      limits.fileBytes === DELEGATION_FILE_DEFAULT_BYTES
        ? [canonical]
        : [canonical, String(limits.fileBytes)],
    cwd: canonical,
    env: environment,
    signal,
  });
  child.stdin.on('error', () => undefined);
  child.on('error', () => undefined);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  return NativeDelegationFiles.open(
    {
      stdin: child.stdin,
      stdout: child.stdout,
      exited,
      terminate: () => {
        child.kill(delegationStopSignal());
      },
    },
    signal,
    limits,
    hostOs,
  );
}
