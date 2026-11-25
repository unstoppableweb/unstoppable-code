import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { posix, win32 } from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';

/*
 * Shell lookups every host that starts Windows shells shares: Electron main,
 * desktop-shared and the core daemon, which may not import either (CAN-5091).
 */

type FileExists = (filePath: string) => boolean;

/**
 * The first executable named `name` in `pathEnv`'s absolute directories,
 * resolved through links. Windows tries each `PATHEXT` extension when the
 * name has none, and needs no execute bit.
 */
export function findExecutableOnPath(
  name: string,
  options: {
    /** Anything but `win32` searches as POSIX. */
    readonly os: PlatformOperatingSystem | null;
    readonly pathEnv: string;
    readonly pathExt?: string;
    readonly rejectInvalid?: boolean;
  },
): string | null {
  const { os, pathEnv } = options;
  if (!pathEnv) return null;
  const paths = os === 'win32' ? win32 : posix;
  const candidates: string[] = [];
  const directories = pathEnv
    .split(paths.delimiter)
    .filter((directory) => paths.isAbsolute(directory));
  if (os === 'win32') {
    const pathExt = (options.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';');
    const hasExt = paths.extname(name).length > 0;
    for (const directory of directories) {
      if (hasExt) candidates.push(paths.join(directory, name));
      else
        for (const ext of pathExt)
          candidates.push(paths.join(directory, name + ext));
    }
  } else {
    for (const directory of directories)
      candidates.push(paths.join(directory, name));
  }
  let invalid: Error | undefined;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) {
        if (options.rejectInvalid) {
          invalid ??= new Error(`Executable is not a file: ${candidate}`);
        }
        continue;
      }
      if (os !== 'win32') accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch (error) {
      if (
        options.rejectInvalid &&
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        invalid ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (invalid !== undefined) throw invalid;
  return null;
}

export function quoteCmdArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      'Cannot pass command arguments containing newlines through cmd.exe',
    );
  }

  if (value.includes('%')) {
    throw new Error(
      'Cannot pass command arguments containing % through cmd.exe because environment variables would be expanded',
    );
  }

  if (!/[ \t&|<>^()"]/.test(value)) {
    return value;
  }

  return `"${value.split('"').join('""')}"`;
}

export function buildCmdCommandLine(
  command: string,
  args: string[] = [],
): string {
  return [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(' ');
}

function firstExistingFile(
  candidates: Array<string | null | undefined>,
  fileExists: FileExists,
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getCommonWindowsGitBashPaths(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment['ProgramFiles(x86)'];
  const localAppData = environment.LOCALAPPDATA;
  return [programFiles, programFilesX86, localAppData]
    .filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    .flatMap((base) => [
      win32.join(base, 'Git', 'bin', 'bash.exe'),
      win32.join(base, 'Programs', 'Git', 'bin', 'bash.exe'),
    ]);
}

function resolveGitBashFromGitExecutable(
  gitExecutable: string,
  fileExists: FileExists = existsSync,
): string | null {
  const normalized = win32.normalize(gitExecutable);
  const parent = win32.basename(win32.dirname(normalized)).toLowerCase();
  if (parent !== 'cmd' && parent !== 'bin') {
    return null;
  }
  const gitRoot = win32.dirname(win32.dirname(normalized));
  return firstExistingFile(
    [win32.join(gitRoot, 'bin', 'bash.exe')],
    fileExists,
  );
}

export function resolveWindowsGitBash(
  environment: Readonly<Record<string, string | undefined>>,
  fileExists: FileExists = existsSync,
): string | null {
  const gitExecutable = environment.CANOPY_GIT_EXECUTABLE?.trim();
  return (
    (gitExecutable
      ? resolveGitBashFromGitExecutable(gitExecutable, fileExists)
      : null) ??
    firstExistingFile(getCommonWindowsGitBashPaths(environment), fileExists)
  );
}
