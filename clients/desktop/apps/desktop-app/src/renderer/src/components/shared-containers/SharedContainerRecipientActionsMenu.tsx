import { useEffect, useRef, useState, type JSX } from 'react';
import {
  ActionMenuRowStyle,
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  Menu,
  RailIconButton,
} from '@canopy/ui-shared/components';
import {
  CopyIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DeleteConfirmModal } from '@/components/shared/DeleteConfirmModal';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
} from '@/stores/sharedContainerReplicasStore';
import { SharedContainerForkModal } from './SharedContainerForkModal';
import { useSharedContainerRecipientActions } from './useSharedContainerRecipientActions';
import {
  readForkRevision,
  useSharedContainerForkRevision,
} from './useSharedContainerForkRevision';

/**
 * Action menu for an accepted share: on its sidebar row, where it is revealed
 * with the row, and on its Past shares row, where it is always visible.
 */
export function SharedContainerRecipientActionsMenu({
  entry,
  reveal = true,
}: {
  entry: SharedContainerListEntry;
  /** Reveal with the hovered sidebar row instead of staying visible. */
  reveal?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [forking, setForking] = useState(false);
  // Whether a replica is readable right now, deciding if the menu offers a
  // copy. Fetched when the menu opens rather than held in the store: the store
  // only tracks the mounted viewer's replica, and a row's replica can be
  // mid-promotion, so a stale "available" would offer a fork over a borrowed
  // checkout that main would then refuse.
  const [forkable, setForkable] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const actions = useSharedContainerRecipientActions(
    entry.container.id,
    entry.organizationId,
    entry.container.title,
  );
  // A server that keeps no record of a removed share makes this removal
  // irreversible, so the confirmation keeps the copy that says so.
  const restorable = useSharedContainerReplicasStore(
    (state) => state.removedStatus !== 'unsupported',
  );
  const testIdPrefix = `shared-container-row-${entry.container.id}`;

  const containerId = entry.container.id;
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    setForkable(false);
    void readForkRevision(containerId).then((revision) => {
      if (!canceled) setForkable(revision.status === 'available');
    });
    return (): void => {
      canceled = true;
    };
  }, [containerId, open]);
  // The revision the dialog reviews is resolved when it opens, not when the
  // menu did, and follows main's updates while it is open.
  const forkRevision = useSharedContainerForkRevision(containerId, forking);

  return (
    <>
      {/* The sidebar's one ••• control: the rail button every row and header
          uses, revealed with the row. */}
      <RailIconButton
        ref={buttonRef}
        icon={MoreHorizontalIcon}
        aria-label={`More actions for ${entry.container.title}`}
        tooltipLabel="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`${testIdPrefix}-actions`}
        hoverSurface
        revealOnItemHover={reveal && !open}
        coarsePointerTarget
        onClick={(event): void => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      />
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-left"
        interaction="menu"
        data-testid={`${testIdPrefix}-menu`}
        className="w-40"
      >
        <ActionMenuRowStyle>
          {forkable && (
            <>
              <MenuItem
                data-testid={`${testIdPrefix}-fork`}
                onClick={(event): void => {
                  event.stopPropagation();
                  setOpen(false);
                  setForking(true);
                }}
              >
                <MenuItemIcon>
                  <CopyIcon />
                </MenuItemIcon>
                Make a copy
              </MenuItem>
              {/* Removal closes the menu in its own group. */}
              <MenuDivider />
            </>
          )}
          <MenuItem
            tone="destructive"
            disabled={actions.dismissing}
            data-testid={`${testIdPrefix}-remove`}
            onClick={(event): void => {
              event.stopPropagation();
              setOpen(false);
              setConfirmingRemove(true);
            }}
          >
            <MenuItemIcon>
              <TrashIcon />
            </MenuItemIcon>
            Remove share
          </MenuItem>
        </ActionMenuRowStyle>
      </Menu>
      {forking && (
        <SharedContainerForkModal
          containerId={entry.container.id}
          organizationId={entry.organizationId}
          access={entry.access ?? 'organization'}
          revision={forkRevision}
          containerType={entry.container.containerType}
          title={entry.container.title}
          ownerName={entry.ownerName}
          onClose={(): void => setForking(false)}
        />
      )}
      {confirmingRemove && (
        <DeleteConfirmModal
          title="Remove this share?"
          message={
            <p className="text-s fg-secondary">
              Remove{' '}
              <span className="font-medium fg-primary">
                {entry.container.title}
              </span>
              ?{' '}
              {restorable ? (
                'This deletes the local copy from this computer. You can restore the share from Past shares and accept it again.'
              ) : (
                <>
                  This deletes the local copy from this computer and gives up
                  your access, so it isn&rsquo;t just hidden from the list.{' '}
                  {entry.ownerName === undefined ? (
                    'The person who shared it'
                  ) : (
                    <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                      {entry.ownerName}
                    </span>
                  )}{' '}
                  would have to share it with you again.
                </>
              )}
            </p>
          }
          confirmLabel="Remove share"
          pendingLabel="Removing…"
          pending={actions.dismissing}
          dataTestId={`${testIdPrefix}-remove-confirmation`}
          confirmTestId={`${testIdPrefix}-remove-confirm`}
          onCancel={(): void => setConfirmingRemove(false)}
          // A success unmounts this row (and the dialog with it) once the
          // listing drops the entry. A failure has to close it explicitly, or
          // the dialog would sit there pending-less and unexplained behind the
          // failure toast.
          onConfirm={(): void => {
            void actions.dismiss().then((outcome) => {
              if (outcome === 'failed') setConfirmingRemove(false);
            });
          }}
        />
      )}
    </>
  );
}
