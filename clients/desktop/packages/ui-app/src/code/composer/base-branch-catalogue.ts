import {
  collapseBranchDuplicates,
  type BranchListEntry,
} from '@canopy/ui-shared/lib/branch-options';
import type { BaseBranchPickerBranchState } from './BaseBranchPicker';

/**
 * A computer's New Task branch catalogue (`worktree.baseBranches` /
 * `home:list-branch-targets`). Desktop's Home response and the protocol's
 * list result both satisfy it.
 */
export interface BaseBranchCatalogue {
  readonly supported: boolean;
  readonly branches: readonly BranchListEntry[];
  readonly defaultBranch: string | null;
  readonly truncated?: boolean;
}

/** The branch a New Task starts from when nobody picks one. */
export interface DefaultBaseBranchTarget {
  readonly branchName: string;
  /** True only when a default branch is known and it has an origin ref. */
  readonly isRemote: boolean;
  /** Whether the chosen ref is present in the catalogue. */
  readonly observed: boolean;
}

/** Shown on the picker's Branches tab when the catalogue read fails. */
export const BASE_BRANCH_CATALOGUE_ERROR = "Couldn't load branches.";

/**
 * The repository default branch, else the current local branch. Prefers the
 * entry with an origin ref; null for an unborn repository or detached HEAD.
 */
export function defaultBaseBranchTarget(
  catalogue: BaseBranchCatalogue,
): DefaultBaseBranchTarget | null {
  const defaultBranch = catalogue.defaultBranch;
  const branchName =
    defaultBranch ||
    catalogue.branches.find((branch) => branch.isCurrent && branch.hasLocalRef)
      ?.name;
  if (!branchName) return null;
  // isRemote marks remote-only rows; a coalesced local branch can also have
  // an origin ref that is newer than its local checkout.
  const matchingBranch =
    catalogue.branches.find(
      (branch) => branch.name === branchName && branch.hasRemoteRef,
    ) ?? catalogue.branches.find((branch) => branch.name === branchName);
  const isRemote = Boolean(defaultBranch && matchingBranch?.hasRemoteRef);
  // The remote default can be discovered before its ref has been fetched.
  const observed = Boolean(
    isRemote ? matchingBranch?.hasRemoteRef : matchingBranch?.hasLocalRef,
  );
  return { branchName, isRemote, observed };
}

/**
 * The picker's Branches tab for a catalogue read. A non-exact (legacy
 * short-name) catalogue keeps local refs only. Never `unsupported`: the host
 * decides that.
 */
export function baseBranchCatalogueState({
  status,
  catalogue,
  exact,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  catalogue: BaseBranchCatalogue | null;
  exact: boolean;
}): BaseBranchPickerBranchState {
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'error')
    return { kind: 'error', message: BASE_BRANCH_CATALOGUE_ERROR };
  const discovered =
    catalogue?.supported === true
      ? collapseBranchDuplicates(catalogue.branches)
      : [];
  const branches = exact
    ? discovered
    : discovered
        .filter((branch) => branch.hasLocalRef)
        .map((branch) => ({ ...branch, hasRemoteRef: false }));
  return catalogue?.truncated === true
    ? { kind: 'ready', branches, truncated: true }
    : { kind: 'ready', branches };
}
