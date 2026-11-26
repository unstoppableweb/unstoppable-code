/**
 * Typed refusals from `assertWorktreeSnapshotSupported` (CAN-6776). Each names
 * a worktree state the three-commit Git snapshot cannot reproduce exactly; an
 * archive takes the files-only (v3) recovery path for it instead. Raw Git,
 * pointer-repair and rollback failures never carry one of these codes.
 *
 * Kept dependency-free: the archive I/O worker bundle imports it.
 */
export const GIT_CAPTURE_CONFLICTS = 'GIT_CAPTURE_CONFLICTS';
export const GIT_CAPTURE_INTENT_TO_ADD = 'GIT_CAPTURE_INTENT_TO_ADD';
export const GIT_CAPTURE_DIRTY_SUBMODULE = 'GIT_CAPTURE_DIRTY_SUBMODULE';
export const GIT_CAPTURE_NESTED_REPOSITORY = 'GIT_CAPTURE_NESTED_REPOSITORY';
/**
 * A transforming attribute on a snapshot path, whether `.gitattributes`,
 * `info/attributes`, `core.attributesFile` or system configuration sets it,
 * that the snapshot cannot ignore: the selected Git predates attribute
 * sources, the archive was captured without an attribute policy, or a restore
 * would replay a policy archive onto a branch that has moved.
 */
export const GIT_CAPTURE_TRANSFORMING_ATTRIBUTE =
  'GIT_CAPTURE_TRANSFORMING_ATTRIBUTE';
/** A transforming attribute from `info/attributes`, `core.attributesFile` or system config. */
export const GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE =
  'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE';

export const WORKTREE_SNAPSHOT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  GIT_CAPTURE_CONFLICTS,
  GIT_CAPTURE_INTENT_TO_ADD,
  GIT_CAPTURE_DIRTY_SUBMODULE,
  GIT_CAPTURE_NESTED_REPOSITORY,
  GIT_CAPTURE_TRANSFORMING_ATTRIBUTE,
  GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE,
]);

export type WorktreeSnapshotRefusalCode =
  | typeof GIT_CAPTURE_CONFLICTS
  | typeof GIT_CAPTURE_INTENT_TO_ADD
  | typeof GIT_CAPTURE_DIRTY_SUBMODULE
  | typeof GIT_CAPTURE_NESTED_REPOSITORY
  | typeof GIT_CAPTURE_TRANSFORMING_ATTRIBUTE
  | typeof GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE;

export type WorktreeSnapshotRefusalError = Error & {
  code: WorktreeSnapshotRefusalCode;
};

export function worktreeSnapshotRefusal(
  code: WorktreeSnapshotRefusalCode,
  message: string,
): WorktreeSnapshotRefusalError {
  return Object.assign(new Error(message), { code });
}

/**
 * Matches by code, not class: the archive I/O runner rebuilds worker errors
 * as plain `Error`s that keep only an allowlisted `code`.
 */
export function isWorktreeSnapshotRefusalError(
  error: unknown,
): error is WorktreeSnapshotRefusalError {
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && WORKTREE_SNAPSHOT_REFUSAL_CODES.has(code);
}

const PATH_SUFFIXED_REFUSAL = /^(Cannot (?:archive|restore) [^:\n]*): [\s\S]*$/;
const WINDOWS_PATH = /(?:\\\\[^\\\s]+\\[^\s]*|\b[A-Za-z]:[\\/][^\s]*)/g;
const POSIX_PATH = /(?:^|(?<=[\s'"(=]))(?:~|\.{1,2})?\/[^\s'")]*/g;

/**
 * A refusal message safe for the local log. Refusals append a
 * repository-relative path after their description, which the first rule
 * removes; the others catch absolute POSIX, drive and UNC paths elsewhere.
 */
export function redactWorktreeSnapshotRefusalMessage(message: string): string {
  return message
    .replace(PATH_SUFFIXED_REFUSAL, '$1: <path>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, '<path>');
}

/**
 * The local log fields for an archive that takes the files-only recovery
 * after a snapshot refusal; undefined for every other failure, which stays
 * fatal.
 */
export function worktreeSnapshotRefusalDiagnostic(
  error: unknown,
): { code: WorktreeSnapshotRefusalCode; message: string } | undefined {
  if (!isWorktreeSnapshotRefusalError(error)) return undefined;
  return {
    code: error.code,
    message: redactWorktreeSnapshotRefusalMessage(error.message),
  };
}
