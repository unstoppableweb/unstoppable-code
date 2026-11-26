import type { JSX } from 'react';
import { FileTreeRow } from './FileTreeRow';
import { Skeleton } from '../primitives/Skeleton';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '../lib/useDelayedFlag';

/**
 * An open folder whose listing is still on its way (CAN-6756): one skeleton
 * row at its children's depth. It shows only after the shared loading delay,
 * so a listing that lands quickly, as a local one does, never flashes it or
 * shifts the tree. A host also shows it under a cloud project that is waking
 * (CAN-6724), so a waking folder reads as loading, never as empty.
 */
export function FileTreeFolderLoadingRow({
  depth,
}: {
  readonly depth: number;
}): JSX.Element | null {
  const visible = useDelayedFlag(true, LOADING_PLACEHOLDER_DELAY_MS);
  if (!visible) return null;
  return (
    <Skeleton loading label="Loading folder" testId="files-tree-folder-loading">
      <FileTreeRow label="Loading" depth={depth} isDirectory={false} />
    </Skeleton>
  );
}

/** An open folder whose listing came back with nothing in it. */
export function FileTreeFolderEmptyRow({
  depth,
}: {
  readonly depth: number;
}): JSX.Element {
  return (
    <div
      className="flex items-center px-2 py-1 text-2xs fg-tertiary"
      style={{ paddingLeft: `${depth * 16 + 32}px` }}
      data-testid="files-tree-folder-empty"
    >
      Empty folder
    </div>
  );
}
