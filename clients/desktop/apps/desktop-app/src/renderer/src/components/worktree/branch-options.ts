import type { RepoBranchInfo } from '@canopy/desktop-shared/types';

export {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  findBranchPresence,
  getBranchProvenanceBadge,
  preserveBranchOption,
  type BranchListEntry,
  type BranchOption,
} from '@canopy/ui-shared/lib/branch-options';

export function resolveDisplayedBaseBranch(params: {
  isMultiRepo: boolean | undefined;
  repoBranches: RepoBranchInfo[] | undefined;
  baseBranch: string | null | undefined;
  trackedBaseBranch: string | null | undefined;
}): string | null {
  const { isMultiRepo, repoBranches, baseBranch, trackedBaseBranch } = params;

  if (isMultiRepo && repoBranches && repoBranches.length > 0) {
    const bases = Array.from(
      new Set(
        repoBranches
          .map((branchInfo) => branchInfo.baseBranch)
          .filter((branch): branch is string => Boolean(branch)),
      ),
    );
    return bases.length === 1 ? bases[0] : null;
  }

  if (baseBranch !== undefined) {
    return baseBranch;
  }

  if (trackedBaseBranch !== undefined) {
    return trackedBaseBranch;
  }

  return repoBranches?.[0]?.baseBranch ?? null;
}
