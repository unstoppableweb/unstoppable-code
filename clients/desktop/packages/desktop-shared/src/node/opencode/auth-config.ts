import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { allowlistedErrnoOrOther } from '@canopy/core-runtime';
import { open, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_AUTH_BYTES = 1024 * 1024;

function openCodeNativeDataDir(env: NodeJS.ProcessEnv, cwd: string): string {
  const home =
    (hostPlatformOperatingSystem() === 'win32' ? env.USERPROFILE : env.HOME) ||
    homedir();
  return resolve(
    cwd,
    env.XDG_DATA_HOME || join(home, '.local', 'share'),
    'opencode',
  );
}

/** V2 keeps credentials and sessions together; only OpenCode writes this database. */
export function openCodeNativeDatabase(
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return join(openCodeNativeDataDir(env, cwd), 'opencode.db');
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    (error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return false;
      throw new Error('OpenCode configuration could not be checked.');
    },
  );
}

/** The v2 CLI has no switch to exclude system/MDM plugin discovery. */
export async function assertOpenCodeSystemConfigSafe(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = hostPlatformOperatingSystem(),
): Promise<void> {
  const paths =
    platform === 'darwin'
      ? [
          '/Library/Application Support/opencode',
          '/Library/Managed Preferences/ai.opencode.managed.plist',
          join(
            '/Library/Managed Preferences',
            userInfo().username,
            'ai.opencode.managed.plist',
          ),
        ]
      : [
          platform === 'win32'
            ? join(env.ProgramData || 'C:\\ProgramData', 'opencode')
            : '/etc/opencode',
        ];
  for (const file of paths) {
    if (await exists(file))
      throw new Error(
        'OpenCode system configuration cannot be isolated. Managed system plugins are not supported.',
      );
  }
}

async function assertNativeDatabaseSafe(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const file = openCodeNativeDatabase(env, cwd);
  if (!(await exists(file))) return;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
          )
          .get()
      )
        return;
      const row = db
        .prepare(
          "SELECT substr(value, 1, 1048577) AS value FROM kv WHERE key = 'wellknown:sources'",
        )
        .get();
      if (!row) return;
      if (
        typeof row.value !== 'string' ||
        Buffer.byteLength(row.value) > MAX_AUTH_BYTES
      )
        throw new Error('Invalid sources');
      const sources: unknown = JSON.parse(row.value);
      if (!Array.isArray(sources) || sources.length)
        throw new Error('Remote sources');
    } finally {
      db.close();
    }
  } catch {
    throw new Error(
      'OpenCode remote configuration could not be excluded. Use a provider sign-in or API key without remote configuration.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An `auth.json` open failure. Only its allowlisted errno (`other` for the
 * rest) may leave this host; the original error, whose message names the
 * path, stays a non-enumerable `runtimeCause` for local logs (CAN-7117).
 */
class OpenCodeCredentialsReadError extends Error {
  readonly code: string;
  declare readonly runtimeCause: unknown;

  constructor(runtimeCause: unknown) {
    super('OpenCode provider credentials could not be read.');
    this.code = allowlistedErrnoOrOther(runtimeCause);
    Object.defineProperty(this, 'runtimeCause', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: runtimeCause,
    });
  }
}

/** Native API/OAuth credentials stay native-owned, including token refresh. */
export async function assertOpenCodeAuthConfigSafe(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  await assertNativeDatabaseSafe(env, cwd);
  if (env.OPENCODE_AUTH_CONTENT) validateAuth(env.OPENCODE_AUTH_CONTENT);
  const file = join(openCodeNativeDataDir(env, cwd), 'auth.json');
  const handle = await open(file, 'r').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw new OpenCodeCredentialsReadError(error);
  });
  if (!handle) return;
  let source: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_AUTH_BYTES)
      throw new Error('OpenCode provider credentials could not be read.');
    const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_AUTH_BYTES)
      throw new Error('OpenCode provider credentials are too large.');
    source = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  validateAuth(source);
}

function validateAuth(source: string): void {
  if (Buffer.byteLength(source) > MAX_AUTH_BYTES)
    throw new Error('OpenCode provider credentials are too large.');
  let auth: unknown;
  try {
    auth = JSON.parse(source);
  } catch {
    throw new Error('OpenCode provider credentials contain invalid JSON.');
  }
  if (!isRecord(auth))
    throw new Error('OpenCode provider credentials contain invalid JSON.');
  // V2 imports legacy credentials into its database on first use, including
  // wellknown remote config sources. Reject those before native migration.
  if (
    Object.values(auth).some(
      (value) => isRecord(value) && value.type === 'wellknown',
    )
  )
    throw new Error(
      'OpenCode remote configuration is not supported. Use a provider sign-in or API key.',
    );
}
