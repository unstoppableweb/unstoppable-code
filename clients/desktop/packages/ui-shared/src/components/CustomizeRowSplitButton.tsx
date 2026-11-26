import {
  Fragment,
  useId,
  useRef,
  useState,
  type JSX,
  type PointerEvent,
} from 'react';
import type {
  InstalledItemStatus,
  InstalledItemTarget,
} from '@canopy/protocol/installed-items';
import { CheckIcon, ChevronDownIcon } from '../icons/AppIcons';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  installedItemStatusDescription,
} from '../lib/installed-item-status';
import { menuDismissalSwallowsClick } from '../lib/menu-open-body-flag';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import { ControlButton } from '../primitives/Button';
import type { CustomizeRowMenuItem } from './CustomizeRowMenu';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from '../primitives/DropdownMenu';
import { FloatingMenu } from '../primitives/FloatingMenu';
import type { InstalledItemStatusGlyph } from './InstalledItemStatusPicker';
import {
  ITEM_STATE_LABEL_CLASS,
  ItemStateMark,
  type ItemStateTone,
} from './ItemStateMark';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { Divider } from '../primitives/Surface';
import { Tooltip } from '../primitives/Tooltip';

/** One status a row's caret menu can switch, as the status picker offers it. */
export interface CustomizeRowSplitStatus {
  readonly current: InstalledItemStatus;
  /** Names the listing when a row stands for several (a provider). */
  readonly heading?: string;
  readonly targetKind?: InstalledItemTarget['kind'];
  /** Re-sends the current status, for a listing with a retryable notice. */
  readonly retryCurrent?: boolean;
  readonly busy?: boolean;
  readonly onChange: (status: InstalledItemStatus) => void;
}

/** What a row's split control shows: one of the shared item states. */
export type CustomizeRowSplitTone = Extract<
  ItemStateTone,
  | 'active'
  | 'available'
  | 'disabled'
  | 'unavailable'
  | 'add'
  | 'run'
  | 'installed'
>;

/**
 * A Customize row's one action control (CAN-6813): the main segment shows
 * the row's state (Add, Active, Available, Disabled, Run) and the caret
 * opens the row's existing actions. Sign-in and updates never replace the
 * state; the row says them on its own lines. Pure display: the host decides
 * the state and owns every action.
 */
export interface CustomizeRowSplitAction {
  readonly label: string;
  /** The main segment's accessible name. */
  readonly accessibleName: string;
  /** A status glyph before the label; `tone` wins when both are set. */
  readonly glyph?: InstalledItemStatusGlyph;
  /** The state's icon and label ink. */
  readonly tone?: CustomizeRowSplitTone;
  readonly busy?: boolean;
  /** Runs the state's action; omitted, the main segment opens the menu. */
  readonly onPrimary?: () => void;
  /** Why the state cannot change here; shown on hover and focus. */
  readonly reason?: string;
  readonly primaryTestId?: string;
  /** Status choices, first in the menu. */
  readonly statuses?: readonly CustomizeRowSplitStatus[];
  /** State-specific choices (Add from a provider), before the row's actions. */
  readonly leadingItems?: readonly CustomizeRowMenuItem[];
  /** Row menu items the main segment already runs (Update, Connect). */
  readonly omitItemIds?: readonly string[];
}

export interface CustomizeRowSplitButtonProps {
  readonly entryName: string;
  /** Section-qualified, so repeated entries keep unique identifiers. */
  readonly idPrefix: string;
  readonly action: CustomizeRowSplitAction;
  /** The row's existing actions, as its ⋯ menu lists them. */
  readonly items: readonly CustomizeRowMenuItem[];
  /** The caret's test id; menu rows extend it as the ⋯ menu's do. */
  readonly testId?: string;
}

function MenuRow({
  item,
  testId,
  onClose,
}: {
  readonly item: CustomizeRowMenuItem;
  readonly testId: string | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Tooltip
      label={item.disabledReason}
      clamp={false}
      disabled={!item.disabledReason}
      className="w-full"
    >
      <DropdownMenuItem
        data-testid={testId ? `${testId}-${item.id}` : undefined}
        tone={item.destructive ? 'destructive' : 'default'}
        disabled={item.disabled}
        aria-disabled={item.disabled || undefined}
        aria-description={item.disabledReason}
        aria-label={
          item.disabledReason
            ? `${item.label}: ${item.disabledReason}`
            : item.label
        }
        onClick={() => {
          if (item.disabled) return;
          onClose();
          item.onSelect();
        }}
      >
        {item.label}
      </DropdownMenuItem>
    </Tooltip>
  );
}

