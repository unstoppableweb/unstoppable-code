'use client';

import { Button } from './Button';
import { OverlayScrollArea } from './OverlayScrollArea';
import {
  useId,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CheckIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { groupContiguousRuns } from '../lib/group-runs';
import {
  SlashCommandAvailabilityTag,
  SlashCommandGroupHeading,
  SlashCommandPendingSpinner,
} from './SlashCommandPrimitives';
import { Notice } from './Notice';
import { Tooltip } from './Tooltip';
import { EmptyStateRow, ErrorBanner } from './StatusBlocks';

export interface ComposerActionRow {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  group: string;
  value?: string;
  opensMenu?: boolean;
  popupRole?: 'menu' | 'dialog';
  disabled?: boolean;
  selected?: boolean;
  /** Toggle rows (plan mode, plugins) expose their state as `aria-pressed`. */
  ariaChecked?: boolean;
  /**
   * Makes the row one choice of a single-select picker: it renders as
   * `role="radio"` with `aria-checked` and a trailing checkmark instead of a
   * pressed toggle or a persistent highlight. A group whose rows all set this
   * becomes a `radiogroup`. Leave it undefined for action and toggle rows.
   */
  checked?: boolean;
  dataTestId?: string;
  /** A typeahead suggestion that Tab may complete (files, plugins, commands). */
  completion?: boolean;
  /** Selecting this row enables its skill or plugin before insertion. */
  available?: boolean;
  /**
   * The row's pick is still running (its skill or plugin is being enabled):
   * the row stays in place and in the keyboard's reach, shows a spinner,
   * says so in `description`, and ignores activation until it settles.
   */
  busy?: boolean;
  onSelect: () => void;
}

/**
 * A pick that did not do what it set out to, shown above the rows until the
 * person moves on: a failure (`error`, the default), or a pick that finished
 * part of its work (`attention`: a command was enabled but not added).
 */
export interface ComposerActionListError {
  message: string;
  /** `attention` only: leads the message, like a notice title. */
  title?: string;
  tone?: 'error' | 'attention';
  /** Only for a failure that trying again can fix. */
  onRetry?: () => void;
  /** The retry is running. */
  retrying?: boolean;
}

/** A control that expands a capped result list; never a completion row. */
export interface ComposerShowAllControl {
  label: string;
  onSelect: () => void;
  dataTestId?: string;
}

const COMPOSER_SHOW_ALL_ROW_ID = 'show-all';

function isRadioRow(row: ComposerActionRow): boolean {
  return row.checked !== undefined;
}

/** Shared presentation for composer action catalogs; the host owns execution. */
export function ComposerActionList({
  rows,
  menuRef,
  activeId,
  onActiveIdChange,
  onHoveredIdChange,
  onBack,
  scope,
  loading,
  dataTestIdPrefix,
  blockRowsFromReplay = false,
  groupRuns = false,
  flat = false,
  showAll,
  error = null,
}: {
  rows: ComposerActionRow[];
  menuRef?: RefObject<HTMLDivElement | null>;
  activeId?: string | null;
  onActiveIdChange?: (id: string | null) => void;
  /** Reports the enabled row under the pointer (`null` when none). */
  onHoveredIdChange?: (id: string | null) => void;
  onBack?: () => void;
  scope?: string;
  loading?: boolean;
  dataTestIdPrefix: string;
  /**
   * Mark each group's rows (not its heading) with the session-replay block
   * class, so a recorder keeps a same-size placeholder instead of serializing
   * a large catalog when the menu opens.
   */
  blockRowsFromReplay?: boolean;
  /**
   * Head each contiguous run of a group instead of collecting a group's rows
   * together, so a ranked list keeps its order. Collected by default.
   */
  groupRuns?: boolean;
  /** Render ranked search results as one list without section headings. */
  flat?: boolean;
  /** Renders after the groups when a capped list has hidden rows. */
  showAll?: ComposerShowAllControl;
  /** A failed pick, above the rows, while the menu stays open. */
  error?: ComposerActionListError | null;
}): JSX.Element {
  const listId = useId();
  const [localActiveId, setLocalActiveId] = useState<string | null>(null);
  const highlightedId = activeId === undefined ? localActiveId : activeId;
  const setHighlightedId = onActiveIdChange ?? setLocalActiveId;
  // No rows means no results group: an empty one would add its bottom margin
  // above the empty and loading message.
  const groups = flat
    ? rows.length > 0
      ? [{ key: 'Search results', occurrence: 0, rows }]
      : []
    : groupRuns
      ? groupContiguousRuns(rows, (row) => row.group)
      : Array.from(new Set(rows.map((row) => row.group))).map((group) => ({
          key: group,
          occurrence: 0,
          rows: rows.filter((row) => row.group === group),
        }));
  const showAllId = `${listId}-${COMPOSER_SHOW_ALL_ROW_ID}`;
  return (
    <div
      ref={menuRef}
      id={listId}
      className="flex min-h-0 flex-col"
      onPointerMove={(event) => {
        // A real pointer move hands the menu back to the mouse: the keyboard
        // highlight clears so the hovered row's hover style shows, and the
        // host activates that hovered row on Enter (`onHoveredIdChange`).
        // Layout/scroll events under a stationary pointer must not override
        // the keyboard.
        if (event.movementX !== 0 || event.movementY !== 0)
          setHighlightedId(null);
      }}
      onKeyDown={(event) => {
        if (
          !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(
            event.key,
          )
        )
          return;
        const radioGroup =
          event.target instanceof Element
            ? event.target.closest('[role="radiogroup"]')
            : null;
        if (!radioGroup && ['ArrowLeft', 'ArrowRight'].includes(event.key))
          return;
        const buttons = Array.from(
          (
            radioGroup ?? event.currentTarget
          ).querySelectorAll<HTMLButtonElement>(
            '[data-action-row]:not(:disabled)',
          ),
        );
        if (!buttons.length) return;
        event.preventDefault();
        if (radioGroup) event.stopPropagation();
        const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const index =
          event.target instanceof HTMLButtonElement
            ? buttons.indexOf(event.target)
            : -1;
        const next =
          index < 0
            ? forward
              ? 0
              : buttons.length - 1
            : (index + (forward ? 1 : -1) + buttons.length) % buttons.length;
        setHighlightedId(buttons[next].id);
        buttons[next].focus();
        buttons[next].scrollIntoView?.({ block: 'nearest' });
        if (radioGroup) buttons[next].click();
      }}
    >
      {onBack && (
        <div
          className="flex shrink-0 items-center gap-2 px-2 py-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button
            variant="ghost"
            size="compact"
            onClick={onBack}
            aria-label="Back to all actions"
          >
            <ChevronLeftMediumIcon size="sm" aria-hidden className="shrink-0" />
            {scope}
          </Button>
        </div>
      )}
      {error && (
        // The banner keeps the editor's focus like the rows do; its Try
        // again is still a button for keyboard users.
        <div
          className="shrink-0 px-2 pt-2"
          onMouseDown={(event) => event.preventDefault()}
        >
          {error.tone === 'attention' ? (
            <Notice
              intent="attention"
              {...(error.title ? { title: error.title } : {})}
              data-testid={`${dataTestIdPrefix}-menu-notice`}
            >
              {error.message}
            </Notice>
          ) : (
            <ErrorBanner
              errorSource="composer-action-list"
              className=""
              error={error.message}
              {...(error.onRetry ? { onRetry: error.onRetry } : {})}
              retrying={error.retrying ?? false}
              testId={`${dataTestIdPrefix}-menu-error`}
            />
          )}
        </div>
      )}
      <OverlayScrollArea
        className="min-h-0 flex-1"
        viewport="menu"
        contentClassName="flex min-w-0 flex-col gap-1.5 py-1"
        railClassName="-right-1"
        thumbEndInset={20}
        edgeFadeSize={8}
        viewportProps={{ 'data-testid': `${dataTestIdPrefix}-menu-scroll` }}
      >
        {groups.map(({ key: group, occurrence, rows: groupRows }) => {
          const radioGroup = groupRows.every(isRadioRow);
          const tabStop = radioGroup
            ? (groupRows.find((row) => row.checked && !row.disabled) ??
              groupRows.find((row) => !row.disabled))
            : undefined;
          return (
            <div
              key={`${group}:${occurrence}`}
              role={radioGroup ? 'radiogroup' : 'group'}
              aria-label={group}
              data-testid={`${dataTestIdPrefix}-plus-${group === 'Current settings' ? 'settings' : group.toLowerCase().replace(/ /g, '-')}${occurrence > 0 ? `-${occurrence}` : ''}`}
            >
              {!flat && <SlashCommandGroupHeading label={group} compact />}
              {/* Rows sit in their own wrapper so replay can block them while
                the group heading above stays recorded. */}
              <div
                className={blockRowsFromReplay ? REPLAY_BLOCK_CLASS : undefined}
              >
                {groupRows.map((row) => (
                  <button
                    key={row.id}
                    id={`${listId}-${encodeURIComponent(row.id)}`}
                    type="button"
                    data-action-row
                    data-row-id={row.id}
                    data-completion-row={row.completion || undefined}
                    data-testid={row.dataTestId}
                    disabled={row.disabled}
                    aria-disabled={row.busy || undefined}
                    aria-busy={row.busy || undefined}
                    role={isRadioRow(row) ? 'radio' : undefined}
                    tabIndex={
                      radioGroup ? (row === tabStop ? 0 : -1) : undefined
                    }
                    aria-checked={row.checked}
                    aria-pressed={isRadioRow(row) ? undefined : row.ariaChecked}
                    aria-haspopup={row.popupRole}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={row.busy ? undefined : row.onSelect}
                    onPointerEnter={(event) =>
                      onHoveredIdChange?.(
                        row.disabled ? null : event.currentTarget.id,
                      )
                    }
                    onPointerLeave={() => onHoveredIdChange?.(null)}
                    className={`focus-ring flex min-h-8 w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs fg-primary disabled:opacity-50 ${highlightedId ? (highlightedId === `${listId}-${encodeURIComponent(row.id)}` ? 'bg-subtle' : '') : row.selected ? 'bg-subtle' : 'hover:bg-subtle'}`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary [&>svg]:!h-4 [&>svg]:!w-4">
                      {row.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                      <span className="max-w-full shrink-0 truncate">
                        {row.label}
                      </span>
                      {row.description && (
                        <Tooltip
                          label={row.description}
                          clamp
                          allowShrink
                          delay="long"
                          replayBlock
                        >
                          <span
                            data-action-description
                            className="min-w-0 truncate text-xs fg-tertiary"
                          >
                            {row.description}
                          </span>
                        </Tooltip>
                      )}
                    </span>
                    {row.available && <SlashCommandAvailabilityTag />}
                    {row.busy && <SlashCommandPendingSpinner />}
                    {(row.value !== undefined || row.opensMenu) && (
                      <span
                        data-menu-trailing
                        className="ml-auto flex max-w-2/5 shrink-0 items-center gap-1 fg-tertiary"
                      >
                        {row.value !== undefined && (
                          <span
                            data-menu-value
                            className="min-w-0 truncate text-right text-xs fg-tertiary"
                            title={row.value}
                          >
                            {row.value}
                          </span>
                        )}
                        {row.opensMenu && (
                          <ChevronRightMediumIcon
                            size="sm"
                            data-menu-chevron
                            aria-hidden
                            className="shrink-0 fg-tertiary"
                          />
                        )}
                      </span>
                    )}
                    {isRadioRow(row) && (
                      // A fixed check column keeps every choice aligned; the
                      // glyph, not a background, marks the selected choice.
                      <span
                        aria-hidden
                        className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center fg-primary"
                      >
                        {row.checked && (
                          <CheckIcon
                            data-radio-check
                            data-menu-check
                            size="sm"
                          />
                        )}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {showAll && rows.length > 0 && (
          <button
            id={showAllId}
            type="button"
            data-action-row
            data-show-all-row
            data-testid={showAll.dataTestId}
            onMouseDown={(event) => event.preventDefault()}
            onClick={showAll.onSelect}
            onPointerEnter={(event) =>
              onHoveredIdChange?.(event.currentTarget.id)
            }
            onPointerLeave={() => onHoveredIdChange?.(null)}
            className={`focus-ring flex min-h-8 w-full items-center rounded-xl px-2 py-1 text-left text-xs fg-secondary ${highlightedId === showAllId ? 'bg-subtle' : highlightedId ? '' : 'hover:bg-subtle'}`}
          >
            {showAll.label}
          </button>
        )}
        {rows.length === 0 && (
          // The shared empty-list line owns its height and type; the wrapper
          // only sets the rows' inset, so the empty and loading menus keep the
          // list's normal padding instead of a tall card.
          <div className="px-2">
            <EmptyStateRow
              title={
                loading
                  ? 'Discovering skills and commands…'
                  : 'No matching actions, skills, or plugins'
              }
            />
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
