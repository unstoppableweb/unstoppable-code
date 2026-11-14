import { useState, type JSX, type ReactNode } from 'react';
import {
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  InlineDeleteConfirm,
  ListRowStatic,
  RowActionButton,
  RowActionTray,
  Skeleton,
} from '@canopy/ui-shared/components';
import { MentionIcon } from '@canopy/ui-shared/icons';
import {
  AttachmentIcon,
  DownloadIcon,
  EyeIcon,
  PlusMediumIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** One shared workspace file, as the list shows it. */
export interface WorkspaceFilesListRow {
  readonly id: string;
  readonly name: string;
  /** The line under the name. */
  readonly meta: string;
  /** Its saved copy is gone; the row says so. */
  readonly unavailable?: boolean;
}

/**
 * The actions a host offers on each row. A row shows only the actions its
 * host passes, so a host that can only list files shows plain rows.
 */
export interface WorkspaceFilesListActions {
  readonly onOpen?: (id: string) => void;
  readonly onMention?: (id: string) => void;
  readonly onDownload?: (id: string) => void;
  readonly onReplace?: (id: string) => void;
  /** Resolves true once the file is removed, which closes the confirmation. */
  readonly onRemove?: (id: string) => Promise<boolean>;
}

export interface WorkspaceFilesListProps extends WorkspaceFilesListActions {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly WorkspaceFilesListRow[];
  readonly onRetry: () => void;
  /** The empty state's second line: how files get here on this host. */
  readonly emptySubtitle: string;
  /** Replaces the empty state, such as while shared files are recovered. */
  readonly notice?: ReactNode;
  /** An action's failure, shown above the list. */
  readonly error?: string | null;
  /** An action is running: row actions that change files are disabled. */
  readonly busy?: boolean;
  /** Said while `busy`. */
  readonly busyLabel?: string;
  /** Host-only controls right after the description, such as a file input. */
  readonly children?: ReactNode;
  /** Host-only controls after the action error, such as an upload retry. */
  readonly afterError?: ReactNode;
}

/** A file's row: its icon, name and meta line, with the host's actions. */
function WorkspaceFileRow({
  name,
  meta,
  actions,
  actionsReveal,
}: {
  readonly name: string;
  readonly meta: string;
  readonly actions?: ReactNode;
  readonly actionsReveal?: boolean;
}): JSX.Element {
  return (
    <ListRowStatic
      icon={<AttachmentIcon size={14} />}
      description={meta}
      actions={actions}
      {...(actionsReveal === undefined ? {} : { actionsReveal })}
    >
      <span title={name}>{name}</span>
    </ListRowStatic>
  );
}

/** Plain file names and version lines, like the rows they stand in for. */
const SAMPLE_FILES = [
  ['release-notes.md', 'v1 · Added to workspace'],
  ['checkout-flow.png', 'v2 · From an earlier chat'],
  ['budget.csv', 'v1 · Added to workspace'],
] as const;

/**
 * The file list while it loads: the rows themselves, rendered from plain
 * samples inside the measured `Skeleton`, so the files replace it in place.
 */
function WorkspaceFilesSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading workspace files"
      testId="workspace-files-skeleton"
    >
      <ul>
        {SAMPLE_FILES.map(([name, meta]) => (
          <li key={name}>
            <WorkspaceFileRow name={name} meta={meta} />
          </li>
        ))}
      </ul>
    </Skeleton>
  );
}

/**
 * A cloud project's shared workspace files (CAN-6568), on the web and on
 * desktop. The host reads and changes the files; this renders them.
 */
