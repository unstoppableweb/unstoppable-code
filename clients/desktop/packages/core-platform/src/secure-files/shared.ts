import type { BigIntStats } from 'node:fs';
import type {
  PlatformPermissionCause as PermissionCause,
  PlatformPermissionRequest as PermissionRequest,
  PlatformPermissionResult as PermissionResult,
} from '@canopy/core-runtime';

export type { PermissionCause, PermissionRequest, PermissionResult };

export type SecureFileErrorCode =
  | 'not_regular_file'
  | 'hard_links_unsupported'
  | 'source_changed';

export const secureFileError = (
  code: SecureFileErrorCode,
  message: string,
): Error & { readonly code: SecureFileErrorCode } =>
  Object.assign(new Error(message), { code });

export const PRIVATE: PermissionResult = Object.freeze({ state: 'private' });

/** One reason on every OS: daemon hosts retry it across atomic replacement. */
export const PATH_CHANGED_DURING_CHECK = 'path changed during permission check';

export const fail = (
  state: 'insecure' | 'unverifiable',
  reason: string,
  cause: PermissionCause,
): PermissionResult => ({ state, reason, cause });

// Structural, not instanceof: fs errors may come from another realm.
export const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined;

export const sameNode = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/** Rejects symbolic links (and junctions on Windows), wrong kinds and multiply linked files. */
export function checkShape(
  stats: BigIntStats,
  kind: PermissionRequest['kind'],
): PermissionResult | null {
  if (stats.isSymbolicLink())
    return fail('insecure', 'path is a symlink', 'symlink');
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    return fail('insecure', `path is not a ${kind}`, 'wrong_kind');
  }
  return kind === 'file' && stats.nlink !== BigInt(1)
    ? fail('insecure', 'file has multiple hard links', 'hard_link')
    : null;
}
