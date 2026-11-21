'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CloseIcon, SearchIcon, SearchXIcon } from '../icons/AppIcons';
import {
  DIALOG_INITIAL_FOCUS_TARGET_EVENT,
  DIALOG_INITIAL_FOCUS_TARGET_SELECTOR,
} from '../lib/dialog-initial-focus';
import { Button, ControlButton } from './Button';
import { FIELD_EDGE_CLASS, FIELD_FOCUS_WITHIN_CLASS } from './Field';
import {
  FieldButtonNestProvider,
  useFieldButtonNest,
  type FieldButtonNest,
} from './field-button-nest';
import { Kbd, type KbdNest } from './Kbd';
import { EmptyState } from './StatusBlocks';
import { Tooltip } from './Tooltip';

/**
 * Search field size. `sm` is the 28px field of toolbars, panels and
 * settings lists; `md` is the 32px field of a page search row, on the
 * subtle fill inside a hairline and filling its row (see
 * `PageSearchRow`); `lg` is the 44px
 * borderless header of a palette or picker.
 */
export type SearchFieldSize = 'sm' | 'md' | 'lg';

/**
 * The field's height, insets and type. A search field is a field, so it is
 * a rounded rectangle, not a capsule (design decisions, 2026-10-30): 10px
 * `rounded-row` corners at 28px and at 32px (12px scaled to 32px is about
 * 10.7px; the nearest token is 10px).
 * The trailing inset is the gap between the field and a nested button
 * above and below it (2px at 28px, 4px at 32px, 8px at 44px). Coarse
 * pointers get a taller field with the inset grown to match.
 */
const FIELD_SIZE_CLASS: Record<SearchFieldSize, string> = {
  sm: `h-7 gap-2 rounded-row pl-2.5 pr-0.5 text-xs pointer-coarse:h-9 pointer-coarse:pr-1.5 ${FIELD_EDGE_CLASS} ${FIELD_FOCUS_WITHIN_CLASS}`,
  // A page search row's field: the shared inset hairline at rest; focus
  // swaps it for the shared field focus edge. Its text matches the 28px
  // dropdowns beside it.
  md: `h-8 gap-2 rounded-row pl-3 pr-1 text-xs pointer-coarse:h-10 pointer-coarse:pr-2 ring-[length:var(--border-hairline)] ring-inset ring-line-base transition-shadow has-[input:focus]:ring-0 ${FIELD_FOCUS_WITHIN_CLASS}`,
  // The header of a surface that is itself the focus (a palette): no edge
  // and no focus ring of its own; the host draws the hairline under it.
  lg: 'h-11 gap-2.5 pl-4 pr-2 text-s',
};

/**
 * The fill. A page search row's field (`md`) rests on the subtle fill inside
 * a hairline, so it reads as the page's one search rather than another form
 * field. Like every field, it keeps its fill while its input has focus.
 */
const FIELD_FILL_CLASS: Record<SearchFieldSize, string> = {
  sm: 'bg-transparent',
  md: 'bg-subtle',
  lg: 'bg-transparent',
};

/** Clear's glyph: 12px in a page search row's field, 14px elsewhere. */
const CLEAR_ICON_SIZE: Record<SearchFieldSize, number> = {
  sm: 14,
  md: 12,
  lg: 14,
};

/**
 * The field its buttons nest in: 24px buttons with the field's corner less
 * their inset in the 28px and 32px fields. The 44px header has no edge of its
 * own to nest in, so its 28px buttons stay round.
 */
const BUTTON_NEST: Record<SearchFieldSize, FieldButtonNest> = {
  sm: 'field',
  md: 'field-md',
  lg: 'header',
};

/**
 * The shortcut caps' corner: nested in the 28px and 32px fields. The 44px
 * header has no edge of its own to nest in, so its caps stay capsules.
 */
const SHORTCUT_NEST: Record<SearchFieldSize, KbdNest | undefined> = {
  sm: 'field',
  md: 'field-md',
  lg: undefined,
};

/**
 * The caps' inset from the field's end, added to the field's own trailing
 * inset (sized for a 24px nested button) so the 18px caps sit as far from
 * the end as from the top and bottom: 5px at 28px, 7px at 32px, 13px at 44px.
 */
const SHORTCUT_INSET_CLASS: Record<SearchFieldSize, string> = {
  sm: 'pr-0.75',
  md: 'pr-0.75',
  lg: 'pr-1.25',
};

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | 'size'
  | 'type'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'className'
  | 'aria-label'
  | 'children'
> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Accessible name: `Search workflows`. The field has no visible label. */
  readonly 'aria-label': string;
  readonly size?: SearchFieldSize;
  /**
   * The result count shown while there is a query (`2 of 6`). The field
   * never says "no results" itself; the list's empty state does.
   */
  readonly count?: ReactNode;
  /**
   * Text that stays at the field's end whatever the query, before Clear:
   * a mode hint such as the palette's `Type > for commands`.
   */
  readonly trailing?: ReactNode;
  /**
   * The keys that focus this field (`⌘K`, see `formatShortcut`), drawn as
   * caps at its end while it is empty. The caps nest in the field: the same
   * inset from its end as from its top and bottom, and the field's corner
   * less that inset. Not for a field that also has `actions`.
   */
  readonly shortcut?: string | readonly string[];
  /**
   * Nested controls at the field's end, after Clear: `SearchFieldButton`s
   * that open filters or a sort.
   */
  readonly actions?: ReactNode;
  readonly clearLabel?: string;
  readonly clearTestId?: string;
  readonly 'data-dialog-initial-focus'?: string;
  /**
   * Escape first clears the query; on an empty field it calls
   * `onEscapeEmpty`, or gives up focus without one. Set false where Escape
   * already means something else (a palette closes on it).
   */
  readonly clearOnEscape?: boolean;
  /** Escape on an empty field: the host backs out (a category, a page). */
  readonly onEscapeEmpty?: () => void;
  /** `data-testid` of the box around the input. */
  readonly fieldTestId?: string;
  /** Placement only (width, margins, flex); the field owns its shape. */
  readonly className?: string;
  /** Classes for the input itself, such as the session replay block class. */
  readonly inputClassName?: string;
  /**
   * `search` (default) is a searchbox. `text` keeps the textbox role, for a
   * find bar that hosts and UI automation already address as a textbox.
   */
  readonly inputType?: 'search' | 'text';
}

/**
 * The one search field: the search glyph at its start and buttons nested
 * in its end, each with the field's corner less its inset. While the field holds a query the end shows the
 * result count and a Clear button; filter and sort buttons follow a
 * hairline. `sm` and `md` rest on the shared field edge and focus to the
 * neutral field focus, like `TextInput`.
 *
 * The browser's own clear control is never drawn. The query is user text:
 * it stays inside the input and is never copied into an attribute.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      value,
      onValueChange,
      size = 'sm',
      count,
      trailing,
      shortcut,
      actions,
      clearLabel = 'Clear search',
      clearTestId,
      'data-dialog-initial-focus': dialogInitialFocus,
      clearOnEscape = true,
      onEscapeEmpty,
      fieldTestId,
      className = '',
      inputClassName = '',
      inputType = 'search',
      onKeyDown,
      disabled,
      ...inputProps
    },
    ref,
  ): JSX.Element {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const setInput = useCallback(
      (node: HTMLInputElement | null): void => {
        inputRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    const hasValue = value !== '';
    const hasCount = hasValue && count !== undefined && count !== null;
    const hasTrailing = trailing !== undefined && trailing !== null;

    useEffect(() => {
      // Let an already-open surface focus a marked search that mounted later.
      const input = inputRef.current;
      const EventConstructor = input?.ownerDocument.defaultView?.Event;
      if (
        !input ||
        !EventConstructor ||
        dialogInitialFocus === undefined ||
        !input.matches(DIALOG_INITIAL_FOCUS_TARGET_SELECTOR)
      )
        return;
      input.dispatchEvent(
        new EventConstructor(DIALOG_INITIAL_FOCUS_TARGET_EVENT, {
          bubbles: true,
        }),
      );
    }, [dialogInitialFocus]);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
      onKeyDown?.(event);
      // An Escape that dismisses an input-method candidate belongs to the
      // input method. Safari reports it with keyCode 229.
      if (
        !clearOnEscape ||
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (hasValue) {
        // Clearing is this Escape's whole job; nothing behind the field
        // (a dialog, a panel) should close on it as well.
        event.preventDefault();
        event.stopPropagation();
        onValueChange('');
        return;
      }
      if (onEscapeEmpty) {
        event.preventDefault();
        onEscapeEmpty();
        return;
      }
      event.currentTarget.blur();
    };

    return (
      <FieldButtonNestProvider value={BUTTON_NEST[size]}>
        <div
          data-search-field={size}
          data-testid={fieldTestId}
          className={`flex min-w-0 cursor-text items-center fg-primary ${FIELD_SIZE_CLASS[size]} ${disabled ? 'cursor-not-allowed bg-disabled fg-disabled' : FIELD_FILL_CLASS[size]} ${className}`}
          onMouseDown={(event): void => {
            // A press on the field's padding or glyph focuses the input,
            // as a press on a field's edge does.
            if (event.target === event.currentTarget) {
              event.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <SearchIcon
            size="sm"
            aria-hidden="true"
            className="pointer-events-none shrink-0 fg-quaternary"
          />
          <input
            {...inputProps}
            data-dialog-initial-focus={dialogInitialFocus}
            ref={setInput}
            type={inputType}
            value={value}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            onChange={(event): void => onValueChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className={`h-full min-w-0 flex-1 appearance-none truncate bg-transparent pointer-coarse:text-m outline-none placeholder:fg-tertiary disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none ${inputClassName}`}
          />
          {hasCount ? (
            <span
              className="pointer-events-none shrink-0 whitespace-nowrap text-xs tabular-nums fg-tertiary"
              data-search-field-count=""
            >
              {count}
            </span>
          ) : null}
          {hasTrailing ? (
            <span className="flex shrink-0 items-center">{trailing}</span>
          ) : null}
          {shortcut !== undefined && !hasValue ? (
            <span
              className={`pointer-events-none flex shrink-0 items-center ${SHORTCUT_INSET_CLASS[size]}`}
            >
              <Kbd shortcut={shortcut} nest={SHORTCUT_NEST[size]} aria-hidden />
            </span>
          ) : null}
          {hasValue ? (
            <SearchFieldButton
              tone="ghost"
              icon={
                <CloseIcon
                  size={CLEAR_ICON_SIZE[size]}
                  // The 12px glyph would otherwise snap to the 14px tier.
                  exactSize={CLEAR_ICON_SIZE[size] === 12}
                  aria-hidden="true"
                />
              }
              aria-label={clearLabel}
              data-testid={clearTestId}
              disabled={disabled}
              // Keep focus (and the caret) in the input.
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(): void => {
                onValueChange('');
                inputRef.current?.focus();
              }}
            />
          ) : null}
          {actions ? (
            <>
              {hasValue ? (
                <span
                  aria-hidden="true"
                  className="h-3.5 w-[var(--border-hairline)] shrink-0 bg-line-base"
                />
              ) : null}
              <span className="flex shrink-0 items-center gap-0.5">
                {actions}
              </span>
            </>
          ) : null}
        </div>
      </FieldButtonNestProvider>
    );
  },
);

SearchField.displayName = 'SearchField';

export interface FieldButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  /** Action-oriented name, also the tooltip: `Filter`, `Show API key`. */
  readonly 'aria-label': string;
  /** The app glyph: 14px in a 24px button, up to 16px in a 28px one. */
  readonly icon: ReactNode;
  /**
   * Filled with the primary ink while the control applies something (a
   * filter is on), so the state shows without opening its menu.
   */
  readonly active?: boolean;
  /**
   * `muted` is a quiet fill at rest, for the controls that open a menu;
   * `ghost` has no fill until hovered, for Clear and Show or Hide.
   */
  readonly tone?: 'muted' | 'ghost';
  /** The tooltip, when it should say more than the name. */
  readonly tooltip?: string;
}

