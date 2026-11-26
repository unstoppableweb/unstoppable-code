import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { Stack } from '@canopy/ui-shared/components';
import {
  Profiler,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { CanopyClient, SessionViewModel } from '@canopy/app-core';
import { Disclosure, Surface } from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import {
  WORKTREE_STATUS_META,
  computeWorktreeUiStatus,
  type WorktreeUiStatus,
} from '@/lib/worktree-status';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSidebarWorkspaces } from './useSidebarWorkspaces';
import {
  DesktopSharedSidebarHost,
  parseDesktopWorktreeSelection,
  routeDesktopSidebarSelection,
} from './DesktopSharedSidebarHost';

// Test compatibility exports; the implementation lives in the shared host.
// eslint-disable-next-line react-refresh/only-export-components
export const parseWorktreeSelectionKey = parseDesktopWorktreeSelection;
// eslint-disable-next-line react-refresh/only-export-components
export const routeShadowSelection = routeDesktopSidebarSelection;

export interface ParityMismatch {
  readonly field:
    | 'workspace-order'
    | 'worktree-order'
    | 'selection'
    | 'status-class';
  readonly id?: string;
  readonly native: unknown;
  readonly shadow: unknown;
}

function shadowStatus(worktree: SessionViewModel['worktrees'][number]): string {
  const status = computeWorktreeUiStatus({
    isDone: worktree.status === 'done',
    hasUnread: worktree.hasUnread === true,
    isWorking:
      worktree.isStreaming === true ||
      worktree.isRunningRun === true ||
      worktree.pipelineStatus === 'running',
    isPlanning:
      worktree.awaitingApproval === true ||
      worktree.pipelineStatus === 'paused',
  });
  return WORKTREE_STATUS_META[status].dotClass;
}

// Kept independent of the rendering host so the parity contract is directly
// testable when the shared implementation is refactored.
// eslint-disable-next-line react-refresh/only-export-components
export function compareDesktopSidebarParity({
  snapshot,
  sortedProjects,
  nativeSelection,
  sharedSelection,
  worktreeStatusMap,
}: {
  readonly snapshot: SessionViewModel;
  readonly sortedProjects: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly worktrees?: ReadonlyArray<{ readonly id: string }>;
  }>;
  readonly nativeSelection: string | null;
  readonly sharedSelection: string | null;
  readonly worktreeStatusMap: ReadonlyMap<string, WorktreeUiStatus>;
}): ParityMismatch[] {
  const result: ParityMismatch[] = [];
  const nativeWorkspaceIds = sortedProjects.map((item) => item.id);
  const sharedWorkspaceIds = snapshot.workspaces.map((item) => item.localId);
  if (nativeWorkspaceIds.join('\0') !== sharedWorkspaceIds.join('\0')) {
    result.push({
      field: 'workspace-order',
      native: nativeWorkspaceIds,
      shadow: sharedWorkspaceIds,
    });
  }
  for (const workspace of snapshot.workspaces) {
    const nativeProject = sortedProjects.find(
      (item) => item.id === workspace.localId,
    );
    const nativeIds =
      nativeProject?.type !== 'cowork'
        ? (nativeProject?.worktrees ?? []).map((item) => item.id)
        : [];
    const sharedIds = snapshot.worktrees
      .filter((item) => item.workspaceLocalId === workspace.localId)
      .map((item) => item.localId);
    if (nativeIds.join('\0') !== sharedIds.join('\0')) {
      result.push({
        field: 'worktree-order',
        id: workspace.localId,
        native: nativeIds,
        shadow: sharedIds,
      });
    }
  }
  if (nativeSelection !== sharedSelection) {
    result.push({
      field: 'selection',
      native: nativeSelection,
      shadow: sharedSelection,
    });
  }
  for (const worktree of snapshot.worktrees) {
    const key = `${worktree.workspaceLocalId}/${worktree.localId}`;
    const nativeStatus = worktreeStatusMap.get(key) ?? 'idle';
    const nativeClass = WORKTREE_STATUS_META[nativeStatus].dotClass;
    const projectedClass = shadowStatus(worktree);
    if (nativeClass !== projectedClass) {
      result.push({
        field: 'status-class',
        id: key,
        native: nativeClass,
        shadow: projectedClass,
      });
    }
  }
  return result;
}

