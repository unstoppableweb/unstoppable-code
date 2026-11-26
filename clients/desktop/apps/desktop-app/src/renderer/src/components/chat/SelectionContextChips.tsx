import { ControlButton } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { fileViewerKey, useFileViewerStore } from '@canopy/app-state';
import { Tooltip } from '@canopy/ui-shared';
import { CodeBracketsIcon } from '@canopy/ui-shared/icons';
import {
  computeSelectionFreshness,
  formatSelectionLabel,
  type EditorSelectionContext,
  type SelectionFreshness,
} from '@/lib/editorSelectionContext';
import { cancelIdle, scheduleIdle } from '@/stores/idleOutputBuffer';
import {
  AttachmentCardTile,
  AttachmentTextPreview,
  AttachmentTileRemoveButton,
} from './AttachmentTile';

/** Characters of a selection shown on its tile: about its first lines. */
const SELECTION_SNIPPET_LENGTH = 400;

interface SessionFreshnessResult {
  content: string;
  freshness: SelectionFreshness;
}

/**
 * Freshness for each staged selection (CAN-1250). Selections whose file has a
 * live shared file-viewer session (the file is open in a tab) are checked
 * reactively against the current buffer — including unsaved edits. Selections
 * without a session fall back to a one-shot disk read per chip.
 *
 * Called only from {@link SelectionContextChips}, which mounts only when
 * selections exist — this keeps the provider-bound file-viewer store out of
 * ChatInput's own hook graph (it renders in provider-less harnesses).
 */
function useSelectionFreshness(
  selections: readonly EditorSelectionContext[],
): Record<string, SelectionFreshness> {
  const sessionContents = useFileViewerStore(
    useShallow((state) => {
      const result: Record<string, string | null> = {};
      for (const selection of selections) {
        const session =
          state.files[
            fileViewerKey({
              projectId: selection.projectId,
              worktreeId: selection.worktreeId,
              ...(selection.repoId
                ? { fileRootLocalId: selection.repoId }
                : {}),
              relativePath: selection.displayPath,
            })
          ];
        result[selection.id] =
          session && session.preview !== null ? session.content : null;
      }
      return result;
    }),
  );

  const [sessionFreshness, setSessionFreshness] = useState<
    Record<string, SessionFreshnessResult>
  >({});
  const [diskFreshness, setDiskFreshness] = useState<
    Record<string, SelectionFreshness>
  >({});
  const checkedIdsRef = useRef<Set<string>>(new Set());
  const pendingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const snapshots = selections.flatMap((selection) => {
      const content = sessionContents[selection.id];
      return content === null || content === undefined
        ? []
        : [{ selection, content }];
    });

    const idleHandle = scheduleIdle(() => {
      setSessionFreshness(() => {
        const next: Record<string, SessionFreshnessResult> = {};
        for (const { selection, content } of snapshots) {
          next[selection.id] = {
            content,
            freshness: computeSelectionFreshness(selection, content),
          };
        }
        return next;
      });
    });
    return (): void => {
      cancelIdle(idleHandle);
    };
  }, [selections, sessionContents]);

  useEffect(() => {
    let cancelled = false;
    const startedIds = new Set<string>();
    const checkedIds = checkedIdsRef.current;
    const pendingIds = pendingIdsRef.current;
    for (const selection of selections) {
      const sessionContent = sessionContents[selection.id];
      if (sessionContent !== null && sessionContent !== undefined) continue;
      if (checkedIds.has(selection.id)) continue;
      if (pendingIds.has(selection.id)) continue;
      pendingIds.add(selection.id);
      startedIds.add(selection.id);
      void window.api
        .readFileContent({ absolutePath: selection.absolutePath })
        .then((result) => {
          if (cancelled) return;
          checkedIds.add(selection.id);
          pendingIds.delete(selection.id);
          const content =
            result.kind === 'text' ||
            result.kind === 'markdown' ||
            result.kind === 'html'
              ? result.content
              : null;
          setDiskFreshness((prev) => ({
            ...prev,
            [selection.id]: computeSelectionFreshness(selection, content),
          }));
        })
        .catch(() => {
          if (cancelled) return;
          checkedIds.add(selection.id);
          pendingIds.delete(selection.id);
          setDiskFreshness((prev) => ({
            ...prev,
            [selection.id]: 'missing',
          }));
        });
    }
    return (): void => {
      cancelled = true;
      startedIds.forEach((selectionId) => {
        pendingIds.delete(selectionId);
      });
    };
  }, [selections, sessionContents]);

  return useMemo(() => {
    const result: Record<string, SelectionFreshness> = {};
    for (const selection of selections) {
      const content = sessionContents[selection.id];
      if (content !== null && content !== undefined) {
        const cached = sessionFreshness[selection.id];
        result[selection.id] =
          cached?.content === content ? cached.freshness : 'checking';
      } else {
        result[selection.id] = diskFreshness[selection.id] ?? 'checking';
      }
    }
    return result;
  }, [selections, sessionContents, sessionFreshness, diskFreshness]);
}

