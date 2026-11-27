'use client';

import { useRef, useState, type JSX } from 'react';
import type { LedgerRootChatFilter } from '@canopy/protocol/canopy-core';
import {
  Picker,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerTrigger,
  PickerTriggerChevron,
  ThinkingSpinner,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { ChatIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** A chat a person started in the task: a root of its own agents' work. */
export interface LedgerFeedRootChat {
  readonly chatId: string;
  readonly title: string;
  /** Working now, as the chat's tab shows. */
  readonly live: boolean;
}

export const LEDGER_ROOT_CHAT_PICKER_LABEL = 'Root chat';
export const LEDGER_ROOT_CHAT_ALL_LABEL = 'All';
export const LEDGER_ROOT_ACTIVITY_ONLY_LABEL = 'Root activity only';

/** The filter for a picked chat (null for All) and the switch. */
export function ledgerRootChatFilter(
  chatId: string | null,
  rootOnly: boolean,
): LedgerRootChatFilter | null {
  if (!rootOnly && chatId === null) return null;
  return chatId === null ? { rootOnly } : { rootOnly, chatId };
}

export interface LedgerRootChatFilterBarProps {
  readonly rootChats: readonly LedgerFeedRootChat[];
  readonly filter: LedgerRootChatFilter | null;
  readonly onChange: (filter: LedgerRootChatFilter | null) => void;
}

/**
 * The Feed panel's root chat picker, All by default, and its Root activity
 * only switch. A picked chat shows its line of agents' work; the switch keeps
 * only what root chats themselves added, from the picked chat or any.
 */
export function LedgerRootChatFilterBar({
  rootChats,
  filter,
  onChange,
}: LedgerRootChatFilterBarProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const chatId = filter?.chatId ?? null;
  const rootOnly = filter?.rootOnly ?? false;
  const picked = rootChats.find((chat) => chat.chatId === chatId);
  const pick = (next: string | null): void => {
    setOpen(false);
    onChange(ledgerRootChatFilter(next, rootOnly));
  };
  const option = (
    key: string,
    selected: boolean,
    label: JSX.Element,
    leading: JSX.Element,
    onSelect: () => void,
  ): JSX.Element => (
    <PickerOption
      key={key}
      role="menuitemradio"
      aria-checked={selected}
      selected={selected}
      data-testid="ledger-root-chat-option"
      data-chat-id={key}
      onClick={onSelect}
    >
      <PickerOptionLeading>{leading}</PickerOptionLeading>
      <PickerOptionContent>
        <PickerOptionLabel>{label}</PickerOptionLabel>
      </PickerOptionContent>
      <PickerOptionCheck selected={selected} />
    </PickerOption>
  );

  return (
    <div
      data-testid="ledger-root-chat-filter"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div className="relative min-w-0">
        <PickerTrigger
          ref={triggerRef}
          data-testid="ledger-root-chat-picker"
          aria-label={LEDGER_ROOT_CHAT_PICKER_LABEL}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={(): void => setOpen((current) => !current)}
          className="max-w-64"
        >
          <ChatIcon size={14} aria-hidden />
          {picked === undefined ? (
            <span className="min-w-0 truncate">
              {LEDGER_ROOT_CHAT_ALL_LABEL}
            </span>
          ) : (
            <span className={`${REPLAY_MASK_CLASS} min-w-0 truncate`}>
              {picked.title}
            </span>
          )}
          <PickerTriggerChevron open={open} />
        </PickerTrigger>
        <Picker
          open={open}
          onOpenChange={setOpen}
          anchorRef={triggerRef}
          placement="bottom-left"
          interaction="menu"
          data-testid="ledger-root-chat-menu"
        >
          <div aria-label={LEDGER_ROOT_CHAT_PICKER_LABEL}>
            {option(
              'all',
              chatId === null,
              <span>{LEDGER_ROOT_CHAT_ALL_LABEL}</span>,
              <ChatIcon size={14} />,
              (): void => pick(null),
            )}
            {rootChats.map((chat) =>
              option(
                chat.chatId,
                chat.chatId === chatId,
                <span className={REPLAY_MASK_CLASS}>{chat.title}</span>,
                chat.live ? (
                  <ThinkingSpinner sizePx={12} tone="accent" />
                ) : (
                  <ChatIcon size={14} />
                ),
                (): void => pick(chat.chatId),
              ),
            )}
          </div>
        </Picker>
      </div>
      <div className="flex items-center gap-2 text-xs fg-secondary">
        <span>{LEDGER_ROOT_ACTIVITY_ONLY_LABEL}</span>
        <ToggleSwitch
          label={LEDGER_ROOT_ACTIVITY_ONLY_LABEL}
          checked={rootOnly}
          dataTestId="ledger-root-activity-only"
          onChange={(on): void => onChange(ledgerRootChatFilter(chatId, on))}
        />
      </div>
    </div>
  );
}
