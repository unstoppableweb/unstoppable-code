'use client';

import { Badge, type BadgeTone } from '@canopy/ui-shared/primitives/Badge';
import type { JSX } from 'react';
import {
  ExecutionActionButton,
  type ExecutionActionButtonVariant,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

/** One read-only row: a label, an optional status chip, and optional detail. */
export interface ActivityListItem {
  readonly key: string;
  readonly dataTestId?: string;
  readonly label: string;
  readonly labelClassName?: string;
  readonly status?: string;
  /** Secondary line (e.g. a truncated output tail or trigger name). */
  readonly detail?: string;
  readonly actionLabel?: string;
  readonly actionDisabled?: boolean;
  /** Visual treatment for the trailing action (Run → primary, Stop →
   * destructive, Open/other → default). Defaults to `default`. */
  readonly actionVariant?: ExecutionActionButtonVariant;
  readonly onAction?: () => void;
}

/** Coarse status → chip color. Unknown statuses fall back to muted. */
function statusTone(status: string): BadgeTone {
  const value = status.toLowerCase();
  if (
    value.includes('run') ||
    value.includes('active') ||
    value.includes('progress')
  ) {
    return 'info';
  }
  if (
    value.includes('fail') ||
    value.includes('error') ||
    value.includes('cancel')
  ) {
    return 'danger';
  }
  if (
    value.includes('success') ||
    value.includes('complete') ||
    value.includes('done') ||
    value.includes('approv') ||
    value.includes('pass')
  ) {
    return 'success';
  }
  return 'neutral';
}

/**
 * Generic read-only list used by the data-bearing activity sections (plans,
 * pipeline runs, scripts, hooks, terminals). Rows mirror the desktop
 * Scripts/Hooks card treatment (`rounded-lg border
 * bg-fg-primary/[0.03] px-2.5 py-2`) so the shared portal rail matches the
 * desktop-native sections. Interactive controls (run / cancel / open) render
 * through the shared {@link ExecutionActionButton}; the host owns the dispatch.
 */
export interface ItemListSectionProps {
  readonly items: readonly ActivityListItem[];
  readonly emptyLabel: string;
  readonly dataTestId?: string;
}

export function ItemListSection({
  items,
  emptyLabel,
  dataTestId,
}: ItemListSectionProps): JSX.Element {
  if (items.length === 0) {
    return (
      <p
        className="text-xs fg-secondary"
        data-testid={dataTestId ? `${dataTestId}-empty` : undefined}
      >
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul
      className="m-0 list-none flex flex-col gap-1.5 p-0"
      data-testid={dataTestId}
    >
      {items.map((item) => (
        <Surface
          as="li"
          variant="group"
          className="group"
          key={item.key}
          data-testid={item.dataTestId}
        >
          <div className="flex items-center gap-2 px-2.5 py-2 text-left text-xs">
            <div className="min-w-0 flex-1">
              <p
                className={`truncate font-medium ${
                  item.labelClassName ?? 'fg-primary/80'
                }`}
                title={item.label}
              >
                {item.label}
              </p>
              {item.detail && (
                <p className="truncate text-2xs fg-secondary">{item.detail}</p>
              )}
            </div>
            {item.status && (
              <Badge tone={statusTone(item.status)}>{item.status}</Badge>
            )}
            {item.actionLabel && item.onAction && (
              <ExecutionActionButton
                label={item.actionLabel}
                ariaLabel={`${item.actionLabel} ${item.label}`}
                variant={item.actionVariant ?? 'default'}
                disabled={item.actionDisabled}
                onClick={item.onAction}
              />
            )}
          </div>
        </Surface>
      ))}
    </ul>
  );
}
