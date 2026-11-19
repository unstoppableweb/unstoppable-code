import { AppErrorErrnoSchema } from '@canopy/protocol/app-errors';
import { isErrnoException } from '../w5/maintenance-guards';

/**
 * Whether a failed filesystem read is a system error that does not mean the
 * path is missing, such as `EACCES`, `EPERM` or `EIO`. `ENOENT` and `ENOTDIR`
 * mean missing, and so does `ENAMETOOLONG`: a name over the limit names a path
 * that cannot exist, such as an unknown worktree with an over-long id. An
 * error without a system code is not decided here.
 */
export function isUnreadablePathError(error: unknown): boolean {
  if (!isErrnoException(error)) return false;
  const { code } = error;
  return (
    AppErrorErrnoSchema.safeParse(code).success &&
    code !== 'ENOENT' &&
    code !== 'ENOTDIR' &&
    code !== 'ENAMETOOLONG'
  );
}