export function WorkspaceFilesList({
  phase,
  rows,
  onRetry,
  emptySubtitle,
  notice,
  error = null,
  busy = false,
  busyLabel,
  children,
  afterError,
  onOpen,
  onMention,
  onDownload,
  onReplace,
  onRemove,
}: WorkspaceFilesListProps): JSX.Element {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const hasActions =
    onOpen !== undefined ||
    onMention !== undefined ||
    onDownload !== undefined ||
    onReplace !== undefined ||
    onRemove !== undefined;
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      data-testid="portal-workspace-files"
    >
      <p className="fg-secondary">
        Files you send in chats and finished files created by agents are shared
        across this workspace.
      </p>
      {children}
      {phase === 'loading' ? (
        <DelayedLoadingPlaceholder slowNote="Still loading workspace files…">
          <WorkspaceFilesSkeleton />
        </DelayedLoadingPlaceholder>
      ) : null}
      {phase === 'error' ? (
        <ErrorBanner
          errorSource="workspace-files-load"
          className=""
          error="Couldn't load workspace files."
          onRetry={onRetry}
        />
      ) : null}
      {notice}
      {phase === 'ready' && rows.length === 0 && notice == null ? (
        <EmptyState title="No shared files yet." subtitle={emptySubtitle} />
      ) : null}
      <ErrorBanner
        errorSource="workspace-files-action"
        className=""
        error={error}
      />
      {afterError}
      {busy && busyLabel !== undefined ? (
        <span role="status">{busyLabel}</span>
      ) : null}
      <ul className="max-h-75 overflow-y-auto">
        {rows.map((row) => {
          const confirming = confirmingId === row.id && onRemove !== undefined;
          const actions = !hasActions ? undefined : confirming ? (
            <InlineDeleteConfirm
              onConfirm={(): void => {
                void onRemove(row.id).then((removed) => {
                  if (removed) setConfirmingId(null);
                });
              }}
              onCancel={(): void => setConfirmingId(null)}
              deleting={busy}
              confirmTestId="workspace-file-remove-confirm"
              cancelTestId="workspace-file-remove-cancel"
              focusRing
              autoFocusConfirm
            />
          ) : (
            <RowActionTray inRowOnTouch revealOnFocus>
              {onOpen !== undefined ? (
                <RowActionButton
                  label={`Open ${row.name}`}
                  testId="workspace-file-open"
                  onClick={(): void => onOpen(row.id)}
                  focusRing
                >
                  <EyeIcon size={12} />
                </RowActionButton>
              ) : null}
              {onMention !== undefined ? (
                <RowActionButton
                  label={`Mention ${row.name} in chat`}
                  testId="workspace-file-mention"
                  focusRing
                  onClick={(): void => onMention(row.id)}
                >
                  <MentionIcon />
                </RowActionButton>
              ) : null}
              {onDownload !== undefined ? (
                <RowActionButton
                  label={`Download ${row.name}`}
                  testId="workspace-file-download"
                  onClick={(): void => onDownload(row.id)}
                  focusRing
                >
                  <DownloadIcon size={12} />
                </RowActionButton>
              ) : null}
              {onReplace !== undefined ? (
                <RowActionButton
                  label={`Replace ${row.name}`}
                  testId="workspace-file-replace"
                  disabled={busy}
                  onClick={(): void => onReplace(row.id)}
                  focusRing
                >
                  <PlusMediumIcon size={12} />
                </RowActionButton>
              ) : null}
              {onRemove !== undefined ? (
                <RowActionButton
                  label={`Remove ${row.name}`}
                  testId="workspace-file-remove"
                  disabled={busy}
                  destructive
                  onClick={(): void => setConfirmingId(row.id)}
                  focusRing
                >
                  <TrashIcon size={12} />
                </RowActionButton>
              ) : null}
            </RowActionTray>
          );
          return (
            <li
              key={row.id}
              data-testid="workspace-file-row"
              data-file-id={row.id}
            >
              <WorkspaceFileRow
                name={row.name}
                meta={row.meta}
                actions={actions}
                {...(confirming ? { actionsReveal: false } : {})}
              />
              {confirming ? (
                <p className="fg-secondary">
                  Remove this shared file? It will disappear from future
                  workspace file lists. Existing chat attachments and copies are
                  kept.
                </p>
              ) : null}
              {row.unavailable === true ? (
                <p className="fg-secondary" role="status">
                  Saved copy is no longer available.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