/**
 * An icon button nested in the end of a field: Clear, Filter and Sort in a
 * `SearchField`, Show or Hide in a `TextInput`. It takes its size and corner
 * from the field ({@link FieldButtonNest}), so it is never a circle inside a
 * rounded rectangle. Its name shows as a tooltip (held back while its menu
 * is open).
 */
export const FieldButton = forwardRef<HTMLButtonElement, FieldButtonProps>(
  function FieldButton(
    {
      icon,
      active = false,
      tone = 'muted',
      tooltip,
      type = 'button',
      ...props
    },
    ref,
  ): JSX.Element {
    const nest = useFieldButtonNest();
    const expanded =
      props['aria-expanded'] === true || props['aria-expanded'] === 'true';
    return (
      <Tooltip label={tooltip ?? props['aria-label']} suppressed={expanded}>
        <ControlButton
          {...props}
          ref={ref}
          type={type}
          data-field-button={nest}
          data-active={active ? 'true' : undefined}
          presentation="search-field-endcap"
          appearance={{ nest, tone: active ? 'active' : tone }}
        >
          {icon}
        </ControlButton>
      </Tooltip>
    );
  },
);

FieldButton.displayName = 'FieldButton';

/** A `SearchField`'s nested button: Clear, Filter, Sort. */
export type SearchFieldButtonProps = FieldButtonProps;

/** The same {@link FieldButton}, under its name in a `SearchField`. */
export const SearchFieldButton = FieldButton;

export interface SearchEmptyStateProps {
  /**
   * One sentence: `Nothing matches your search.`, `No workflows match
   * these filters`. A node, so a caller can block a quoted query from
   * session replay.
   */
  readonly title: ReactNode;
  /** The one way out: `Clear search`, `Clear filters`. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionTestId?: string;
  readonly testId?: string;
}

/**
 * A search or filter that hides every row: the search-x glyph on its own in
 * the quiet ink, one sentence, and at most one action. The field above it
 * keeps its count and never says "no results" itself.
 */
export function SearchEmptyState({
  title,
  actionLabel,
  onAction,
  actionTestId,
  testId,
}: SearchEmptyStateProps): JSX.Element {
  return (
    <EmptyState
      testId={testId}
      icon={
        <SearchXIcon size="xl" aria-hidden="true" className="fg-tertiary" />
      }
      title={<span className="text-pretty">{title}</span>}
      titleWeight="normal"
      spacing="relaxed"
      action={
        actionLabel && onAction ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid={actionTestId}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : undefined
      }
    />
  );
}
