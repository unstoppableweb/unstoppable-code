import { Fragment, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import {
  CUSTOMIZE_ROW_GRID_CLASS,
  gridRowNeighbor,
} from '../lib/customize-grid';
import { Button } from '../primitives/Button';

export interface CustomizeInstalledListProps {
  readonly sectionId: string;
  readonly entries: readonly UnifiedPluginEntry[];
  /** Collapsed preview size; omitted shows every entry. */
  readonly previewLimit?: number;
  readonly onShowAll?: () => void;
  readonly renderRow: (entry: UnifiedPluginEntry) => ReactNode;
}

function moveFocus(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[data-marketplace-entry="true"]',
    ),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index === -1) return;
  const next = gridRowNeighbor(rows, index, event.key === 'ArrowDown' ? 1 : -1);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** Rows of one headed section, with an optional Show all preview. */
export function CustomizeInstalledList({
  sectionId,
  entries,
  previewLimit,
  onShowAll,
  renderRow,
}: CustomizeInstalledListProps): JSX.Element {
  const collapsed =
    previewLimit !== undefined &&
    onShowAll !== undefined &&
    entries.length > previewLimit;
  const visible = collapsed ? entries.slice(0, previewLimit) : entries;
  const rows = (
    <div className="flex flex-col gap-3 pt-3">
      <ul
        data-testid={`customize-section-${sectionId}-rows`}
        data-row-count={visible.length}
        className={CUSTOMIZE_ROW_GRID_CLASS}
        onKeyDown={moveFocus}
      >
        {visible.map((entry) => (
          <Fragment key={entry.id}>{renderRow(entry)}</Fragment>
        ))}
      </ul>
      {collapsed && (
        <div>
          <Button
            size="compact"
            data-testid={`customize-section-${sectionId}-show-all`}
            onClick={onShowAll}
          >
            {`Show all ${entries.length}`}
          </Button>
        </div>
      )}
    </div>
  );
  // Columns follow this section's actual width (see the grid class).
  return <div className="@container">{rows}</div>;
}
