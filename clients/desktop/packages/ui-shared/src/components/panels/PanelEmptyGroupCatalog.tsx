import type { JSX, ReactNode } from 'react';
import { MoreHorizontalIcon } from '../../icons/AppIcons';
import { ListRow } from '../../primitives/ListRow';
import { LoadingSpinner } from '../../primitives/LoadingSpinner';
import { Heading } from '../../primitives/Heading';

export interface PanelEmptyGroupCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onActivate: () => void;
  readonly testId?: string;
  readonly disabled?: boolean;
  /** Shows a spinner in place of the icon while the panel is being created. */
  readonly busy?: boolean;
}

export interface PanelEmptyGroupCatalogProps {
  readonly title: string;
  readonly entries: readonly PanelEmptyGroupCatalogEntry[];
  /** Opens the group's full add menu, for what the short list leaves out. */
  readonly onMore?: () => void;
  /**
   * The open add menu, rendered inside the More row so it opens from that
   * row rather than from the group's `+`.
   */
  readonly moreMenu?: ReactNode;
  readonly moreLabel?: string;
  readonly testId?: string;
}

/**
 * An empty panel group's starting point: what can be opened there, one row
 * per surface, so the group explains itself instead of showing a blank area.
 */
export function PanelEmptyGroupCatalog({
  title,
  entries,
  onMore,
  moreMenu,
  moreLabel = 'More…',
  testId,
}: PanelEmptyGroupCatalogProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto p-4"
    >
      <div className="flex w-full max-w-64 flex-col gap-2">
        <div className="px-2">
          <Heading level={2} variant="title">
            {title}
          </Heading>
        </div>
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li key={entry.key}>
              <ListRow
                data-testid={entry.testId}
                disabled={entry.disabled}
                aria-busy={entry.busy || undefined}
                onClick={entry.onActivate}
                icon={
                  <span aria-hidden="true" className="inline-flex">
                    {entry.busy ? <LoadingSpinner /> : entry.icon}
                  </span>
                }
              >
                {entry.label}
              </ListRow>
            </li>
          ))}
          {onMore !== undefined && (
            <li className="relative">
              <ListRow
                data-testid={
                  testId !== undefined ? `${testId}-more` : undefined
                }
                aria-haspopup="menu"
                aria-expanded={moreMenu !== undefined}
                onClick={onMore}
                icon={<MoreHorizontalIcon aria-hidden="true" />}
              >
                <span className="fg-secondary">{moreLabel}</span>
              </ListRow>
              {moreMenu}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
