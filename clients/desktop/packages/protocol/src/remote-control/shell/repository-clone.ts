/** Whole-repository cloning convenience only; admission and authorization stay with callers. */
export function normalizeRepositoryCloneUrl(input: string): string {
  const value = input.trim();
  // Inspect raw text: URL parsing would erase traversal and explicit default ports.
  if (/[\\\s]/.test(value) || /%(?![\da-f]{2})/i.test(value)) {
    return value;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return value;
  }
  const match =
    /^(https?):\/\/(?:www\.)?github\.com(\/[^?#]*)(?:[?#].*)?$/i.exec(value);
  if (!match) return value;
  const [, scheme, rawPath] = match;
  if (/%(?:2f|5c)/i.test(rawPath)) return value;
  const segments = rawPath.replace(/\/$/, '').slice(1).split('/');
  if (
    segments.some((segment) => {
      const dots = segment.replace(/%2e/gi, '.');
      return !segment || dots === '.' || dots === '..';
    })
  )
    return value;
  const [owner, repository, marker] = segments;
  if (!owner || !/^[a-z\d-]+$/i.test(owner)) return value;
  if (!repository || !/^[a-z\d._-]+$/i.test(repository)) return value;
  const name = repository.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') return value;
  if (
    (marker !== 'tree' && marker !== 'blob') ||
    segments.length < (marker === 'tree' ? 4 : 5)
  )
    return value;
  return `${scheme.toLowerCase()}://github.com/${owner}/${repository}`;
}

export const REPOSITORY_CLONE_FAILURE_MESSAGE =
  'Failed to clone the repository. Check the URL and access, then try again.';

const SAFE_REPOSITORY_RECOVERY_MESSAGES: ReadonlySet<string> = new Set([
  'This change was saved but did not finish and needs recovery.',
  'This request was saved but did not finish and needs recovery.',
  'An earlier attempt of this request was interrupted and needs recovery.',
]);

/** Safe local clone display copy; a saved workspace decision may need recovery. */
export function repositoryCloneErrorMessage(error: unknown): string {
  const message: unknown = error instanceof Error ? error.message : error;
  return typeof message === 'string' &&
    SAFE_REPOSITORY_RECOVERY_MESSAGES.has(message)
    ? message
    : REPOSITORY_CLONE_FAILURE_MESSAGE;
}

export const REMOTE_CONTROL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE =
  "Couldn't confirm that the clone finished. Check Projects before trying again.";

const SAFE_REMOTE_CONTROL_CLONE_MESSAGES: ReadonlySet<string> = new Set([
  REPOSITORY_CLONE_FAILURE_MESSAGE,
  REMOTE_CONTROL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE,
  'Could not confirm the clone request on the desktop. Check Projects before trying again.',
  'Could not confirm the clone result on the desktop. Check Projects before trying again.',
  'The desktop restarted before the clone result was confirmed. Check Projects before trying again.',
  'The clone request expired before the desktop confirmed it. Check Projects before trying again.',
]);
const WORKSPACE_CREATE_ERROR_PREFIX =
  'Portal command portal.workspace.create failed: ';

/** Safe display text only. Never use formatted text to classify completion or Retry. */
export function remoteControlRepositoryCloneErrorMessage(
  error: unknown,
): string {
  const message: unknown = error instanceof Error ? error.message : error;
  if (typeof message !== 'string')
    return REMOTE_CONTROL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE;
  const unwrapped = message.startsWith(WORKSPACE_CREATE_ERROR_PREFIX)
    ? message.slice(WORKSPACE_CREATE_ERROR_PREFIX.length)
    : message;
  return SAFE_REMOTE_CONTROL_CLONE_MESSAGES.has(unwrapped)
    ? unwrapped
    : REMOTE_CONTROL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE;
}
