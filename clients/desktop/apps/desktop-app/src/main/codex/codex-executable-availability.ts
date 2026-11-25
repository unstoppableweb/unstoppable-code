import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import {
  getBundledBinDir,
  getBundledBinaryOverride,
  getLoginShellPathSnapshot,
  resolveBundledBinary,
  type BundledBinaryResolution,
} from '@canopy/execution-engine/pipelines/config-paths';

const ABSENCE_TTL_MS = 30_000;

type Probe = {
  command: string;
  status: BundledBinaryResolution['status'];
  installed: boolean;
};

let absence: { key: string; result: Probe; expiresAt: number } | undefined;
const pendingProbes = new Map<string, Promise<Probe>>();

export class CodexNotInstalledError extends Error {
  constructor() {
    super('Codex CLI is not installed.');
    this.name = 'CodexNotInstalledError';
  }
}

async function probeExecutable(searchPath: string): Promise<Probe> {
  const platform = hostPlatformOperatingSystem();
  const resolution = resolveBundledBinary('codex', { probeOnly: true });
  const command = resolution.path;
  const selection = { command, status: resolution.status };
  const bareCommand =
    (resolution.status === 'override' || resolution.status === 'unbundled') &&
    !path.parse(command).root &&
    !command.includes('/') &&
    !(platform === 'win32' && command.includes('\\'));
  if (bareCommand) {
    const executablePath =
      platform === 'win32'
        ? searchPath
        : searchPath
            .split(path.delimiter)
            .map((directory) => path.resolve(directory))
            .join(path.delimiter);
    return {
      ...selection,
      installed:
        findExecutableOnPath(command, executablePath, {
          rejectInvalid: true,
        }) !== null,
    };
  }
  try {
    if (!(await stat(command)).isFile()) {
      throw new Error(`Codex executable is not a file: ${command}`);
    }
    if (platform !== 'win32') await access(command, constants.X_OK);
    return { ...selection, installed: true };
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    ) {
      throw error;
    }
    return { ...selection, installed: false };
  }
}

function executableLookup(): { key: string; searchPath: string } {
  const binDir = getBundledBinDir();
  const loginPath = getLoginShellPathSnapshot();
  const searchPath = [binDir, loginPath].filter(Boolean).join(path.delimiter);
  const key = JSON.stringify([
    getBundledBinaryOverride('codex'),
    binDir,
    searchPath,
    process.cwd(),
    process.env.PATHEXT,
  ]);
  return { key, searchPath };
}

function checkExecutable(
  { key, searchPath } = executableLookup(),
): Promise<Probe> {
  const pending = pendingProbes.get(key);
  if (pending) return pending;
  if (absence?.key === key && Date.now() < absence.expiresAt) {
    return Promise.resolve(absence.result);
  }
  const probe = probeExecutable(searchPath)
    .then((result) => {
      if (!result.installed) {
        absence = { key, result, expiresAt: Date.now() + ABSENCE_TTL_MS };
      }
      return result;
    })
    .finally(() => pendingProbes.delete(key));
  pendingProbes.set(key, probe);
  return probe;
}

export async function isCodexExecutableInstalled(): Promise<boolean> {
  return (await checkExecutable()).installed;
}

async function requireExecutable(lookup = executableLookup()): Promise<Probe> {
  const result = await checkExecutable(lookup);
  if (!result.installed) throw new CodexNotInstalledError();
  return result;
}

export async function assertCodexExecutableInstalled(): Promise<void> {
  await requireExecutable();
}

export async function withOptionalCodex<T>(
  read: () => Promise<T>,
): Promise<T | null> {
  if (!(await isCodexExecutableInstalled())) return null;
  try {
    return await read();
  } catch (error) {
    if (error instanceof CodexNotInstalledError) return null;
    throw error;
  }
}

export async function withInstalledCodex<T>(
  action: () => Promise<T>,
): Promise<T> {
  const lookup = executableLookup();
  const selection = await requireExecutable(lookup);
  try {
    return await action();
  } catch (error) {
    const spawnError =
      typeof error === 'object' && error !== null && 'cause' in error
        ? (error.cause ?? error)
        : error;
    if (
      typeof spawnError === 'object' &&
      spawnError !== null &&
      'code' in spawnError &&
      spawnError.code === 'ENOENT' &&
      'path' in spawnError &&
      typeof spawnError.path === 'string' &&
      'syscall' in spawnError &&
      spawnError.syscall === `spawn ${spawnError.path}` &&
      (spawnError.path === selection.command ||
        selection.status === 'host-fallback')
    ) {
      const currentLookup = executableLookup();
      if (lookup.key !== currentLookup.key) throw error;
      await pendingProbes.get(currentLookup.key)?.catch(() => undefined);
      if (absence?.key === currentLookup.key) absence = undefined;
      const current = await checkExecutable(currentLookup);
      if (
        !current.installed &&
        (spawnError.path === selection.command ||
          (current.status === 'missing' && spawnError.path === current.command))
      ) {
        throw new CodexNotInstalledError();
      }
    }
    throw error;
  }
}
