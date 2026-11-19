declare const GIT_REF_NAME: unique symbol;

/**
 * A branch name that {@link parseGitBranchName} accepted. A branch name from a
 * remote, a remote-facing caller or a clone reaches Git argv only as this type
 * (CAN-7169), so passing an unvalidated string to such a sink is a type error.
 */
export type GitRefName = string & { readonly [GIT_REF_NAME]: true };

// Characters `git check-ref-format` refuses anywhere in a name, besides
// controls and DEL.
const FORBIDDEN_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);

function hasForbiddenCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || FORBIDDEN_CHARACTERS.has(character))
      return true;
  }
  return false;
}

function isBranchName(name: string): name is GitRefName {
  // Exactly `git check-ref-format --branch`'s rules outside a repository:
  // HEAD, a leading '-' and any '@{' are refused there too.
  if (name === '' || name === 'HEAD') return false;
  if (name.startsWith('-') || name.includes('@{')) return false;
  if (hasForbiddenCharacter(name)) return false;
  if (name.includes('..') || name.endsWith('.')) return false;
  return name
    .split('/')
    .every(
      (component) =>
        component !== '' &&
        !component.startsWith('.') &&
        !component.endsWith('.lock'),
    );
}

/**
 * The branch name, when Git would accept `refs/heads/<name>` from
 * `git check-ref-format --branch` without expanding it; null otherwise.
 * One pure check shared by every host, so the in-process and daemon paths
 * refuse exactly the same names.
 */
export function parseGitBranchName(name: string): GitRefName | null {
  return isBranchName(name) ? name : null;
}

/**
 * Re-checks a validated name at the Git call that uses it, so a future caller
 * that reaches the sink without the type still fails closed before any spawn.
 */
export function assertGitRefName(name: string): asserts name is GitRefName {
  if (!isBranchName(name))
    throw new Error('The branch name is not a valid branch name.');
}

/**
 * `refs/heads/<branch>`: the explicit refspec for fetching or pulling a
 * validated branch from origin. `git pull` hands its arguments to `git fetch`
 * without a `--`, so a bare name there can still be parsed as an option; a
 * refspec under refs/heads/ never can. Git's output, FETCH_HEAD and the
 * opportunistic origin/<branch> update are the same as for the bare name.
 */
export function originBranchRefspec(branch: GitRefName): string {
  assertGitRefName(branch);
  return `refs/heads/${branch}`;
}

/** Where a suppressed remote default branch was read. Never the name itself. */
export type InvalidRemoteDefaultSource =
  | 'remote-head'
  | 'origin-head'
  | 'recorded-hint'
  | 'reported-default'
  | 'clone-head';

const invalidRemoteDefaults = new Map<InvalidRemoteDefaultSource, number>();
let invalidRemoteDefaultSink:
  | ((source: InvalidRemoteDefaultSource) => void)
  | undefined;

/**
 * Installs the host's diagnostic for a suppressed remote default (a log line
 * in Electron, fixed stderr text in the daemon). The sink sees only the
 * source, so the remote's text can never reach a log.
 */
export function setInvalidRemoteDefaultSink(
  sink: ((source: InvalidRemoteDefaultSource) => void) | undefined,
): void {
  invalidRemoteDefaultSink = sink;
}

/** Suppressed remote defaults this process has seen, by source. */
export function invalidRemoteDefaultCounts(): ReadonlyMap<
  InvalidRemoteDefaultSource,
  number
> {
  return new Map(invalidRemoteDefaults);
}

/**
 * {@link parseGitBranchName} for a default branch a remote supplied. A refused
 * name is recorded by source only, so support can tell an invalid default
 * from no default without the name ever being logged.
 */
export function parseRemoteDefaultBranch(
  name: string,
  source: InvalidRemoteDefaultSource,
): GitRefName | null {
  const branch = parseGitBranchName(name);
  if (branch) return branch;
  invalidRemoteDefaults.set(
    source,
    (invalidRemoteDefaults.get(source) ?? 0) + 1,
  );
  invalidRemoteDefaultSink?.(source);
  return null;
}
