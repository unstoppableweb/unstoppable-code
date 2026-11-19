import { execFile } from 'node:child_process';
import { readdir, unlink } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { parseDn } from 'builder-util-runtime';
import { ElectronAppAdapter } from 'electron-updater/out/ElectronAppAdapter';
import type { VerifyUpdateCodeSignature } from 'electron-updater';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { drainOwnedProcess } from '../lib/process-kill';
import {
  logMainProcessError,
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';

const SIGNATURE_TIMEOUT_MS = 180_000;
const SIGNATURE_ATTEMPTS = 2;

const WINDOWS_UPDATE_MESSAGES = {
  ERR_UPDATER_SIGNATURE_TIMEOUT:
    'Update signature verification timed out. Try downloading the update again.',
  ERR_UPDATER_SIGNATURE_CHECK_FAILED:
    'The update could not be verified. Try downloading the update again.',
  ERR_UPDATER_TEMP_CLEANUP_FAILED:
    'The previous update could not be cleared. Restart the app and try again.',
} as const;

type WindowsUpdateErrorCode = keyof typeof WINDOWS_UPDATE_MESSAGES;

class WindowsUpdateError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;

  constructor(
    readonly code: WindowsUpdateErrorCode,
    cause?: unknown,
  ) {
    super(WINDOWS_UPDATE_MESSAGES[code]);
    this.cause = cause;
    this.name = 'WindowsUpdateError';
  }
}

export function windowsUpdateErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return null;
  for (const [code, message] of Object.entries(WINDOWS_UPDATE_MESSAGES)) {
    if (error.code === code) return message;
  }
  return null;
}

/** The closed code of a Windows update failure, or null for any other error. */
export function windowsUpdateErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return null;
  for (const code of Object.keys(WINDOWS_UPDATE_MESSAGES)) {
    if (error.code === code) return code;
  }
  return null;
}

function signatureCommand(file: string): string {
  const literalPath = file.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${literalPath}'`,
    '$signature | Select-Object Status, Path, @{Name="Subject";Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress',
  ].join('; ');
}

function runSignatureCheck(file: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let termination: Promise<void> | null = null;
    const env = getEnhancedEnv({
      includeCanopySecrets: false,
      environment: false,
    });
    // Preserve electron-updater's module-path reset without cmd.exe/chcp.
    for (const name of Object.keys(env)) {
      if (name.toLowerCase() === 'psmodulepath') delete env[name];
    }
    env.PSModulePath = '';
    const child = execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-InputFormat',
        'None',
        '-EncodedCommand',
        Buffer.from(signatureCommand(file), 'utf16le').toString('base64'),
      ],
      { env, windowsHide: true, shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        // The callback can run while taskkill is still draining descendants.
        // Keep the download mutex held until both operations finish.
        void (async (): Promise<void> => {
          if (termination) await termination;
          if (timedOut)
            throw new WindowsUpdateError('ERR_UPDATER_SIGNATURE_TIMEOUT');
          if (error || stderr.trim())
            throw new WindowsUpdateError(
              'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
              error ?? new Error(stderr),
            );
          resolve(stdout);
        })().catch(reject);
      },
    );
    // Own the deadline: Node's built-in timeout would kill the parent before
    // taskkill /T could discover its descendants.
    const timer = setTimeout(() => {
      timedOut = true;
      logMainProcessWarn('Windows update signature verification timed out', {
        file,
        timeoutMs,
        pid: child.pid,
      });
      if (child.pid === undefined) return;
      termination = drainOwnedProcess(
        child.pid,
        () => child.exitCode === null && child.signalCode === null,
      ).catch(async (error: unknown): Promise<never> => {
        // Direct execution also lets us terminate the actual reader if the
        // tree operation fails. Never retry a failed tree cleanup.
        if (child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => {
            child.once('close', () => resolve());
          });
          child.kill('SIGKILL');
          await closed;
        }
        throw new WindowsUpdateError(
          'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
          error,
        );
      });
      void termination.catch(reject);
    }, timeoutMs);
  });
}

