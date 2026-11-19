import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ChangedFileInfo,
  type FileDiffSource,
  type TurnDiffData,
} from '@canopy/desktop-shared/types';
import type { FileDiffContext } from '@canopy/desktop-shared/types/code-review';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  requestFilePanelPlacementAsSibling,
  requestFilePanelPlacementBesideChat,
} from './chat-panel-sync';

export async function openFileInDiff(
  scope: { projectId: string; worktreeId: string },
  file: ChangedFileInfo,
  source: FileDiffSource = 'combined',
  origin?: { fileTabId?: string; chatTabId?: string },
  turnDiff?: TurnDiffData,
): Promise<string | null> {
  try {
    const root =
      scope.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
        ? await window.api.getFileTreeRoots(scope).then(({ roots }) => {
            const match = file.repoId
              ? roots.find((candidate) => candidate.repoId === file.repoId)
              : roots.length === 1
                ? roots[0]
                : undefined;
            if (!match) {
              throw new Error('Diff root is unavailable.');
            }
            return match.absolutePath;
          })
        : await window.api.getWorktreePath({
            ...scope,
            repoId: file.repoId,
          });
    const absolutePath = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${file.path}`;
    const state = useChatStore.getState();
    const comparablePath = (value: string): string => {
      const normalized = value.replace(/\\/g, '/');
      return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized;
    };
    const existingPath = state.worktreeChats?.[
      `${scope.projectId}/${scope.worktreeId}`
    ]?.tabs.find(
      (tab) =>
        tab.kind === 'file' &&
        tab.filePath &&
        comparablePath(tab.filePath) === comparablePath(absolutePath),
    )?.filePath;
    const tabId = state.openFileTab(
      {
        absolutePath: existingPath ?? absolutePath,
        filename: file.path.split(/[\\/]/).pop() ?? file.path,
      },
      scope,
    );
    if (!tabId) return null;
    if (!existingPath)
      useFileTabUiStore.getState().initializeFileTreeMode(tabId, 'diff');
    const tree =
      turnDiff?.treeRefs?.length === 1
        ? turnDiff.treeRefs[0]
        : turnDiff?.treeRefs?.find((ref) => ref.repoId === file.repoId);
    const context: FileDiffContext = {
      path: file.path,
      ...(file.repoId ? { repoId: file.repoId } : {}),
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      source: tree ? 'turn' : source,
      ...(tree
        ? { startTree: tree.startTree, endTree: tree.endTree, turnDiff }
        : {}),
    };
    state.setFileTabViewMode(tabId, 'diff', scope, context);
    if (origin?.fileTabId)
      requestFilePanelPlacementAsSibling(tabId, origin.fileTabId);
    else if (origin?.chatTabId)
      requestFilePanelPlacementBesideChat(tabId, origin.chatTabId);
    return tabId;
  } catch (error) {
    useGitHubStore
      .getState()
      .addToast(
        error instanceof Error ? error.message : 'Unable to open changes',
        'error',
        undefined,
        { ...scope, caught: error },
      );
    return null;
  }
}
