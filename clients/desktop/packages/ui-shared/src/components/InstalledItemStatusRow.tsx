'use client';

import { useId, useRef, useState, type JSX, type RefObject } from 'react';
import type {
  InstalledItemNotice,
  InstalledItemRef,
  InstalledItemStatus,
  InstalledItemTarget,
  InstalledItemUninstallTarget,
} from '@canopy/protocol/installed-items';
import { INSTALLED_ITEM_MARKETPLACE_OWNED_REASON } from '@canopy/protocol/installed-items';
import {
  installedItemTargetKey,
  installedItemStatusDescription,
  type InstalledEntryStatusState,
  type InstalledItemMutationOutcome,
} from '../lib/installed-item-status';
import { MoreHorizontalIcon, TrashIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { Skeleton } from './Skeleton';
import { DetailPageActions } from './DetailActionBar';
import {
  DetailMoreMenu,
  DetailMoreMenuRows,
  focusMenuTrigger,
  useDetailMoreItems,
} from './DetailMoreMenu';
import { DropdownMenuItem } from './DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';
import {
  InstalledItemStatusPicker,
  InstalledItemStatusUnavailable,
} from './InstalledItemStatusPicker';
import { Notice } from './Notice';
import {
  DETAIL_FACT_GRID_CLASS,
  DETAIL_FACT_VALUE_OFFSET_CLASS,
} from './DetailFact';
import { IconCircleQuestionmark } from '../icons/AppGlyphs.generated';
import { ArrowUpRightIcon } from '../icons/AppIcons';
import { ErrorBanner } from './StatusBlocks';
import { Tooltip } from './Tooltip';
import { UninstallConfirmDialog } from './UninstallConfirmDialog';

/**
 * Installed-item status surfaces (CAN-4255).
 *
 * `InstalledItemStatusControl` is the compact picker an Installed card shows,
 * in a fixed right-aligned slot so pickers line up down a list;
 * `InstalledItemStatusRow` is the detail page's Status section, with one
 * picker per configuration of a device MCP server and the item's provider
 * notices. Its Uninstall joins the detail's action bar as the destructive row
 * of a ⋯ More menu, through `DetailPageActions`.
 *
 * Both are callback-driven. The host passes the controller's `setStatus` and
 * `uninstall`; an omitted callback leaves that action out.
 */

export type InstalledItemSetStatus = (
  target: InstalledItemTarget,
  status: InstalledItemStatus,
) => Promise<InstalledItemMutationOutcome>;

export type InstalledItemUninstall = (
  target: InstalledItemUninstallTarget,
) => Promise<InstalledItemMutationOutcome>;

export interface InstalledItemStatusControlProps {
  readonly itemName: string;
  readonly state: InstalledEntryStatusState | undefined;
  readonly pendingKeys: ReadonlySet<string>;
  readonly onSetStatus?: InstalledItemSetStatus;
  /** Reports a failed change; cards have no room for inline errors. */
  readonly onError?: (message: string) => void;
  readonly testId?: string;
}

/** A non-interactive status in the picker trigger's 28px capsule line. */
const QUIET_STATUS_CLASS =
  'inline-flex h-7 shrink-0 items-center rounded-lg px-2 text-xs whitespace-nowrap fg-tertiary';

/** The status the loading picker is measured from: a typical one. */
const SAMPLE_LOADING_STATUS: InstalledItemStatus = 'active';

/** The card-level picker. Renders nothing for rows without an installed status. */
export function InstalledItemStatusControl({
  itemName,
  state,
  pendingKeys,
  onSetStatus,
  onError,
  testId,
}: InstalledItemStatusControlProps): JSX.Element | null {
  if (!state) return null;
  if (state.kind === 'loading')
    return (
      <Skeleton
        loading
        label="Loading status"
        testId={testId ? `${testId}-loading` : undefined}
        className="inline-flex shrink-0"
      >
        <InstalledItemStatusPicker
          itemName={itemName}
          status={SAMPLE_LOADING_STATUS}
        />
      </Skeleton>
    );
  if (state.kind === 'read-only')
    return (
      <InstalledItemStatusUnavailable
        itemName={itemName}
        reason={state.reason}
        testId={testId ? `${testId}-unavailable` : undefined}
      />
    );
  if (state.kind === 'fixed')
    return (
      <InstalledItemStatusPicker
        itemName={itemName}
        status={state.status}
        disabledReason={state.reason}
        testId={testId}
      />
    );
  const { item } = state;
  if (item.status === null)
    return item.notices.some((notice) => notice.code === 'partial_removal') ? (
      <span
        className={QUIET_STATUS_CLASS}
        data-testid={testId ? `${testId}-pending-uninstall` : undefined}
      >
        Uninstall incomplete
      </span>
    ) : null;
  const target = item.target;
  return (
    <InstalledItemStatusPicker
      itemName={itemName}
      status={item.status}
      targetKind={target.kind}
      retryCurrent={item.notices.some((notice) => notice.retryable)}
      busy={pendingKeys.has(installedItemTargetKey(target))}
      testId={testId}
      onChange={
        onSetStatus
          ? (status): void => {
              void onSetStatus(target, status).then((outcome) => {
                if (!outcome.ok && outcome.message) onError?.(outcome.message);
              });
            }
          : undefined
      }
    />
  );
}

function NoticeLines({
  notices,
  testId,
}: {
  readonly notices: readonly InstalledItemNotice[];
  readonly testId: string;
}): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {notices.map((notice) => (
        <Notice
          key={`${notice.code}:${notice.provider ?? ''}:${notice.message}`}
          intent={
            notice.code === 'session_recreation_required'
              ? 'neutral'
              : 'attention'
          }
          data-notice-code={notice.code}
        >
          {notice.message}
        </Notice>
      ))}
    </div>
  );
}

