'use client';

import { useCallback, useId, useRef, useState, type JSX } from 'react';
import {
  ChatComposerToolbarChip,
  PickerTrigger,
  Tooltip,
  FLOATING_PICKER_GAP,
  FloatingMenu,
  DirectoryPickerOptionRow,
} from '@canopy/ui-shared';
import {
  ChevronDownMediumIcon,
  FolderIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/protocol/ui-labels';
import { DirectoryPickerHeading } from './DirectoryPickerHeading';

/**
 * Tooltip shown while the picker is locked. Mirrors the desktop
 * `DirectoryPicker` lock copy: the provider session's cwd is fixed once the
 * chat has started, so a new chat is required to change it.
 */
const SESSION_LOCKED_TOOLTIP =
  'Working directory is locked while this chat is active — start a new chat to change it.';

export interface DirectoryPickerOption {
  id: string;
  name: string;
}

interface RemoteControlDirectoryPickerProps {
  statusRow?: boolean;
  compact?: boolean;
  /**
   * Currently selected repo id. `undefined` is equivalent to
   * {@link WORKSPACE_ROOT_REPO_ID} and renders as "Project root".
   */
  currentRepoId: string | undefined;
  /** Child repos in the workspace (workspace root is prepended automatically). */
  childRepos: DirectoryPickerOption[];
  /** Selecting the workspace root reports `undefined` (matches desktop). */
  onSelect: (repoId: string | undefined) => void;
  /**
   * Locked once the chat's provider session has started: the cwd is fixed for
   * the life of the session, so the trigger becomes a non-interactive label
   * (matching desktop, which disables its picker after `hasStartedSession`).
   */
  disabled?: boolean;
}

/**
 * Browser-safe port of the desktop `DirectoryPicker` chip (CAN-1216). The
 * trigger reuses the shared {@link ChatComposerToolbarChip} so it renders
 * byte-identically to the desktop directory chip; the popup is a lightweight
 * ARIA listbox anchored above the composer. The selected repo id is carried
 * inline on the next `portal.chat.send` (`RemoteControlChatSendPayload.selectedRepoId`).
 *
 * Rendered only for multi-repo worktree workspaces — cowork/standalone chats
 * have no child repos, so the picker never appears there.
 */
export function RemoteControlDirectoryPicker({
  currentRepoId,
  childRepos,
  onSelect,
  disabled = false,
  statusRow = false,
  compact = false,
}: RemoteControlDirectoryPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const effectiveId = currentRepoId ?? WORKSPACE_ROOT_REPO_ID;
  const currentName =
    effectiveId === WORKSPACE_ROOT_REPO_ID
      ? WORKSPACE_ROOT_REPO_NAME
      : (childRepos.find((repo) => repo.id === effectiveId)?.name ??
        effectiveId);

  const options: DirectoryPickerOption[] = [
    { id: WORKSPACE_ROOT_REPO_ID, name: WORKSPACE_ROOT_REPO_NAME },
    ...childRepos,
  ];

  const handleSelect = useCallback(
    (repoId: string): void => {
      onSelect(repoId === WORKSPACE_ROOT_REPO_ID ? undefined : repoId);
      setOpen(false);
    },
    [onSelect],
  );

  // A newly-locked picker (the chat just started) must not keep an open menu.
  // Render-phase reset (not an effect) so it applies before paint and stays
  // clear of the set-state-in-effect rule; the guard flips false after the
  // update so it does not loop. Mirrors the draft-reset pattern in
  // `remote-control-shared-chat-panel.tsx`.
  if (disabled && open) {
    setOpen(false);
  }

  return (
    <div className={statusRow ? 'relative min-w-0' : 'relative shrink-0'}>
      {statusRow ? (
        <Tooltip
          label={disabled ? SESSION_LOCKED_TOOLTIP : 'Working directory'}
          allowShrink
        >
          <PickerTrigger
            ref={triggerRef}
            disabled={disabled}
            onClick={(): void => setOpen((prev) => !prev)}
            className="max-w-full"
            // Compact drops the folder glyph, so the name leads the capsule.
            textLead={compact}
            textTrail
            aria-label={`Select working directory, current ${currentName}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-testid="remote-control-chat-directory-picker"
          >
            {compact ? null : <FolderIcon size="sm" />}
            <span className="min-w-0 truncate fg-primary">{currentName}</span>
          </PickerTrigger>
        </Tooltip>
      ) : (
        <ChatComposerToolbarChip
          variant="capsule"
          buttonRef={triggerRef}
          onClick={disabled ? undefined : (): void => setOpen((prev) => !prev)}
          disabled={disabled}
          icon={<FolderIcon size="sm" />}
          label={currentName}
          trailing={disabled ? undefined : <ChevronDownMediumIcon size="sm" />}
          ariaLabel={`Select working directory, current ${currentName}`}
          ariaHasPopup={disabled ? undefined : 'listbox'}
          ariaExpanded={disabled ? undefined : open}
          ariaControls={!disabled && open ? menuId : undefined}
          title={disabled ? SESSION_LOCKED_TOOLTIP : 'Working directory'}
          dataTestId="remote-control-chat-directory-picker"
        />
      )}
      <FloatingMenu
        id={menuId}
        open={open && !disabled}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="top-left"
        gap={FLOATING_PICKER_GAP}
        heightLimit={224}
        interaction="listbox"
        role="listbox"
        aria-label="Working directory options"
        data-testid="remote-control-chat-directory-menu"
        className="w-56"
      >
        <DirectoryPickerHeading />
        {options.map((option) => (
          <DirectoryPickerOptionRow
            key={option.id}
            name={option.name}
            selected={option.id === effectiveId}
            data-testid="remote-control-chat-directory-option"
            onSelect={(): void => handleSelect(option.id)}
          />
        ))}
      </FloatingMenu>
    </div>
  );
}
