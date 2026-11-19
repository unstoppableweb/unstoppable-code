import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  W5RecoveryStatusSchema,
  type W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';
import { syncDirectory } from './atomic-file';
import { isErrnoException, isRecord } from './type-guards';

const W5_RECOVERY_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 4096;
// Covers status character bounds after JSON escaping; revisit if those bounds grow.
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
export interface W5RecoveryRequest {
  readonly version: 1;
  readonly createdAt: number;
}
export class W5RecoveryRequestError extends Error {
  constructor(
    readonly reason:
      | 'invalid-request'
      | 'runtime-unavailable'
      | 'platform-unsupported',
  ) {
    super(`Recovery request refused (${reason}).`);
    this.name = 'W5RecoveryRequestError';
  }
}
const refuse = (reason: W5RecoveryRequestError['reason']): never => {
  throw new W5RecoveryRequestError(reason);
};
export const w5RecoveryRequestPath = (dataRoot: string): string =>
  join(dataRoot, 'runtime', 'w5-recovery-request.json');
export const w5RecoveryResultPath = (dataRoot: string): string =>
  join(dataRoot, 'runtime', 'w5-recovery-result.json');

/** Verifies only; recovery must not repair linked or non-private runtime roots. */
export async function requirePrivateW5RecoveryRuntime(
  dataRoot: string,
): Promise<void> {
  if (hostPlatformOperatingSystem() === 'win32')
    throw new W5RecoveryRequestError('platform-unsupported');
  try {
    if (resolve(dataRoot) !== dataRoot) refuse('runtime-unavailable');
    const os = hostPlatformOperatingSystem();
    const platform = hostPlatformServices(createPlatformEndpointServices(os));
    for (const path of [dataRoot, join(dataRoot, 'runtime')]) {
      if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
        refuse('runtime-unavailable');
      const permission = await platform.secureFiles.permissions({
        path,
        kind: 'directory',
        mode: 'owner-only',
        action: 'verify',
      });
      if (permission.state !== 'private') refuse('runtime-unavailable');
    }
  } catch {
    refuse('runtime-unavailable');
  }
}
const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

async function privateBytes(
  path: string,
  observed: Stats,
  max: number,
): Promise<Buffer> {
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.nlink !== 1 ||
    observed.size > max ||
    (observed.mode & 0o077) !== 0
  )
    refuse('runtime-unavailable');
  const platform = hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
  );
  const permission = await platform.secureFiles.permissions({
    path,
    kind: 'file',
    mode: 'owner-only',
    action: 'verify',
  });
  if (permission.state !== 'private') refuse('runtime-unavailable');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFile(observed, await handle.stat())) refuse('runtime-unavailable');
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length > max ||
      after.size !== observed.size ||
      after.mtimeMs !== observed.mtimeMs ||
      !sameFile(observed, await lstat(path))
    )
      refuse('runtime-unavailable');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Single-use intent, deleted durably before any recovery can execute. */
export async function consumeW5RecoveryRequest(
  dataRoot: string,
  now = Date.now(),
): Promise<W5RecoveryRequest | null> {
  const path = w5RecoveryRequestPath(dataRoot);
  let observed: Stats;
  try {
    observed = await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    return refuse('runtime-unavailable');
  }
  await requirePrivateW5RecoveryRuntime(dataRoot);
  let bytes: Buffer;
  try {
    bytes = await privateBytes(path, observed, MAX_REQUEST_BYTES);
    await unlink(path);
    await syncDirectory(join(dataRoot, 'runtime'));
  } catch {
    return refuse('runtime-unavailable');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse('invalid-request');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'createdAt,version' ||
    value.version !== 1 ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0 ||
    value.createdAt > now ||
    now - value.createdAt > W5_RECOVERY_REQUEST_MAX_AGE_MS
  )
    return refuse('invalid-request');
  return { version: 1, createdAt: value.createdAt };
}

/** Exclusive create: a second click never overwrites an earlier launch's intent. */
export async function writeW5RecoveryRequest(
  dataRoot: string,
  now = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(now) || now <= 0) refuse('invalid-request');
  await requirePrivateW5RecoveryRuntime(dataRoot);
  const file = await open(w5RecoveryRequestPath(dataRoot), 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ version: 1, createdAt: now })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(join(dataRoot, 'runtime'));
}

/** Discovery only; never reads a token, leases, starts, or repairs a daemon. */
export async function readW5RecoveryDescriptor(
  dataRoot: string,
): Promise<unknown> {
  await requirePrivateW5RecoveryRuntime(dataRoot);
  const path = join(dataRoot, 'runtime/core.json');
  let observed: Stats;
  try {
    observed = await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(
    (await privateBytes(path, observed, 64 * 1024)).toString('utf8'),
  );
}

export async function readW5RecoveryResult(
  dataRoot: string,
  now = Date.now(),
): Promise<W5RecoveryStatus | null> {
  try {
    await requirePrivateW5RecoveryRuntime(dataRoot);
    const path = w5RecoveryResultPath(dataRoot);
    const value: unknown = JSON.parse(
      (await privateBytes(path, await lstat(path), MAX_RESULT_BYTES)).toString(
        'utf8',
      ),
    );
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.finishedAt !== 'number' ||
      value.finishedAt > now ||
      now - value.finishedAt > W5_RECOVERY_REQUEST_MAX_AGE_MS
    )
      return null;
    const parsed = W5RecoveryStatusSchema.safeParse(value.status);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
