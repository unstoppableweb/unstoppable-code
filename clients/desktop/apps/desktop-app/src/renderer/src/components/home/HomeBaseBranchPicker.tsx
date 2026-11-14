import { hasExactWorktreeBaseCatalogue } from '@/lib/remote-control/worktree-base-availability';
import { workspaceRepoPathForCreateFrom } from '@/lib/createFromSource';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  homeWorktreeBaseMissing,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type { PullRequestSummary } from '@canopy/desktop-shared/types';
import {
  BaseBranchPicker,
  type BaseBranchPickerBranchState,
  type BaseBranchPickerPullRequests,
  type BaseBranchPickerWorktree,
  type BaseBranchTarget,
} from '@canopy/ui-app';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { collapseBranchDuplicates } from '../worktree/branch-options';

const BASE_BRANCH_TOOLTIP = (
  <div>
    <p className="text-xs font-medium">Base branch</p>
    <p className="mt-0.5 text-2xs leading-snug opacity-70">
      Branch, worktree, or pull request to create the new worktree from.
    </p>
  </div>
);

/** Desktop Home's single-repository base picker over the Home composer store. */
export function HomeBaseBranchPicker(): JSX.Element | null {
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [prState, setPrState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [prError, setPrError] = useState<string | null>(null);
  const prRequestIdRef = useRef(0);

  const projects = useProjectsStore((state) => state.projects);
  const {
    workspaceId,
    branchTargets,
    branchTargetsStatus,
    newWorktreeBaseTarget,
    setNewWorktreeBaseTarget,
    retryBranchTargets,
  } = useHomeComposerStore(
    useShallow((state) => ({
      workspaceId: state.workspaceId,
      branchTargets: state.branchTargets,
      branchTargetsStatus: state.branchTargetsStatus,
      newWorktreeBaseTarget: state.newWorktreeBaseTarget,
      setNewWorktreeBaseTarget: state.setNewWorktreeBaseTarget,
      retryBranchTargets: state.retryBranchTargets,
    })),
  );

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === workspaceId) ?? null,
    [projects, workspaceId],
  );
  const repoPath = useMemo(
    () => (project ? workspaceRepoPathForCreateFrom(project) : null),
    [project],
  );
  const worktrees = useMemo(
    (): BaseBranchPickerWorktree[] =>
      project?.type === 'single-repo'
        ? project.worktrees.map((worktree) => ({
            id: worktree.id,
            branchName: worktree.branchName,
          }))
        : [],
    [project],
  );
  const branches = useMemo((): BaseBranchPickerBranchState => {
    if (branchTargetsStatus === 'loading') return { kind: 'loading' };
    if (branchTargetsStatus === 'error')
      return { kind: 'error', message: "Couldn't load branches." };
    const discovered =
      branchTargets?.supported === true
        ? collapseBranchDuplicates(branchTargets.branches)
        : [];
    if (!hasExactWorktreeBaseCatalogue(branchTargets)) {
      return {
        kind: 'ready',
        branches: discovered
          .filter((branch) => branch.hasLocalRef)
          .map((branch) => ({ ...branch, hasRemoteRef: false })),
      };
    }
    return { kind: 'ready', branches: discovered };
  }, [branchTargets, branchTargetsStatus]);

  useEffect(() => {
    prRequestIdRef.current += 1;
    setPullRequests([]);
    setPrState('idle');
    setPrError(null);
  }, [repoPath, workspaceId]);

  const loadPullRequests = useCallback((): void => {
    if (!repoPath) return;
    const requestId = ++prRequestIdRef.current;
    setPrState('loading');
    void window.api
      .listPullRequests({ repoPath })
      .then((response) => {
        if (prRequestIdRef.current !== requestId) return;
        setPullRequests(response.pullRequests.filter((pr) => !pr.isCrossRepo));
        setPrState('ready');
      })
      .catch((error: unknown) => {
        if (prRequestIdRef.current !== requestId) return;
        setPrError(extractIpcErrorMessage(error));
        setPrState('error');
      });
  }, [repoPath]);

  const pullRequestSource = useMemo(
    (): BaseBranchPickerPullRequests => ({
      state: prState,
      items: pullRequests,
      error: prError,
      onLoad: loadPullRequests,
    }),
    [loadPullRequests, prError, prState, pullRequests],
  );

  const handleChange = useCallback(
    (target: BaseBranchTarget): void => {
      // Desktop offers no default row, so every selection is concrete.
      if (target.kind === 'default') return;
      setNewWorktreeBaseTarget(target);
    },
    [setNewWorktreeBaseTarget],
  );

  const refreshBranches = useCallback((): void => {
    const state = useHomeComposerStore.getState();
    if (
      state.branchTargetsStatus !== 'loading' &&
      state.branchTargetsStatus !== 'error' &&
      hasExactWorktreeBaseCatalogue(state.branchTargets)
    )
      void state.loadBranchTargets();
  }, []);

  const selectedBranchMissing = useMemo(
    () =>
      homeWorktreeBaseMissing(
        newWorktreeBaseTarget,
        branchTargets,
        branchTargetsStatus,
      ),
    [newWorktreeBaseTarget, branchTargets, branchTargetsStatus],
  );
  if (
    project?.type !== 'single-repo' ||
    (!newWorktreeBaseTarget &&
      branches.kind !== 'error' &&
      branches.kind !== 'loading')
  )
    return null;

  const value: BaseBranchTarget = newWorktreeBaseTarget ?? { kind: 'default' };
  return (
    <BaseBranchPicker
      value={value}
      selectedBranchMissing={selectedBranchMissing}
      onChange={handleChange}
      worktrees={worktrees}
      branches={branches}
      onOpen={refreshBranches}
      onRetryBranches={retryBranchTargets}
      pullRequests={pullRequestSource}
      testIdPrefix="home-base-branch-picker"
      triggerVariant="capsule"
      tooltip={BASE_BRANCH_TOOLTIP}
    />
  );
}
