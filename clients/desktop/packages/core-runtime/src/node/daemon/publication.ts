import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  CanopyRuntimeDescriptorSchema,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import type { CanopyRuntimeMode } from '@canopy/protocol';
import type {
  PlatformEndpointListener,
  PlatformNamedPipeAddress,
  PlatformServices,
  PlatformUnixSocketAddress,
} from '../../platform/platform-services';
import { assertStorageWriteAllowed, STORAGE_OWNERSHIP } from '../../storage';
import type {
  DaemonStartupClaimAcquisition,
  DaemonStartupClaimPort,
} from '../../platform/startup-claim';
import { bindCanopyDaemonEndpoint } from './binding';

/**
 * A startup claim the caller acquired before publishing, for a writer it
 * composed under the claim (W5b Q8(a)). Publication releases it only after
 * it succeeds; a failed publication keeps it held, so the caller releases it
 * once its writer has stopped. `current` follows a reclaim.
 */
export interface CanopyDaemonHeldClaim {
  current: object;
  /** The acquisition's departed-owner recovery, as `tryAcquire` reported it. */
  readonly recovered?: { readonly endpointBound: boolean };
  released: boolean;
}

export interface CanopyDaemonPublicationOptions {
  /** Trusted startup stop; no later publication admission. */
  readonly signal?: AbortSignal;
  /** Transfers a submitted publication to ordinary stop, bounded by this signal. */
  readonly admitPublication?: () => AbortSignal;
  readonly dataRoot: string;
  readonly runtimeMode: CanopyRuntimeMode;
  readonly platform: PlatformServices;
  readonly claims: DaemonStartupClaimPort;
  readonly claimHandle?: object;
  /** Exclusive with `claimHandle`. */
  readonly heldClaim?: CanopyDaemonHeldClaim;
  readonly pid: number;
  readonly startIdentity: string;
  readonly buildVersion: string;
  readonly protocolRange: { readonly min: number; readonly max: number };
}

export interface CanopyDaemonPublication {
  readonly descriptor: CanopyRuntimeDescriptor;
  readonly listener: PlatformEndpointListener<
    PlatformUnixSocketAddress | PlatformNamedPipeAddress
  >;
  /** Trusted transport composition only; never serialize or log this object. */
  readonly auth: { readonly secret: string; readonly dataRootHash: string };
  /** Endpoint close and step-8 descriptor removal, serialized against restart. */
  close(): Promise<void>;
}

/**
 * Every caller names the data root, `runtime/` or a file in it, so other
 * accounts' entries are admitted like the launching host admits them (CAN-7915).
 */
async function privatePath(
  platform: PlatformServices,
  path: string,
  kind: 'file' | 'directory',
  action: 'verify' | 'restrict',
): Promise<void> {
  const permissions = await platform.secureFiles.permissions({
    path,
    kind,
    action,
    mode: 'owner-only',
    foreignTrustees: 'accept',
  });
  if (permissions.state !== 'private')
    throw new Error('Runtime permissions are not private.');
}

/**
 * Creates the private `runtime/` directory the startup claim and publication
 * use, under a private data root. Returns its path.
 */
export async function prepareCanopyDaemonRuntimeDirectory(
  dataRoot: string,
  platform: PlatformServices,
): Promise<string> {
  const directory = platform.paths.runtimeDirectory({ dataRoot });
  if (directory !== join(dataRoot, 'runtime'))
    throw new Error('Foreign runtime directory.');
  await privatePath(platform, dataRoot, 'directory', 'verify');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
  }
  await privatePath(platform, directory, 'directory', 'restrict');
  return directory;
}

