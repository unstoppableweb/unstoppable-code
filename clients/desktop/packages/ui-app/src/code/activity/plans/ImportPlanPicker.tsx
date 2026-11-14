import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { derivePlanTitle } from '@canopy/protocol/plans';
import {
  Badge,
  Button,
  DelayedLoadingPlaceholder,
  DialogModal,
  Disclosure,
  ErrorState,
  HighlightedSegments,
  SearchField,
  Skeleton,
  Surface,
  splitMatchSegments,
} from '@canopy/ui-shared/components';
import { formatShortcut } from '@canopy/ui-shared/lib/shortcuts';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';

/** One importable file from the host's file index, already ranked. */
export interface ImportPlanFileRow {
  readonly key: string;
  readonly filename: string;
  readonly relativePath: string;
  readonly repoId: string;
  readonly repoName: string;
  readonly filenameMatchedIndices: readonly number[];
  readonly pathMatchedIndices: readonly number[];
  /** Set when this file is already a tracked plan; the row opens it instead. */
  readonly trackedPlanId?: string;
}

/** A plan file an agent wrote in a chat, detected by the host. */
export interface ImportPlanSuggestion {
  readonly id: string;
  readonly sourceRepoId: string;
  readonly sourceFilePath: string;
  /** Title of the chat the file was detected in, when that chat still exists. */
  readonly chatTitle?: string;
  readonly trackedPlanId?: string;
}

export type ImportPlanPickerItem =
  | { readonly kind: 'suggestion'; readonly suggestion: ImportPlanSuggestion }
  | { readonly kind: 'file'; readonly file: ImportPlanFileRow };

export type ImportPlanPickerGroup = 'suggestions' | 'files';

/** An option row's layout, shared by the listbox options and their skeleton. */
const OPTION_ROW_CLASS =
  'flex min-w-0 flex-1 items-center justify-between gap-3 px-6 py-2 text-left';

/** A group's label above its options. */
const GROUP_LABEL_CLASS = 'px-6 pb-1 pt-2 text-2xs font-medium fg-secondary';

/** A file option's name, path and repository. */
function FileOptionContent({
  file,
}: {
  readonly file: ImportPlanFileRow;
}): JSX.Element {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-s font-medium">
          <HighlightedSegments
            segments={splitMatchSegments(
              file.filename,
              file.filenameMatchedIndices,
            )}
          />
        </div>
        <div className="mt-0.5 truncate text-xs fg-secondary">
          <HighlightedSegments
            segments={splitMatchSegments(
              file.relativePath,
              file.pathMatchedIndices,
            )}
          />
        </div>
      </div>
      <span className="text-2xs fg-tertiary">{file.repoName}</span>
    </>
  );
}

function sampleFile(filename: string, relativePath: string): ImportPlanFileRow {
  return {
    key: `import-plan-skeleton-${filename}`,
    filename,
    relativePath,
    repoId: 'import-plan-skeleton',
    repoName: 'app',
    filenameMatchedIndices: [],
    pathMatchedIndices: [],
  };
}

/** Plain plan files the loading skeleton measures. */
const SAMPLE_FILES: readonly ImportPlanFileRow[] = [
  sampleFile('plan.md', 'docs/plan.md'),
  sampleFile('roadmap.md', 'docs/roadmap.md'),
  sampleFile('notes.txt', 'notes.txt'),
];

export interface ImportPlanPickerProps {
  /** Pending suggestions in display order, already filtered by `query`. */
  readonly suggestions: readonly ImportPlanSuggestion[];
  /** Suggestions the user hid; listed collapsed at the end. */
  readonly hiddenSuggestions: readonly ImportPlanSuggestion[];
  readonly files: readonly ImportPlanFileRow[];
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** The file list is loading; suggestions still render. */
  readonly loading: boolean;
  readonly error?: string | null;
  /** An import is running; every import path is inert until it settles. */
  readonly importing: boolean;
  readonly onImport: (item: ImportPlanPickerItem) => void;
  readonly onOpenTracked: (planId: string) => void;
  readonly onDismissSuggestion: (suggestion: ImportPlanSuggestion) => void;
  readonly onBrowse: () => void;
  readonly onClose: () => void;
  /** Read the selected file for the preview; `null` when unavailable. */
  readonly loadPreview?: (item: ImportPlanPickerItem) => Promise<string | null>;
  readonly onSelectedGroupChange?: (
    group: ImportPlanPickerGroup | null,
  ) => void;
}

