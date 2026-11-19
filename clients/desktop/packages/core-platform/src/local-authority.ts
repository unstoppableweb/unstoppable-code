import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  relocationTransition,
  type RelocationTransition,
} from '@canopy/core-runtime/node/relocation';
import { isFullyQualified } from './paths';

/** Closed reason an `invalid_root` refusal came from the filesystem, not the root's shape. */
export type LocalAuthorityRootCause = 'root_missing' | 'root_denied';

export class LocalAuthorityIdentityError extends Error {
  override readonly name = 'LocalAuthorityIdentityError';
  constructor(
    readonly code: 'invalid_brand' | 'invalid_root' | 'principal_unavailable',
    readonly rootCause?: LocalAuthorityRootCause,
  ) {
    super(`Local authority identity unavailable: ${code}.`);
  }
}

/** Trusted host observation only; never accept these inputs from a renderer. */
export interface LocalAuthorityObservation {
  readonly platform: string;
  readonly getuid: () => number | undefined;
  /**
   * Windows only: the host's trusted TokenUser observer
   * (`windowsPrincipalObserver` over its selected helper path). Absent refuses.
   */
  readonly windowsPrincipal?: () => Promise<string>;
}

export interface LocalAuthorityIdentity {
  readonly authorityId: string;
  readonly canonicalDataRoot: string;
}

/** This process's platform and user, plus a host-selected Windows principal. */
export function hostLocalAuthorityObservation(
  windowsPrincipal?: () => Promise<string>,
): LocalAuthorityObservation {
  return {
    platform: process.platform,
    getuid: () => process.getuid?.(),
    ...(windowsPrincipal && { windowsPrincipal }),
  };
}

/**
 * Canonical SID text: revision 1, an unsigned decimal 48-bit identifier
 * authority and 0..15 unsigned decimal 32-bit subauthorities, no leading zeroes.
 */
export function isCanonicalWindowsSid(sid: string): boolean {
  const row = /^S-1-(0|[1-9]\d{0,14})((?:-(?:0|[1-9]\d{0,9})){0,15})$/.exec(
    sid,
  );
  if (!row || row[1] === undefined || row[2] === undefined) return false;
  return (
    Number(row[1]) <= 0xffffffffffff &&
    row[2]
      .split('-')
      .slice(1)
      .every((part) => Number(part) <= 0xffffffff)
  );
}

type Principal =
  | readonly ['posix-uid', number]
  | readonly ['windows-sid', string];

async function observePrincipal(
  observation: LocalAuthorityObservation,
): Promise<Principal> {
  try {
    if (observation.platform === 'win32') {
      const sid = await observation.windowsPrincipal?.();
      if (typeof sid === 'string' && isCanonicalWindowsSid(sid))
        return ['windows-sid', sid];
    } else if (
      observation.platform === 'darwin' ||
      observation.platform === 'linux'
    ) {
      const uid = observation.getuid();
      if (uid !== undefined && Number.isSafeInteger(uid) && uid >= 0)
        return ['posix-uid', uid];
    }
  } catch {
    // Observer failures carry no detail past the fixed refusal.
  }
  throw new LocalAuthorityIdentityError('principal_unavailable');
}

/**
 * SHA-256 of the UTF-8 JSON tuple
 * ["canopy.local-authority", 1, brandId, canonicalDataRoot, principal], where
 * principal is ["posix-uid", uid] on Darwin and Linux and
 * ["windows-sid", canonical SID text] on Windows. JSON boundaries and the
 * version tag prevent ambiguous concatenation. This authority digest is
 * separate from the transport's existing root-only hash.
 */
export async function deriveLocalAuthorityIdentity(
  input: { readonly brandId: string; readonly dataRoot: string },
  observation: LocalAuthorityObservation = hostLocalAuthorityObservation(),
): Promise<LocalAuthorityIdentity> {
  if (
    typeof input.brandId !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(input.brandId)
  )
    throw new LocalAuthorityIdentityError('invalid_brand');
  return deriveAuthorityForPrincipal(
    input,
    await observePrincipal(observation),
  );
}

function rootCause(error: unknown): LocalAuthorityRootCause | undefined {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'root_missing';
  return code === 'EACCES' || code === 'EPERM' ? 'root_denied' : undefined;
}

async function deriveAuthorityForPrincipal(
  input: { readonly brandId: string; readonly dataRoot: string },
  principal: Principal,
): Promise<LocalAuthorityIdentity> {
  // Root rules follow the filesystem that resolves the root: on Windows,
  // drive or UNC only, never drive-relative, rooted-only or a device namespace.
  const qualified = (path: string): boolean =>
    process.platform === 'win32'
      ? isFullyQualified('win32', path)
      : isAbsolute(path) && !path.includes('\0');
  let canonicalDataRoot: string;
  try {
    if (typeof input.dataRoot !== 'string' || !qualified(input.dataRoot))
      throw new LocalAuthorityIdentityError('invalid_root');
    canonicalDataRoot = await realpath(input.dataRoot);
    if (
      !qualified(canonicalDataRoot) ||
      !(await stat(canonicalDataRoot)).isDirectory()
    )
      throw new LocalAuthorityIdentityError('invalid_root');
  } catch (error) {
    throw new LocalAuthorityIdentityError('invalid_root', rootCause(error));
  }
  return authorityIdentity(input.brandId, canonicalDataRoot, principal);
}

function authorityIdentity(
  brandId: string,
  canonicalDataRoot: string,
  principal: Principal,
): LocalAuthorityIdentity {
  const authorityId = createHash('sha256')
    .update(
      JSON.stringify([
        'canopy.local-authority',
        1,
        brandId,
        canonicalDataRoot,
        principal,
      ]),
    )
    .digest('hex');
  return { authorityId, canonicalDataRoot };
}

/** Trusted cold host only: project the absent destination using its real parent. */
export async function observeLocalAuthorityRelocation(
  input: {
    brandId: string;
    installationId: string;
    sourceRoot: string;
    destinationRoot: string;
  },
  observation: LocalAuthorityObservation = hostLocalAuthorityObservation(),
): Promise<RelocationTransition> {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(input.brandId))
    throw new LocalAuthorityIdentityError('invalid_brand');
  const principal = await observePrincipal(observation);
  const from = await deriveAuthorityForPrincipal(
    { brandId: input.brandId, dataRoot: input.sourceRoot },
    principal,
  );
  if (
    !(process.platform === 'win32'
      ? isFullyQualified('win32', input.destinationRoot)
      : isAbsolute(input.destinationRoot) &&
        !input.destinationRoot.includes('\0')) ||
    input.destinationRoot !== resolve(input.destinationRoot)
  )
    throw new LocalAuthorityIdentityError('invalid_root');
  const destination = join(
    await realpath(dirname(input.destinationRoot)),
    basename(input.destinationRoot),
  );
  const exists = await lstat(destination).then(
    () => true,
    (error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw error;
    },
  );
  if (exists) throw new LocalAuthorityIdentityError('invalid_root');
  return relocationTransition({
    version: 1,
    installationId: input.installationId,
    brandId: input.brandId,
    from,
    to: authorityIdentity(input.brandId, destination, principal),
  });
}
