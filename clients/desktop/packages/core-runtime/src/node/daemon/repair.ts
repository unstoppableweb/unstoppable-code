import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  CanopyRuntimeDescriptorSchema,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  PlatformOperatingSystem,
  PlatformServices,
  PlatformStartupClaim,
} from '../../platform/platform-services';
import type { DaemonStartupClaimPort } from '../../platform/startup-claim';

export interface EndpointRepairClaimPort extends DaemonStartupClaimPort {
  release(
    handle: object,
    options?: { readonly preserveEndpointBind?: boolean },
  ): Promise<'released' | 'not_owner' | 'ambiguous'>;
}

export interface CanopyEndpointRepairHost {
  readonly os: PlatformOperatingSystem;
  readonly dataRoot: string;
  readonly platform: PlatformServices;
  readonly claims: () => Promise<EndpointRepairClaimPort>;
}

export interface CanopyEndpointRepairOptions extends CanopyEndpointRepairHost {
  readonly signal?: AbortSignal;
  /** Trusted test seams; production uses the running process and UTC clock. */
  readonly selfPid?: number;
  readonly now?: () => Date;
  readonly onCleanupFailure?: (message: string) => void;
}

export interface CanopyEndpointRepairResult {
  readonly kind: 'repaired' | 'noop' | 'refused' | 'incomplete';
  /** Fixed text and an optional generated folder name only. */
  readonly message: string;
}

class RepairRefusal extends Error {}
class RepairNoop extends Error {}
function refuse(message: string): never {
  throw new RepairRefusal(message);
}
const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const absent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';
const stat = async (path: string): Promise<BigIntStats | null> => {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};

/**
 * The socket at the path is the one the descriptor published: same inode, and
 * the same device unless the filesystem device ID changed (CAN-5957). A missing
 * receipt cannot prove ownership, so it is never a match.
 */
function socketRecordedBy(
  descriptor: CanopyRuntimeDescriptor,
  socket: BigIntStats,
): boolean {
  return descriptor.socketIdentity?.inode === String(socket.ino);
}

async function privateRegularFile(
  platform: PlatformServices,
  path: string,
): Promise<BigIntStats> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    (await realpath(path)) !== path ||
    (
      await platform.secureFiles.permissions({
        path,
        kind: 'file',
        action: 'verify',
        mode: 'owner-only',
      })
    ).state !== 'private'
  )
    refuse('Repair refused: connection file is not a private regular file.');
  if (!same(before, await lstat(path, { bigint: true })))
    refuse('Repair refused: connection file changed.');
  return before;
}

