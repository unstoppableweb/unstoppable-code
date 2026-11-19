import type { WorkerGitDefaultBranchSource } from '@canopy/protocol/canopy-core';
import {
  parseGitBranchName,
  parseRemoteDefaultBranch,
  type GitRefName,
  type InvalidRemoteDefaultSource,
} from './ref-name';

/** Recorded remote knowledge counts as fresh for this long. */
export const GIT_DEFAULT_BRANCH_HINT_TTL_MS = 5 * 60_000;

/** A recorded remote default branch for the repository's identity. */
export interface GitDefaultBranchHint {
  defaultBranch: string;
  /** ISO 8601 time the remote value was observed. */
  resolvedAt: string;
}

/**
 * The read-only facts default-branch selection consults, in precedence
 * order. Each read is best effort: a rejection counts as "no answer".
 */
export interface GitDefaultBranchFacts {
  readHint(): Promise<GitDefaultBranchHint | null>;
  /** The live remote HEAD (`ls-remote --symref origin HEAD`). */
  readRemoteHead(): Promise<string | null>;
  /** Local `refs/remotes/origin/HEAD`. */
  readLocalOriginHead(): Promise<string | null>;
  /** The first existing `origin/{main,master,develop}`, without the network. */
  readConventional(): Promise<string | null>;
}

export interface GitDefaultBranchSelection {
  /** Only a valid branch name; an invalid reported name counts as no answer. */
  defaultBranch: GitRefName | null;
  source: WorkerGitDefaultBranchSource | null;
}

export function isGitDefaultBranchHintFresh(
  hint: GitDefaultBranchHint,
  now: number,
): boolean {
  const resolvedAt = Date.parse(hint.resolvedAt);
  return (
    Number.isFinite(resolvedAt) &&
    resolvedAt <= now &&
    now - resolvedAt < GIT_DEFAULT_BRANCH_HINT_TTL_MS
  );
}

const orNull = <Value>(read: Promise<Value | null>): Promise<Value | null> =>
  read.catch(() => null);

// CAN-7169: every source is remote-derived or recorded from one, so a name Git
// would not accept as a branch is no answer, never an argument.
const branchOrNull = async (
  read: Promise<string | null>,
  source: InvalidRemoteDefaultSource,
): Promise<GitRefName | null> => {
  const name = await orNull(read);
  return name === null ? null : parseRemoteDefaultBranch(name, source);
};

/**
 * Selects the default branch without side effects. Fresh recorded knowledge
 * wins; otherwise the live remote HEAD, the local origin/HEAD, older recorded
 * knowledge, then the conventional names. `allowRemoteLookup: false` skips
 * the network and trusts recorded knowledge of any age.
 */
export async function selectGitDefaultBranch(
  facts: GitDefaultBranchFacts,
  options: { now: number; allowRemoteLookup?: boolean },
): Promise<GitDefaultBranchSelection> {
  const hint = await orNull(facts.readHint());
  const hintBranch = hint
    ? parseRemoteDefaultBranch(hint.defaultBranch, 'recorded-hint')
    : null;
  const fresh =
    hint !== null &&
    hintBranch !== null &&
    isGitDefaultBranchHintFresh(hint, options.now);
  if (hintBranch && (options.allowRemoteLookup === false || fresh))
    return {
      defaultBranch: hintBranch,
      source: fresh ? 'hint' : 'stale-hint',
    };
  if (options.allowRemoteLookup !== false) {
    const remoteHead = await branchOrNull(
      facts.readRemoteHead(),
      'remote-head',
    );
    if (remoteHead) return { defaultBranch: remoteHead, source: 'remote' };
  }
  const localOriginHead = await branchOrNull(
    facts.readLocalOriginHead(),
    'origin-head',
  );
  if (localOriginHead)
    return { defaultBranch: localOriginHead, source: 'local-origin-head' };
  if (hintBranch) return { defaultBranch: hintBranch, source: 'stale-hint' };
  const conventionalName = await orNull(facts.readConventional());
  const conventional =
    conventionalName === null ? null : parseGitBranchName(conventionalName);
  return conventional
    ? { defaultBranch: conventional, source: 'conventional' }
    : { defaultBranch: null, source: null };
}
