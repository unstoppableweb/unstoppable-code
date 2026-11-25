import { isAbsolute, relative, sep } from 'node:path';
import { classifyError } from '@canopy/protocol/app-errors/classification';
import { redactSecrets } from '@canopy/protocol/value-redaction';
import { isErrnoException } from '../lib/type-guards';

export class ArchiveRemovalNotPermittedError extends Error {
  readonly code = 'external.removal_not_permitted';

  constructor(readonly path: string) {
    super(
      `Couldn't remove ${JSON.stringify(path)} because the system did not permit it. Check file permissions or immutable flags, then try again; the remaining files were kept.`,
    );
    this.name = 'ArchiveRemovalNotPermittedError';
    classifyError(this, this.code);
  }
}

/** EPERM alone cannot distinguish immutable flags from other OS restrictions. */
export function archiveRemovalError(error: unknown, root: string): unknown {
  if (!isErrnoException(error) || error.code !== 'EPERM') return error;
  let path = '<removal-root>';
  if (typeof error.path === 'string' && isAbsolute(error.path)) {
    const suffix = relative(root, error.path);
    if (
      suffix &&
      !isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith(`..${sep}`)
    ) {
      path += `/${redactSecrets(suffix.split(sep).join('/'))}`;
    }
  }
  // No raw cause: it includes the absolute host path and unfiltered message.
  return new ArchiveRemovalNotPermittedError(path);
}