/**
 * The ⋯ More menu an installed item's detail declares into its action bar,
 * with the host's rows first and Uninstall as its destructive row, last.
 */
function InstalledItemMoreMenu({
  itemName,
  anchorRef,
  disabled,
  testId,
  onUninstall,
}: {
  readonly itemName: string;
  readonly anchorRef: RefObject<HTMLSpanElement | null>;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onUninstall: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  // A host's own rows (a plugin's Update) join this menu, above Uninstall.
  const hostItems = useDetailMoreItems();
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Tooltip label="More actions">
          <Button
            variant="secondary"
            size="compact"
            iconOnly
            aria-label={`More actions for ${itemName}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-testid={`${testId}-more`}
            onClick={(): void => setOpen((current) => !current)}
          >
            <MoreHorizontalIcon size="sm" aria-hidden="true" />
          </Button>
        </Tooltip>
      </span>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={`Actions for ${itemName}`}
        data-testid={`${testId}-menu`}
        className="min-w-44 max-w-64"
      >
        {hostItems.length > 0 ? (
          // With host rows, Uninstall joins them in one row style, last
          // below a divider.
          <DetailMoreMenuRows
            items={[
              ...hostItems,
              {
                id: 'uninstall',
                label: 'Uninstall…',
                icon: <TrashIcon />,
                testId: `${testId}-uninstall`,
                onSelect: onUninstall,
                disabled,
                destructive: true,
              },
            ]}
            onClose={(): void => {
              setOpen(false);
              focusMenuTrigger(anchorRef.current);
            }}
          />
        ) : (
          <DropdownMenuItem
            tone="destructive"
            disabled={disabled}
            data-testid={`${testId}-uninstall`}
            onClick={(): void => {
              setOpen(false);
              onUninstall();
            }}
          >
            Uninstall…
          </DropdownMenuItem>
        )}
      </FloatingMenu>
    </>
  );
}

/**
 * The ⋯ More menu of an item its marketplace owns. Only a menu that renders may
 * ask for the host's rows: the first to ask gets them, so a row that asked
 * while loading would leave a later Uninstall menu without them.
 */
function ManageSourceMoreMenu({
  itemName,
  testId,
  onManageSource,
}: {
  readonly itemName: string;
  readonly testId: string;
  readonly onManageSource: () => void;
}): JSX.Element {
  const hostItems = useDetailMoreItems();
  return (
    <DetailPageActions
      more={
        <DetailMoreMenu
          name={itemName}
          triggerTestId={`${testId}-more`}
          menuTestId={`${testId}-menu`}
          placement="bottom-right"
          items={[
            ...hostItems,
            {
              id: 'manage-source',
              label: 'Manage in marketplace',
              icon: <ArrowUpRightIcon />,
              testId: `${testId}-manage-source`,
              onSelect: onManageSource,
            },
          ]}
        />
      }
    />
  );
}

export interface InstalledItemStatusRowProps {
  /** Opens the marketplace that owns an item this page can't remove. */
  readonly onManageSource?: () => void;
  readonly itemName: string;
  readonly state: InstalledEntryStatusState | undefined;
  readonly pendingKeys: ReadonlySet<string>;
  readonly onSetStatus?: InstalledItemSetStatus;
  readonly onUninstall?: InstalledItemUninstall;
  /** Called after a confirmed uninstall, so the host can leave the detail. */
  readonly onUninstalled?: () => void;
  /** Names a device server's configuration; defaults to its id. */
  readonly configurationLabel?: (ref: InstalledItemRef) => string;
  readonly testId?: string;
}

export function InstalledItemStatusRow({
  onManageSource,
  itemName,
  state,
  pendingKeys,
  onSetStatus,
  onUninstall,
  onUninstalled,
  configurationLabel,
  testId = 'installed-item-status-row',
}: InstalledItemStatusRowProps): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const uninstallRef = useRef<HTMLSpanElement>(null);
  if (!state) return null;

  const change = (
    target: InstalledItemTarget,
    status: InstalledItemStatus,
  ): void => {
    if (!onSetStatus) return;
    setError(null);
    void onSetStatus(target, status).then((outcome) => {
      if (!outcome.ok) setError(outcome.message ?? null);
    });
  };

  let body: JSX.Element;
  if (state.kind === 'loading') {
    body = <span className="text-s fg-tertiary">Loading status…</span>;
  } else if (state.kind === 'read-only') {
    body = (
      <span data-testid={`${testId}-reason`} className="text-s fg-tertiary">
        {state.reason}
      </span>
    );
  } else if (state.kind === 'fixed') {
    body = (
      <InstalledItemStatusPicker
        itemName={itemName}
        status={state.status}
        disabledReason={state.reason}
        testId={`${testId}-picker`}
      />
    );
  } else if (state.item.status === null) {
    body = (
      <span data-testid={`${testId}-reason`} className="text-s fg-tertiary">
        {state.item.notices.some(
          (notice) => notice.code === 'provider_unavailable',
        )
          ? 'Status could not be loaded.'
          : state.item.target.kind === 'mcp-server'
            ? 'No configurations are installed.'
            : 'Uninstall needs to finish.'}
      </span>
    );
  } else {
    const item = state.item;
    const itemStatus = state.item.status;
    body = (
      <InstalledItemStatusPicker
        itemName={itemName}
        status={itemStatus}
        retryCurrent={item.notices.some((notice) => notice.retryable)}
        busy={pendingKeys.has(installedItemTargetKey(item.target))}
        testId={`${testId}-picker`}
        menuPlacement="bottom-left"
        targetKind={item.target.kind}
        onChange={
          onSetStatus
            ? (status): void => change(item.target, status)
            : undefined
        }
      />
    );
  }

  const ready = state.kind === 'ready' ? state : null;
  const describedStatus =
    ready?.item.status ?? (state.kind === 'fixed' ? state.status : null);
  const uninstallTarget = ready?.item.uninstallTarget;
  const canUninstall =
    ready !== null &&
    ready.item.removable &&
    uninstallTarget !== undefined &&
    onUninstall !== undefined;

  return (
    <section
      aria-label="Status"
      data-testid={testId}
      className="flex flex-col gap-1"
    >
      {/* One unit (CAN-4261): the heading, the current state right beside
          it, and what that state means. */}
      <div className={DETAIL_FACT_GRID_CLASS} data-testid={`${testId}-line`}>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-s fg-secondary">Status</span>
          {describedStatus && (
            <Tooltip
              label={installedItemStatusDescription(
                describedStatus,
                ready?.item.target.kind,
              )}
            >
              <span
                tabIndex={0}
                role="img"
                aria-label={installedItemStatusDescription(
                  describedStatus,
                  ready?.item.target.kind,
                )}
                data-testid={`${testId}-description`}
                className="focus-ring inline-flex rounded-sm fg-tertiary"
              >
                <IconCircleQuestionmark size={12} />
              </span>
            </Tooltip>
          )}
        </span>
        <div
          className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1${
            state.kind === 'ready' || state.kind === 'fixed' ? ' -ml-2' : ''
          }`}
        >
          {body}
        </div>
      </div>
      {ready && ready.configurations.length > 1 && (
        <ul
          data-testid={`${testId}-configurations`}
          aria-label={`Configurations of ${itemName}`}
          className="flex flex-col gap-1"
        >
          {ready.configurations.map((configuration) => {
            const ref = configuration.target;
            if (ref.kind === 'mcp-server' || configuration.status === null)
              return null;
            const name =
              configurationLabel?.(ref) ??
              (ref.kind === 'mcp-config' ? ref.configId : itemName);
            const key = installedItemTargetKey(ref);
            return (
              <li
                key={key}
                className="flex items-center justify-between gap-4 pl-3"
              >
                <span className="min-w-0 truncate text-s fg-secondary">
                  {name}
                </span>
                <InstalledItemStatusPicker
                  itemName={`${itemName} (${name})`}
                  status={configuration.status}
                  targetKind={ref.kind}
                  retryCurrent={configuration.notices.some(
                    (notice) => notice.retryable,
                  )}
                  busy={pendingKeys.has(key)}
                  testId={`${testId}-configuration-${ref.kind === 'mcp-config' ? ref.configId : key}`}
                  onChange={
                    onSetStatus
                      ? (status): void => change(ref, status)
                      : undefined
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <ErrorBanner
        errorSource="installed-item-status-row"
        className=""
        error={error}
        testId={`${testId}-error`}
      />
      {ready && (
        <NoticeLines
          notices={[
            ...ready.item.notices,
            ...ready.configurations.flatMap((item) => item.notices),
          ].filter(
            (notice, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.code === notice.code &&
                  candidate.provider === notice.provider &&
                  candidate.message === notice.message,
              ) === index,
          )}
          testId={`${testId}-notices`}
        />
      )}
      {ready &&
        !canUninstall &&
        !ready.item.removable &&
        ready.item.reason &&
        (onManageSource &&
        ready.item.reason === INSTALLED_ITEM_MARKETPLACE_OWNED_REASON ? (
          <ManageSourceMoreMenu
            itemName={itemName}
            testId={testId}
            onManageSource={onManageSource}
          />
        ) : (
          <p
            data-testid={`${testId}-not-removable`}
            className={`text-xs fg-tertiary ${DETAIL_FACT_VALUE_OFFSET_CLASS}`}
          >
            {ready.item.reason}
          </p>
        ))}
      {canUninstall && (
        // Uninstall is rare and destructive, so it lives in the ⋯ More menu
        // that leads the detail's action bar, not in the Status body.
        <DetailPageActions
          more={
            <InstalledItemMoreMenu
              itemName={itemName}
              anchorRef={uninstallRef}
              disabled={pendingKeys.has(
                installedItemTargetKey(ready.item.target),
              )}
              testId={testId}
              onUninstall={(): void => setConfirming(true)}
            />
          }
        />
      )}
      {confirming && uninstallTarget && onUninstall && ready && (
        <UninstallConfirmDialog
          title={`Uninstall ${itemName}?`}
          message={
            ready.item.uninstallDescription ?? `This removes ${itemName}.`
          }
          restoreFocusRef={uninstallRef}
          dataTestId={`${testId}-uninstall-dialog`}
          confirmTestId={`${testId}-uninstall-confirm`}
          cancelTestId={`${testId}-uninstall-cancel`}
          onConfirm={async (): Promise<string | null> => {
            const outcome = await onUninstall(uninstallTarget);
            return outcome.ok
              ? null
              : (outcome.message ?? 'Could not uninstall. Try again.');
          }}
          onCancel={(): void => setConfirming(false)}
          onUninstalled={(): void => {
            setConfirming(false);
            onUninstalled?.();
          }}
        />
      )}
    </section>
  );
}
