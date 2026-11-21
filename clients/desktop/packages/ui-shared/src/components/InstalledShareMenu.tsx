'use client';

import { useId, useRef, useState, type JSX } from 'react';
import { MoreHorizontalIcon, SettingsIcon, TrashIcon } from '../icons/AppIcons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from './ActionMenuItems';
import { Button } from './Button';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';
import { UninstallConfirmDialog } from './UninstallConfirmDialog';

/**
 * The ⋯ menu beside an installed shared resource (CAN-3710): Manage and
 * Uninstall, shared by the desktop install review and the web `/share/*`
 * landers. Uninstall asks in the shared `UninstallConfirmDialog` with a
 * button named for the outcome, never an inline `Yes` / `No`.
 *
 * Pure display: the host owns what Manage opens and what Uninstall removes.
 * The menu is the shared floating action menu, so Escape closes only the open
 * menu and a dialog around it keeps its own Escape. Uninstall sits in its own
 * last group, as removal rows do in every action menu.
 */

export interface InstalledShareMenuTestIds {
  readonly kebab: string;
  readonly menu: string;
  readonly manage: string;
  readonly uninstall: string;
  readonly uninstallConfirm: string;
  readonly uninstallDialog: string;
}

const DEFAULT_TEST_IDS: InstalledShareMenuTestIds = {
  kebab: 'installed-share-kebab',
  menu: 'installed-share-menu',
  manage: 'installed-share-manage',
  uninstall: 'installed-share-uninstall',
  uninstallConfirm: 'installed-share-uninstall-confirm',
  uninstallDialog: 'installed-share-uninstall-dialog',
};

export interface InstalledShareMenuProps {
  /** The uninstall question (default `Uninstall this item?`). */
  readonly uninstallTitle?: string;
  readonly onManage: () => void;
  /**
   * Removes the installed copy. Resolves whether it was removed; `false` (or a
   * rejection) keeps the confirm open with `uninstallErrorMessage`.
   * Omit to offer Manage only.
   */
  readonly onUninstall?: () => Promise<boolean>;
  /** Disables the kebab and both items while the host is writing. */
  readonly busy?: boolean;
  readonly manageLabel?: string;
  readonly uninstallErrorMessage?: string;
  /**
   * The host already recorded why `onUninstall` failed, so the confirm shows
   * its message and records nothing.
   */
  readonly uninstallErrorRecorded?: boolean;
  /** `above` rises from a footer row; `below` drops from a top row. */
  readonly placement?: 'above' | 'below';
  readonly testIds?: Partial<InstalledShareMenuTestIds>;
}

type InstalledShareMenuAction = 'manage' | 'uninstall';

export function InstalledShareMenu({
  uninstallTitle = 'Uninstall this item?',
  onManage,
  onUninstall,
  busy = false,
  manageLabel = 'Manage',
  uninstallErrorMessage = 'Could not uninstall. Try again.',
  uninstallErrorRecorded = false,
  placement = 'below',
  testIds,
}: InstalledShareMenuProps): JSX.Element {
  const ids = { ...DEFAULT_TEST_IDS, ...testIds };
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items: ActionMenuItem<InstalledShareMenuAction>[] = [
    {
      key: 'manage',
      label: manageLabel,
      icon: <SettingsIcon />,
      disabled: busy,
      testId: ids.manage,
      onSelect: onManage,
    },
  ];
  if (onUninstall) {
    items.push({
      key: 'uninstall',
      label: 'Uninstall',
      icon: <TrashIcon />,
      tone: 'destructive',
      disabled: busy,
      separatorBefore: true,
      testId: ids.uninstall,
      onSelect: (): void => {
        setConfirming(true);
      },
    });
  }

  return (
    <div className="relative inline-flex shrink-0">
      <Button
        ref={kebabRef}
        variant="secondary"
        size="lg"
        iconOnly
        data-testid={ids.kebab}
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={(): void => {
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontalIcon size="sm" aria-hidden />
      </Button>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={kebabRef}
        placement={placement === 'above' ? 'top-right' : 'bottom-right'}
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        data-testid={ids.menu}
        className="w-52"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={items}
            onSelect={(item): void => {
              setOpen(false);
              // Hand focus back to the kebab, as a FloatingMenu pick does.
              kebabRef.current?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
      {confirming && onUninstall && (
        <UninstallConfirmDialog
          {...(uninstallErrorRecorded
            ? { errorRecordingDisabled: true as const }
            : { errorSource: 'uninstall-installed-share' })}
          title={uninstallTitle}
          message="This removes your installed copy. You can install it again later."
          dataTestId={ids.uninstallDialog}
          confirmTestId={ids.uninstallConfirm}
          restoreFocusRef={kebabRef}
          fallbackErrorMessage={uninstallErrorMessage}
          onConfirm={async (): Promise<string | null> =>
            (await onUninstall()) ? null : uninstallErrorMessage
          }
          onUninstalled={(): void => {
            setConfirming(false);
          }}
          onCancel={(): void => {
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}
