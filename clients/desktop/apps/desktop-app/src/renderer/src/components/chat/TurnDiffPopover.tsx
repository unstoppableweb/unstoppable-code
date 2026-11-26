import { memo, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  ChangedFileInfo,
  FileDiffImagePreview,
  TurnDiffData,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import { DiffContentView } from '../activity/DiffContentView';
import {
  DiffTurnUnavailableState,
  HeaderActionButton,
  HoverCard,
  Surface,
} from '@canopy/ui-shared/components';
import {
  MaximizeIcon,
  PencilIcon as AppCatalogPencilIcon,
} from '@canopy/ui-shared/icons/AppIcons';

function findTreeRef(
  file: ChangedFileInfo,
  treeRefs: TurnDiffTreeRef[],
): TurnDiffTreeRef | undefined {
  if (treeRefs.length === 1) return treeRefs[0];
  return treeRefs.find((ref) => ref.repoId === file.repoId);
}

interface TurnDiffPopoverProps {
  file: ChangedFileInfo;
  turnDiff: TurnDiffData;
  projectId: string;
  worktreeId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement: 'left' | 'right';
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenModal: () => void;
  onEdit: () => void;
}

export const TurnDiffPopover = memo(function TurnDiffPopover({
  file,
  turnDiff,
  projectId,
  worktreeId,
  anchorRef,
  placement,
  onMouseEnter,
  onMouseLeave,
  onOpenModal,
  onEdit,
}: TurnDiffPopoverProps): JSX.Element {
  const [oldValue, setOldValue] = useState('');
  const [newValue, setNewValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [binary, setBinary] = useState(false);
  const [imagePreview, setImagePreview] = useState<
    FileDiffImagePreview | undefined
  >(undefined);

  const treeRefs = turnDiff.treeRefs;
  const treeRef = useMemo(
    () =>
      treeRefs && treeRefs.length > 0 ? findTreeRef(file, treeRefs) : undefined,
    [file, treeRefs],
  );

  // Only the turn's own trees: without them no other comparison stands in.
  useEffect(() => {
    if (!treeRef) return;
    setLoading(true);
    let cancelled = false;

    void window.api.activity
      .getTurnFileDiff({
        projectId,
        worktreeId,
        filePath: file.path,
        startTree: treeRef.startTree,
        endTree: treeRef.endTree,
        repoId: file.repoId,
      })
      .then((response) => {
        if (cancelled) return;
        setOldValue(response.oldValue);
        setNewValue(response.newValue);
        setTruncated(response.truncated);
        setBinary(response.binary);
        setImagePreview(response.imagePreview);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setOldValue('');
        setNewValue('');
        setTruncated(false);
        setBinary(false);
        setImagePreview(undefined);
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [file, projectId, worktreeId, treeRef]);

  // Portaled to the body, out of the transcript's replay block. The header
  // (file path, counts, actions) is recorded; `DiffContentView` blocks the
  // diff itself.
  //
  // A compact 288px by 176px preview beside the hovered half of the row.
  // The shared hover surface shrinks into the available gutter and flips
  // when that side has no room. Header actions and the diff well
  // sit 4px in, with 8px corners nested in the card's 12px ones; the path
  // lands on the preview cards' 12px text edge.
  return (
    <HoverCard
      open
      anchorRef={anchorRef}
      placement={placement}
      interactive
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      dataTestId="turn-diff-popover"
      elevation="menu"
      surfacePadding="frame"
      surfaceClassName="w-72"
      content={
        <div className="flex h-44 min-h-0 flex-col gap-1">
          <div className="flex min-w-0 shrink-0 items-center gap-2 pl-2">
            <span className="min-w-0 truncate text-xs font-medium fg-primary">
              {file.path.split(/[\\/]/).pop() ?? file.path}
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              <HeaderActionButton
                tone="neutral"
                iconOnly
                aria-label="Open full diff view"
                onClick={onOpenModal}
              >
                <MaximizeIcon size="sm" />
              </HeaderActionButton>
              <HeaderActionButton
                tone="neutral"
                iconOnly
                aria-label="Open file in editor"
                onClick={onEdit}
              >
                <AppCatalogPencilIcon size="sm" aria-hidden="true" />
              </HeaderActionButton>
            </span>
          </div>

          <Surface
            variant="group"
            size="small"
            className="min-h-0 flex-1 overflow-hidden flex flex-col"
          >
            <div className="flex diff-popover-compact min-h-0 flex-1">
              {treeRef ? (
                <DiffContentView
                  oldValue={oldValue}
                  newValue={newValue}
                  viewMode="unified"
                  loading={loading}
                  truncated={truncated}
                  binary={binary}
                  imagePreview={imagePreview}
                  variant="compact"
                />
              ) : (
                <DiffTurnUnavailableState
                  action={
                    <p>Expand to see all branch changes for this file.</p>
                  }
                />
              )}
            </div>
          </Surface>
        </div>
      }
    />
  );
});
