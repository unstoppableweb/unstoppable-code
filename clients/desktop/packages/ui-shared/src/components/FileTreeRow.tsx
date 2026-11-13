import { Badge } from './Badge';
import type {
  CSSProperties,
  DragEvent,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { FolderIcon } from '../icons/FolderIcon';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

const ROW_BASE_CLASS =
  'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors';

export interface FileTreeRowProps {
  /** Label shown for this row. */
  label: string;
  /** Indent depth — each level adds 16px of left padding. */
  depth: number;
  /** Folder rows render a chevron + folder glyph; file rows their file-type icon. */
  isDirectory: boolean;
  /** Only meaningful when `isDirectory` is true. */
  expanded?: boolean;
  /** Tree rows that represent the workspace/repo root get a small-caps label. */
  isRepoRoot?: boolean;
  /** Visually dim the row (e.g. .gitignored entries). */
  isIgnored?: boolean;
  /** Highlight the row as currently selected. */
  selected?: boolean;
  /** Highlight this file as the one shown by the owning file panel. */
  current?: boolean;
  /** Disable click handling. */
  disabled?: boolean;
  /** Optional override for the leading icon. */
  icon?: ReactNode;
  /** Optional host-provided action revealed on hover or keyboard focus. */
  trailingAction?: ReactNode;
  /** Always visible inside the row, independent of hover actions. */
  badge?: ReactNode;
  /** Display-only context alongside the original folder name. */
  secondaryLabel?: string;
  /** Mask the label text in session replays, for user-authored titles. */
  replayMaskLabel?: boolean;
  /** Full text shown on the truncated label (defaults to the label). */
  title?: string;
  /** Click handler. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Right-click handler. */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Optional test id. */
  dataTestId?: string;
  /** Optional additional data attributes. */
  dataPath?: string;
  /** Stable interaction id and ARIA state for full explorer consumers. */
  dataNodeId?: string;
  ariaSelected?: boolean;
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  dropTarget?: boolean;
  /**
   * Render this row as a VS Code-style sticky header. The row pins to the top
   * of the scroll container at `depth` rows down, stacking under its ancestor
   * folders. Only meaningful for folder rows. The scroll container is
   * responsible for defining the `--file-tree-row-height` custom property and
   * toggling each pinned row's `data-stuck` attribute.
   */
  sticky?: boolean;
  /**
   * Enforce a ≥44px touch target on the row (CAN-1206). Opt-in so the desktop
   * file tree stays pixel-identical; the web portal passes it only for the
   * mobile-drawer variant.
   */
  touchTarget?: boolean;
}

/**
 * Single row in a hierarchical file tree. Pure display component used by both
 * the desktop renderer's `FilesTreeTab` and the web portal's file explorer.
 * Indentation is computed from `depth` so callers do not need to track CSS
 * variables.
 */
export function FileTreeRow({
  label,
  depth,
  isDirectory,
  expanded = false,
  isRepoRoot = false,
  isIgnored = false,
  selected = false,
  current = false,
  disabled = false,
  icon,
  trailingAction,
  badge,
  secondaryLabel,
  replayMaskLabel = false,
  title,
  onClick,
  onContextMenu,
  dataTestId,
  dataPath,
  dataNodeId,
  ariaSelected,
  tabIndex,
  onKeyDown,
  draggable,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  dropTarget = false,
  sticky = false,
  touchTarget = false,
}: FileTreeRowProps): JSX.Element {
  const paddingLeft = `${depth * 16 + 8}px`;
  // The full text rides on the truncated text as a native title, never on the
  // row button (docs/design/interaction.md#tooltips).
  const tooltip = replayMaskLabel
    ? undefined
    : (title ?? (secondaryLabel ? `${label} — ${secondaryLabel}` : label));

  // Sticky folder headers stack at the top of the scroll container: the root row
  // (depth 0) pins flush at the top, and each nested header pins directly below
  // it — offset by the root row's own measured height plus one measured
  // `--file-tree-row-height` per intervening level. Measuring the root
  // separately (`--file-tree-root-height`) matters because the repo-root row is
  // a slightly different height than nested folders, so a uniform `depth * H`
  // offset would leave a gap under it. The pinned block styling (opaque
  // background, single bottom edge/radius, and the z-index that lifts pinned
  // rows above merely-scrolling ones) is applied by the `[data-stuck]` /
  // `[data-stuck-edge]` rules in the renderer's globals.css.
  const stickyFolder = sticky && isDirectory;
  const stickyStyle: CSSProperties = stickyFolder
    ? {
        position: 'sticky',
        top:
          depth <= 0
            ? '0px'
            : `calc(var(--file-tree-root-height, 1.75rem) + var(--file-tree-row-height, 1.75rem) * ${depth - 1})`,
      }
    : {};
  const rowStyle: CSSProperties = { paddingLeft, ...stickyStyle };

  const baseTone = isDirectory
    ? 'fg-secondary'
    : isIgnored
      ? 'fg-secondary/70'
      : 'fg-primary/80';
  const hoverTone = onClick
    ? 'cursor-pointer hover:bg-fg-primary/[0.06]'
    : 'cursor-default';
  const selectedTone =
    selected || current ? 'bg-fg-primary/[0.06] fg-primary' : '';
  const rowDisabled = disabled || (!onClick && !onContextMenu);

  const baseLabelClass = isRepoRoot
    ? 'truncate text-2xs font-semibold fg-primary/80'
    : `truncate ${isIgnored ? 'fg-secondary/70' : ''}`;
  const labelClass = replayMaskLabel
    ? `${baseLabelClass} ${REPLAY_MASK_CLASS}`
    : baseLabelClass;

  const folderIcon = (
    <FolderIcon
      className={`shrink-0 fg-secondary ${isIgnored ? 'opacity-50' : ''}`}
    />
  );
  // A file shows its type, in the file-type family's own colors.
  const fileIcon = (
    <FileTypeIcon
      filename={label}
      className={isIgnored ? 'opacity-50' : undefined}
    />
  );

  const context = (
    <>
      {secondaryLabel && (
        <span
          className="min-w-0 truncate fg-secondary"
          data-testid="file-tree-row-secondary-label"
          title={tooltip}
        >
          {secondaryLabel}
        </span>
      )}
      {badge !== undefined && badge !== null && (
        <Badge
          size="compact"
          className="ml-auto"
          data-testid="file-tree-row-badge"
        >
          {badge}
        </Badge>
      )}
    </>
  );
  const row = (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      disabled={rowDisabled}
      data-testid={dataTestId}
      data-path={dataPath}
      data-file-tree-id={dataNodeId}
      data-file-tree-kind={isDirectory ? 'directory' : 'file'}
      data-current-file={current ? 'true' : undefined}
      role={dataNodeId ? 'treeitem' : undefined}
      aria-selected={dataNodeId ? ariaSelected : undefined}
      aria-current={current ? 'page' : undefined}
      aria-expanded={dataNodeId && isDirectory ? expanded : undefined}
      aria-level={dataNodeId ? depth + 1 : undefined}
      tabIndex={dataNodeId ? tabIndex : undefined}
      onKeyDown={onKeyDown}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-ignored={isIgnored ? 'true' : undefined}
      data-file-tree-folder={
        stickyFolder && trailingAction === undefined ? '' : undefined
      }
      data-sticky-depth={
        stickyFolder && trailingAction === undefined ? depth : undefined
      }
      className={`${ROW_BASE_CLASS} ${trailingAction !== undefined ? 'pr-9 ' : ''}${touchTarget ? 'min-h-11 ' : ''}${baseTone} ${hoverTone} ${selectedTone} ${dropTarget ? 'ring-1 ring-inset ring-fg-accent bg-accent-subtle ' : ''}disabled:cursor-default disabled:opacity-60`}
      style={trailingAction === undefined ? rowStyle : { paddingLeft }}
    >
      {isDirectory ? (
        <>
          <span className="w-3 shrink-0 text-3xs">{expanded ? '▼' : '▶'}</span>
          {icon ?? folderIcon}
          <span
            className={secondaryLabel ? `${labelClass} shrink-0` : labelClass}
            title={tooltip}
          >
            {label}
          </span>
          {context}
        </>
      ) : (
        <>
          <span className="w-3 shrink-0" aria-hidden="true" />
          {icon ?? fileIcon}
          <span
            className={secondaryLabel ? `${labelClass} shrink-0` : labelClass}
            title={tooltip}
          >
            {label}
          </span>
          {context}
        </>
      )}
    </button>
  );

  if (trailingAction === undefined) {
    return row;
  }

  return (
    <div
      className="group relative"
      data-file-tree-folder={stickyFolder ? '' : undefined}
      data-sticky-depth={stickyFolder ? depth : undefined}
      style={stickyStyle}
    >
      {row}
      <div className="absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {trailingAction}
      </div>
    </div>
  );
}
