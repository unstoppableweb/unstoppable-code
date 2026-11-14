'use client';

import type { JSX } from 'react';
import type { MarketplaceSource } from '@canopy/app-core/client';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface MarketplaceSourceStatusNoticeProps {
  readonly source: MarketplaceSource;
  readonly updating: boolean;
  readonly refreshing?: boolean;
  readonly onUpdate: () => void;
  readonly onRefresh?: () => void;
  readonly onRemove?: () => void;
  readonly legacy?: {
    readonly banner: string;
    readonly update: string;
    readonly remove: string;
    readonly note: string;
  };
}

/** Provider failure content and recovery actions shared with retained wrappers. */
export function MarketplaceSourceStatusNotice({
  source,
  updating,
  refreshing = false,
  onUpdate,
  onRefresh,
  onRemove,
  legacy,
}: MarketplaceSourceStatusNoticeProps): JSX.Element | null {
  if (source.status.state !== 'invalid') return null;
  return (
    <Notice
      errorSource="marketplace-source-status"
      intent="destructive"
      data-testid={legacy?.banner ?? 'marketplace-source-invalid'}
      title={
        legacy
          ? 'This marketplace is not available.'
          : 'This marketplace could not be loaded.'
      }
      onClick={(event) => event.stopPropagation()}
      detail={
        source.status.note ? (
          <p data-testid={legacy?.note}>{source.status.note}</p>
        ) : undefined
      }
      actions={
        <>
          {onRemove && source.actions.remove && (
            <NoticeButton
              variant="secondary"
              onClick={onRemove}
              data-testid={legacy?.remove}
            >
              Remove marketplace
            </NoticeButton>
          )}
          {source.actions.update && (
            <NoticeButton
              variant="primary"
              disabled={updating}
              onClick={onUpdate}
              data-testid={
                legacy?.update ?? 'marketplace-source-invalid-update'
              }
            >
              {legacy
                ? updating
                  ? 'Trying again…'
                  : 'Try again'
                : updating
                  ? 'Updating…'
                  : 'Update'}
            </NoticeButton>
          )}
          {onRefresh && (
            <NoticeButton
              variant="secondary"
              disabled={refreshing}
              onClick={onRefresh}
              data-testid="marketplace-source-invalid-refresh"
            >
              Refresh status
            </NoticeButton>
          )}
        </>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {source.status.errors.map((error, index) => (
          <li key={`${error.label}-${index}`}>
            {error.label}:{' '}
            <span className={REPLAY_BLOCK_CLASS}>{error.message}</span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
