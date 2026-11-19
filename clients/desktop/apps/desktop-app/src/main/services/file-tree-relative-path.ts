import { posix, sep, win32 } from 'node:path';
import { RemoteControlServiceError } from './remote-control-service-error';

/**
 * A file-tree path relative to its root, with `/` separators. Shared by the
 * direct Files reader and the daemon Files route so both refuse the same
 * input with the same error. `./` normalizes to `.`, which lists the root.
 */
export function normalizeFileTreeRelativePath(value: string): string {
  if (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new RemoteControlServiceError(
      'invalid_target',
      'Path must be relative.',
    );
  }
  const normalizedInput = sep === '\\' ? value.replace(/\\/g, '/') : value;
  if (posix.isAbsolute(normalizedInput)) {
    throw new RemoteControlServiceError(
      'invalid_target',
      'Path must be relative.',
    );
  }
  if (
    normalizedInput.split('/').some((segment) => segment === '..') ||
    value.split('\\').includes('..')
  ) {
    throw new RemoteControlServiceError(
      'invalid_target',
      'Path cannot traverse outside the worktree.',
    );
  }
  const normalized = posix.normalize(normalizedInput);
  if (normalized === '.') {
    return '';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments.join('/');
}
