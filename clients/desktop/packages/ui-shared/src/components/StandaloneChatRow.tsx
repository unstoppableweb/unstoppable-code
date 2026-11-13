import type { JSX, KeyboardEvent } from 'react';
import type { ModelCatalogProvider } from '@canopy/protocol/models';
import { ArchiveIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { ModelProviderIcon } from '../icons/ModelProviderIcon';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export type StandaloneChatProviderType = ModelCatalogProvider;

export interface StandaloneChatRowProps {
  /** Title to display. */
  title: string;
  /** Optional model label sub-text. */
  modelLabel?: string;
  /** Provider that owns the chat. Drives the leading provider icon. */
  providerType?: StandaloneChatProviderType;
  /** True for archived chats (read-only, muted treatment). */
  archived?: boolean;
  /** True when an archive request is in flight (disables selection). */
  archivingInFlight?: boolean;
  /** Whether the row is the currently-selected chat. */
  selected?: boolean;
  /** Click handler for selecting this chat. */
  onSelect?: () => void;
  /** Click handler for archiving this chat. When omitted, the archive
   * button is hidden. */
  onArchive?: () => void;
  /** Stable testid hook for automation on the outer wrapper. */
  dataTestId?: string;
  /** Forwarded as `data-standalone-chat-id` for automation. */
  dataChatId?: string;
  /**
   * Enforce a ≥44px touch target on the row (CAN-1206). Opt-in so the desktop
   * side rail stays pixel-identical; the web portal passes it only for the
   * mobile-drawer variant.
   */
  touchTarget?: boolean;
}

/**
 * Standalone chat list row. Renders the provider icon, the title and an
 * optional model label, and an archive button revealed on hover and always
 * visible on coarse pointers. Pure display: hosts wire up selection, archive,
 * and provider icon dispatch.
 */
export function StandaloneChatRow({
  title,
  modelLabel,
  providerType,
  archived = false,
  archivingInFlight = false,
  selected = false,
  onSelect,
  onArchive,
  dataTestId,
  dataChatId,
  touchTarget = false,
}: StandaloneChatRowProps): JSX.Element {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (archivingInFlight) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    }
  };

  // The shared sidebar row: 32px, the Work Entry row's 6px inset and gap,
  // selection by background alone. A model label adds a second line, so the
  // row grows from the same floor instead of taking its own padding.
  const heightClass = touchTarget
    ? 'min-h-11'
    : modelLabel
      ? 'min-h-8 py-1'
      : 'h-8 py-0';
  const wrapperBaseClass = `group flex w-full min-w-0 cursor-pointer items-center ${heightClass} gap-1.5 rounded-row px-1.5 text-left text-s transition-colors`;
  const stateClass = selected
    ? 'bg-muted fg-primary'
    : archived
      ? 'fg-tertiary hover:bg-subtle'
      : 'fg-secondary hover:bg-subtle';

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={dataTestId}
      data-standalone-chat-id={dataChatId}
      data-archived={archived ? 'true' : 'false'}
      onClick={() => {
        if (!archivingInFlight) onSelect?.();
      }}
      onKeyDown={handleKeyDown}
      className={`${wrapperBaseClass} ${stateClass} ${archivingInFlight ? 'pointer-events-none opacity-50' : ''}`}
    >
      {providerType ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center fg-tertiary">
          <ModelProviderIcon provider={providerType} central size={16} />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p
          className={`${REPLAY_MASK_CLASS} min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-s font-normal leading-snug`}
          title={title}
        >
          {title}
        </p>
        {modelLabel && (
          <p className="truncate text-3xs fg-secondary">{modelLabel}</p>
        )}
      </div>
      {onArchive && !archived && (
        // The wrapper owns the reveal; the 28px quiet icon button overhangs
        // the row's 6px end inset (`-mx-1`), so the title keeps its width.
        <span className="-mx-1 inline-flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          <Button
            variant="ghost-quiet"
            size="sm"
            iconOnly
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            aria-label="Archive chat"
            data-testid="standalone-chat-row-archive"
          >
            <ArchiveIcon size={14} aria-hidden="true" />
          </Button>
        </span>
      )}
    </div>
  );
}
