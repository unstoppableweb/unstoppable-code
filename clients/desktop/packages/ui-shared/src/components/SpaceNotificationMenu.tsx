import type { JSX, MouseEvent } from 'react';
import { BellIcon, CheckIcon } from '../icons/AppIcons';
import { LoadingSpinner } from './LoadingSpinner';
import { LoadingIndicator } from './LoadingIndicatorStyle';
import { DropdownMenuItem, DropdownMenuItemIcon } from './DropdownMenu';
import { NestedMenuFlyout } from './NestedMenuFlyout';
import { ErrorBanner } from './StatusBlocks';

/** Mirrors the wire levels without importing a contract package. */
export type SpaceNotificationMenuLevel = 'all' | 'attention' | 'mute';

/**
 * `null` clears the space's override. A space without one gets every
 * notification, so All activity saves `null` rather than storing `all`.
 */
export type SpaceNotificationMenuChoice = SpaceNotificationMenuLevel | null;

/**
 * What a host knows about one space's saved notification choice.
 *
 * `override` is always the last choice the server acknowledged. A save in
 * flight is carried in `pendingChoice` and never shown as selected, so the menu
 * cannot claim a setting that has not been stored; its row shows a spinner in
 * the check slot instead.
 */
export interface SpaceNotificationMenuState {
  readonly status: 'loading' | 'ready' | 'saving' | 'failed';
  readonly override: SpaceNotificationMenuChoice;
  /** False until a saved choice has been read, including a failed first read. */
  readonly selectionKnown?: boolean;
  readonly pendingChoice?: SpaceNotificationMenuChoice;
  /** Set when the choices can be read but not changed; shown as the reason. */
  readonly disabledReason?: string;
  /** Set with `failed`: why the last read or save did not go through. */
  readonly failure?: string;
}

export type SpaceNotificationMenuChoiceKey =
  | 'notify-all'
  | 'notify-attention'
  | 'notify-mute';

export interface SpaceNotificationMenuChoiceRow {
  readonly key: SpaceNotificationMenuChoiceKey;
  readonly choice: SpaceNotificationMenuChoice;
  readonly label: string;
  /** What the choice delivers, for the hover title and screen readers. */
  readonly description: string;
  readonly checked: boolean;
  /** The choice a save in flight is storing; shows a spinner, not a check. */
  readonly pending: boolean;
  readonly disabled: boolean;
  /** Choosing this row starts a save: not checked, disabled, or mid-save. */
  readonly selectable: boolean;
}

export const SPACE_NOTIFICATION_MENU_HEADING = 'Notifications';

/** Status and failure lines every host shows for the same situation. */
export const SPACE_NOTIFICATION_MENU_COPY = {
  signIn: 'Sign in to choose notifications for this space.',
  writesClosed: 'Changing this isn’t available right now.',
  loadFailed: 'Couldn’t load notifications.',
  saveFailed: 'Couldn’t save. Try again.',
  changedElsewhere: 'This changed somewhere else. Showing the latest.',
  deliveryInProgress:
    'A notification is being delivered. Try again in a moment.',
  unconfirmed: 'Couldn’t confirm the change. Check your connection.',
} as const;

const LEVEL_LABELS: Record<SpaceNotificationMenuLevel, string> = {
  all: 'All activity',
  attention: 'Needs my attention',
  mute: 'Mute',
};

const LEVEL_DESCRIPTIONS: Record<SpaceNotificationMenuLevel, string> = {
  all: 'Notify me about everything in this space',
  attention:
    'Notify me only when work needs input, approval, or review, is blocked, or fails',
  mute: 'Send no notifications from this space',
};

const CHOICES: readonly {
  readonly key: SpaceNotificationMenuChoiceKey;
  readonly level: SpaceNotificationMenuLevel;
  readonly choice: SpaceNotificationMenuChoice;
}[] = [
  { key: 'notify-all', level: 'all', choice: null },
  { key: 'notify-attention', level: 'attention', choice: 'attention' },
  { key: 'notify-mute', level: 'mute', choice: 'mute' },
];

/**
 * The three choices in menu order. All activity is checked for a space with
 * no override, and for one that saved `all` explicitly. Every choice is
 * disabled while the saved value is unknown or when the host cannot write.
 *
 * A save in flight leaves the rows enabled and adds no status line, so the
 * menu keeps its ink and height on every change; it only stops new saves
 * through `selectable` and marks the pending row.
 */
export function spaceNotificationMenuChoices(
  state: SpaceNotificationMenuState,
): readonly SpaceNotificationMenuChoiceRow[] {
  const known = state.selectionKnown ?? state.status !== 'loading';
  const disabled = !known || state.disabledReason !== undefined;
  const saving = state.status === 'saving';
  const level = state.override ?? 'all';
  const pendingLevel = saving ? (state.pendingChoice ?? 'all') : undefined;
  return CHOICES.map((row) => {
    const checked = known && level === row.level;
    return {
      key: row.key,
      choice: row.choice,
      label: LEVEL_LABELS[row.level],
      description: LEVEL_DESCRIPTIONS[row.level],
      checked,
      pending: !checked && pendingLevel === row.level,
      disabled,
      selectable: !checked && !disabled && !saving,
    };
  });
}

