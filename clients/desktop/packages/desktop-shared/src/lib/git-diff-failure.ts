/**
 * A failed `git diff` or untracked listing must reach callers as a failure,
 * never as an empty diff that reads as "no changes".
 *
 * The class carries only a closed reason and a validated exit code so callers
 * and telemetry can classify the failure without reading stderr, paths or
 * branch names. `message` keeps git's original text, like every other git
 * failure in these flows; the raw error is deliberately not kept as `cause`.
 */
export type GitDiffFailureReason =
  | 'exit'
  | 'maxbuffer'
  | 'signal'
  | 'spawn'
  | 'unknown';

const SPAWN_ERRNO_CODES: ReadonlySet<string> = new Set([
  'E2BIG',
  'EACCES',
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOTDIR',
  'EPERM',
]);

const MAX_EXIT_CODE = 255;

export class GitDiffUnavailableError extends Error {
  readonly reason: GitDiffFailureReason;
  readonly exitCode: number | null;

  constructor(
    message: string,
    reason: GitDiffFailureReason,
    exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitDiffUnavailableError';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

function readCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function readSignal(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'signal' in error
    ? error.signal
    : undefined;
}

function classify(error: unknown): {
  reason: GitDiffFailureReason;
  exitCode: number | null;
} {
  const code = readCode(error);
  if (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    code >= 0 &&
    code <= MAX_EXIT_CODE
  ) {
    return { reason: 'exit', exitCode: code };
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { reason: 'maxbuffer', exitCode: null };
  }
  const signal = readSignal(error);
  if (typeof signal === 'string' && signal.length > 0) {
    return { reason: 'signal', exitCode: null };
  }
  if (typeof code === 'string' && SPAWN_ERRNO_CODES.has(code)) {
    return { reason: 'spawn', exitCode: null };
  }
  return { reason: 'unknown', exitCode: null };
}

/**
 * The stdout captured before a `maxBuffer` overflow, or `null` for any other
 * failure (or an overflow that carries no stdout). For callers that only need
 * a bounded prefix of the output, where an overflow means "more than needed"
 * rather than a failed read. Exit, signal and spawn failures never qualify.
 */
export function readMaxBufferPartialStdout(error: unknown): string | null {
  if (readCode(error) !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return null;
  }
  return typeof error === 'object' &&
    error !== null &&
    'stdout' in error &&
    typeof error.stdout === 'string'
    ? error.stdout
    : null;
}

/** Convert any failure from a git diff read into the typed error. */
export function toGitDiffUnavailableError(
  error: unknown,
): GitDiffUnavailableError {
  if (error instanceof GitDiffUnavailableError) {
    return error;
  }
  const { reason, exitCode } = classify(error);
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'git diff failed';
  return new GitDiffUnavailableError(message, reason, exitCode);
}

/** Run a git diff read, rethrowing any failure as the typed error. */
export async function rejectGitDiffFailure<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw toGitDiffUnavailableError(error);
  }
}
