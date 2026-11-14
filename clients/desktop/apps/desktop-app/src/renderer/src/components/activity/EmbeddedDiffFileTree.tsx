import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { useChatTabRenderState } from '@/stores/chatStore';
import type { ChangedFileRow } from '@canopy/ui-app';
import { useMemo, useState, type JSX } from 'react';
import { useActivityStore } from '@/stores/activityStore';
import { useOpenFileDiffTarget } from '../chat/useOpenFileDiffTarget';
import {
  useChangedFilesSectionHostModel,
  toPortalFile,
} from './ChangedFilesSection';
import { DiffFileTree } from './DiffFileTree';
import { EmbeddedFileTreeToolbar } from './EmbeddedFileTreeToolbar';
import type {
  ChangedFileInfo,
  FileDiffSource,
} from '@canopy/desktop-shared/types';
import { Notice, SearchField } from '@canopy/ui-shared';

const EMPTY: ChangedFileInfo[] = [];
export interface EmbeddedDiffFileTreeProps {
  projectId: string;
  worktreeId: string;
  tabId: string;
  currentFilePath: string;
  onModeChange: (mode: 'file' | 'diff') => void;
}

export function EmbeddedDiffFileTree({
  projectId,
  worktreeId,
  tabId,
  currentFilePath,
  onModeChange,
}: EmbeddedDiffFileTreeProps): JSX.Element {
  const listView = useFileTabUiStore(
    (state) => state.fileTreeListViewByTabId[tabId] ?? false,
  );
  const setListView = useFileTabUiStore((state) => state.setFileTreeListView);
  const [query, setQuery] = useState('');
  const [searchRequest, setSearchRequest] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapseRequest, setCollapseRequest] = useState(0);
  const [revealRequest, setRevealRequest] = useState(0);
  const [revealFilteredFile, setRevealFilteredFile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = useChatTabRenderState(
    { projectId, worktreeId, chatId: tabId },
    ({ tab }) => tab?.fileDiffContext,
  );
  const target = useOpenFileDiffTarget(projectId, worktreeId, currentFilePath);
  const turnDiff = context?.source === 'turn' ? context.turnDiff : undefined;
  const liveFiles = useActivityStore(
    (state) => state.changedFiles[`${projectId}/${worktreeId}`],
  );
  const files = useMemo(
    () =>
      turnDiff ? { uncommitted: turnDiff.files, committed: EMPTY } : liveFiles,
    [turnDiff, liveFiles],
  );
  const selected =
    files?.uncommitted
      .concat(files.committed)
      .find(
        (file) =>
          file.path === (context?.path ?? target?.file.path) &&
          file.repoId === (context?.repoId ?? target?.file.repoId),
      ) ?? null;
  const selectedSource: FileDiffSource =
    context?.source === 'committed'
      ? 'committed'
      : selected !== null && files?.uncommitted.includes(selected)
        ? 'uncommitted'
        : 'committed';
  const model = useChangedFilesSectionHostModel({
    projectId,
    worktreeId,
    originFileTabId: tabId,
    diffTree: true,
    turnDiff,
  });
  const filtered = useMemo(() => {
    const filter = (source: 'uncommitted' | 'committed'): ChangedFileInfo[] =>
      (files?.[source] ?? EMPTY).filter(
        (file) =>
          (revealFilteredFile &&
            selected?.path === file.path &&
            selected.repoId === file.repoId) ||
          (file.path.toLowerCase().includes(query.toLowerCase()) &&
            model.changedFiles?.[source].some(
              (row) =>
                row.filePath === toPortalFile(file).filePath &&
                row.repoId === file.repoId,
            )),
      );
    return {
      uncommitted: filter('uncommitted'),
      committed: filter('committed'),
    };
  }, [files, query, model.changedFiles, selected, revealFilteredFile]);
  const row = (
    file: ChangedFileInfo,
    source: FileDiffSource,
  ): ChangedFileRow => ({
    ...toPortalFile(file),
    source: source === 'committed' ? 'committed' : 'uncommitted',
  });
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const updated = await window.api.activity.getChangedFiles({
        projectId,
        worktreeId,
      });
      useActivityStore
        .getState()
        .setChangedFiles(projectId, worktreeId, updated);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to refresh files.',
      );
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="file-tab-diff-tree"
    >
      <EmbeddedFileTreeToolbar
        mode="diff"
        onModeChange={onModeChange}
        filter={model.headerAction}
        listView={listView}
        onToggleListView={() => setListView(tabId, !listView)}
        searchOpen={searchOpen}
        onToggleSearch={() => {
          setSearchOpen(!searchOpen);
          if (searchOpen) setQuery('');
        }}
        onFocusFile={() => {
          setQuery('');
          setRevealFilteredFile(true);
          setRevealRequest((value) => value + 1);
        }}
        focusDisabled={!selected}
        onRefresh={() => {
          void refresh();
        }}
        refreshDisabled={refreshing}
        onCollapseAll={() => setCollapseRequest((value) => value + 1)}
        collapseDisabled={listView}
      />
      {turnDiff && (
        <div className="px-2 pt-2 text-xs fg-secondary">Turn changes</div>
      )}
      {searchOpen && (
        <div className="shrink-0 p-2">
          <SearchField
            autoFocus
            className=""
            clearOnEscape={false}
            aria-label="Search changed files"
            placeholder="Search files…"
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setSearchRequest((value) => value + 1);
              setRevealFilteredFile(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false);
                setQuery('');
              }
            }}
          />
        </div>
      )}
      {error && (
        <div className="shrink-0 p-2">
          <Notice
            errorSource="embedded-diff-file-tree"
            intent="destructive"
            className=""
          >
            {error}
          </Notice>
        </div>
      )}
      {filtered.uncommitted.length + filtered.committed.length === 0 ? (
        <p className="p-3 text-xs fg-secondary">
          {(files?.uncommitted.length ?? 0) + (files?.committed.length ?? 0) > 0
            ? 'No matching changed files.'
            : 'No changed files.'}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <DiffFileTree
            {...filtered}
            selectedFile={selected}
            selectedSource={selectedSource}
            onSelectFile={(file, source) =>
              model.onFileClick?.(row(file, source))
            }
            onFileContextMenu={(file, source, point) =>
              model.onFileContextMenu?.(row(file, source), point)
            }
            collapsed={false}
            onToggleCollapsed={() => undefined}
            width={256}
            resizable={false}
            clampWidth={() => 256}
            onWidthCommit={() => undefined}
            hideHeader
            listView={listView}
            collapseAllRequest={collapseRequest}
            expandAllRequest={searchRequest}
            revealFileRequest={revealRequest}
          />
        </div>
      )}
      {model.supplementaryContent}
    </div>
  );
}