/**
 * Whether a space's acknowledged choice is Mute, exactly when the menu shows
 * Mute checked. A save in flight to Mute does not count, and an unknown
 * selection (a first read still loading or failed) is never muted.
 */
export function isSpaceNotificationMuted(
  state: SpaceNotificationMenuState | undefined,
): boolean {
  if (!state) return false;
  const known = state.selectionKnown ?? state.status !== 'loading';
  return known && state.override === 'mute';
}

/** The check-slot icon: a check, a spinner for the pending save, or none. */
export function SpaceNotificationMenuRowIcon({
  row,
}: {
  readonly row: SpaceNotificationMenuChoiceRow;
}): JSX.Element | null {
  if (row.checked) return <CheckIcon />;
  if (row.pending) return <LoadingSpinner tone="secondary" decorative />;
  return null;
}

export interface SpaceNotificationMenuStatus {
  readonly tone: 'default' | 'failure';
  /** Unset while `loading`: the shared loading copy stands in. */
  readonly text?: string;
  /**
   * The first read is still running. The line shows the loading copy under
   * the `text` loading style, or a spinner under `spinner`.
   */
  readonly loading?: true;
}

/**
 * The status beside the choices: a first read, a failure, or why it is
 * read-only. A save in flight has none; its spinner sits in the row.
 */
export function spaceNotificationMenuStatus(
  state: SpaceNotificationMenuState,
): SpaceNotificationMenuStatus | undefined {
  if (state.status === 'loading') {
    return { tone: 'default', loading: true };
  }
  if (state.status === 'saving') return undefined;
  if (state.status === 'failed') {
    return {
      tone: 'failure',
      text: state.failure ?? SPACE_NOTIFICATION_MENU_COPY.saveFailed,
    };
  }
  return state.disabledReason === undefined
    ? undefined
    : { tone: 'default', text: state.disabledReason };
}

/**
 * A space whose saved choice has never loaded and whose read failed (offline,
 * or a cloud this app cannot reach) has nothing to show or change, so menus
 * omit the group rather than list three dead rows over an error. A failed
 * save on a known choice still shows the group and its error.
 */
export function spaceNotificationMenuUnavailable(
  state: SpaceNotificationMenuState,
): boolean {
  return state.status === 'failed' && state.selectionKnown === false;
}

export interface SpaceNotificationMenuItemsProps {
  readonly state: SpaceNotificationMenuState;
  readonly onSelect: (choice: SpaceNotificationMenuChoice) => void;
  /** Builds a test id from a suffix such as `-notify-mute`. */
  readonly testIdFor?: (suffix: string) => string | undefined;
}

/**
 * The shared Notifications submenu for Work Entry menus. The menu stays
 * open on selection so the saved, pending, or failed
 * outcome is visible where the choice was made.
 */
export function SpaceNotificationMenuItems({
  state,
  onSelect,
  testIdFor,
}: SpaceNotificationMenuItemsProps): JSX.Element | null {
  if (spaceNotificationMenuUnavailable(state)) return null;
  const status = spaceNotificationMenuStatus(state);
  const group = (
    <div
      role="group"
      aria-label={SPACE_NOTIFICATION_MENU_HEADING}
      aria-busy={state.status === 'loading' || state.status === 'saving'}
      data-testid={testIdFor?.('-notify')}
    >
      {spaceNotificationMenuChoices(state).map((row) => (
        <DropdownMenuItem
          key={row.key}
          role="menuitemradio"
          aria-checked={row.checked}
          aria-busy={row.pending ? true : undefined}
          disabled={row.disabled}
          title={row.description}
          data-testid={testIdFor?.(`-${row.key}`)}
          onClick={(event: MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();
            if (row.selectable) onSelect(row.choice);
          }}
        >
          <DropdownMenuItemIcon>
            <SpaceNotificationMenuRowIcon row={row} />
          </DropdownMenuItemIcon>
          {row.label}
        </DropdownMenuItem>
      ))}
      {status && (
        <SpaceNotificationMenuStatusLine
          status={status}
          testId={testIdFor?.('-notify-status')}
        />
      )}
    </div>
  );
  return (
    <NestedMenuFlyout
      label={SPACE_NOTIFICATION_MENU_HEADING}
      leading={<BellIcon />}
      triggerTestId={testIdFor?.('-notify-submenu') ?? 'notify-submenu'}
      menuTestId={testIdFor?.('-notify-submenu-menu') ?? 'notify-submenu-menu'}
    >
      {group}
    </NestedMenuFlyout>
  );
}

export function SpaceNotificationMenuStatusLine({
  status,
  testId,
}: {
  readonly status: SpaceNotificationMenuStatus;
  readonly testId?: string;
}): JSX.Element {
  if (status.tone === 'failure' && !status.loading) {
    return (
      <ErrorBanner
        errorSource="space-notification-menu-status-line"
        className="m-1"
        error={status.text}
        testId={testId}
      />
    );
  }
  // A plain row, not `DropdownMenuLabel`: the label truncates to one line and
  // owns its ink, and this line must wrap.
  return (
    <div
      role="status"
      data-testid={testId}
      className="px-2 py-1 text-xs font-normal fg-secondary"
    >
      {status.loading ? <LoadingIndicator /> : status.text}
    </div>
  );
}