interface SelectionContextChipsProps {
  selections: readonly EditorSelectionContext[];
  /** Passive reveal (chip focused): highlight the range if its editor shows. */
  onReveal: (selection: EditorSelectionContext) => void;
  /** Full open (chip activated): open/activate the file tab, then reveal. */
  onOpen: (selection: EditorSelectionContext) => void;
  onRemove: (selectionId: string) => void;
  /**
   * Reports the latest freshness map so the composer can tag each selection's
   * serialized block at send time without subscribing to the file store.
   */
  onFreshnessChange?: (freshness: Record<string, SelectionFreshness>) => void;
}

/**
 * Editor selections staged on the composer (CAN-1250), as tiles in its
 * attachment strip: the selected code above "filename:lines". Fully keyboard
 * operable: Tab focuses a tile (passively revealing its range), Enter/Space
 * opens the file at the range, and Delete/Backspace — or the corner X —
 * removes it without touching the source file or the draft.
 */
export const SelectionContextChips = memo(function SelectionContextChips({
  selections,
  onReveal,
  onOpen,
  onRemove,
  onFreshnessChange,
}: SelectionContextChipsProps): JSX.Element {
  const freshnessById = useSelectionFreshness(selections);

  useEffect(() => {
    onFreshnessChange?.(freshnessById);
  }, [freshnessById, onFreshnessChange]);

  // Tiles in the composer's attachment strip, ahead of the files; the
  // wrapper adds no box of its own.
  return (
    <span className="contents" data-testid="selection-context-chips">
      {selections.map((selection) => {
        const freshness = freshnessById[selection.id] ?? 'checking';
        const label = formatSelectionLabel(selection);
        const staleNote =
          freshness === 'missing'
            ? ' — the file is no longer available'
            : freshness === 'stale'
              ? ' — the file changed since this was captured'
              : freshness === 'checking'
                ? ' — checking whether the file changed'
                : '';
        const badge =
          selection.capturedDirty && freshness === 'fresh' ? (
            <Badge
              tone="warning"
              size="compact"
              data-testid="selection-context-chip-unsaved"
            >
              unsaved
            </Badge>
          ) : freshness === 'checking' ? (
            <Badge
              tone="warning"
              size="compact"
              data-testid="selection-context-chip-checking"
            >
              checking
            </Badge>
          ) : freshness === 'stale' || freshness === 'missing' ? (
            <Badge
              tone="warning"
              size="compact"
              data-testid="selection-context-chip-stale"
            >
              {freshness === 'missing' ? 'missing' : 'stale'}
            </Badge>
          ) : null;
        return (
          <div key={selection.id} className="group relative shrink-0">
            <Tooltip
              label={`${selection.displayPath}:${selection.startLine}-${selection.endLine}${staleNote}`}
            >
              <ControlButton
                type="button"
                data-testid="selection-context-chip"
                onFocus={(): void => onReveal(selection)}
                onClick={(): void => onOpen(selection)}
                onKeyDown={(event): void => {
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    onRemove(selection.id);
                  }
                }}
                presentation="attachment-preview"
              >
                <AttachmentCardTile
                  kind="selection"
                  preview={
                    <AttachmentTextPreview
                      text={selection.text.slice(0, SELECTION_SNIPPET_LENGTH)}
                    />
                  }
                  icon={
                    <CodeBracketsIcon
                      size="sm"
                      className="shrink-0 fg-secondary"
                    />
                  }
                  name={label}
                  badge={badge}
                />
              </ControlButton>
            </Tooltip>
            <AttachmentTileRemoveButton
              label={label}
              testId="selection-context-chip-remove"
              onRemove={(): void => onRemove(selection.id)}
            />
          </div>
        );
      })}
    </span>
  );
});