const PREVIEW_DEBOUNCE_MS = 150;
const COPY_NOTICE =
  "Saves a copy. Later edits to the file don't update the plan.";
const BENEFITS = [
  'Review and comment on it',
  'Keep revisions as it changes',
  'Implement it or run a pipeline',
] as const;

function itemKey(item: ImportPlanPickerItem): string {
  return item.kind === 'suggestion'
    ? `suggestion:${item.suggestion.id}`
    : `file:${item.file.key}`;
}

function itemPath(item: ImportPlanPickerItem): string {
  return item.kind === 'suggestion'
    ? item.suggestion.sourceFilePath
    : item.file.relativePath;
}

function itemTrackedPlanId(item: ImportPlanPickerItem): string | undefined {
  return item.kind === 'suggestion'
    ? item.suggestion.trackedPlanId
    : item.file.trackedPlanId;
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '';
}

type PreviewState =
  | { readonly key: string; readonly status: 'loading' }
  | { readonly key: string; readonly status: 'ready'; readonly title: string }
  | { readonly key: string; readonly status: 'unavailable' };

/**
 * Read the selected row's file for its preview title. Debounced so arrowing
 * through the list reads only the row it stops on; a response for a row that
 * is no longer selected is dropped. The effect keys on the row, not the item
 * object rebuilt with each list, and reads the item through a ref.
 */
