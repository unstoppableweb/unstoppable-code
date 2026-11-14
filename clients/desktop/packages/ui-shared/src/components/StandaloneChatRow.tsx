import { useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { ModelCatalogProvider } from '@canopy/protocol/models';
import { ArchiveIcon, MoreHorizontalIcon } from '../icons/AppIcons';
import { ModelProviderIcon } from '../icons/ModelProviderIcon';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { RailIconButton } from './RailIconButton';
import { FloatingMenu } from './FloatingMenu';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { WorkEntryRowMenuItems } from './WorkEntryRow';

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys on the nested Archive button are that button's own activation.
    if (archivingInFlight || event.target !== event.currentTarget) return;
    if (
      onArchive &&
      !archived &&
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    ) {
      event.preventDefault();
      setMenuOpen(true);
      return;
    }
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
  const wrapperBaseClass = `group group/sidebar-item flex w-full min-w-0 cursor-pointer items-center ${heightClass} gap-1.5 rounded-row px-1.5 text-left text-s transition-colors`;
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
      aria-disabled={archivingInFlight || undefined}
      aria-busy={archivingInFlight || undefined}
      onClick={() => {
        if (!archivingInFlight) onSelect?.();
      }}
      onKeyDown={handleKeyDown}
      onContextMenu={
        onArchive && !archived
          ? (event): void => {
              event.preventDefault();
              event.stopPropagation();
              if (!archivingInFlight) setMenuOpen(true);
            }
          : undefined
      }
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
        <span
          className="flex shrink-0 items-center"
          onClick={(event): void => event.stopPropagation()}
          onKeyDown={(event): void => event.stopPropagation()}
        >
          <RailIconButton
            icon={ArchiveIcon}
            iconSize={14}
            disabled={archivingInFlight}
            onClick={onArchive}
            revealOnItemHover
            aria-label="Archive chat"
            tooltipLabel="Archive this entry and all of its chats"
            data-testid="standalone-chat-row-archive"
          />
          <RailIconButton
            ref={menuAnchor}
            icon={MoreHorizontalIcon}
            disabled={archivingInFlight}
            coarsePointerTarget
            touchTarget={touchTarget}
            onClick={(): void => setMenuOpen((open) => !open)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="standalone-chat-row-menu"
          />
          <FloatingMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            anchorRef={menuAnchor}
            placement="bottom-right"
            interaction="menu"
          >
            <ActionMenuRowStyle>
              <WorkEntryRowMenuItems
                menu={{
                  close: (): void => setMenuOpen(false),
                  testIdFor: (suffix): string =>
                    `standalone-chat-row-menu${suffix}`,
                }}
                archiveTitle="Archive this entry and all of its chats"
                removalDisabledReason={
                  archivingInFlight ? 'Archiving…' : undefined
                }
                onArchive={onArchive}
              />
            </ActionMenuRowStyle>
          </FloatingMenu>
        </span>
      )}
    </div>
  );
}