function validateSignature(
  output: string,
  file: string,
  publisherNames: string[],
): string | null {
  const data: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
  if (
    typeof data !== 'object' ||
    data === null ||
    !('Status' in data) ||
    data.Status !== 0 ||
    !('Path' in data) ||
    typeof data.Path !== 'string' ||
    win32.normalize(data.Path).toLowerCase() !==
      win32.normalize(file).toLowerCase() ||
    !('Subject' in data) ||
    typeof data.Subject !== 'string'
  ) {
    return 'The downloaded update has an invalid signature or file path.';
  }
  const subject = parseDn(data.Subject);
  const matches = publisherNames.some((name) => {
    const expected = parseDn(name);
    return expected.size > 0
      ? Array.from(expected).every(([key, value]) => subject.get(key) === value)
      : name.length > 0 && subject.get('CN') === name;
  });
  return matches ? null : 'The downloaded update has an unexpected publisher.';
}

export function createWindowsUpdateVerifier(
  options: { timeoutMs?: number } = {},
): VerifyUpdateCodeSignature {
  const timeoutMs = options.timeoutMs ?? SIGNATURE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid Windows update signature timeout.');
  return async (publishers, file): Promise<string | null> => {
    for (let attempt = 1; ; attempt += 1) {
      const started = Date.now();
      logMainProcessInfo('Verifying Windows update signature', {
        file,
        attempt,
      });
      try {
        const output = await runSignatureCheck(file, timeoutMs);
        const result = validateSignature(output, file, publishers);
        logMainProcessInfo('Windows update signature verification completed', {
          file,
          attempt,
          durationMs: Date.now() - started,
          valid: result === null,
        });
        return result;
      } catch (error) {
        logMainProcessError(
          'Windows update signature verification failed',
          error,
        );
        if (
          error instanceof WindowsUpdateError &&
          error.code === 'ERR_UPDATER_SIGNATURE_TIMEOUT' &&
          attempt < SIGNATURE_ATTEMPTS
        ) {
          continue;
        }
        if (error instanceof WindowsUpdateError) throw error;
        throw new WindowsUpdateError(
          'ERR_UPDATER_SIGNATURE_CHECK_FAILED',
          error,
        );
      }
    }
  };
}

async function pendingDirectory(updater: object): Promise<string> {
  // electron-updater documents this runtime property as public but strips it
  // from its .d.ts as @internal. Validate it rather than casting its type.
  if (
    !('configOnDisk' in updater) ||
    typeof updater.configOnDisk !== 'object' ||
    updater.configOnDisk === null ||
    !('value' in updater.configOnDisk)
  ) {
    throw new WindowsUpdateError('ERR_UPDATER_TEMP_CLEANUP_FAILED');
  }
  const config: unknown = await updater.configOnDisk.value;
  if (
    typeof config !== 'object' ||
    config === null ||
    !('updaterCacheDirName' in config) ||
    typeof config.updaterCacheDirName !== 'string' ||
    !config.updaterCacheDirName ||
    config.updaterCacheDirName === '.' ||
    config.updaterCacheDirName === '..' ||
    basename(config.updaterCacheDirName) !== config.updaterCacheDirName
  ) {
    throw new WindowsUpdateError('ERR_UPDATER_TEMP_CLEANUP_FAILED');
  }
  return join(
    new ElectronAppAdapter().baseCachePath,
    config.updaterCacheDirName,
    'pending',
  );
}

export async function cleanupWindowsUpdateTempFiles(
  updater: object,
): Promise<void> {
  try {
    const directory = await pendingDirectory(updater);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^(?:\d+-)?temp-.+\.exe$/i.test(entry.name))
        continue;
      const file = join(directory, entry.name);
      for (let attempt = 0; ; attempt += 1) {
        try {
          await unlink(file);
          break;
        } catch (error) {
          if (isFileError(error, 'ENOENT')) break;
          if (
            attempt >= 2 ||
            !['EBUSY', 'EPERM', 'EACCES'].some((code) =>
              isFileError(error, code),
            )
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    logMainProcessError(
      'Windows update temporary installer cleanup failed',
      error,
    );
    throw new WindowsUpdateError('ERR_UPDATER_TEMP_CLEANUP_FAILED', error);
  }
}

function isFileError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