function usePlanPreview(
  item: ImportPlanPickerItem | null,
  key: string | null,
  loadPreview: ImportPlanPickerProps['loadPreview'],
): PreviewState | null {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const itemRef = useRef(item);
  useEffect(() => {
    itemRef.current = item;
  });
  useEffect(() => {
    const current = itemRef.current;
    if (!current || key === null || !loadPreview) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ key, status: 'loading' });
    const timer = setTimeout((): void => {
      loadPreview(current)
        .then((content): void => {
          if (cancelled) return;
          setPreview(
            content && content.trim().length > 0
              ? { key, status: 'ready', title: derivePlanTitle(content) }
              : { key, status: 'unavailable' },
          );
        })
        .catch((): void => {
          if (!cancelled) setPreview({ key, status: 'unavailable' });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return (): void => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, loadPreview]);
  return preview;
}

/**
 * What importing the selected file gives: the plan title it will get (file
 * content, so replay-blocked), its path, the benefits, and the copy notice.
 */
function PreviewPane({
  item,
  title,
}: {
  readonly item: ImportPlanPickerItem;
  readonly title: string | undefined;
}): JSX.Element {
  const path = itemPath(item);
  return (
    <Surface
      as="aside"
      variant="section"
      boundary="left"
      data-testid="import-plan-preview"
      aria-label="Preview"
      className="hidden w-72 shrink-0 flex-col md:flex"
    >
      <div className="flex flex-col gap-3 py-3 pl-4 pr-6">
        <div className="min-w-0">
          {title !== undefined ? (
            <div
              data-testid="import-plan-preview-title"
              className={`line-clamp-2 text-s font-semibold fg-primary ${REPLAY_BLOCK_CLASS}`}
            >
              {title}
            </div>
          ) : (
            <div className="truncate text-s font-semibold fg-primary">
              {baseName(path)}
            </div>
          )}
          <div
            data-testid="import-plan-preview-path"
            className="mt-0.5 break-all text-xs fg-secondary"
          >
            {path}
          </div>
        </div>
        <ul className="flex flex-col gap-1 text-xs fg-primary">
          {BENEFITS.map((benefit) => (
            <li key={benefit}>{benefit}</li>
          ))}
        </ul>
        {/* Opening a tracked plan copies nothing. */}
        {itemTrackedPlanId(item) ? null : (
          <p
            data-testid="import-plan-copy-notice"
            className="text-xs fg-secondary"
          >
            {COPY_NOTICE}
          </p>
        )}
      </div>
    </Surface>
  );
}

/**
 * The import-plan picker: suggestions agents wrote in chats first, then every
 * importable file, a preview of the selected one, and an explicit import
 * action. Hosts own the file index, the import, and the preview read.
 */
export function ImportPlanPicker({
  suggestions,
  hiddenSuggestions,
  files,
  query,
  onQueryChange,
  loading,
  error,
  importing,
  onImport,
  onOpenTracked,
  onDismissSuggestion,
  onBrowse,
  onClose,
  loadPreview,
  onSelectedGroupChange,
}: ImportPlanPickerProps): JSX.Element {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const items = useMemo<ImportPlanPickerItem[]>(
    () => [
      ...suggestions.map(
        (suggestion): ImportPlanPickerItem => ({
          kind: 'suggestion',
          suggestion,
        }),
      ),
      ...files.map((file): ImportPlanPickerItem => ({ kind: 'file', file })),
    ],
    [files, suggestions],
  );

  // Keep the user's selection while it is still listed; otherwise select the
  // first row, which is the first suggestion or, without one, the first file.
  // Suggestions that load after the files therefore take the selection.
  const selectedItem = useMemo(
    () =>
      items.find((item) => itemKey(item) === selectedKey) ?? items[0] ?? null,
    [items, selectedKey],
  );
  const selectedItemKey = selectedItem ? itemKey(selectedItem) : null;
  const listboxId = `${titleId}-listbox`;
  const optionIds = useMemo(
    () =>
      new Map(
        items.map((item, index) => [
          itemKey(item),
          `${listboxId}-option-${String(index)}`,
        ]),
      ),
    [items, listboxId],
  );
  const selectedTrackedPlanId = selectedItem
    ? itemTrackedPlanId(selectedItem)
    : undefined;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Disabling the control that started an import would drop focus to the
  // page, where Escape no longer reaches the dialog.
  useEffect(() => {
    if (importing) inputRef.current?.focus();
  }, [importing]);

  useEffect(() => {
    if (selectedItemKey === null) return;
    optionRefs.current
      .get(selectedItemKey)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedItemKey]);

  const selectedGroup: ImportPlanPickerGroup | null = selectedItem
    ? selectedItem.kind === 'suggestion'
      ? 'suggestions'
      : 'files'
    : null;
  useEffect(() => {
    onSelectedGroupChange?.(selectedGroup);
  }, [onSelectedGroupChange, selectedGroup]);

  const preview = usePlanPreview(selectedItem, selectedItemKey, loadPreview);

  function runPrimary(item: ImportPlanPickerItem | null): void {
    if (!item || importing) return;
    const trackedPlanId = itemTrackedPlanId(item);
    if (trackedPlanId) {
      onOpenTracked(trackedPlanId);
      return;
    }
    onImport(item);
  }

  function moveSelection(delta: 1 | -1): void {
    if (items.length === 0) return;
    const current = selectedItem ? items.indexOf(selectedItem) : -1;
    const next = Math.min(items.length - 1, Math.max(0, current + delta));
    setSelectedKey(itemKey(items[next]));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // An IME composition owns Escape, the arrow keys and Enter until it ends,
    // so its Escape must not reach the dialog's own Escape either.
    if (event.nativeEvent.isComposing) {
      if (event.key === 'Escape') event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    const target = event.target;
    const fromList =
      target === inputRef.current ||
      (target instanceof HTMLElement &&
        target.getAttribute('role') === 'option');
    if (!fromList) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runPrimary(selectedItem);
    }
  }

  function renderOption(
    item: ImportPlanPickerItem,
    content: JSX.Element,
    testId: string,
  ): JSX.Element {
    const key = itemKey(item);
    const selected = key === selectedItemKey;
    return (
      // Options stay out of the Tab order: the search box owns keyboard
      // selection. While importing they are aria-disabled, not disabled, so a
      // focused row keeps focus and Escape still reaches the dialog. The
      // selected row is the combobox's active descendant, its keyboard focus,
      // so it keeps DESIGN.md's focus highlight rather than a checkmark.
      <button
        type="button"
        role="option"
        id={optionIds.get(key)}
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={importing || undefined}
        data-testid={testId}
        ref={(node): void => {
          if (node) optionRefs.current.set(key, node);
          else optionRefs.current.delete(key);
        }}
        onClick={(): void => {
          if (!importing) setSelectedKey(key);
        }}
        onDoubleClick={(): void => runPrimary(item)}
        className={`${OPTION_ROW_CLASS} transition-colors aria-disabled:opacity-50 ${
          selected
            ? 'bg-accent-subtle fg-accent-strong'
            : 'fg-primary hover:bg-secondary'
        }`}
      >
        {content}
        {itemTrackedPlanId(item) ? (
          <Badge tone="success" data-testid="import-plan-tracked-badge">
            Tracked
          </Badge>
        ) : null}
      </button>
    );
  }

  const hasRows = items.length > 0;
  const showFilesLoading = loading && files.length === 0;
  const showEmpty = !hasRows && !showFilesLoading && !error;

  return (
    <DialogModal
      onClose={onClose}
      title="Import plan"
      subtitle="Turn a Markdown or text file into a tracked plan."
      titleId={titleId}
      dataTestId="import-plan-modal"
      maxWidth="4xl"
      placement="top"
      inset="flush"
      scrollableBody={false}
      headerActions={
        <Button
          type="button"
          variant="secondary"
          size="compact"
          data-testid="import-plan-browse"
          disabled={importing}
          onClick={onBrowse}
        >
          Browse…
        </Button>
      }
      footer={
        <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5 text-xs fg-secondary">
            {selectedTrackedPlanId ? null : (
              <p className="md:hidden">{COPY_NOTICE}</p>
            )}
            <p data-testid="import-plan-hint">
              Or tell your agent{' '}
              <span className="font-mono fg-primary/80">
                {'"Import @<file> as a plan"'}
              </span>
            </p>
          </div>
          <Button
            variant="primary"
            size="compact"
            data-testid="import-plan-primary"
            disabled={importing || !selectedItem}
            shortcut={formatShortcut('list-open')}
            onClick={(): void => runPrimary(selectedItem)}
          >
            {selectedTrackedPlanId ? 'Open plan' : 'Import plan'}
          </Button>
        </div>
      }
    >
      {/* The palette's own keys (arrows, Enter, Escape) are handled here, so
          the field never clears on Escape and an IME composition keeps them. */}
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
        <Surface variant="section" boundary="bottom">
          <div className="px-6 py-3">
            <SearchField
              ref={inputRef}
              size="lg"
              clearOnEscape={false}
              value={query}
              onValueChange={onQueryChange}
              placeholder="Search files (.md or .txt)…"
              aria-label="Search plan files"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={hasRows}
              aria-controls={hasRows ? listboxId : undefined}
              aria-activedescendant={
                selectedItemKey === null
                  ? undefined
                  : optionIds.get(selectedItemKey)
              }
              data-testid="import-plan-input"
            />
          </div>
        </Surface>

        <Surface
          variant="section"
          boundary="bottom"
          className="flex min-h-0 flex-1"
        >
          <div className="max-h-104 min-w-0 flex-1 overflow-y-auto">
            {hasRows && (
              <div
                role="listbox"
                id={listboxId}
                aria-label="Plan files"
                className="py-1"
              >
                {suggestions.length > 0 && (
                  <div
                    role="group"
                    aria-labelledby={`${titleId}-suggestions`}
                    data-testid="import-plan-suggestions-group"
                  >
                    <div
                      id={`${titleId}-suggestions`}
                      className="px-6 pb-1 pt-2 text-2xs font-medium fg-secondary"
                    >
                      From your chats
                    </div>
                    {suggestions.map((suggestion) => {
                      const item: ImportPlanPickerItem = {
                        kind: 'suggestion',
                        suggestion,
                      };
                      const directory = dirName(suggestion.sourceFilePath);
                      return (
                        <div
                          key={suggestion.id}
                          role="none"
                          className="group/suggestion flex items-center gap-2 pr-4"
                        >
                          {renderOption(
                            item,
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-s font-medium">
                                {baseName(suggestion.sourceFilePath)}
                              </div>
                              <div className="mt-0.5 truncate text-xs fg-secondary">
                                {directory}
                                {directory && suggestion.chatTitle && ' · '}
                                {/* Chat titles are user-authored. */}
                                {suggestion.chatTitle && (
                                  <>
                                    from{' '}
                                    <span className={REPLAY_MASK_CLASS}>
                                      {suggestion.chatTitle}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>,
                            `import-plan-detected-import-${suggestion.id}`,
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="compact"
                            data-testid={`import-plan-detected-dismiss-${suggestion.id}`}
                            disabled={importing}
                            onClick={(): void =>
                              onDismissSuggestion(suggestion)
                            }
                          >
                            Hide
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {files.length > 0 && (
                  <div
                    role="group"
                    aria-labelledby={`${titleId}-files`}
                    data-testid="import-plan-files-group"
                  >
                    <div id={`${titleId}-files`} className={GROUP_LABEL_CLASS}>
                      All files
                    </div>
                    {files.map((file) => (
                      <div key={file.key} role="none" className="flex">
                        {renderOption(
                          { kind: 'file', file },
                          <FileOptionContent file={file} />,
                          'import-plan-result',
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {showFilesLoading && (
              <DelayedLoadingPlaceholder slowNote="Still loading files…">
                <Skeleton
                  loading
                  label="Loading files"
                  testId="import-plan-files-loading"
                >
                  <div className="py-1">
                    <div className={GROUP_LABEL_CLASS}>All files</div>
                    {SAMPLE_FILES.map((file) => (
                      <div key={file.key} className="flex">
                        <div className={OPTION_ROW_CLASS}>
                          <FileOptionContent file={file} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Skeleton>
              </DelayedLoadingPlaceholder>
            )}
            {error && <ErrorState space="panel" message={error} />}
            {showEmpty && (
              <div
                className="px-6 py-8 text-center text-s fg-secondary"
                data-testid="import-plan-empty"
              >
                {query
                  ? 'No matches.'
                  : 'No plan files found. Use Browse… to pick any file.'}
              </div>
            )}
            {hiddenSuggestions.length > 0 && (
              <Surface variant="section" boundary="top">
                <div className="px-6 py-2">
                  <Disclosure
                    dataTestId="import-plan-dismissed-section"
                    label={`${hiddenSuggestions.length} hidden`}
                  >
                    <ul className="divide-y">
                      {hiddenSuggestions.map((suggestion) => (
                        <li
                          key={suggestion.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-s font-medium fg-primary">
                              {baseName(suggestion.sourceFilePath)}
                            </div>
                            <div className="mt-0.5 truncate text-xs fg-secondary">
                              {suggestion.sourceFilePath}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="compact"
                            data-testid={`import-plan-detected-import-${suggestion.id}`}
                            disabled={importing}
                            onClick={(): void =>
                              runPrimary({ kind: 'suggestion', suggestion })
                            }
                          >
                            {suggestion.trackedPlanId ? 'Open plan' : 'Import'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </div>
              </Surface>
            )}
          </div>

          {selectedItem && (
            <PreviewPane
              item={selectedItem}
              title={
                preview?.key === selectedItemKey && preview.status === 'ready'
                  ? preview.title
                  : undefined
              }
            />
          )}
        </Surface>
      </div>
    </DialogModal>
  );
}