interface CommitCounter {
  readonly getSnapshot: () => number;
  readonly increment: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createCommitCounter(): CommitCounter {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => count,
    increment: (): void => {
      count += 1;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

export function DesktopSidebarShadowPanel({
  client = ipcCanopyClient,
}: {
  readonly client?: CanopyClient;
}): JSX.Element {
  const model = useSidebarWorkspaces();
  const [expanded, setExpanded] = useState(false);
  const [readoutExpanded, setReadoutExpanded] = useState(true);
  const [snapshot, setSnapshot] = useState<SessionViewModel | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastBuildDuration, setLastBuildDuration] = useState(0);
  const commitCounter = useMemo(createCommitCounter, []);
  const activePage = useNavigationStore((state) => state.activePage);
  const handleSnapshot = useCallback((next: SessionViewModel): void => {
    setSnapshot(next);
    setRefreshCount((count) => count + 1);
  }, []);
  const handleRefreshMeasured = useCallback((durationMs: number): void => {
    setLastBuildDuration(durationMs);
  }, []);
  const nativeSelection =
    activePage === 'main' ? model.selectedWorktreeKey : null;
  const sharedSelection = parseDesktopWorktreeSelection(nativeSelection);
  const sharedSelectionKey = sharedSelection
    ? `${sharedSelection.workspaceLocalId}/${sharedSelection.worktreeLocalId}`
    : null;
  const mismatches = useMemo(() => {
    if (!snapshot) return [];
    return compareDesktopSidebarParity({
      snapshot,
      sortedProjects: model.sortedProjects,
      nativeSelection,
      sharedSelection: sharedSelectionKey,
      worktreeStatusMap: model.worktreeStatusMap,
    });
  }, [
    model.sortedProjects,
    model.worktreeStatusMap,
    nativeSelection,
    sharedSelectionKey,
    snapshot,
  ]);

  return (
    <div className="pt-2 empty:hidden">
      <Surface
        as="section"
        variant="section"
        boundary="top"
        data-testid="desktop-sidebar-shadow-panel"
      >
        <div className="pt-2">
          <Disclosure
            label="Shared sidebar shadow"
            open={expanded}
            onOpenChange={setExpanded}
            dataTestId="desktop-sidebar-shadow-disclosure"
          >
            <Surface variant="outline" size="small" className="overflow-hidden">
              <Profiler
                id="desktop-sidebar-shadow"
                onRender={commitCounter.increment}
              >
                <DesktopSharedSidebarHost
                  client={client}
                  testIds={{ root: 'desktop-sidebar-shadow-surface' }}
                  onSnapshot={handleSnapshot}
                  onRefreshMeasured={handleRefreshMeasured}
                />
              </Profiler>
              <ParityReadout
                commitCounter={commitCounter}
                expanded={readoutExpanded}
                lastBuildDuration={lastBuildDuration}
                mismatches={mismatches}
                onToggle={() => setReadoutExpanded((value) => !value)}
                refreshCount={refreshCount}
              />
            </Surface>
          </Disclosure>
        </div>
      </Surface>
    </div>
  );
}

function ParityReadout({
  commitCounter,
  expanded,
  lastBuildDuration,
  mismatches,
  onToggle,
  refreshCount,
}: {
  readonly commitCounter: CommitCounter;
  readonly expanded: boolean;
  readonly lastBuildDuration: number;
  readonly mismatches: readonly ParityMismatch[];
  readonly onToggle: () => void;
  readonly refreshCount: number;
}): JSX.Element {
  const commitCount = useSyncExternalStore(
    commitCounter.subscribe,
    commitCounter.getSnapshot,
    commitCounter.getSnapshot,
  );
  return (
    <Surface
      variant="quiet-panel"
      boundary="top"
      padding="tight"
      data-testid="desktop-sidebar-shadow-parity-readout"
    >
      <div className="text-2xs">
        <Disclosure
          label={`Parity: ${mismatches.length} mismatch(es)`}
          open={expanded}
          onOpenChange={onToggle}
          dataTestId="desktop-sidebar-shadow-parity-disclosure"
        >
          <Stack gap="tight">
            <div>
              refreshes {refreshCount} · build{' '}
              {Number(lastBuildDuration.toFixed(2))} ms · commits {commitCount}
            </div>
            <CodeBlock
              variant="bare"
              size="inherit"
              wrap="words"
              tone="inherit"
              replay="block"
              className="max-h-32"
            >
              {JSON.stringify(mismatches, null, 2)}
            </CodeBlock>
          </Stack>
        </Disclosure>
      </div>
    </Surface>
  );
}
