import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readBoundedBytes } from '@canopy/execution-engine/node/lib/bounded-file-reader';
import { isRecord } from '../lib/type-guards';

const MAX_AUTH_BYTES = 64 * 1024;

/** The access token in an `auth.json` body, or null for anything else. */
function accessTokenFrom(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.accessToken === 'string'
      ? value.accessToken.trim() || null
      : null;
  } catch {
    return null;
  }
}

/** Mirrors the pinned CLI's credential store. Never copies or persists tokens. */
export async function readCursorAccessToken(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  signal.throwIfAborted();
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-a',
          'cursor-user',
          '-s',
          'cursor-access-token',
          '-w',
        ],
        {
          env,
          signal,
          timeout: 10_000,
          maxBuffer: MAX_AUTH_BYTES,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    });
  }
  // The pinned CLI's file credential store outside macOS: Linux uses
  // `$XDG_CONFIG_HOME/cursor/auth.json` and Windows `APPDATA/Cursor/auth.json`.
  // Managed launches point both variables into the private profile, so this
  // reads the managed sign-in. Only the variable is used, never the CLI's
  // home-directory fallback, so a different installation is never read.
  if (platform === 'linux') {
    if (!env.XDG_CONFIG_HOME) return null;
    // Non-blocking, regular files only, no links: a FIFO or device in the
    // profile can neither hold this read past cancellation nor feed it.
    const bytes = await readBoundedBytes(
      env.XDG_CONFIG_HOME,
      'cursor/auth.json',
      MAX_AUTH_BYTES,
      signal,
    ).catch(() => null);
    return bytes ? accessTokenFrom(bytes.toString('utf8')) : null;
  }
  if (platform !== 'win32' || !env.APPDATA) return null;
  const file = await open(join(env.APPDATA, 'Cursor', 'auth.json'), 'r').catch(
    () => null,
  );
  if (!file) return null;
  try {
    const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > MAX_AUTH_BYTES) return null;
    return accessTokenFrom(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
