import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphIpcError,
  CodeGraphQueueEntry,
} from '@canopy/desktop-shared/types';
import {
  Button,
  LoadingSpinner,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { ChevronDown, ChevronUp } from '@canopy/ui-shared/icons/AppIcons';
import {
  SettingsGroup,
  SettingsLoading,
  SettingsSection,
} from './SettingsLayout';

const REORDER_CONFLICT_MESSAGE =
  'The generation queue changed. Review the latest order and try again.';
const QUEUE_EMPTY_MESSAGE = 'No Code Graph generations are queued or running.';

function isIpcError(
  value: CodeGraphGenerationQueueSnapshot | CodeGraphIpcError,
): value is CodeGraphIpcError {
  return 'ok' in value && value.ok === false;
}

function scopeLabel(scope: CodeGraphQueueEntry['scope']): string {
  return scope === 'worktree' ? 'Worktree graph' : 'Project graph';
}

/**
 * Safe, human-readable primary label for a queue entry. Uses the backend's
 * pre-sanitized `label` when present (never a filesystem/shadow path) and falls
 * back to the scope description.
 */
function entryPrimaryLabel(entry: CodeGraphQueueEntry): string {
  const label = entry.label?.trim();
  return label && label.length > 0 ? label : scopeLabel(entry.scope);
}

function entryWorkspaceLabel(entry: CodeGraphQueueEntry): string {
  const label = entry.workspaceLabel?.trim();
  if (label) return label;
  return entry.workspaceIds[0]?.trim() || 'Workspace';
}

function entryAccessibleLabel(entry: CodeGraphQueueEntry): string {
  const primaryLabel = entryPrimaryLabel(entry);
  return entry.scope === 'worktree'
    ? `${primaryLabel} in ${entryWorkspaceLabel(entry)}`
    : primaryLabel;
}

/**
 * An entry's name with its graph scope beside it, and where it came from on
 * the line under it.
 */
function EntryText({ entry }: { entry: CodeGraphQueueEntry }): JSX.Element {
  return (
    <div className="flex flex-col min-w-0 flex-1 gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-s font-medium fg-primary">
          {entryPrimaryLabel(entry)}
        </span>
        <span className="shrink-0 text-xs fg-tertiary">
          {scopeLabel(entry.scope)}
        </span>
      </div>
      <p className="truncate text-xs fg-secondary">
        {entry.scope === 'worktree' && (
          <>
            <span>Project: {entryWorkspaceLabel(entry)}</span>
            <span aria-hidden="true"> · </span>
          </>
        )}
        {entry.trigger}
      </p>
    </div>
  );
}

/**
 * Live Code Graph generation queue rendered beneath the Code Graph preference
 * controls on Settings → Code Graph.
 *
 * Renders the backend's authoritative snapshot verbatim: running entries are
 * listed first (pinned, read-only), queued entries follow in dispatch order and
 * may be reordered by pointer drag or the accessible move-up/move-down
 * controls. Reorders apply optimistically and roll back to the authoritative
 * snapshot on conflict. The queue never derives state from local timers,
 * runner keys, or paths — only the safe snapshot from the build runner.
 */
export function CodeGraphGenerationQueue(): JSX.Element {
  const [snapshot, setSnapshot] =
    useState<CodeGraphGenerationQueueSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [optimisticQueued, setOptimisticQueued] = useState<
    CodeGraphQueueEntry[] | null
  >(null);
  const [reordering, setReordering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<CodeGraphGenerationQueueSnapshot | null>(null);
  const draggedEntryIdRef = useRef<string | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // Load the current snapshot on mount and subscribe to live updates for the
  // lifetime of the tab. A broadcast is authoritative: it replaces the snapshot
  // and clears any in-flight optimistic order so disable-driven row removals
  // never leave stale rows.
  useEffect(() => {
    let active = true;
    void window.api
      .codeGraphGetGenerationQueue()
      .then((snap) => {
        if (active) {
          snapshotRef.current = snap;
          setSnapshot(snap);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setLoaded(true);
        }
      });
    const unsubscribe = window.api.onCodeGraphGenerationQueueChanged((snap) => {
      snapshotRef.current = snap;
      if (
        draggedEntryIdRef.current !== null &&
        !snap.entries.some(
          (entry) =>
            entry.status === 'queued' && entry.id === draggedEntryIdRef.current,
        )
      ) {
        draggedEntryIdRef.current = null;
      }
      setSnapshot(snap);
      setOptimisticQueued(null);
    });
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, []);

  const reloadSnapshot = useCallback(async (): Promise<void> => {
    try {
      const snap = await window.api.codeGraphGetGenerationQueue();
      snapshotRef.current = snap;
      setSnapshot(snap);
    } catch {
      // Keep the last snapshot; a later broadcast will reconcile.
    }
  }, []);

  const commitReorder = useCallback(
    async (nextQueued: CodeGraphQueueEntry[]): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) {
        return;
      }
      setOptimisticQueued(nextQueued);
      setReordering(true);
      setError(null);
      try {
        const response = await window.api.codeGraphReorderGenerationQueue({
          revision: current.revision,
          orderedQueuedEntryIds: nextQueued.map((entry) => entry.id),
        });
        if (isIpcError(response)) {
          if (response.code === 'conflict' && response.snapshot) {
            setSnapshot(response.snapshot);
          } else {
            await reloadSnapshot();
          }
          setError(REORDER_CONFLICT_MESSAGE);
        } else {
          setSnapshot(response);
        }
      } catch {
        await reloadSnapshot();
        setError(REORDER_CONFLICT_MESSAGE);
      } finally {
        setOptimisticQueued(null);
        setReordering(false);
      }
    },
    [reloadSnapshot],
  );

  const entries = snapshot?.entries ?? [];
  const running = entries.filter((entry) => entry.status === 'running');
  const snapshotQueued = entries.filter((entry) => entry.status === 'queued');
  const queued = optimisticQueued ?? snapshotQueued;

  const moveQueuedEntry = (index: number, direction: -1 | 1): void => {
    if (reordering) {
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= queued.length) {
      return;
    }
    const next = queued.slice();
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    void commitReorder(next);
  };

  const handleDrop = (targetEntryId: string): void => {
    const draggedEntryId = draggedEntryIdRef.current;
    draggedEntryIdRef.current = null;
    if (draggedEntryId === null || reordering) {
      return;
    }
    const latestQueued =
      snapshotRef.current?.entries.filter(
        (entry) => entry.status === 'queued',
      ) ?? [];
    const from = latestQueued.findIndex((entry) => entry.id === draggedEntryId);
    const target = latestQueued.findIndex(
      (entry) => entry.id === targetEntryId,
    );
    if (from === -1 || target === -1 || from === target) {
      return;
    }
    const next = latestQueued.slice();
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return;
    }
    next.splice(target, 0, moved);
    void commitReorder(next);
  };

  const hasEntries = running.length > 0 || queued.length > 0;

  return (
    <SettingsSection
      title="Generation queue"
      description="Running generations are pinned. Reorder queued builds to change the order they run in."
      dataTestId="code-graph-generation-queue"
    >
      {error && (
        <ErrorBanner
          errorSource="code-graph-queue-error"
          className=""
          error={error}
          testId="code-graph-queue-error"
        />
      )}

      <SettingsGroup
        dataTestId={hasEntries ? 'code-graph-queue-list' : undefined}
        ariaLabel={hasEntries ? 'Generation queue' : undefined}
      >
        {!loaded ? (
          <SettingsLoading rows={1} dataTestId="code-graph-queue-loading" />
        ) : !hasEntries ? (
          <p
            className="text-s fg-secondary"
            data-testid="code-graph-queue-empty"
          >
            {QUEUE_EMPTY_MESSAGE}
          </p>
        ) : null}
        {running.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-3"
            data-testid={`code-graph-queue-running-${entry.id}`}
          >
            <span className="flex w-5 shrink-0 items-center justify-center">
              <LoadingSpinner tone="accent" />
            </span>
            <EntryText entry={entry} />
            <span className="shrink-0 text-xs fg-secondary">Running</span>
          </div>
        ))}
        {queued.map((entry, index) => (
          <div
            key={entry.id}
            draggable={!reordering}
            onDragStart={(): void => {
              draggedEntryIdRef.current = entry.id;
            }}
            onDragOver={(event): void => {
              event.preventDefault();
            }}
            onDrop={(event): void => {
              event.preventDefault();
              handleDrop(entry.id);
            }}
            className="flex items-center gap-3"
            data-testid={`code-graph-queue-entry-${entry.id}`}
          >
            <span
              className="w-5 shrink-0 text-center text-xs tabular-nums fg-secondary"
              aria-hidden="true"
            >
              {(index + 1).toLocaleString()}
            </span>
            <EntryText entry={entry} />
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="compact"
                variant="secondary"
                iconOnly
                // `aria-disabled` keeps the secondary surface on the first
                // row; `disabled` would paint the shared disabled fill.
                aria-disabled={reordering || index === 0}
                onClick={(): void => {
                  if (!reordering && index > 0) moveQueuedEntry(index, -1);
                }}
                aria-label={`Move ${entryAccessibleLabel(entry)} up`}
                data-testid={`code-graph-queue-move-up-${entry.id}`}
              >
                <ChevronUp size="sm" />
              </Button>
              <Button
                size="compact"
                variant="secondary"
                iconOnly
                aria-disabled={reordering || index === queued.length - 1}
                onClick={(): void => {
                  if (!reordering && index < queued.length - 1) {
                    moveQueuedEntry(index, 1);
                  }
                }}
                aria-label={`Move ${entryAccessibleLabel(entry)} down`}
                data-testid={`code-graph-queue-move-down-${entry.id}`}
              >
                <ChevronDown size="sm" />
              </Button>
            </div>
          </div>
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
