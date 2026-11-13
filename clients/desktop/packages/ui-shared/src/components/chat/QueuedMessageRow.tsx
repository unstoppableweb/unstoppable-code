import {
  createContext,
  forwardRef,
  Fragment,
  useContext,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type HTMLAttributes as ElementAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ChatWatcherFiredInfo,
  QueuedMessageRetryBlockedReason,
  SettingsHeldChange,
} from '@canopy/protocol/portal';
import type { QueuedMessageForceKind } from '../../lib/queued-message-force';
import {
  DragHandleIcon,
  ArrowUpIcon,
  CopyIcon,
  FileIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from '../../icons/AppIcons';
import {
  DRAWER_ITEM_ACTIONS_CLASS,
  DRAWER_ITEM_GROUP_CLASS,
} from '../../lib/drawer-reveal';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { ActionTooltip } from '../ActionTooltip';
import { Button } from '../Button';
import { copyTextToClipboard } from '../copy-to-clipboard';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from '../DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from '../FloatingMenu';
import { Tooltip } from '../Tooltip';
import {
  useDoubleClickToEdit,
  type MessageEditHandler,
} from './MessageEditEntry';
import { ATTACHMENT_TILE_EDGE_CLASS } from './MessageImageAttachments';
import { hostMessagePresentation } from './SteeringRequestTitle';
import { WatcherFiredTitle } from './WatcherFiredTitle';
import { QueuedMessageSettingsHeldWarning } from './QueuedMessageSettingsHeldWarning';
import {
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP,
  QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE,
  QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS,
} from './QueuedMessageBubble';

/**
 * Whether queued messages draw as the compact list above the composer (the
 * compact presentation variant) instead of a bubble each at the end of the
 * transcript. Off is the default and unconfigured component consumers.
 * Hosts choose it once at their root.
 */
const CompactQueueContext = createContext(false);

export function CompactQueueProvider({
  value,
  children,
}: {
  readonly value: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <CompactQueueContext.Provider value={value}>
      {children}
    </CompactQueueContext.Provider>
  );
}

/** Whether the surrounding presentation uses compact queue rows. */
export function useCompactQueue(): boolean {
  return useContext(CompactQueueContext);
}

/**
 * The compact queue's surface: a card that sits behind the composer and
 * tucks under its top edge, like a tab.
 *
 * - It takes `bg-secondary`, the surface step between the page and the
 *   composer box (`bg-tertiary`), so the composer reads as the raised surface
 *   on top of it, with the shared hairline edge.
 * - It is inset from the composer by the composer's own 20px corner radius on
 *   each side (`mx-5`), so its sides rise from the composer's straight top
 *   edge, clear of the composer's corner curve, and its top corners take the
 *   same 20px (`rounded-t-2xl`).
 * - Every corner button sits 12px from the edges: `pt-2` plus a row's 4px
 *   around its 28px buttons at the top, the rows' 12px side inset, and at the
 *   bottom `pb-6`, which is the same 8px plus the 16px that tucks under the
 *   composer (`-mb-4`). Hosts render the card through `ComposerTray`, which
 *   lands it directly on the composer box, below every notice above it.
 */
export const QUEUED_MESSAGE_TRAY_CLASS =
  'bg-secondary ring-[length:var(--border-hairline)] ring-line-secondary mx-5 rounded-t-2xl pt-2 pb-6 -mb-4';

/** How far the card runs under the composer's top edge, in px. */
export const QUEUED_MESSAGE_TRAY_TUCK_PX = 16;

/** Drawn stroke for the row's 14px icons, as on the app's other cards. */
const ROW_ICON_STROKE_PX = 1.5;

/** The drag handle's dots draw finer, so the grip stays quiet beside text. */
const DRAG_HANDLE_STROKE_PX = 1;

/**
 * How a sortable host lets a row be reordered: the props it spreads on the
 * row's leading drag handle, which drags with the pointer and, focused, with
 * Space and the arrow keys.
 */
export interface QueuedMessageReorderProps {
  readonly handleProps: ElementAttributes<HTMLElement>;
  /** This row is being dragged. */
  readonly dragging?: boolean;
  /** Why this row can't move now; its handle stays, disabled, saying so. */
  readonly unavailableReason?: string;
}

/**
 * One file sent with a queued message. Images and videos show as a plain
 * 24px square thumbnail: an image's picture, a video's first frame (an empty
 * tile until, or where, the host has one). Any other file shows its icon and
 * name.
 */
export interface QueuedMessageAttachment {
  /** Stable React key (e.g. the attachment's path). */
  readonly key: string;
  readonly kind: 'image' | 'video' | 'file';
  /** The file name, shown for a file and as every thumbnail's name. */
  readonly name: string;
  /** An image's URL; `null` or absent while it loads or when it cannot show. */
  readonly src?: string | null;
  /** A file's type icon; the app's file glyph when absent. */
  readonly icon?: ReactNode;
}

/**
 * Why a row's actions wait: the message is still on its way into the queue,
 * so there is no queued entry yet to send, edit or delete. It usually lasts
 * a moment; a new task's first message waits like this while its worktree
 * is prepared.
 */
export const QUEUED_MESSAGE_SENDING_TOOLTIP =
  'Available once this message is queued';
/** Another queued message is open in the editor; the queue holds still. */
export const QUEUED_MESSAGE_EDITING_TOOLTIP =
  'Available after you finish editing';
/** The agent is between steps (handing over a message, recovering). */
export const QUEUED_MESSAGE_BUSY_TOOLTIP =
  'Available when the current step finishes';

/**
 * A row action that can't run now keeps its place and stays quiet: the
 * quiet ghost draws it disabled as a dimmed label with no grey fill, and its
 * reason shows on hover.
 */
function actionVariant(unavailable: boolean): 'ghost-overlay' | 'ghost-quiet' {
  return unavailable ? 'ghost-quiet' : 'ghost-overlay';
}

/** How many attachments a row shows before it counts the rest. */
const VISIBLE_ATTACHMENTS = 3;

export interface QueuedMessageRowProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  /** The queued text. Whitespace collapses to one line, which truncates. */
  readonly text: string;
  /** A fired watcher's label, leading the row. */
  readonly watcherFired?: ChatWatcherFiredInfo;
  /**
   * A leading label the host supplies instead (an agent sender). It is a
   * title, so it is never replay-blocked: it masks its own text.
   */
  readonly label?: ReactNode;
  /** Why the message is waiting, after the text in the tertiary ink. */
  readonly status?: ReactNode;
  /** The files sent with the message, shown before its text. */
  readonly attachments?: readonly QueuedMessageAttachment[];
  /** Present only while the list can be reordered. */
  readonly reorder?: QueuedMessageReorderProps;
  /** Opens the editor from the menu's Edit message or a double-click. */
  readonly onEdit?: MessageEditHandler;
  /** The host cannot hold the row while editing, so double-click stays off. */
  readonly editLockAdvisory?: boolean;
  readonly onSteer?: () => void;
  /**
   * Why Steer can't run now, on a chat that can steer: it shows disabled
   * with this reason. Omit (with no `onSteer`) where the chat can't steer.
   */
  readonly steerUnavailableReason?: string;
  /** Steering is supported but this message changes agent capabilities. */
  readonly steerBlockedByCapabilityChange?: boolean;
  /** See `QueuedMessageActionsProps.settingsHeld`. */
  readonly settingsHeld?: readonly SettingsHeldChange[];
  readonly onInterrupt?: () => void;
  /**
   * The host holds this row until something outside the queue changes (for
   * example the account has no AI credits). Send now renders disabled with
   * the reason's explanation, even without `onInterrupt`, and Steer is
   * withheld.
   */
  readonly sendBlockedReason?: QueuedMessageRetryBlockedReason;
  /** Preserve the host's force action when the row is idle or held. */
  readonly forceKind?: QueuedMessageForceKind;
  /** Draws Interrupt as an icon button with this glyph (14px), label in its tooltip. */
  readonly interruptIcon?: typeof DragHandleIcon;
  /** Why Send now can't run now: it shows disabled with this reason. */
  readonly interruptUnavailableReason?: string;
  readonly onDelete?: () => void;
  /** The message is being handed to the agent; it can no longer change. */
  readonly sending?: boolean;
  /**
   * `tray` (default): the compact queue card's row. `drawer`: a row in the
   * composer drawer, nested in its 4px inset: 16px corners, the list-row
   * hover fill, the drag handle's circle 4px from the start (11px inset) and
   * the last button 4px from the end; lifted while dragged, on the muted fill.
   */
  readonly surface?: 'tray' | 'drawer';
}

