'use client';

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { RemoteControlDiffReadPayload } from '@canopy/protocol/remote-control/shell';
import {
  diffViewerKey,
  useFileViewerStore,
  useWorkspaceCapabilities,
} from '@canopy/app-state';
import {
  Surface,
  DiffBinaryState,
  DiffBoundNotice,
  DiffFileTree,
  Button,
  DiffViewModeToggle,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  ErrorState,
  useIsMobile,
  type DiffFileTreeFile,
  type DiffFileTreeGroup,
  type DiffViewMode,
} from '@canopy/ui-shared/components';
import { ChevronRightIcon, FilesIcon } from '@canopy/ui-shared/icons';
import { toDiffFileStatus } from './diff-status';
import { UnifiedDiffView } from './UnifiedDiffView';

/**
 * The write-once diff viewer for the Code tab. Opens a diff through the shared
 * {@link useFileViewerStore} (routing to `client.query('diff.read')`) and lays
 * out the shared {@link DiffFileTree} sidebar next to a dependency-free
 * {@link UnifiedDiffView} of the patch. Read-only on every host — a diff has no
 * edit affordance — so no capability gate is needed.
 */
export interface DiffViewerProps {
  readonly request: RemoteControlDiffReadPayload;
  /** Notified when a file row is clicked (host may open its focused diff). */
  readonly onSelectFile?: (filePath: string) => void;
}

