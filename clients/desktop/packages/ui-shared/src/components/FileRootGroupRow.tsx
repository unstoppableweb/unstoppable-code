import type { JSX, KeyboardEvent } from 'react';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';
import { ChevronRightIcon } from '../icons/ChevronRightIcon';
import { FileTreeRow } from './FileTreeRow';

export interface FileRootGroupRowProps {
  /** Host-supplied brand display name for the app-owned group. */
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** Roving-focus id; must not collide with any file tree node id. */
  nodeId: string;
  depth?: number;
  selected?: boolean;
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  dataTestId?: string;
  /** Preserve the host's tree or root-switcher presentation. */
  presentation?: 'tree' | 'switcher';
  controlsId?: string;
}

/**
 * Tree row for the group of app-owned roots. It is a presentation control,
 * not a directory: it has no path, context menu, drag source, or drop target.
 */
export function FileRootGroupRow({
  label,
  expanded,
  onToggle,
  nodeId,
  depth = 0,
  selected = false,
  tabIndex,
  onKeyDown,
  dataTestId = 'file-root-group',
  presentation = 'tree',
  controlsId,
}: FileRootGroupRowProps): JSX.Element {
  if (presentation === 'switcher') {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        data-testid={dataTestId}
        className="focus-ring flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary"
      >
        {expanded ? (
          <ChevronDownIcon size={12} aria-hidden className="shrink-0" />
        ) : (
          <ChevronRightIcon size={12} aria-hidden className="shrink-0" />
        )}
        {label}
      </button>
    );
  }
  return (
    <FileTreeRow
      label={label}
      depth={depth}
      isDirectory
      expanded={expanded}
      isRepoRoot
      selected={selected}
      ariaSelected={selected}
      onClick={onToggle}
      dataTestId={dataTestId}
      dataNodeId={nodeId}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      sticky
    />
  );
}