/** The row's own inset, hover and lifted fill, per surface. */
const ROW_SURFACE_CLASS = {
  tray: 'px-3',
  drawer: `${DRAWER_ITEM_GROUP_CLASS} rounded-drawer-row pl-2.75 pr-1 hover:bg-subtle data-[dragging]:bg-muted`,
} as const;

/**
 * In the drawer, Steer and the menu show on hover, focus or touch, flush
 * like every drawer row's ghost controls: their padding is their space.
 */
const ROW_ACTIONS_CLASS = {
  tray: '',
  drawer: DRAWER_ITEM_ACTIONS_CLASS,
} as const;

/** A 24px square with a compact 4px corner for queued media. */
const THUMBNAIL_CLASS =
  'relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm';

/** The files before the row's text: thumbnails, then file names. */
export function QueuedMessageAttachments({
  attachments,
}: {
  readonly attachments: readonly QueuedMessageAttachment[];
}): JSX.Element {
  const shown = attachments.slice(0, VISIBLE_ATTACHMENTS);
  const hidden = attachments.length - shown.length;
  return (
    <span
      data-testid="queued-message-attachments"
      className={`${REPLAY_BLOCK_CLASS} flex min-w-0 max-w-1/2 shrink-0 items-center gap-1.5`}
    >
      {shown.map((attachment) =>
        attachment.kind === 'file' ? (
          <span
            key={attachment.key}
            title={attachment.name}
            data-testid="queued-message-attachment"
            data-kind="file"
            className="flex min-w-0 items-center gap-1 fg-secondary"
          >
            <span className="flex shrink-0 fg-tertiary">
              {attachment.icon ?? (
                <FileIcon
                  size="sm"
                  drawnStrokeWidth={ROW_ICON_STROKE_PX}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="max-w-32 truncate">{attachment.name}</span>
          </span>
        ) : (
          <span
            key={attachment.key}
            title={attachment.name}
            role="img"
            aria-label={
              attachment.kind === 'video'
                ? `Video ${attachment.name}`
                : attachment.name
            }
            data-testid="queued-message-attachment"
            data-kind={attachment.kind}
            className={`${THUMBNAIL_CLASS} bg-muted`}
          >
            {attachment.src ? (
              <img
                src={attachment.src}
                alt=""
                draggable={false}
                className="h-full w-full object-cover"
              />
            ) : null}
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-0 rounded-sm ${ATTACHMENT_TILE_EDGE_CLASS}`}
            />
          </span>
        ),
      )}
      {hidden > 0 ? (
        <span
          className={`${THUMBNAIL_CLASS} inset-ring inset-ring-fg-primary/8 text-s fg-tertiary`}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** The row's ••• menu: the less common actions, after the ChatGPT queue. */
function QueuedMessageMoreMenu({
  items,
  unavailableReason,
}: {
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly icon: typeof DragHandleIcon;
    readonly onSelect: () => void;
    /**
     * Run after the menu has closed and handed focus back to •••, so an
     * editor the pick opens keeps the focus it takes. Other picks act at once.
     */
    readonly afterClose?: boolean;
    /** A removal row: last, below a divider, in the destructive ink. */
    readonly destructive?: boolean;
    readonly disabled?: boolean;
    readonly reason?: string;
  }[];
  /** Why every item waits, shown above them; the menu itself still opens. */
  readonly unavailableReason?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  return (
    <>
      <Tooltip label="More actions" suppressed={open} delay="long">
        <Button
          ref={triggerRef}
          variant="ghost-overlay"
          size="sm"
          iconOnly
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-testid="queued-message-more"
          onClick={(): void => setOpen((value) => !value)}
        >
          {/* The sidebar's More glyph (RailIconButton's 16, its own stroke),
              so every ••• in the app reads the same. */}
          <MoreHorizontalIcon size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label="More actions"
        data-testid="queued-message-more-menu"
        className="w-max min-w-44"
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          {unavailableReason ? (
            <p
              data-testid="queued-message-more-unavailable"
              className="px-2 py-1.5 text-s fg-tertiary"
            >
              {unavailableReason}
            </p>
          ) : null}
          {items.map((item, index) => {
            const ItemIcon = item.icon;
            return (
              <Fragment key={item.id}>
                {item.destructive && index > 0 ? <DropdownMenuDivider /> : null}
                <DropdownMenuItem
                  data-testid={`queued-message-${item.id}`}
                  tone={item.destructive ? 'destructive' : 'default'}
                  disabled={unavailableReason !== undefined || item.disabled}
                  aria-description={item.reason}
                  onClick={(): void => {
                    setOpen(false);
                    if (item.afterClose) setTimeout(item.onSelect, 0);
                    else item.onSelect();
                  }}
                >
                  <DropdownMenuItemIcon>
                    <ItemIcon
                      size="sm"
                      drawnStrokeWidth={ROW_ICON_STROKE_PX}
                      aria-hidden="true"
                    />
                  </DropdownMenuItemIcon>
                  {item.label}
                </DropdownMenuItem>
              </Fragment>
            );
          })}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/**
 * One queued message in the compact list, after the ChatGPT and Codex queue:
 * a quiet drag handle while the list can be reordered, the text on one
 * truncated line after any attachments in the primary ink, then Steer and
 * Send now as quiet text buttons in the secondary grey (no icon, no fill;
 * hover lifts them to the primary ink with the quiet hover), and a •••
 * menu with the less common actions (Edit message, then Delete below a
 * divider). All are the shared capsule ghost buttons, always visible; a row
 * that cannot steer shows Send now alone.
 */
export const QueuedMessageRow = forwardRef<
  HTMLDivElement,
  QueuedMessageRowProps
>(function QueuedMessageRow(
  {
    text,
    watcherFired,
    label,
    status,
    attachments = [],
    reorder,
    onEdit,
    editLockAdvisory = false,
    onSteer,
    steerUnavailableReason,
    steerBlockedByCapabilityChange = false,
    settingsHeld,
    onInterrupt,
    sendBlockedReason,
    forceKind = 'interrupt',
    interruptIcon: InterruptIcon,
    interruptUnavailableReason,
    onDelete,
    sending = false,
    surface = 'tray',
    className = '',
    ...props
  },
  ref,
): JSX.Element {
  const gesture = useDoubleClickToEdit(
    editLockAdvisory || sending ? undefined : onEdit,
  );
  // A delegate's steering request or a fired watcher that reached the queue
  // as its own text shows its readable part after its label.
  const hostMessage = hostMessagePresentation(text, undefined, 'inline');
  const preview =
    (hostMessage?.text ?? text).replace(/\s+/g, ' ').trim() || 'Attached files';
  const leading =
    label ??
    (watcherFired ? (
      <WatcherFiredTitle watcherFired={watcherFired} layout="inline" />
    ) : (
      hostMessage?.title
    ));
  const sendBlock =
    sendBlockedReason === undefined
      ? undefined
      : QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS[sendBlockedReason];
  const drawerInterruptReason =
    sendBlock?.description ??
    interruptUnavailableReason ??
    (sending ? QUEUED_MESSAGE_SENDING_TOOLTIP : undefined);
  const forceLabel =
    sendBlock || forceKind === 'retry'
      ? 'Try again'
      : forceKind === 'run-now'
        ? 'Run now'
        : 'Interrupt';
  const menuItems = [
    ...(surface === 'drawer' &&
    (sendBlock || onInterrupt || interruptUnavailableReason)
      ? [
          {
            id: forceKind,
            label: forceLabel,
            icon: ArrowUpIcon,
            onSelect: (): void => {
              if (!sendBlock) onInterrupt?.();
            },
            disabled: drawerInterruptReason !== undefined,
            reason: drawerInterruptReason,
          },
        ]
      : []),
    ...(onEdit
      ? [
          {
            id: 'edit',
            label: surface === 'drawer' ? 'Edit' : 'Edit message',
            icon: PencilIcon,
            onSelect: (): void => void onEdit(),
            afterClose: true,
          },
        ]
      : []),
    ...(surface === 'drawer'
      ? [
          {
            id: 'copy',
            label: 'Copy',
            icon: CopyIcon,
            onSelect: (): void => {
              void copyTextToClipboard(text);
            },
          },
        ]
      : []),
    ...(onDelete
      ? [
          {
            id: 'cancel',
            label: 'Delete',
            icon: TrashIcon,
            onSelect: onDelete,
            destructive: true,
          },
        ]
      : []),
  ];
  // Steer and Send now keep their place whenever the row offers them; one
  // that can't run now is disabled and says why. Until the message is
  // queued, both wait for that.
  const steerReason = steerBlockedByCapabilityChange
    ? undefined
    : (steerUnavailableReason ??
      (sending && onSteer ? QUEUED_MESSAGE_SENDING_TOOLTIP : undefined));
  const interruptReason =
    interruptUnavailableReason ??
    (sending && onInterrupt ? QUEUED_MESSAGE_SENDING_TOOLTIP : undefined);
  const steerButton =
    !sendBlock && (onSteer || steerReason || steerBlockedByCapabilityChange) ? (
      <Button
        variant={actionVariant(
          steerBlockedByCapabilityChange || steerReason !== undefined,
        )}
        // In the drawer, the compact size of every drawer row action.
        size={surface === 'drawer' ? 'compact' : 'sm'}
        aria-description={
          steerBlockedByCapabilityChange
            ? QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP
            : steerReason
        }
        data-testid="queued-message-steer"
        disabled={steerBlockedByCapabilityChange || steerReason !== undefined}
        onClick={onSteer}
      >
        Steer
      </Button>
    ) : null;
  const sendNowButton =
    onInterrupt || interruptReason ? (
      <Button
        variant={actionVariant(interruptReason !== undefined)}
        size="sm"
        {...(InterruptIcon
          ? { iconOnly: true, 'aria-label': forceLabel }
          : { iconOnly: false })}
        aria-description={interruptReason}
        data-testid={`queued-message-${forceKind}`}
        disabled={interruptReason !== undefined}
        onClick={onInterrupt}
      >
        {InterruptIcon ? (
          <InterruptIcon
            size="sm"
            drawnStrokeWidth={ROW_ICON_STROKE_PX}
            aria-hidden="true"
          />
        ) : (
          forceLabel
        )}
      </Button>
    ) : null;
  // Only actions that would act now: a disabled Steer or Send now does nothing.
  const steerActs =
    steerButton !== null &&
    !steerBlockedByCapabilityChange &&
    steerReason === undefined;
  // The drawer offers Interrupt in its More actions menu instead.
  const interruptActs =
    !sendBlock &&
    forceKind === 'interrupt' &&
    onInterrupt !== undefined &&
    interruptReason === undefined;
  const settingsHeldWarning =
    settingsHeld && (steerActs || interruptActs) ? (
      <QueuedMessageSettingsHeldWarning
        changes={settingsHeld}
        steer={steerActs}
        interrupt={interruptActs}
      />
    ) : null;
  return (
    <div
      {...props}
      {...gesture}
      ref={ref}
      role="listitem"
      data-dragging={reorder?.dragging ? '' : undefined}
      className={`flex h-9 min-w-0 items-center gap-2.5 text-s ${
        ROW_SURFACE_CLASS[surface]
      } ${className}`}
    >
      {reorder ? (
        // The drag handle: the row's leading slot, the shared quiet icon
        // button (round, so its hover nests in any corner) with a grab cursor. Its 28px circle reaches 7px past the 14px
        // glyph on each side; the negative margin keeps the text in place.
        // A row that can't move now keeps its handle, disabled, with why.
        <Tooltip
          label={reorder.unavailableReason ?? 'Drag to reorder'}
          suppressed={reorder.dragging === true}
          delay="long"
        >
          <Button
            variant={actionVariant(reorder.unavailableReason !== undefined)}
            size="sm"
            iconOnly
            aria-label="Reorder queued message"
            {...(reorder.unavailableReason === undefined
              ? reorder.handleProps
              : {})}
            aria-description={reorder.unavailableReason}
            disabled={reorder.unavailableReason !== undefined}
            data-testid="queued-message-drag-handle"
            data-no-double-click-edit
            className={`-mx-1.75 touch-none ${
              reorder.unavailableReason === undefined ? 'cursor-default' : ''
            }`}
          >
            <DragHandleIcon
              size="sm"
              drawnStrokeWidth={DRAG_HANDLE_STROKE_PX}
              aria-hidden="true"
            />
          </Button>
        </Tooltip>
      ) : null}
      {surface === 'drawer' ? settingsHeldWarning : null}
      {leading ? (
        <span className="flex min-w-0 max-w-1/2 shrink-0">{leading}</span>
      ) : null}
      {attachments.length > 0 ? (
        <QueuedMessageAttachments attachments={attachments} />
      ) : null}
      <span
        data-testid="queued-message-preview"
        className={`${REPLAY_BLOCK_CLASS} min-w-0 flex-1 truncate fg-primary`}
      >
        {preview}
      </span>
      {status ? (
        // A flex slot centers a rich status (an inline reason's tooltip
        // trigger) on the row's axis. Plain text truncates in its own span.
        <span
          data-testid="queued-message-status"
          className="flex min-w-0 max-w-1/2 shrink items-center fg-tertiary"
        >
          {typeof status === 'string' ? (
            <span className="min-w-0 truncate">{status}</span>
          ) : (
            status
          )}
        </span>
      ) : null}
      <span
        className={`flex shrink-0 items-center ${ROW_ACTIONS_CLASS[surface]}`}
      >
        {surface === 'drawer' ? null : settingsHeldWarning}
        {steerButton ? (
          steerBlockedByCapabilityChange ? (
            <ActionTooltip
              title={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE}
              description={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP}
            >
              {steerButton}
            </ActionTooltip>
          ) : steerReason ? (
            <Tooltip label={steerReason}>{steerButton}</Tooltip>
          ) : (
            steerButton
          )
        ) : null}
        {surface === 'drawer' ? null : sendBlock ? (
          <ActionTooltip
            title={sendBlock.title}
            description={sendBlock.description}
          >
            {/* `aria-disabled` keeps the explanation reachable by keyboard. */}
            <Button
              variant="ghost-overlay"
              size="sm"
              data-testid={`queued-message-${forceKind}`}
              aria-disabled="true"
              aria-description={sendBlock.description}
              disabled={sending}
            >
              Try again
            </Button>
          </ActionTooltip>
        ) : sendNowButton && (interruptReason || InterruptIcon) ? (
          <Tooltip label={interruptReason ?? forceLabel} delay="long">
            {sendNowButton}
          </Tooltip>
        ) : (
          sendNowButton
        )}
        {menuItems.length > 0 ? (
          <QueuedMessageMoreMenu
            items={menuItems}
            unavailableReason={
              sending ? QUEUED_MESSAGE_SENDING_TOOLTIP : undefined
            }
          />
        ) : null}
      </span>
    </div>
  );
});