/** Explicit roots/modes only. Windows additionally requires native pipe security in the platform endpoints. */
export async function publishCanopyDaemon(
  options: CanopyDaemonPublicationOptions,
): Promise<CanopyDaemonPublication> {
  const { platform, claims, dataRoot, heldClaim } = options;
  options.signal?.throwIfAborted();
  // A held claim on a pipe must be the caller's own acquisition: the core
  // daemon refuses a launcher's there before adopting it (CAN-5530).
  if (
    platform.endpoints.semantics === 'first-instance-pipe' &&
    options.claimHandle !== undefined
  )
    throw new Error('Windows launcher claim unsupported.');
  if (options.claimHandle !== undefined && heldClaim !== undefined)
    throw new Error('Startup claim handle and held claim are exclusive.');
  if (heldClaim?.released === true)
    throw new Error('Startup claim unavailable.');
  if (
    !['prod', 'rc', 'dev'].includes(options.runtimeMode) ||
    !isAbsolute(dataRoot) ||
    (await realpath(dataRoot)) !== dataRoot
  )
    throw new Error('Explicit canonical data root and runtime mode required.');
  const directory = platform.paths.runtimeDirectory({ dataRoot });
  if (directory !== join(dataRoot, 'runtime'))
    throw new Error('Foreign runtime directory.');
  const tokenPath = join(directory, `core-${randomUUID()}.token`);
  const descriptorPath = join(directory, 'core.json');
  const temporaryPath = join(directory, `.core-${randomUUID()}.tmp`);
  const descriptor = CanopyRuntimeDescriptorSchema.parse({
    version: 1,
    secureStorageLayout: 'nested-v1',
    pid: options.pid,
    startIdentity: options.startIdentity,
    buildVersion: options.buildVersion,
    protocolRange: { ...options.protocolRange },
    tokenRef: tokenPath,
    endpoint: { kind: 'socket', path: descriptorPath },
  });
  assertStorageWriteAllowed(
    'daemon_runtime_descriptor',
    'daemon',
    STORAGE_OWNERSHIP,
  );
  assertStorageWriteAllowed(
    'daemon_runtime_token',
    'daemon',
    STORAGE_OWNERSHIP,
  );
  assertStorageWriteAllowed(
    'daemon_startup_claim',
    'daemon',
    STORAGE_OWNERSHIP,
  );
  options.signal?.throwIfAborted();
  await prepareCanopyDaemonRuntimeDirectory(dataRoot, platform);
  // Verify inherited ACLs before writing secret bytes; POSIX creates with 0600.
  async function exclusiveFile(path: string, contents: string): Promise<void> {
    options.signal?.throwIfAborted();
    const file = await open(path, 'wx', 0o600);
    if (path === tokenPath) tokenCreated = true;
    if (path === temporaryPath) temporaryCreated = true;
    try {
      await privatePath(platform, path, 'file', 'verify');
      options.signal?.throwIfAborted();
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async function acquire(): Promise<object> {
    const result = await claims.tryAcquire();
    if (result.kind !== 'acquired')
      throw new Error('Startup claim unavailable.');
    return result.handle;
  }
  async function release(
    handle: object,
    cleanupComplete = false,
  ): Promise<void> {
    const result = await claims.release(handle);
    if (result !== 'released' && !(cleanupComplete && result === 'not_owner'))
      throw new Error('Startup claim release uncertain.');
  }
  async function unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
  }
  // Replacing discovery drops the only reference to a departed owner's token.
  async function removeDepartedToken(): Promise<void> {
    let previous: CanopyRuntimeDescriptor;
    try {
      const parsed = CanopyRuntimeDescriptorSchema.safeParse(
        JSON.parse(await readFile(descriptorPath, 'utf8')),
      );
      if (!parsed.success) return;
      previous = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) return;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return;
      throw error;
    }
    if (
      dirname(previous.tokenRef) !== directory ||
      !/^core-[0-9a-f-]{36}\.token$/.test(basename(previous.tokenRef))
    )
      return;
    const owner = await platform.supervision.inspectProcess({
      pid: previous.pid,
    });
    if (
      owner.state === 'unverifiable' ||
      (owner.state === 'running' &&
        owner.startIdentity === previous.startIdentity)
    )
      return;
    await unlinkIfPresent(previous.tokenRef);
  }
  // Only a standalone POSIX start replaces a departed claim; a pipe has no stale file (CAN-3935).
  const startup: DaemonStartupClaimAcquisition = heldClaim
    ? {
        kind: 'acquired',
        handle: heldClaim.current,
        ...(heldClaim.recovered && { recovered: heldClaim.recovered }),
      }
    : options.claimHandle === undefined
      ? await claims.tryAcquire(undefined, {
          recoverDeparted: platform.endpoints.semantics === 'filesystem-socket',
        })
      : await claims.adopt(options.claimHandle);
  if (startup.kind !== 'acquired')
    throw new Error('Startup claim unavailable.');
  const { handle } = startup;
  let listener: CanopyDaemonPublication['listener'] | undefined;
  let publicationAttempted = false;
  let tokenCreated = false;
  let temporaryCreated = false;
  const secret = randomBytes(32).toString('hex');
  try {
    options.signal?.throwIfAborted();
    const binding = await bindCanopyDaemonEndpoint({
      dataRoot,
      platform,
      claims,
      claimHandle: handle,
      recoveredEndpointBind: startup.recovered?.endpointBound === true,
    });
    listener = binding.listener;
    descriptor.endpoint = {
      kind: listener.address.kind === 'unix-socket' ? 'socket' : 'pipe',
      path: listener.address.path,
    };
    // Stale-owner recovery (CAN-3932) fails closed without the bound socket's identity.
    if (binding.socketIdentity)
      descriptor.socketIdentity = { ...binding.socketIdentity };
    options.signal?.throwIfAborted();
    await removeDepartedToken();
    await exclusiveFile(tokenPath, secret);
    await exclusiveFile(temporaryPath, JSON.stringify(descriptor));
    options.signal?.throwIfAborted();
    const completionSignal = options.admitPublication?.() ?? options.signal;
    publicationAttempted = true;
    const renamed = await platform.secureFiles.rename({
      from: temporaryPath,
      to: descriptorPath,
      mode: 'replace',
    });
    if (renamed.kind !== 'renamed' || renamed.sourceState !== 'removed')
      throw new Error('Descriptor publication uncertain.');
    temporaryCreated = false;
    // A submitted rename may outlive its deadline; roll it back under the claim.
    completionSignal?.throwIfAborted();
    await platform.secureFiles.syncDirectory(directory);
    completionSignal?.throwIfAborted();
    await release(handle);
    completionSignal?.throwIfAborted();
    if (heldClaim) heldClaim.released = true;
  } catch (error) {
    let cleanupHandle = handle;
    const failures: unknown[] = [error];
    try {
      try {
        await listener?.close();
      } catch (closeError) {
        // A possibly live endpoint keeps attempted publication as stale-owner proof.
        if (publicationAttempted) throw closeError;
        failures.push(closeError);
      }
      // Retire this attempt's unique files before the descriptor that references the token.
      for (const artifact of [
        { path: temporaryPath, created: temporaryCreated },
        { path: tokenPath, created: tokenCreated },
      ]) {
        if (!artifact.created) continue;
        try {
          await unlinkIfPresent(artifact.path);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (publicationAttempted) {
        try {
          // A release may have committed before its receipt failed. Reclaim before unlinking.
          if (!(await claims.identity(handle))) cleanupHandle = await acquire();
          await removeOwnDescriptor();
        } catch (reclaimError) {
          // Shared discovery needs the claim; this attempt's unique files do not.
          failures.push(reclaimError);
        }
      }
      await platform.secureFiles.syncDirectory(directory);
    } catch (cleanupError) {
      failures.push(cleanupError);
    } finally {
      // A held claim stays with its caller until the caller's writer stops.
      if (heldClaim) heldClaim.current = cleanupHandle;
      else
        try {
          await release(cleanupHandle, true);
        } catch (releaseError) {
          failures.push(releaseError);
        }
    }
    if (failures.length > 1)
      throw Object.assign(new Error('Daemon startup rollback failed.'), {
        errors: failures,
      });
    throw error;
  }
  const boundListener = listener;
  if (!boundListener) throw new Error('Endpoint was not bound.');
  let closed = false;
  let closing: Promise<void> | undefined;
  let cleanupClaim: object | undefined;
  let cleanupComplete = false;
  async function removeOwnDescriptor(): Promise<void> {
    try {
      const current = CanopyRuntimeDescriptorSchema.safeParse(
        JSON.parse(await readFile(descriptorPath, 'utf8')),
      );
      if (
        current.success &&
        current.data.tokenRef === tokenPath &&
        current.data.pid === descriptor.pid &&
        current.data.startIdentity === descriptor.startIdentity
      )
        await unlink(descriptorPath);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
  }
  async function shutdown(): Promise<void> {
    // Compare-and-release by handle never removes a successor's claim.
    if (cleanupClaim && cleanupComplete) {
      await release(cleanupClaim, true);
      cleanupClaim = undefined;
      closed = true;
      return;
    }
    // An uncertain release may have committed, but a null identity can also mean
    // unverifiable ownership: keep the handle until a fresh claim replaces it.
    if (cleanupClaim && !(await claims.identity(cleanupClaim)))
      cleanupClaim = await acquire();
    // Acquire before closing: a restart cannot replace discovery between close and unlink.
    const handle = (cleanupClaim ??= await acquire());
    try {
      if (!cleanupComplete) {
        await boundListener.close();
        // The descriptor is the only reference to the token: retire the token first.
        await unlinkIfPresent(tokenPath);
        await removeOwnDescriptor();
        await platform.secureFiles.syncDirectory(directory);
        cleanupComplete = true;
      }
    } finally {
      // A lost receipt may follow a successful release; never touch its new owner.
      await release(handle, cleanupComplete);
      cleanupClaim = undefined;
    }
    closed = true;
  }
  return {
    descriptor,
    listener: boundListener,
    auth: {
      secret,
      dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closing ??= shutdown().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
