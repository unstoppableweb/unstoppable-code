'use client';

import { ChangedFileRowSurface } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from '@tanstack/react-virtual';
import type {
  RemoteControlChangedFile,
  RemoteControlChangedFilesGroup,
  RemoteControlChangedFiles,
  RemoteControlChangedFilesNotice,
  RemoteControlCodeViewerSelection,
} from '@canopy/protocol/remote-control/shell';
import {
  Stack,
  OverlayScrollArea,
  FileChangeMetadata,
  FileRevertButton,
  LoadingSpinner,
  Notice,
  Button,
  Heading,
} from '@canopy/ui-shared/components';
import { toDiffFileStatus } from '../../file/diff-status';
import { useScrollMargin } from '../../use-scroll-margin';

export interface ChangedFileRow extends RemoteControlChangedFile {
  readonly source: 'uncommitted' | 'committed';
}

/**
 * Split a path into its muted directory prefix (with trailing slash) and the
 * emphasized filename, mirroring the desktop `ChangedFilesSection.splitPath`.
 */
function splitPath(filePath: string): { dir: string; name: string } {
  const lastSlash = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  if (lastSlash === -1) return { dir: '', name: filePath };
  return {
    dir: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}

function displayPath(file: ChangedFileRow, showRepoName = false): string {
  const previousPath = file.renamedFrom ?? file.previousPath;
  const currentPath = filePathForDisplay(file, showRepoName);
  const previousDisplayPath =
    showRepoName && file.repoName && previousPath
      ? `${file.repoName}/${previousPath}`
      : previousPath;
  // Both status vocabularies are live on the wire (word statuses and
  // porcelain codes); normalise before the rename check.
  return toDiffFileStatus(file.status) === 'renamed' && previousDisplayPath
    ? `${previousDisplayPath} → ${currentPath}`
    : currentPath;
}

function filePathForDisplay(
  file: ChangedFileRow,
  showRepoName: boolean,
): string {
  return showRepoName && file.repoName
    ? `${file.repoName}/${file.filePath}`
    : file.filePath;
}

const NOTICE_COPY: Record<RemoteControlChangedFilesNotice['kind'], string> = {
  truncated: 'Not every changed file is listed.',
  base_unavailable:
    "The base branch isn't available, so committed changes can't be compared.",
  unavailable: "Changes aren't available right now.",
  sleeping: 'Project is sleeping. Changes load when it wakes.',
};

/**
 * Why the lists are incomplete (REG-3024), one quiet line per notice. A
 * producer that reports none (desktop) renders nothing here.
 */
function ChangedFilesNotices({
  notices,
  showRepoName,
}: {
  readonly notices: readonly RemoteControlChangedFilesNotice[];
  readonly showRepoName: boolean;
}): JSX.Element | null {
  if (notices.length === 0) return null;
  // The shared inline Notice (DESIGN.md): neutral, the glyph carries the
  // meaning; announced politely when a refresh changes the answer.
  return (
    <div className="flex flex-col gap-2 px-3">
      {notices.map((notice, index) => (
        <Notice
          key={`${notice.kind}:${notice.repoId ?? ''}:${String(index)}`}
          intent="neutral"
          data-testid="activity-changed-files-notice"
          data-notice-kind={notice.kind}
        >
          {showRepoName && notice.repoName
            ? `${notice.repoName}: ${NOTICE_COPY[notice.kind]}`
            : NOTICE_COPY[notice.kind]}
        </Notice>
      ))}
    </div>
  );
}

/**
 * Read-only changed-files list for the activity panel (uncommitted +
 * committed). Each row mirrors the desktop-native row: a `px-3 py-1`,
 * keyboard-operable line with a muted directory / foreground filename split,
 * the shared {@link FileChangeMetadata} status dot, and a hover-revealed
 * {@link FileRevertButton}. Selecting a row calls the injected
 * {@link ChangedFilesSectionProps.onSelectFile} (host opens the diff); the
 * revert affordance renders only when the host can write
 * (`fileSystemAccess === 'read-write'`) and a handler is injected.
 */
export interface ChangedFilesSectionProps {
  readonly changedFiles: RemoteControlChangedFiles | undefined;
  /** True when the host can revert (desktop); hides Revert otherwise. */
  readonly canRevert?: boolean;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  /** Prefix paths with repo names when the selected workspace has >1 repo. */
  readonly showRepoName?: boolean;
  readonly onSelectFile?: (selection: RemoteControlCodeViewerSelection) => void;
  readonly onFileClick?: (file: ChangedFileRow) => void;
  readonly onFileContextMenu?: (
    file: ChangedFileRow,
    point: { clientX: number; clientY: number },
  ) => void;
  readonly onRevertFile?: (file: ChangedFileRow) => void;
  /** Request the next bounded page after locally revealed rows are exhausted. */
  readonly onLoadMore?: (group: RemoteControlChangedFilesGroup) => void;
  readonly hasMore?: Partial<Record<RemoteControlChangedFilesGroup, boolean>>;
  readonly loadingMore?: Partial<
    Record<RemoteControlChangedFilesGroup, boolean>
  >;
  /** Defaults to the portal's existing empty-state copy; pass null for blank. */
  readonly emptyState?: ReactNode;
  /** Applies the native rail's inner scroll cap. */
  readonly scrollable?: boolean;
  readonly openDataTestId?: string;
}

function FileRow({
  file,
  canRevert,
  onSelectFile,
  onFileClick,
  onFileContextMenu,
  onRevertFile,
  workspaceLocalId,
  worktreeLocalId,
  showRepoName,
  openDataTestId,
  focusOnMount = false,
  onFocus,
}: {
  file: ChangedFileRow;
  canRevert: boolean;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  showRepoName: boolean;
  onSelectFile?: (selection: RemoteControlCodeViewerSelection) => void;
  focusOnMount?: boolean;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onFileClick?: (file: ChangedFileRow) => void;
  onFileContextMenu?: ChangedFilesSectionProps['onFileContextMenu'];
  onRevertFile?: (file: ChangedFileRow) => void;
  openDataTestId?: string;
}): JSX.Element {
  const renderedPath = filePathForDisplay(file, showRepoName);
  const { dir, name } = splitPath(renderedPath);
  const tooltip = displayPath(file, showRepoName);
  // Only wire selection when the complete diff-selection identity is present:
  // a handler plus both workspace and worktree ids.
  const selectFromRemoteControl =
    onSelectFile && workspaceLocalId && worktreeLocalId
      ? (): void =>
          onSelectFile({
            kind: 'diff',
            title: file.filePath,
            request: {
              workspaceId: workspaceLocalId,
              worktreeId: worktreeLocalId,
              path: file.filePath,
              source: file.source,
              ...(file.repoId ? { repoId: file.repoId } : {}),
            },
          })
      : undefined;
  const select = onFileClick
    ? (): void => onFileClick(file)
    : selectFromRemoteControl;
  const isSelectable = select !== undefined;
  const rowRef = useCallback(
    (element: HTMLDivElement | null): void => {
      if (element !== null && focusOnMount && isSelectable) element.focus();
    },
    [focusOnMount, isSelectable],
  );
  const revert =
    canRevert && onRevertFile ? (): void => onRevertFile(file) : undefined;

  return (
    <ChangedFileRowSurface
      ref={rowRef}
      selectable={isSelectable}
      data-testid="activity-changed-file"
      role={select ? 'button' : undefined}
      tabIndex={select ? 0 : undefined}
      onClick={select}
      onFocus={onFocus}
      onContextMenu={
        onFileContextMenu
          ? (event: MouseEvent<HTMLDivElement>): void => {
              event.preventDefault();
              event.stopPropagation();
              onFileContextMenu(file, {
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }
          : undefined
      }
      onKeyDown={
        select
          ? (event: KeyboardEvent<HTMLDivElement>): void => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                // Defensive: keep row activation keys out of ancestor
                // keyboard handlers (e.g. a future dnd-kit sensor), matching
                // ExecutionActionButton.
                event.stopPropagation();
                select();
              }
            }
          : undefined
      }
    >
      {/* The full path on the truncated text, not the row: a row's help is a
          shared tooltip, a cut-off value keeps its native title. */}
      <div
        className="flex min-w-0 flex-1 items-baseline text-s"
        data-testid={openDataTestId}
        title={tooltip}
      >
        <span className="min-w-0 shrink truncate fg-secondary">{dir}</span>
        <span className="max-w-full shrink-0 truncate fg-primary/80">
          {name}
        </span>
      </div>
      {file.binary === true ? (
        <span
          className={`shrink-0 text-2xs fg-secondary ${
            revert ? 'group-hover:hidden group-focus-within:hidden' : ''
          }`}
        >
          Binary
        </span>
      ) : null}
      <FileChangeMetadata
        insertions={file.insertions}
        deletions={file.deletions}
        status={toDiffFileStatus(file.status)}
        hideOnHover={revert !== undefined}
      />
      {revert ? (
        <FileRevertButton
          ariaLabel={`Discard changes to ${tooltip}`}
          onClick={revert}
        />
      ) : null}
    </ChangedFileRowSurface>
  );
}

/**
 * Capped list body. When it scrolls it goes behind the shared
 * OverlayScrollArea like every other surface, so its scrollbar is the same
 * overlay thumb — the native one was a 15px track that also ate 15px of the
 * card's width, which is why it read as thicker and different.
 */
interface ChangedFilesBodyProps {
  readonly scrollable: boolean;
  readonly children: ReactNode;
  readonly bodyRef?: (element: HTMLDivElement | null) => void;
  readonly viewportRef?: (element: HTMLDivElement | null) => void;
  readonly virtualized?: boolean;
  readonly onBlurCapture?: (event: FocusEvent<HTMLDivElement>) => void;
}

function ChangedFilesBody({
  scrollable,
  children,
  bodyRef,
  viewportRef,
  virtualized = false,
  onBlurCapture,
}: ChangedFilesBodyProps): JSX.Element {
  if (!scrollable) {
    return (
      <div
        ref={bodyRef}
        className="flex flex-col gap-2"
        data-testid="activity-changed-files"
        {...(virtualized ? { 'data-virtualized': 'true' } : {})}
        onBlurCapture={onBlurCapture}
      >
        {children}
      </div>
    );
  }
  const viewportProps = {
    'data-testid': 'activity-changed-files',
    ...(virtualized ? { 'data-virtualized': 'true' } : {}),
    onBlurCapture,
  };
  return (
    <OverlayScrollArea
      className="-mb-3 -mt-3 max-h-70"
      contentClassName="flex flex-col gap-2 py-3"
      railClassName="-right-1"
      viewportProps={viewportProps}
      viewportRef={viewportRef}
    >
      {children}
    </OverlayScrollArea>
  );
}

const VIRTUALIZE_THRESHOLD = 100;
const REVEAL_PAGE_SIZE = 200;
const ESTIMATED_FILE_ITEM_HEIGHT = 24;
const AUTO_REVEAL_ROOT_MARGIN = '0px 0px 96px 0px';
const EMPTY_FILES: readonly RemoteControlChangedFile[] = [];
const EMPTY_NOTICES: readonly RemoteControlChangedFilesNotice[] = [];

type ChangedFilesGroup = RemoteControlChangedFilesGroup;

interface RevealBudgets {
  readonly scopeKey: string;
  readonly uncommitted: number;
  readonly committed: number;
}

interface FocusedRowIdentity {
  readonly group: ChangedFilesGroup;
  readonly repoId: string | undefined;
  readonly filePath: string;
  readonly focusKey: string;
  readonly rowKey: string;
}

interface ChangedFilesListHandlers {
  readonly canRevert: boolean;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly showRepoName: boolean;
  readonly onSelectFile?: (selection: RemoteControlCodeViewerSelection) => void;
  readonly onFileClick?: (file: ChangedFileRow) => void;
  readonly onFileContextMenu?: ChangedFilesSectionProps['onFileContextMenu'];
  readonly onRevertFile?: (file: ChangedFileRow) => void;
  readonly onLoadMore?: (group: ChangedFilesGroup) => void;
  readonly openDataTestId?: string;
}

interface ChangedFilesHeadingItem {
  readonly kind: 'heading';
  readonly key: string;
  readonly group: ChangedFilesGroup;
  readonly label: string;
  readonly total: number;
  readonly budget: number;
  readonly truncated: boolean;
  readonly exactTotal: boolean;
  readonly topSpacing: number;
}

interface ChangedFilesRowItem {
  readonly kind: 'file';
  readonly key: string;
  readonly group: ChangedFilesGroup;
  readonly file: ChangedFileRow;
  readonly focusKey: string;
  readonly topSpacing: number;
}

interface ChangedFilesNoticeItem {
  readonly kind: 'notices';
  readonly key: string;
  readonly topSpacing: number;
}

interface ChangedFilesShowMoreItem {
  readonly kind: 'show-more';
  readonly key: string;
  readonly group: ChangedFilesGroup;
  readonly label: string;
  readonly total: number;
  readonly moreCount: number;
  readonly remaining: number;
  readonly loadMore: boolean;
  readonly loading: boolean;
  readonly topSpacing: number;
}

type ChangedFilesListItem =
  | ChangedFilesHeadingItem
  | ChangedFilesRowItem
  | ChangedFilesNoticeItem
  | ChangedFilesShowMoreItem;

interface ChangedFilesListProps extends ChangedFilesListHandlers {
  readonly uncommitted: readonly ChangedFileRow[];
  readonly committed: readonly ChangedFileRow[];
  readonly notices: readonly RemoteControlChangedFilesNotice[];
  readonly hasMore?: Partial<Record<ChangedFilesGroup, boolean>>;
  readonly loadingMore?: Partial<Record<ChangedFilesGroup, boolean>>;
  readonly totals: Partial<Record<ChangedFilesGroup, number>>;
  readonly budgets: RevealBudgets;
  readonly truncated: boolean;
  readonly scrollable: boolean;
  readonly scopeKey: string;
  readonly onRevealMore: (
    group: ChangedFilesGroup,
    focusAfterReveal?: boolean,
  ) => void;
  readonly onFocusRow: (focus: FocusedRowIdentity | null) => void;
  readonly focusedRow: FocusedRowIdentity | null;
  readonly onBlurCapture: (event: FocusEvent<HTMLDivElement>) => void;
}

function formatFileCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

function changedFileRowKey(file: ChangedFileRow): string {
  return `${file.source === 'uncommitted' ? 'u' : 'c'}:${file.repoId ?? ''}:${file.filePath}:${file.status}`;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareChangedFileIdentity(
  left: RemoteControlChangedFile,
  right: RemoteControlChangedFile,
): number {
  return (
    compareCodePoint(left.repoId ?? '', right.repoId ?? '') ||
    compareCodePoint(left.filePath, right.filePath)
  );
}

function changedFileFocusKey(
  group: ChangedFilesGroup,
  file: ChangedFileRow,
): string {
  return `${group}\u001f${file.repoId ?? ''}\u001f${file.filePath}`;
}

function focusedRowIdentity(
  group: ChangedFilesGroup,
  file: ChangedFileRow,
): FocusedRowIdentity {
  return {
    group,
    repoId: file.repoId,
    filePath: file.filePath,
    focusKey: changedFileFocusKey(group, file),
    rowKey: changedFileRowKey(file),
  };
}

function changedFilesHeadingText(
  label: string,
  total: number,
  budget: number,
  truncated: boolean,
  exactTotal: boolean,
): string {
  if (total <= budget && !exactTotal) return label;
  const count = formatFileCount(total);
  return truncated
    ? `${label} · ${count} files listed`
    : `${label} · ${count} files`;
}

function ChangedFilesGroupHeading({
  item,
}: {
  readonly item: ChangedFilesHeadingItem;
}): JSX.Element {
  const isCapped = item.total > item.budget;
  const reportsTotal = isCapped || item.exactTotal;
  return (
    <div className="pb-1 px-3">
      <Heading
        level={4}
        variant="label"
        {...(reportsTotal ? { 'data-total': String(item.total) } : {})}
      >
        {changedFilesHeadingText(
          item.label,
          item.total,
          item.budget,
          item.truncated,
          item.exactTotal,
        )}
      </Heading>
    </div>
  );
}

function ChangedFilesShowMore({
  item,
  onRevealMore,
  buttonRef,
}: {
  readonly item: ChangedFilesShowMoreItem;
  readonly onRevealMore: (
    group: ChangedFilesGroup,
    focusAfterReveal?: boolean,
  ) => void;
  readonly buttonRef?: (button: HTMLButtonElement | null) => void;
}): JSX.Element {
  if (item.loading && item.loadMore) {
    return (
      <span
        className="flex items-center gap-2 px-3 py-1.5 text-xs fg-secondary"
        data-testid="activity-changed-files-show-more"
        data-group={item.group}
        data-load-more="true"
        role="status"
        aria-live="polite"
      >
        <LoadingSpinner tone="secondary" decorative />
        Loading more files…
      </span>
    );
  }
  const visibleLabel = `Show ${formatFileCount(item.moreCount)} more file${item.moreCount === 1 ? '' : 's'}`;
  const remainingLabel = `${formatFileCount(item.remaining)} file${item.remaining === 1 ? '' : 's'} not shown`;
  return (
    <div className="flex flex-col items-start">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        data-testid="activity-changed-files-show-more"
        data-group={item.group}
        data-total={String(item.total)}
        {...(item.loadMore ? { 'data-load-more': 'true' } : {})}
        aria-label={
          item.loadMore
            ? `Load more ${item.label.toLowerCase()} files`
            : `${visibleLabel}, ${item.label} files`
        }
        onClick={(): void => onRevealMore(item.group, true)}
      >
        <span className="flex flex-col items-start">
          <span>{item.loadMore ? 'Load more files' : visibleLabel}</span>
          {!item.loadMore && (
            <span className="text-2xs fg-tertiary">{remainingLabel}</span>
          )}
        </span>
      </Button>
    </div>
  );
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  if (view === null) return null;
  let ancestor = element.parentElement;
  while (ancestor !== null) {
    if (ancestor.dataset['testid'] !== 'activity-list') {
      const overflowY = view.getComputedStyle(ancestor).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function useAncestorScrollElement(
  listElement: HTMLElement | null,
  enabled: boolean,
): HTMLElement | null {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled || listElement === null) {
      setScrollElement(null);
      return undefined;
    }
    const document = listElement.ownerDocument;
    const view = document.defaultView;
    if (view === null) {
      setScrollElement(null);
      return undefined;
    }

    let observedAncestors: HTMLElement[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let recompute = (): void => undefined;
    const mutationObserver = new view.MutationObserver((): void => {
      recompute();
    });

    const currentAncestors = (): HTMLElement[] => {
      const ancestors: HTMLElement[] = [];
      let ancestor = listElement.parentElement;
      while (ancestor !== null) {
        ancestors.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      return ancestors;
    };

    const refreshObservers = (ancestors: HTMLElement[]): void => {
      const unchangedPath =
        ancestors.length === observedAncestors.length &&
        ancestors.every(
          (ancestor, index) => observedAncestors[index] === ancestor,
        );
      if (unchangedPath) return;
      observedAncestors = ancestors;
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      mutationObserver.observe(listElement, {
        attributes: true,
        childList: true,
      });
      for (const ancestor of ancestors) {
        mutationObserver.observe(ancestor, {
          attributes: true,
          attributeFilter: ['class', 'hidden', 'style'],
          childList: true,
        });
      }
      resizeObserver =
        typeof view.ResizeObserver === 'undefined'
          ? null
          : new view.ResizeObserver((): void => recompute());
      resizeObserver?.observe(listElement);
      for (const ancestor of ancestors) resizeObserver?.observe(ancestor);
    };

    recompute = (): void => {
      const next = findScrollableAncestor(listElement);
      setScrollElement((previous) => (previous === next ? previous : next));
      refreshObservers(currentAncestors());
    };

    view.addEventListener('resize', recompute);
    recompute();
    return (): void => {
      view.removeEventListener('resize', recompute);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [enabled, listElement]);

  return enabled ? scrollElement : null;
}

interface ScrollProgress {
  lastScrollTop: number;
  forward: number;
  lastReveal: number;
}

function renderChangedFilesItem(
  item: ChangedFilesListItem,
  notices: readonly RemoteControlChangedFilesNotice[],
  handlers: ChangedFilesListHandlers,
  onRevealMore: (group: ChangedFilesGroup, focusAfterReveal?: boolean) => void,
  lastGroup: ChangedFilesGroup,
  focusedRow: FocusedRowIdentity | null,
  setSentinel?: (button: HTMLButtonElement | null) => void,
): JSX.Element {
  switch (item.kind) {
    case 'notices':
      return (
        <ChangedFilesNotices
          notices={notices}
          showRepoName={handlers.showRepoName}
        />
      );
    case 'heading':
      return <ChangedFilesGroupHeading item={item} />;
    case 'file':
      return (
        <div data-focus-key={item.focusKey} data-row-key={item.key}>
          <FileRow
            file={item.file}
            canRevert={handlers.canRevert && item.group === 'uncommitted'}
            onSelectFile={handlers.onSelectFile}
            onFileClick={handlers.onFileClick}
            onFileContextMenu={handlers.onFileContextMenu}
            onRevertFile={handlers.onRevertFile}
            workspaceLocalId={handlers.workspaceLocalId}
            worktreeLocalId={handlers.worktreeLocalId}
            showRepoName={handlers.showRepoName}
            openDataTestId={handlers.openDataTestId}
            focusOnMount={focusedRow?.focusKey === item.focusKey}
          />
        </div>
      );
    case 'show-more':
      return (
        <ChangedFilesShowMore
          item={item}
          onRevealMore={onRevealMore}
          buttonRef={item.group === lastGroup ? setSentinel : undefined}
        />
      );
  }
}

function VirtualizedChangedFilesItems({
  items,
  scrollElement,
  scopeKey,
  budgets,
  lastGroup,
  handlers,
  onRevealMore,
  onFocusCapture,
  focusedRow,
  notices,
}: {
  readonly items: readonly ChangedFilesListItem[];
  readonly scrollElement: HTMLElement;
  readonly scopeKey: string;
  readonly budgets: RevealBudgets;
  readonly lastGroup: ChangedFilesGroup;
  readonly handlers: ChangedFilesListHandlers;
  readonly onRevealMore: (
    group: ChangedFilesGroup,
    focusAfterReveal?: boolean,
  ) => void;
  readonly onFocusCapture: (event: FocusEvent<HTMLDivElement>) => void;
  readonly focusedRow: FocusedRowIdentity | null;
  readonly notices: readonly RemoteControlChangedFilesNotice[];
}): JSX.Element {
  const windowRef = useRef<HTMLDivElement>(null);
  const [sentinel, setSentinel] = useState<HTMLButtonElement | null>(null);
  const progressRef = useRef<ScrollProgress>({
    lastScrollTop: scrollElement.scrollTop,
    forward: 0,
    lastReveal: 0,
  });
  const scrollEventPendingRef = useRef(false);
  const ignoredCorrectionScrollTopRef = useRef<number | null>(null);
  const correctionResetFrameRef = useRef<number | null>(null);
  const sentinelIntersectsRef = useRef(false);
  const sentinelObservedRef = useRef(false);
  const latchedRevealRef = useRef(new Set<string>());
  const scrollMargin = useScrollMargin(windowRef, scrollElement);
  const itemBudget = budgets[lastGroup];
  const mayReveal = items[items.length - 1]?.kind === 'show-more';
  const revealMore = useCallback(
    (group: ChangedFilesGroup, focusAfterReveal = true): void => {
      // Manual reveals and automatic reveals both establish the new baseline.
      // A page inserted before the last group must not consume that group's
      // budget just because its sentinel is still intersecting.
      progressRef.current.lastReveal = progressRef.current.forward;
      onRevealMore(group, focusAfterReveal);
    },
    [onRevealMore],
  );
  const maybeAutoReveal = useCallback((): void => {
    if (
      sentinel === null ||
      !sentinel.isConnected ||
      !sentinelObservedRef.current ||
      !sentinelIntersectsRef.current ||
      !mayReveal
    ) {
      return;
    }
    const progress = progressRef.current.forward;
    if (progress <= progressRef.current.lastReveal) return;
    const latchKey = `${scopeKey}\u001f${lastGroup}\u001f${itemBudget}`;
    if (latchedRevealRef.current.has(latchKey)) return;
    latchedRevealRef.current.add(latchKey);
    const shouldReturnFocus =
      sentinel?.ownerDocument.activeElement === sentinel;
    revealMore(lastGroup, shouldReturnFocus);
  }, [itemBudget, lastGroup, mayReveal, revealMore, scopeKey, sentinel]);
  const maybeAutoRevealRef = useRef(maybeAutoReveal);
  useLayoutEffect((): void => {
    maybeAutoRevealRef.current = maybeAutoReveal;
  }, [maybeAutoReveal]);

  useEffect(() => {
    const view = scrollElement.ownerDocument.defaultView;
    if (correctionResetFrameRef.current !== null && view !== null) {
      view.cancelAnimationFrame(correctionResetFrameRef.current);
    }
    correctionResetFrameRef.current = null;
    ignoredCorrectionScrollTopRef.current = null;
    progressRef.current = {
      lastScrollTop: scrollElement.scrollTop,
      forward: 0,
      lastReveal: 0,
    };
    sentinelIntersectsRef.current = false;
    latchedRevealRef.current.clear();
    return (): void => {
      if (correctionResetFrameRef.current !== null && view !== null) {
        view.cancelAnimationFrame(correctionResetFrameRef.current);
      }
      correctionResetFrameRef.current = null;
    };
  }, [scopeKey, scrollElement]);

  useEffect(() => {
    const view = scrollElement.ownerDocument.defaultView;
    if (
      view === null ||
      sentinel === null ||
      typeof view.IntersectionObserver === 'undefined'
    ) {
      return undefined;
    }
    const observer = new view.IntersectionObserver(
      (entries): void => {
        if (!sentinelObservedRef.current || !sentinel.isConnected) return;
        sentinelIntersectsRef.current = entries.some(
          (entry) => entry.target === sentinel && entry.isIntersecting,
        );
        if (sentinelIntersectsRef.current) maybeAutoRevealRef.current();
      },
      { root: scrollElement, rootMargin: AUTO_REVEAL_ROOT_MARGIN },
    );
    sentinelObservedRef.current = true;
    observer.observe(sentinel);
    return (): void => {
      sentinelObservedRef.current = false;
      sentinelIntersectsRef.current = false;
      observer.disconnect();
    };
  }, [scrollElement, sentinel]);

  const focusedIndex = useMemo(
    () =>
      focusedRow === null
        ? -1
        : items.findIndex(
            (item) =>
              item.kind === 'file' && item.focusKey === focusedRow.focusKey,
          ),
    [focusedRow, items],
  );
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      const focusedItem = items[focusedIndex];
      if (focusedItem?.kind === 'file') {
        indexes.add(focusedIndex);
        for (const neighborIndex of [focusedIndex - 1, focusedIndex + 1]) {
          const neighbor = items[neighborIndex];
          if (
            neighbor?.kind === 'file' &&
            neighbor.group === focusedItem.group
          ) {
            indexes.add(neighborIndex);
          }
        }
      }
      return Array.from(indexes).sort((left, right) => left - right);
    },
    [focusedIndex, items],
  );
  const getItemKey = useCallback(
    (index: number): string => items[index]?.key ?? String(index),
    [items],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: (): HTMLElement => scrollElement,
    getItemKey,
    estimateSize: (): number => ESTIMATED_FILE_ITEM_HEIGHT,
    overscan: 12,
    scrollMargin,
    rangeExtractor,
    onChange: (_instance, sync): void => {
      // `sync` can also mean TanStack just corrected scrollTop after a
      // measurement. Do not treat that as user progress; suppress its matching
      // scroll event before the browser delivers it.
      if (sync && !scrollEventPendingRef.current) {
        const view = scrollElement.ownerDocument.defaultView;
        ignoredCorrectionScrollTopRef.current = scrollElement.scrollTop;
        if (correctionResetFrameRef.current !== null && view !== null) {
          view.cancelAnimationFrame(correctionResetFrameRef.current);
        }
        correctionResetFrameRef.current =
          view?.requestAnimationFrame((): void => {
            ignoredCorrectionScrollTopRef.current = null;
            correctionResetFrameRef.current = null;
          }) ?? null;
      }
    },
  });
  useEffect(() => {
    const onScrollCapture = (): void => {
      scrollEventPendingRef.current = true;
    };
    const onScroll = (): void => {
      const nextScrollTop = scrollElement.scrollTop;
      const progress = progressRef.current;
      scrollEventPendingRef.current = false;
      const correctionScrollTop = ignoredCorrectionScrollTopRef.current;
      if (
        correctionScrollTop !== null &&
        Math.abs(nextScrollTop - correctionScrollTop) < 1.5
      ) {
        ignoredCorrectionScrollTopRef.current = null;
        progress.lastScrollTop = nextScrollTop;
        return;
      }
      ignoredCorrectionScrollTopRef.current = null;
      if (nextScrollTop > progress.lastScrollTop) {
        progress.forward += nextScrollTop - progress.lastScrollTop;
      }
      progress.lastScrollTop = nextScrollTop;
      maybeAutoRevealRef.current();
    };
    scrollElement.addEventListener('scroll', onScrollCapture, {
      capture: true,
      passive: true,
    });
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    return (): void => {
      scrollElement.removeEventListener('scroll', onScrollCapture, true);
      scrollElement.removeEventListener('scroll', onScroll);
    };
  }, [scrollElement]);
  const measure = useCallback(
    (element: HTMLDivElement | null): void => {
      if (element !== null) virtualizer.measureElement(element);
    },
    [virtualizer],
  );
  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div
      ref={windowRef}
      className="relative"
      onFocusCapture={onFocusCapture}
      style={{
        height: virtualizer.getTotalSize(),
      }}
    >
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (item === undefined) return null;
        return (
          <div
            key={item.key}
            ref={measure}
            data-index={virtualItem.index}
            className={item.kind === 'heading' ? 'flow-root' : undefined}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              boxSizing: 'border-box',
              paddingTop: item.topSpacing,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            {renderChangedFilesItem(
              item,
              notices,
              handlers,
              revealMore,
              lastGroup,
              focusedRow,
              setSentinel,
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChangedFilesLargeBody(props: ChangedFilesListProps): JSX.Element {
  const {
    uncommitted,
    committed,
    notices,
    hasMore,
    loadingMore,
    totals,
    budgets,
    truncated,
    scrollable,
    scopeKey,
    onRevealMore,
    onFocusRow,
    focusedRow,
    onBlurCapture,
    ...handlers
  } = props;
  const loadMore = handlers.onLoadMore;
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const ancestorScroller = useAncestorScrollElement(listElement, !scrollable);
  const scrollElement = scrollable ? viewportElement : ancestorScroller;
  const lastGroup: ChangedFilesGroup =
    committed.length > 0 || hasMore?.committed === true
      ? 'committed'
      : 'uncommitted';
  const items = useMemo((): ChangedFilesListItem[] => {
    const flattened: ChangedFilesListItem[] = [];
    if (notices.length > 0) {
      flattened.push({ kind: 'notices', key: 'notices', topSpacing: 0 });
    }
    let groupTopSpacing = notices.length > 0 ? 8 : 0;
    const addGroup = (
      group: ChangedFilesGroup,
      label: string,
      files: readonly ChangedFileRow[],
      budget: number,
      showHeading: boolean,
    ): void => {
      const total = totals[group] ?? files.length;
      const canLoadMore = hasMore?.[group] === true && loadMore !== undefined;
      if (files.length === 0 && total === 0 && !canLoadMore) return;
      const shouldShowHeading =
        showHeading || (totals[group] !== undefined && total > 0);
      if (shouldShowHeading) {
        flattened.push({
          kind: 'heading',
          key: `heading:${group}`,
          group,
          label,
          total,
          budget,
          truncated,
          exactTotal: totals[group] !== undefined,
          topSpacing: groupTopSpacing,
        });
      }
      files.slice(0, budget).forEach((file, index) => {
        flattened.push({
          kind: 'file',
          key: changedFileRowKey(file),
          group,
          file,
          focusKey: changedFileFocusKey(group, file),
          topSpacing: !shouldShowHeading && index === 0 ? groupTopSpacing : 0,
        });
      });
      const hasLocalRowsToReveal = files.length > budget;
      const shouldLoadMore = !hasLocalRowsToReveal && canLoadMore;
      if (hasLocalRowsToReveal || shouldLoadMore) {
        flattened.push({
          kind: 'show-more',
          key: `more:${group}`,
          group,
          label,
          total,
          moreCount: hasLocalRowsToReveal
            ? Math.min(REVEAL_PAGE_SIZE, files.length - budget)
            : Math.max(0, total - files.length),
          // A paged group counts rows still on the desktop, not just loaded ones.
          remaining: hasLocalRowsToReveal
            ? total - budget
            : Math.max(0, total - files.length),
          loadMore: shouldLoadMore,
          loading: shouldLoadMore && loadingMore?.[group] === true,
          topSpacing: 8,
        });
      }
      groupTopSpacing = 8;
    };

    addGroup(
      'uncommitted',
      'Uncommitted',
      uncommitted,
      budgets.uncommitted,
      committed.length > 0 || hasMore?.committed === true,
    );
    addGroup('committed', 'Committed', committed, budgets.committed, true);
    return flattened;
  }, [
    hasMore,
    loadMore,
    loadingMore,
    budgets.committed,
    budgets.uncommitted,
    committed,
    notices,
    totals,
    truncated,
    uncommitted,
  ]);

  const onFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      const target = event.target;
      const HTMLElementConstructor =
        event.currentTarget.ownerDocument.defaultView?.HTMLElement;
      if (
        HTMLElementConstructor === undefined ||
        !(target instanceof HTMLElementConstructor)
      ) {
        onFocusRow(null);
        return;
      }
      const row = target.closest<HTMLElement>('[data-focus-key]');
      if (row === null) {
        onFocusRow(null);
        return;
      }
      const focusKey = row.getAttribute('data-focus-key');
      const rowKey = row.getAttribute('data-row-key');
      if (focusKey === null || rowKey === null) {
        onFocusRow(null);
        return;
      }
      const item = items.find(
        (candidate): candidate is ChangedFilesRowItem =>
          candidate.kind === 'file' &&
          candidate.focusKey === focusKey &&
          candidate.key === rowKey,
      );
      if (item === undefined) {
        onFocusRow(null);
        return;
      }
      onFocusRow(focusedRowIdentity(item.group, item.file));
    },
    [items, onFocusRow],
  );

  useLayoutEffect((): void => {
    if (focusedRow === null) return;
    const exactItem = items.find(
      (item): item is ChangedFilesRowItem =>
        item.kind === 'file' && item.focusKey === focusedRow.focusKey,
    );
    const sameGroupItems = items.filter(
      (item): item is ChangedFilesRowItem =>
        item.kind === 'file' && item.group === focusedRow.group,
    );
    const sameRepositoryItems = sameGroupItems.filter(
      (item) => item.file.repoId === focusedRow.repoId,
    );
    const candidates =
      sameRepositoryItems.length > 0 ? sameRepositoryItems : sameGroupItems;
    const adjacentItem =
      candidates.find(
        (item) => item.file.filePath.localeCompare(focusedRow.filePath) >= 0,
      ) ?? candidates[candidates.length - 1];
    const nextVisibleItem = items.find(
      (item): item is ChangedFilesRowItem => item.kind === 'file',
    );
    const nextItem = exactItem ?? adjacentItem ?? nextVisibleItem;
    if (
      nextItem === undefined ||
      (exactItem !== undefined && exactItem.key === focusedRow.rowKey)
    ) {
      return;
    }

    onFocusRow(focusedRowIdentity(nextItem.group, nextItem.file));
  }, [focusedRow, items, onFocusRow]);

  // Load more replaces its button with a status, so focus goes to the first
  // loaded row once it arrives, as Show more focuses the first revealed row.
  const pendingLoadFocusRef = useRef<{
    readonly group: ChangedFilesGroup;
    readonly index: number;
    sawLoading: boolean;
  } | null>(null);
  useEffect((): void => {
    const pending = pendingLoadFocusRef.current;
    if (pending === null) return;
    const loading = loadingMore?.[pending.group] === true;
    pending.sawLoading ||= loading;
    const files = pending.group === 'uncommitted' ? uncommitted : committed;
    const firstLoaded = files[pending.index];
    if (firstLoaded === undefined) {
      // The load ended without new rows (a stale cursor or a failure).
      if (pending.sawLoading && !loading) pendingLoadFocusRef.current = null;
      return;
    }
    if (budgets[pending.group] <= pending.index) {
      onRevealMore(pending.group);
      return;
    }
    pendingLoadFocusRef.current = null;
    onFocusRow(focusedRowIdentity(pending.group, firstLoaded));
  }, [budgets, committed, loadingMore, onFocusRow, onRevealMore, uncommitted]);
  useEffect((): void => {
    pendingLoadFocusRef.current = null;
  }, [scopeKey]);

  const revealMore = useCallback(
    (group: ChangedFilesGroup, focusAfterReveal = true): void => {
      const files = group === 'uncommitted' ? uncommitted : committed;
      const currentBudget = budgets[group];
      if (files.length <= currentBudget) {
        if (hasMore?.[group] === true && loadMore !== undefined) {
          pendingLoadFocusRef.current = focusAfterReveal
            ? { group, index: files.length, sawLoading: false }
            : null;
          loadMore(group);
        }
        return;
      }
      if (focusAfterReveal) {
        const firstRevealedFile = files[currentBudget];
        if (firstRevealedFile !== undefined) {
          onFocusRow(focusedRowIdentity(group, firstRevealedFile));
        }
      }
      onRevealMore(group);
    },
    [
      budgets,
      committed,
      loadMore,
      hasMore,
      onFocusRow,
      onRevealMore,
      uncommitted,
    ],
  );

  const isVirtualized = scrollElement !== null;
  const fallbackContent = (
    <div onFocusCapture={onFocusCapture}>
      {items.map((item) => (
        <div
          key={item.key}
          className={item.kind === 'heading' ? 'flow-root' : undefined}
          style={{ paddingTop: item.topSpacing }}
        >
          {renderChangedFilesItem(
            item,
            notices,
            handlers,
            revealMore,
            lastGroup,
            focusedRow,
          )}
        </div>
      ))}
    </div>
  );
  const renderedContent =
    scrollElement === null ? (
      fallbackContent
    ) : (
      <VirtualizedChangedFilesItems
        items={items}
        scrollElement={scrollElement}
        scopeKey={scopeKey}
        budgets={budgets}
        lastGroup={lastGroup}
        handlers={handlers}
        onRevealMore={revealMore}
        onFocusCapture={onFocusCapture}
        focusedRow={focusedRow}
        notices={notices}
      />
    );

  if (scrollable) {
    return (
      <ChangedFilesBody
        scrollable
        virtualized={isVirtualized}
        viewportRef={setViewportElement}
        onBlurCapture={onBlurCapture}
      >
        {renderedContent}
      </ChangedFilesBody>
    );
  }

  return (
    <ChangedFilesBody
      scrollable={false}
      bodyRef={setListElement}
      virtualized={isVirtualized}
      onBlurCapture={onBlurCapture}
    >
      {renderedContent}
    </ChangedFilesBody>
  );
}

export function ChangedFilesSection({
  changedFiles,
  canRevert = false,
  onSelectFile,
  onFileClick,
  onFileContextMenu,
  onRevertFile,
  workspaceLocalId,
  worktreeLocalId,
  showRepoName = false,
  emptyState = (
    <p
      className="text-xs fg-secondary"
      data-testid="activity-changed-files-empty"
    >
      No changed files.
    </p>
  ),
  scrollable = true,
  openDataTestId,
  hasMore: requestedHasMore,
  loadingMore,
  onLoadMore,
}: ChangedFilesSectionProps): JSX.Element {
  const page = changedFiles?.page;
  const uncommittedSource = changedFiles?.uncommitted ?? EMPTY_FILES;
  const committedSource = changedFiles?.committed ?? EMPTY_FILES;
  const uncommitted = useMemo(
    (): ChangedFileRow[] =>
      [...uncommittedSource]
        .sort(
          page === undefined
            ? (left, right): number =>
                left.filePath.localeCompare(right.filePath)
            : compareChangedFileIdentity,
        )
        .map((file): ChangedFileRow => ({ ...file, source: 'uncommitted' })),
    [page, uncommittedSource],
  );
  const committed = useMemo(
    (): ChangedFileRow[] =>
      [...committedSource]
        .sort(
          page === undefined
            ? (left, right): number =>
                left.filePath.localeCompare(right.filePath)
            : compareChangedFileIdentity,
        )
        .map((file): ChangedFileRow => ({ ...file, source: 'committed' })),
    [committedSource, page],
  );
  const hasMore = useMemo(
    () =>
      requestedHasMore ??
      (page
        ? {
            uncommitted: page.uncommitted.nextCursor !== undefined,
            committed: page.committed.nextCursor !== undefined,
          }
        : undefined),
    [page, requestedHasMore],
  );
  const hasMorePages =
    hasMore?.uncommitted === true || hasMore?.committed === true;
  const hasIncompletePages =
    hasMorePages ||
    (page !== undefined &&
      (uncommitted.length < page.uncommitted.total ||
        committed.length < page.committed.total));
  const notices = (changedFiles?.notices ?? EMPTY_NOTICES).filter(
    (notice) =>
      notice.kind !== 'truncated' || page === undefined || hasIncompletePages,
  );
  const truncated =
    page === undefined && notices.some((notice) => notice.kind === 'truncated');
  const totals = useMemo(
    () =>
      page
        ? {
            uncommitted: page.uncommitted.total,
            committed: page.committed.total,
          }
        : {},
    [page],
  );
  const scopeKey = `${workspaceLocalId ?? ''}\u001f${worktreeLocalId ?? ''}`;
  const [storedBudgets, setStoredBudgets] = useState<RevealBudgets>(() => ({
    scopeKey,
    uncommitted: REVEAL_PAGE_SIZE,
    committed: REVEAL_PAGE_SIZE,
  }));
  const budgets = useMemo(
    () =>
      storedBudgets.scopeKey === scopeKey
        ? storedBudgets
        : {
            scopeKey,
            uncommitted: REVEAL_PAGE_SIZE,
            committed: REVEAL_PAGE_SIZE,
          },
    [scopeKey, storedBudgets],
  );
  const [focusedRow, setFocusedRow] = useState<FocusedRowIdentity | null>(null);

  useEffect((): void => {
    setStoredBudgets((previous) =>
      previous.scopeKey === scopeKey
        ? previous
        : {
            scopeKey,
            uncommitted: REVEAL_PAGE_SIZE,
            committed: REVEAL_PAGE_SIZE,
          },
    );
    setFocusedRow(null);
  }, [scopeKey]);

  useEffect((): void => {
    if (uncommitted.length > 0 || committed.length > 0) return;
    setFocusedRow(null);
  }, [committed.length, uncommitted.length]);

  const onRevealMore = useCallback(
    (group: ChangedFilesGroup): void => {
      const groupFiles = group === 'uncommitted' ? uncommitted : committed;
      if (groupFiles.length <= budgets[group]) {
        if (hasMore?.[group] === true) onLoadMore?.(group);
        return;
      }
      setStoredBudgets((previous) => {
        const current =
          previous.scopeKey === scopeKey
            ? previous
            : {
                scopeKey,
                uncommitted: REVEAL_PAGE_SIZE,
                committed: REVEAL_PAGE_SIZE,
              };
        return {
          ...current,
          [group]: current[group] + REVEAL_PAGE_SIZE,
        };
      });
    },
    [budgets, committed, hasMore, onLoadMore, scopeKey, uncommitted],
  );
  const onFocusRow = useCallback(
    (focus: FocusedRowIdentity | null): void => {
      if (
        (focus === null && focusedRow === null) ||
        (focus !== null &&
          focusedRow?.focusKey === focus.focusKey &&
          focusedRow.rowKey === focus.rowKey)
      ) {
        return;
      }
      setFocusedRow(focus);
    },
    [focusedRow],
  );
  const onBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      const relatedTarget = event.relatedTarget;
      const NodeConstructor =
        event.currentTarget.ownerDocument.defaultView?.Node;
      if (
        NodeConstructor !== undefined &&
        relatedTarget instanceof NodeConstructor &&
        event.currentTarget.contains(relatedTarget)
      ) {
        return;
      }
      onFocusRow(null);
    },
    [onFocusRow],
  );

  const handlers: ChangedFilesListHandlers = {
    canRevert,
    workspaceLocalId,
    worktreeLocalId,
    showRepoName,
    onSelectFile,
    onFileClick,
    onFileContextMenu,
    onRevertFile,
    onLoadMore,
    openDataTestId,
  };

  const noticeList = (
    <ChangedFilesNotices notices={notices} showRepoName={showRepoName} />
  );

  if (
    uncommitted.length === 0 &&
    committed.length === 0 &&
    page === undefined
  ) {
    // A notice explains an incomplete answer; "no changed files" would claim
    // a complete one.
    return notices.length > 0 ? (
      <Stack gap="inline" data-testid="activity-changed-files">
        {noticeList}
      </Stack>
    ) : (
      <>{emptyState}</>
    );
  }

  if (
    page !== undefined ||
    uncommitted.length + committed.length > VIRTUALIZE_THRESHOLD
  ) {
    return (
      <ChangedFilesLargeBody
        uncommitted={uncommitted}
        committed={committed}
        notices={notices}
        hasMore={hasMore}
        loadingMore={loadingMore}
        totals={totals}
        budgets={budgets}
        truncated={truncated}
        scrollable={scrollable}
        scopeKey={scopeKey}
        onRevealMore={onRevealMore}
        onFocusRow={onFocusRow}
        focusedRow={focusedRow}
        onBlurCapture={onBlurCapture}
        {...handlers}
      />
    );
  }

  return (
    <ChangedFilesBody scrollable={scrollable} onBlurCapture={onBlurCapture}>
      {noticeList}
      {uncommitted.length > 0 && (
        <div>
          {committed.length > 0 && (
            <div className="pb-1 px-3">
              <Heading level={4} variant="label">
                Uncommitted
              </Heading>
            </div>
          )}
          {uncommitted.map((file) => (
            <FileRow
              key={changedFileRowKey(file)}
              file={file}
              canRevert={canRevert}
              onSelectFile={onSelectFile}
              onFileClick={onFileClick}
              onFileContextMenu={onFileContextMenu}
              onRevertFile={onRevertFile}
              workspaceLocalId={workspaceLocalId}
              worktreeLocalId={worktreeLocalId}
              showRepoName={showRepoName}
              openDataTestId={openDataTestId}
              focusOnMount={
                focusedRow?.focusKey ===
                changedFileFocusKey('uncommitted', file)
              }
              onFocus={(): void =>
                onFocusRow(focusedRowIdentity('uncommitted', file))
              }
            />
          ))}
        </div>
      )}
      {committed.length > 0 && (
        <div>
          <div className="pb-1 px-3">
            <Heading level={4} variant="label">
              Committed
            </Heading>
          </div>
          {committed.map((file) => (
            <FileRow
              key={changedFileRowKey(file)}
              file={file}
              canRevert={false}
              onSelectFile={onSelectFile}
              onFileClick={onFileClick}
              onFileContextMenu={onFileContextMenu}
              workspaceLocalId={workspaceLocalId}
              worktreeLocalId={worktreeLocalId}
              showRepoName={showRepoName}
              openDataTestId={openDataTestId}
              focusOnMount={
                focusedRow?.focusKey === changedFileFocusKey('committed', file)
              }
              onFocus={(): void =>
                onFocusRow(focusedRowIdentity('committed', file))
              }
            />
          ))}
        </div>
      )}
    </ChangedFilesBody>
  );
}
