// Grouped recipient picker for choosing the chat a watcher posts to when it
// fires (the watcher's `destination`). Shared by the chat-surface watcher
// modal's "Add" action (App Advisor recipients only) and the pipeline-run
// modal's watcher toggle (App Advisor recipients plus the current worktree's
// chats). Renders a rich dropdown with inline group headers and a separator
// between groups; each group header (and the selected recipient on the trigger)
// is prefixed with its group icon — the App Advisor glyph for App Advisor chats
// and a chat bubble for the current worktree's chats.
//
// The open menu is the shared `Picker`, which portals itself, so
// an ancestor's `overflow-hidden` (e.g. the pipeline-run dialog modal) never
// clips it.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import {
  Button,
  Picker,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerSection,
  PickerSectionLabel,
} from '@canopy/ui-shared';
import { AppAdvisorIcon, ChatIcon } from '@canopy/ui-shared/icons';
import {
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  type AppIconProps,
} from '@canopy/ui-shared/icons/AppIcons';

type RecipientGroupKey = 'app-advisor' | 'worktree';

/**
 * Icon for a recipient group, keyed by group: the App Advisor glyph for App
 * Advisor chats and a chat bubble for the current worktree's chats. Reused for
 * both the group headers and the selected-recipient display on the trigger so
 * the picker reads consistently in the pipeline-run modal and the chat watcher
 * management modal.
 */
const RECIPIENT_GROUP_ICONS: Readonly<
  Record<RecipientGroupKey, (props: AppIconProps) => JSX.Element>
> = {
  'app-advisor': AppAdvisorIcon,
  worktree: ChatIcon,
};

export interface WatcherRecipientOption {
  /** Destination chat the fired watcher posts to. */
  destination: AppAdvisorWatcherDestination;
  /** Display label (chat title). */
  label: string;
  /**
   * When true this option is the preferred default selection (e.g. the active
   * chat in the relevant worktree). Consumers that auto-select a recipient
   * should prefer it over list order.
   */
  preferredDefault?: boolean;
}

export interface WatcherRecipientGroup {
  key: RecipientGroupKey;
  /** Inline header label for this group. */
  label: string;
  options: WatcherRecipientOption[];
}

export interface WatcherRecipientPickerProps {
  groups: WatcherRecipientGroup[];
  value: AppAdvisorWatcherDestination | null;
  onChange: (destination: AppAdvisorWatcherDestination) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Open above (`top`) or below (`bottom`) the trigger. Defaults to bottom. */
  placement?: 'top' | 'bottom';
  dataTestId?: string;
}

function destinationsEqual(
  a: AppAdvisorWatcherDestination | null,
  b: AppAdvisorWatcherDestination,
): boolean {
  return (
    a !== null &&
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.chatId === b.chatId
  );
}

export function WatcherRecipientPicker({
  groups,
  value,
  onChange,
  placeholder = 'Select a chat…',
  disabled = false,
  placement = 'bottom',
  dataTestId = 'watcher-recipient-picker',
}: WatcherRecipientPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const totalOptions = useMemo(
    () => groups.reduce((count, group) => count + group.options.length, 0),
    [groups],
  );

  const selected = useMemo((): {
    label: string;
    groupKey: RecipientGroupKey;
  } | null => {
    for (const group of groups) {
      for (const option of group.options) {
        if (destinationsEqual(value, option.destination)) {
          return { label: option.label, groupKey: group.key };
        }
      }
    }
    return null;
  }, [groups, value]);

  const handleSelect = useCallback(
    (destination: AppAdvisorWatcherDestination): void => {
      onChange(destination);
      setOpen(false);
    },
    [onChange],
  );

  const SelectedGroupIcon = selected
    ? RECIPIENT_GROUP_ICONS[selected.groupKey]
    : null;
  const isDisabled = disabled || totalOptions === 0;
  const triggerLabel =
    selected?.label ??
    (totalOptions === 0 ? 'No chats available' : placeholder);

  return (
    <div className="electron-no-drag relative">
      {/* A dropdown is a field: the 28px rounded rectangle, like
          `SettingsSelect`, not the capsule of the actions beside it. */}
      <Button
        ref={triggerRef}
        size="field"
        variant="secondary"
        disabled={isDisabled}
        onClick={(): void => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${dataTestId}-trigger`}
        className="min-w-48 max-w-72"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {SelectedGroupIcon && (
            <SelectedGroupIcon
              size="sm"
              aria-hidden="true"
              className="shrink-0 fg-secondary"
            />
          )}
          <span
            className={`truncate ${selected ? 'fg-primary' : 'fg-secondary'}`}
          >
            {triggerLabel}
          </span>
        </span>
        <AppCatalogChevronDownMediumIcon
          size="sm"
          aria-hidden="true"
          className="shrink-0 fg-secondary"
        />
      </Button>

      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        // Right edges line up with the trigger.
        placement={placement === 'top' ? 'top-right' : 'bottom-right'}
        interaction="listbox"
        role="listbox"
        aria-label="Watcher recipient"
        minimumWidth="18rem"
        heightLimit={256}
        data-testid={`${dataTestId}-menu`}
      >
        {/* Portaled over window drag regions; app-region ignores z-order. */}
        <div className="electron-no-drag">
          {groups
            .filter((group) => group.options.length > 0)
            .map((group, groupIndex) => {
              const GroupIcon = RECIPIENT_GROUP_ICONS[group.key];
              const rows = (
                <>
                  <PickerSectionLabel>
                    <span className="flex items-center gap-1.5">
                      <GroupIcon
                        size="sm"
                        aria-hidden="true"
                        className="shrink-0"
                      />
                      <span>{group.label}</span>
                    </span>
                  </PickerSectionLabel>
                  {group.options.map((option) => {
                    const isSelected = destinationsEqual(
                      value,
                      option.destination,
                    );
                    return (
                      <PickerOption
                        key={option.destination.chatId}
                        role="option"
                        aria-selected={isSelected}
                        selected={isSelected}
                        onClick={(): void => handleSelect(option.destination)}
                        data-testid={`${dataTestId}-option-${option.destination.chatId}`}
                      >
                        <PickerOptionContent>
                          <PickerOptionLabel>{option.label}</PickerOptionLabel>
                        </PickerOptionContent>
                        <PickerOptionCheck selected={isSelected} />
                      </PickerOption>
                    );
                  })}
                </>
              );
              // Each group after the first opens with the section rule.
              return groupIndex === 0 ? (
                <div key={group.key}>{rows}</div>
              ) : (
                <PickerSection key={group.key}>{rows}</PickerSection>
              );
            })}
        </div>
      </Picker>
    </div>
  );
}