async function readRepairDescriptor(
  platform: PlatformServices,
  descriptorPath: string,
  endpointPath: string,
): Promise<{
  readonly descriptor: CanopyRuntimeDescriptor;
  readonly descriptorStat: BigIntStats;
}> {
  const descriptorStat = await privateRegularFile(platform, descriptorPath);
  if (descriptorStat.size > 65536n)
    refuse('Repair refused: descriptor is invalid.');
  const file = await open(
    descriptorPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let raw: string;
  try {
    if (!same(descriptorStat, await file.stat({ bigint: true })))
      refuse('Repair refused: descriptor changed.');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (BigInt(bytesRead) !== descriptorStat.size || bytesRead > 65536)
      refuse('Repair refused: descriptor changed.');
    raw = bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const parsed = CanopyRuntimeDescriptorSchema.safeParse(JSON.parse(raw));
  if (
    !parsed.success ||
    parsed.data.endpoint.kind !== 'socket' ||
    parsed.data.endpoint.path !== endpointPath
  )
    refuse('Repair refused: descriptor does not identify this endpoint.');
  const descriptor = parsed.data;
  return { descriptor, descriptorStat };
}

async function eligibleRepairToken(
  platform: PlatformServices,
  directory: string,
  descriptorPath: string,
  socketPath: string,
  descriptorStat: BigIntStats,
  socket: BigIntStats,
  tokenPath: string,
): Promise<
  { readonly path: string; readonly identity: BigIntStats } | undefined
> {
  // Optional token: never traverse a symlink, move an external file or an alias.
  const tokenRelative = relative(directory, tokenPath);
  if (
    isAbsolute(tokenPath) &&
    tokenRelative !== '' &&
    tokenRelative !== '..' &&
    !tokenRelative.startsWith(`..${sep}`) &&
    !isAbsolute(tokenRelative) &&
    tokenPath !== descriptorPath &&
    tokenPath !== socketPath &&
    // The held claim is a repair input, never a token to preserve.
    tokenPath !== join(directory, 'startup-claim.json')
  ) {
    const identity = await stat(tokenPath);
    if (
      identity?.isFile() &&
      identity.nlink === 1n &&
      (await realpath(dirname(tokenPath))) === dirname(tokenPath) &&
      (await realpath(tokenPath)) === tokenPath &&
      (
        await platform.secureFiles.permissions({
          path: tokenPath,
          kind: 'file',
          action: 'verify',
          mode: 'owner-only',
        })
      ).state === 'private' &&
      !(
        identity.dev === descriptorStat.dev &&
        identity.ino === descriptorStat.ino
      ) &&
      !(identity.dev === socket.dev && identity.ino === socket.ino)
    ) {
      return { path: tokenPath, identity };
    }
  }
  return undefined;
}

interface RepairMutationContext {
  readonly signal: AbortSignal | undefined;
  readonly claims: EndpointRepairClaimPort;
  readonly handle: object;
  readonly claim: PlatformStartupClaim;
  readonly dataRoot: string;
  readonly directories: ReadonlyMap<string, BigIntStats>;
  readonly backup: string;
  readonly backupStat: BigIntStats;
}

async function validateRepairContext({
  signal,
  claims,
  handle,
  claim,
  dataRoot,
  directories,
  backup,
  backupStat,
}: RepairMutationContext): Promise<void> {
  signal?.throwIfAborted();
  const held = await claims.identity(handle);
  if (!held || held.claimId !== claim.claimId || held.dataRoot !== dataRoot)
    refuse('Repair refused: startup claim changed.');
  for (const [path, expected] of directories) {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mode !== expected.mode ||
      (await realpath(path)) !== path
    )
      refuse('Repair refused: runtime directory changed.');
  }
  const current = await lstat(backup, { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev !== backupStat.dev ||
    current.ino !== backupStat.ino ||
    current.mode !== backupStat.mode
  )
    refuse('Repair refused: backup directory changed.');
}

async function revalidateRepairFile(
  path: string,
  expected: BigIntStats,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (!same(expected, current))
    refuse('Repair refused: connection file changed.');
}

async function repairDestination(
  backup: string,
  name: string,
): Promise<string> {
  const target = join(backup, name);
  if (await stat(target)) refuse('Repair refused: backup destination exists.');
  return target;
}

async function moveRepairFile(
  context: RepairMutationContext,
  platform: PlatformServices,
  path: string,
  identity: BigIntStats,
  name: string,
): Promise<void> {
  await validateRepairContext(context);
  const target = await repairDestination(context.backup, name);
  await revalidateRepairFile(path, identity);
  const moved = await platform.secureFiles.rename({
    from: path,
    to: target,
    mode: 'no-replace',
  });
  if (moved.kind !== 'renamed' || moved.sourceState !== 'removed')
    refuse('Repair incomplete: connection file move was not confirmed.');
}

/**
 * Trusted offline maintenance of daemon discovery files, under the startup claim.
 * Refusal alone is not owner-death proof: a foreign full-backlog listener can
 * look refused. Unverifiable process visibility always refuses. Fresh lstats
 * narrow but cannot eliminate replacement races by arbitrary same-user writers;
 * the claim serializes cooperating starters only. Socket-first preservation is
 * not a transaction: partial failures retain backups and never roll back.
 */
export async function repairCanopyDaemonEndpoint(
  options: CanopyEndpointRepairOptions,
): Promise<CanopyEndpointRepairResult> {
  if (options.os === 'win32')
    return { kind: 'noop', message: 'Nothing to repair on this platform.' };
  const { dataRoot, platform, signal } = options;
  let backupName: string | undefined;
  let mutationStarted = false;
  let cleanupFailed = false;
  let result: CanopyEndpointRepairResult;
  try {
    signal?.throwIfAborted();
    const directory = platform.paths.runtimeDirectory({ dataRoot });
    if (!isAbsolute(dataRoot) || directory !== join(dataRoot, 'runtime'))
      refuse('Repair refused: runtime directories are not canonical.');
    // An unused installation needs no directories or claim files created.
    if (!(await stat(dataRoot)) || !(await stat(directory)))
      return { kind: 'noop', message: 'Nothing to repair.' };
    const directories = new Map<string, BigIntStats>();
    for (const path of [dataRoot, directory]) {
      const before = await lstat(path, { bigint: true });
      if (
        !before.isDirectory() ||
        (await realpath(path)) !== path ||
        (
          await platform.secureFiles.permissions({
            path,
            kind: 'directory',
            action: 'verify',
            mode: 'owner-only',
          })
        ).state !== 'private'
      )
        refuse(
          'Repair refused: runtime directories are not private and canonical.',
        );
      directories.set(path, before);
    }
    const self = await platform.supervision.inspectProcess({
      pid: options.selfPid ?? process.pid,
      signal,
    });
    if (self.state !== 'running')
      refuse('Repair refused: this process identity is unverifiable.');
    const endpoints = platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      refuse('Repair refused: unsupported endpoint.');
    const address = endpoints.address({ dataRoot, endpointName: 'core' });
    const claims = await options.claims();
    const acquired = await claims.tryAcquire(signal, { recoverDeparted: true });
    if (acquired.kind !== 'acquired')
      refuse('Repair refused: startup claim is held or ambiguous.');
    const preserveEndpointBind = acquired.recovered?.endpointBound === true;
    try {
      if (preserveEndpointBind)
        refuse(
          'Repair refused: the next daemon start must recover the earlier endpoint bind.',
        );
      const claim = await claims.identity(acquired.handle);
      if (!claim || claim.dataRoot !== dataRoot)
        refuse('Repair refused: startup claim is unavailable.');
      const observed = await endpoints.probe(address);
      if (observed.state === 'absent') throw new RepairNoop();
      if (observed.state !== 'refused')
        refuse('Repair refused: endpoint is live or ambiguous.');
      const socket = await lstat(address.path, { bigint: true });
      if (
        !socket.isSocket() ||
        String(socket.dev) !== String(observed.identity.device) ||
        String(socket.ino) !== String(observed.identity.inode)
      )
        refuse('Repair refused: endpoint changed.');
      const descriptorPath = join(directory, 'core.json');
      const { descriptor, descriptorStat } = await readRepairDescriptor(
        platform,
        descriptorPath,
        address.path,
      );
      // A refused probe is not owner-death proof (CAN-3935): a live successor
      // with a full backlog also refuses. Only the socket the descriptor
      // recorded may move, with nothing but a device-ID change allowed.
      if (!socketRecordedBy(descriptor, socket))
        refuse(
          'Repair refused: the endpoint does not belong to the earlier run.',
        );
      const owner = await platform.supervision.inspectProcess({
        pid: descriptor.pid,
        signal,
      });
      if (
        owner.state === 'unverifiable' ||
        (owner.state === 'running' &&
          owner.startIdentity === descriptor.startIdentity)
      )
        refuse('Repair refused: the earlier owner is live or unverifiable.');
      const token = await eligibleRepairToken(
        platform,
        directory,
        descriptorPath,
        address.path,
        descriptorStat,
        socket,
        descriptor.tokenRef,
      );
      const stamp = (options.now?.() ?? new Date())
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
      backupName = `endpoint-repair-${stamp}`;
      const backup = join(directory, backupName);
      await mkdir(backup, { mode: 0o700 }); // Exclusive: a timestamp collision refuses.
      const backupStat = await lstat(backup, { bigint: true });
      const context: RepairMutationContext = {
        signal,
        claims,
        handle: acquired.handle,
        claim,
        dataRoot,
        directories,
        backup,
        backupStat,
      };
      await validateRepairContext(context);
      await revalidateRepairFile(address.path, socket);
      await revalidateRepairFile(descriptorPath, descriptorStat);
      if (token) await revalidateRepairFile(token.path, token.identity);
      const socketTarget = await repairDestination(backup, 'core.sock');
      await revalidateRepairFile(address.path, socket);
      mutationStarted = true;
      await rename(address.path, socketTarget);
      await moveRepairFile(
        context,
        platform,
        descriptorPath,
        descriptorStat,
        'core.json',
      );
      if (token)
        await moveRepairFile(
          context,
          platform,
          token.path,
          token.identity,
          'core.token',
        );
      if (
        (await platform.secureFiles.syncDirectory(backup)) !== 'flushed' ||
        (await platform.secureFiles.syncDirectory(directory)) !== 'flushed'
      )
        refuse('Repair incomplete: directory sync was not confirmed.');
      result = {
        kind: 'repaired',
        message: `Moved the earlier run's connection files to ${backupName}.`,
      };
    } finally {
      try {
        const released = await claims.release(acquired.handle, {
          preserveEndpointBind,
        });
        if (
          released !== 'released' &&
          !(preserveEndpointBind && released === 'not_owner')
        ) {
          cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      }
    }
  } catch (error) {
    result =
      mutationStarted && backupName
        ? {
            kind: 'incomplete',
            message: `Repair incomplete. Preserved files remain in ${backupName}; inspect this folder before trying again.`,
          }
        : error instanceof RepairNoop
          ? { kind: 'noop', message: 'Nothing to repair.' }
          : {
              kind: 'refused',
              message:
                error instanceof RepairRefusal
                  ? error.message
                  : 'Repair refused: connection files could not be safely preserved.',
            };
  }
  if (cleanupFailed) {
    try {
      options.onCleanupFailure?.(
        'Endpoint repair startup claim release failed.',
      );
    } catch {
      /* Diagnostics never replace the primary outcome. */
    }
    return {
      kind: 'incomplete',
      message: `${result.message} Startup claim release failed.`,
    };
  }
  return result;
}
