import { constants, type BigIntStats } from 'node:fs';
import { checkDarwinAcl, type DarwinAclProbe } from './darwin-acl';
import { lstat, open } from 'node:fs/promises';
import {
  checkShape,
  fail,
  PATH_CHANGED_DURING_CHECK,
  PRIVATE,
  sameNode,
  type PermissionRequest,
  type PermissionResult,
} from './shared';

const checkNode = (
  stats: BigIntStats,
  { kind }: PermissionRequest,
  uid: number,
): PermissionResult | null =>
  checkShape(stats, kind) ??
  (stats.uid === BigInt(uid)
    ? null
    : fail('insecure', 'owned by another user', 'foreign_owner'));

function checkMode(stats: BigIntStats, expected: number): PermissionResult {
  const actual = Number(stats.mode) & 0o7777;
  return actual === expected
    ? PRIVATE
    : fail(
        'insecure',
        `mode ${actual.toString(8)} is not private`,
        'broad_mode',
      );
}

/**
 * Restriction and Darwin ACL checks use a no-follow handle whose identity,
 * kind and owner match the checked path. Darwin clears and proves its ACL by fd.
 * Parents are the caller's private precondition: re-checks narrow, but do not
 * eliminate, races inside them. A node its owner cannot read is unverifiable.
 */
export async function posixPermissions(
  request: PermissionRequest,
  uid: number | undefined,
  darwinAcl: DarwinAclProbe | null,
): Promise<PermissionResult> {
  if (uid === undefined)
    return fail('unverifiable', 'user id is unavailable', 'unverifiable');
  const before = await lstat(request.path, { bigint: true });
  const problem = checkNode(before, request, uid);
  if (problem) return problem;
  const expected =
    request.kind === 'directory' || request.mode === 'owner-executable'
      ? 0o700
      : 0o600;
  if (request.action === 'verify' && darwinAcl === null)
    return checkMode(before, expected);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;
  const flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  const handle = await open(
    request.path,
    request.kind === 'directory' ? flags | O_DIRECTORY : flags,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const changed = sameNode(before, opened)
      ? checkNode(opened, request, uid)
      : fail('insecure', 'path changed while opening', 'path_changed');
    if (changed) return changed;
    if (request.action === 'restrict') await handle.chmod(expected);
    const acl =
      darwinAcl === null
        ? null
        : checkDarwinAcl(
            await darwinAcl(handle, request.action === 'restrict'),
            opened,
          );
    const after = await handle.stat({ bigint: true });
    if (!sameNode(after, await lstat(request.path, { bigint: true }))) {
      return fail('insecure', PATH_CHANGED_DURING_CHECK, 'path_changed');
    }
    return acl ?? checkNode(after, request, uid) ?? checkMode(after, expected);
  } finally {
    await handle.close();
  }
}