export function DiffViewer({
  request,
  onSelectFile,
}: DiffViewerProps): JSX.Element {
  const key = diffViewerKey(request);
  const session = useFileViewerStore((state) => state.diffs[key]);

  const openDiff = useFileViewerStore((state) => state.openDiff);

  // A target that diffs one path at a time (a cloud repository worktree)
  // cannot answer a whole-worktree request: ask for a file instead of issuing
  // a read that would only fail (REG-3024).
  const { wholeWorktreeDiff } = useWorkspaceCapabilities(request.workspaceId);
  const needsFile = request.path === undefined && wholeWorktreeDiff === false;

  useEffect(() => {
    if (needsFile) return;
    void openDiff(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, openDiff, needsFile]);

  // Tommy (RC review, reply 20): the file list could not be collapsed, so on a
  // narrow viewport the diff was squeezed into whatever was left beside a fixed
  // 256px sidebar. Start collapsed on mobile and let either surface toggle it.
  const isMobile = useIsMobile();
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(
    null,
  );
  // A single-file request (the web file tab) starts collapsed too: desktop
  // shows that diff with no file list beside it.
  const filesCollapsed =
    collapseOverride ?? (isMobile || request.path !== undefined);
  const setFilesCollapsed = (next: boolean): void => setCollapseOverride(next);
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');

  const groups = useMemo<DiffFileTreeGroup[]>(() => {
    const files = session?.diff?.files ?? [];
    if (files.length === 0) {
      return [];
    }
    const rows: DiffFileTreeFile[] = files.map((file) => ({
      filePath: file.filePath,
      status: toDiffFileStatus(file.status),
      insertions: file.insertions,
      deletions: file.deletions,
      key: file.filePath,
      // `request.path` is optional: undefined means the combined diff, so the
      // comparison is intentionally false and nothing is pre-selected.
      selected: request.path === file.filePath,
    }));
    // Group by directory (CAN-2517). A single flat list repeated the full path
    // on every row, which is what makes a many-file diff unreadable in a narrow
    // sidebar. Directory headings pull the shared prefix out of the rows.
    //
    // This is NOT a full tree: `DiffFileTreeGroup` is a flat heading + files,
    // and nesting would be a redesign of the shared component (and a desktop
    // re-QA). Directory grouping recovers most of the benefit within the
    // existing contract.
    const byDirectory = new Map<string, DiffFileTreeFile[]>();
    for (const row of rows) {
      const slash = row.filePath.lastIndexOf('/');
      const directory = slash === -1 ? '' : row.filePath.slice(0, slash);
      // Under a directory heading the prefix is redundant; selection still
      // addresses the full `filePath`.
      const labelled: DiffFileTreeFile =
        directory === ''
          ? row
          : { ...row, label: row.filePath.slice(slash + 1) };
      const bucket = byDirectory.get(directory);
      if (bucket) {
        bucket.push(labelled);
      } else {
        byDirectory.set(directory, [labelled]);
      }
    }
    // Root-level files sort first (empty heading), then directories A→Z, so the
    // order is stable across reloads regardless of the diff's file order.
    const entries: Array<[string, DiffFileTreeFile[]]> = Array.from(
      byDirectory.entries(),
    );
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries.map(([directory, files]) => ({
      heading: directory === '' ? '(root)' : directory,
      files,
    }));
  }, [session?.diff?.files, request.path]);

  if (needsFile) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center px-6 text-s fg-secondary"
        data-testid="diff-viewer-select-file"
      >
        Select a file to see its diff.
      </div>
    );
  }

  if (!session || (session.status === 'loading' && session.diff === null)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner spacing="section" />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (session.status === 'error' && session.diff === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <ErrorState
          space="panel"
          testId="diff-error"
          message={session.error ?? "Couldn't read the diff."}
        />
      </div>
    );
  }

  const patch = session.diff?.patch ?? '';
  // Bounded-response metadata (REG-3024); absent on desktop and older
  // producers, which render exactly as before.
  const filesTruncated = session.diff?.truncated === true;
  const patchOversized = session.diff?.oversized === true;
  const patchBinary = session.diff?.binary === true;

  // Sum across ALL groups: directory grouping splits the diff into one group
  // per directory, so reading `groups[0]` alone silently reported just the
  // first directory's file count in the collapsed rail and the header.
  const fileCount = groups.reduce(
    (total, group) => total + group.files.length,
    0,
  );
  // A cut list is counted as a floor, as the Changed files header does.
  const fileCountLabel = `${String(fileCount)}${filesTruncated ? '+' : ''}`;

  return (
    <div className="flex h-full min-h-0" data-testid="diff-viewer">
      {filesCollapsed ? (
        // Collapsed rail: a diff on a narrow viewport is unreadable beside a
        // fixed 256px file list, so the list folds away to a single control
        // that still shows the file count.
        <Surface variant="section" boundary="right" className="shrink-0">
          <div className="flex shrink-0 flex-col items-center gap-1 px-1 py-2">
            <Button
              variant="ghost"
              iconOnly
              onClick={(): void => setFilesCollapsed(false)}
              // The visible count beside this button is aria-hidden, so the
              // count has to ride on the accessible name or assistive tech
              // cannot discover it while the rail is collapsed.
              aria-label={`Show ${fileCountLabel} changed file${
                fileCount === 1 && !filesTruncated ? '' : 's'
              }${filesTruncated ? '. Not every changed file is listed.' : ''}`}
              aria-expanded={false}
              data-testid="diff-viewer-files-expand"
            >
              <FilesIcon />
            </Button>
            <span className="text-3xs fg-secondary" aria-hidden="true">
              {fileCountLabel}
            </span>
          </div>
        </Surface>
      ) : (
        <div className="flex min-h-0 shrink-0 flex-col overflow-hidden">
          <Surface
            variant="section"
            boundary="bottom-right"
            padding="diff-controls"
            className="flex shrink-0 justify-end"
          >
            <Button
              variant="ghost"
              iconOnly
              onClick={(): void => setFilesCollapsed(true)}
              aria-label="Hide changed files"
              aria-expanded={true}
              data-testid="diff-viewer-files-collapse"
            >
              <ChevronRightIcon className="rotate-180" />
            </Button>
          </Surface>
          {filesTruncated ? (
            <div className="p-2">
              <DiffBoundNotice kind="truncated" className="shrink-0" />
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <DiffFileTree
              groups={groups}
              onSelect={(file): void => onSelectFile?.(file.filePath)}
              headerLabel={`${session?.diff?.rangeLabel ?? 'Changes'} · Files (${fileCount})`}
              emptyState={
                <div className="px-3 py-2 text-xs fg-secondary">
                  No changes.
                </div>
              }
            />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {patchBinary || patch.trim() === '' ? null : (
          // Mirrors the file list's header height so the two borders align.
          <Surface variant="section" boundary="bottom" className="shrink-0">
            <div className="flex shrink-0 justify-end px-2 pt-1">
              <div className="flex min-h-8 items-center">
                <DiffViewModeToggle
                  value={viewMode}
                  onChange={setViewMode}
                  dataTestId="diff-viewer-layout"
                />
              </div>
            </div>
          </Surface>
        )}
        {filesTruncated && filesCollapsed ? (
          // The list's own notice folds away with it; keep it in view.
          <div className="p-2">
            <DiffBoundNotice kind="truncated" className="shrink-0" />
          </div>
        ) : null}
        {patchOversized ? (
          <div className="p-2">
            <DiffBoundNotice kind="oversized" className="shrink-0" />
          </div>
        ) : null}
        {patchBinary ? (
          <DiffBinaryState />
        ) : (
          <UnifiedDiffView
            patch={patch}
            viewMode={viewMode}
            emptyState={
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-s fg-secondary">
                No textual changes to display.
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