export function CustomizeRowSplitButton({
  entryName,
  idPrefix,
  action,
  items,
  testId,
}: CustomizeRowSplitButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const menuId = `${idPrefix}-menu`;
  const statuses = action.statuses ?? [];
  const actions = [
    ...(action.leadingItems ?? []),
    ...items.filter((item) => item.destructive !== true),
  ];
  const destructive = items.filter((item) => item.destructive === true);
  const hasMenu =
    statuses.length > 0 || actions.length > 0 || destructive.length > 0;
  const close = (): void => setOpen(false);
  const toggle = (): void => setOpen((value) => !value);
  // A menu open elsewhere on the page swallows the click that dismisses it,
  // so a press opens this one at once (as the ⋯ menu does).
  const openOnPress = (event: PointerEvent<HTMLButtonElement>): void => {
    if (
      !open &&
      menuDismissalSwallowsClick(
        event.currentTarget.ownerDocument,
        event.target,
      )
    )
      setOpen(true);
  };
  const primaryOpensMenu = action.onPrimary === undefined && hasMenu;
  const tone = action.tone ?? action.glyph;
  const main = (
    <ControlButton
      type="button"
      presentation="customize-row-action"
      data-testid={action.primaryTestId}
      aria-label={action.accessibleName}
      aria-describedby={action.reason ? reasonId : undefined}
      aria-busy={action.busy || undefined}
      aria-haspopup={primaryOpensMenu ? 'menu' : undefined}
      aria-expanded={primaryOpensMenu ? open : undefined}
      aria-disabled={
        action.onPrimary === undefined && !hasMenu ? true : undefined
      }
      disabled={action.busy === true}
      onPointerDown={primaryOpensMenu ? openOnPress : undefined}
      onClick={() => {
        if (action.onPrimary) {
          close();
          action.onPrimary();
        } else if (hasMenu) toggle();
      }}
    >
      {action.busy ? (
        <LoadingSpinner sizePx={14} decorative />
      ) : (
        tone !== undefined && <ItemStateMark tone={tone} />
      )}
      <span
        className={`min-w-0 truncate${tone !== undefined ? ` ${ITEM_STATE_LABEL_CLASS[tone]}` : ''}`}
      >
        {action.label}
      </span>
      {action.reason && (
        <span id={reasonId} className="sr-only">
          {action.reason}
        </span>
      )}
    </ControlButton>
  );
  return (
    <div
      ref={clusterRef}
      data-testid={testId ? `${testId}-split` : undefined}
      className={`inline-flex h-7 w-36 shrink-0 items-stretch overflow-hidden rounded-md pointer-coarse:h-11 ${SECONDARY_SURFACE_SHELL_CLASS}`}
    >
      {action.reason ? (
        <Tooltip
          label={action.reason}
          clamp={false}
          className="min-w-0 flex-1 items-stretch"
        >
          {main}
        </Tooltip>
      ) : (
        main
      )}
      {hasMenu && (
        <>
          <span className="flex h-4 self-center">
            <Divider orientation="vertical" aria-hidden />
          </span>
          <ControlButton
            ref={caretRef}
            type="button"
            presentation="customize-row-action-menu"
            id={`${idPrefix}-menu-trigger`}
            data-testid={testId}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={`More actions for ${entryName}`}
            disabled={action.busy === true}
            onPointerDown={openOnPress}
            onClick={toggle}
          >
            <ChevronDownIcon size="sm" aria-hidden />
          </ControlButton>
          <FloatingMenu
            id={menuId}
            open={open}
            onOpenChange={setOpen}
            anchorRef={clusterRef}
            returnFocusRef={caretRef}
            outsidePressBoundaryRef={clusterRef}
            placement="bottom-right"
            aria-label={`Actions for ${entryName}`}
            data-testid={testId ? `${testId}-surface` : undefined}
            className={statuses.length > 0 ? 'w-64' : 'min-w-40'}
          >
            {statuses.map((status, index) => (
              <Fragment key={status.heading ?? index}>
                {index > 0 && <DropdownMenuDivider />}
                {status.heading && (
                  <DropdownMenuLabel>{status.heading}</DropdownMenuLabel>
                )}
                {INSTALLED_ITEM_STATUS_ORDER.map((option) => {
                  const selected = option === status.current;
                  return (
                    <DropdownMenuItem
                      key={option}
                      role="menuitemradio"
                      aria-checked={selected}
                      multiline
                      disabled={status.busy}
                      data-testid={
                        testId
                          ? `${testId}-status-${statuses.length > 1 ? `${index}-` : ''}${option}`
                          : undefined
                      }
                      onClick={(): void => {
                        close();
                        if (!selected || status.retryCurrent)
                          status.onChange(option);
                      }}
                    >
                      <DropdownMenuItemIcon>
                        <ItemStateMark tone={option} />
                      </DropdownMenuItemIcon>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium fg-primary">
                          {INSTALLED_ITEM_STATUS_COPY[option].label}
                        </span>
                        <span className="block text-xs fg-tertiary">
                          {installedItemStatusDescription(
                            option,
                            status.targetKind,
                          )}
                        </span>
                      </span>
                      <DropdownMenuItemIcon>
                        {selected && <CheckIcon size="sm" aria-hidden />}
                      </DropdownMenuItemIcon>
                    </DropdownMenuItem>
                  );
                })}
              </Fragment>
            ))}
            {[actions, destructive]
              .filter((group) => group.length > 0)
              .map((group, index) => (
                <Fragment key={index}>
                  {(index > 0 || statuses.length > 0) && (
                    <DropdownMenuDivider />
                  )}
                  {group.map((item) => (
                    <MenuRow
                      key={item.id}
                      item={item}
                      testId={testId}
                      onClose={close}
                    />
                  ))}
                </Fragment>
              ))}
          </FloatingMenu>
        </>
      )}
    </div>
  );
}
