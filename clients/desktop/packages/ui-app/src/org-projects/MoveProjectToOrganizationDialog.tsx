import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { OrgProjectMoveErrorCode } from '@canopy/protocol/org-projects';
import {
  Button,
  DialogFormField,
  DialogModal,
  Select,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * Moves a Personal project, with every worktree in it, to one of the viewer's
 * organizations. Presentational: the host owns the move, the busy state and
 * the error, and reads the organizations live. The organization is always the
 * viewer's explicit pick; only a single organization is preselected.
 */

const TITLE = 'Move to organization';
const ORGANIZATION_LABEL = 'Organization';
const ORGANIZATION_PLACEHOLDER = 'Choose an organization';
const CANCEL_LABEL = 'Cancel';
const MOVE_LABEL = 'Move';
const MOVE_BUSY_LABEL = 'Moving…';

export interface MoveProjectToOrganizationOption {
  readonly id: string;
  readonly name: string;
}

export interface MoveProjectToOrganizationError {
  readonly code: OrgProjectMoveErrorCode;
  /** The organization the failed move was for; the sentence shows only for it. */
  readonly organizationId: string;
}

export interface MoveProjectToOrganizationDialogProps {
  readonly projectName: string;
  readonly organizations: readonly MoveProjectToOrganizationOption[];
  /** True while the move is in flight. */
  readonly busy?: boolean;
  readonly error?: MoveProjectToOrganizationError | null;
  readonly onMove: (organizationId: string) => void;
  readonly onCancel: () => void;
  readonly dataTestId?: string;
}

/** The inline sentence for a refused move. Every refusal leaves the project in Personal. */
export function moveProjectToOrganizationErrorMessage(
  code: OrgProjectMoveErrorCode,
  projectName: string,
  organizationName: string,
): string {
  switch (code) {
    case 'unavailable':
      return `Couldn't move ${projectName}. Organization projects aren't available for ${organizationName}.`;
    case 'workspace-not-found':
    case 'workspace-unreadable':
      return `Couldn't move ${projectName}. Its project settings could not be read.`;
    case 'unsupported-workspace':
      return `Couldn't move ${projectName}. This project can't move to an organization.`;
    case 'not-personal':
      return `${projectName} already belongs to an organization.`;
    case 'repository-outside-organization':
      return `Couldn't move ${projectName}. Its repository isn't available to ${organizationName}.`;
    case 'repository-unavailable':
      return `Couldn't move ${projectName}. Its Git remote could not be read.`;
    case 'limit-reached':
      return `Couldn't move ${projectName}. You've reached ${organizationName}'s limit for private projects.`;
    case 'project-unavailable':
      return `Couldn't move ${projectName}. ${organizationName}'s project isn't available.`;
    case 'project-already-bound':
      return `Couldn't move ${projectName}. ${organizationName}'s project for this repository is already set up on this device.`;
    case 'busy':
      return `${projectName} is already being moved or set up. Wait for that to finish.`;
    case 'offline':
      return `Couldn't move ${projectName}. Check your connection and try again.`;
    case 'move-failed':
      return `Couldn't move ${projectName}. It stayed in Personal.`;
  }
}

/**
 * The pick starts on the viewer's only organization, an explicit account fact
 * (sole membership); with several, the viewer makes it. List order is display
 * only and never chooses.
 */
function initialSelection(
  organizations: readonly MoveProjectToOrganizationOption[],
): string {
  if (organizations.length !== 1) return '';
  // eslint-disable-next-line eslint-js/no-restricted-syntax -- Sole membership: with exactly one organization there is no order to infer from.
  return organizations[0]?.id ?? '';
}

export function MoveProjectToOrganizationDialog({
  projectName,
  organizations,
  busy = false,
  error = null,
  onMove,
  onCancel,
  dataTestId = 'move-project-to-organization-dialog',
}: MoveProjectToOrganizationDialogProps): JSX.Element {
  const selectId = useId();
  const selectRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const [selectedId, setSelectedId] = useState(() =>
    initialSelection(organizations),
  );
  // True while the pick is the sole-membership default, not the viewer's.
  const [autoPicked, setAutoPicked] = useState(
    () => organizations.length === 1,
  );
  const preselected = organizations.length === 1;

  // The list is live: a pick that leaves it (the viewer left the
  // organization) falls back to the placeholder or the one remaining option,
  // and a default pick is cleared once there is more than one to choose from.
  useEffect(() => {
    if (
      selectedId !== '' &&
      organizations.some((organization) => organization.id === selectedId) &&
      !(autoPicked && organizations.length !== 1)
    ) {
      return;
    }
    const next = initialSelection(organizations);
    if (next !== selectedId) setSelectedId(next);
    setAutoPicked(next !== '');
  }, [organizations, selectedId, autoPicked]);

  const selected = organizations.find(
    (organization) => organization.id === selectedId,
  );
  const visibleError =
    error !== null &&
    selected !== undefined &&
    error.organizationId === selected.id
      ? error
      : null;
  const close = busy ? (): void => {} : onCancel;

  return (
    <DialogModal
      inset="flush"
      onClose={close}
      title={TITLE}
      maxWidth="sm"
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeButtonDisabled={busy}
      dataTestId={dataTestId}
      trapFocus
      initialFocusRef={preselected ? moveRef : selectRef}
    >
      <div className="flex flex-col gap-3 px-6 py-4">
        <p className="text-s fg-secondary">
          Once <span className={REPLAY_MASK_CLASS}>{projectName}</span> moves to
          an organization, it stays there and cannot move back to your personal
          space.
        </p>
        <DialogFormField label={ORGANIZATION_LABEL} htmlFor={selectId}>
          <Select
            ref={selectRef}
            id={selectId}
            value={selectedId === '' ? null : selectedId}
            placeholder={ORGANIZATION_PLACEHOLDER}
            disabled={busy}
            onValueChange={(value): void => {
              setSelectedId(value);
              setAutoPicked(false);
            }}
            options={organizations.map((organization) => ({
              value: organization.id,
              label: organization.name,
            }))}
            data-testid="move-project-to-organization-select"
          />
        </DialogFormField>
        {visibleError && selected ? (
          <ErrorBanner
            errorSource="move-project-to-organization-error"
            className=""
            // The sentence names the user-authored project.
            blockMessageFromReplay
            testId="move-project-to-organization-error"
            error={moveProjectToOrganizationErrorMessage(
              visibleError.code,
              projectName,
              selected.name,
            )}
          />
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-3">
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={busy}
          data-testid="move-project-to-organization-cancel"
        >
          {CANCEL_LABEL}
        </Button>
        <Button
          ref={moveRef}
          variant="primary"
          onClick={(): void => {
            if (selected) onMove(selected.id);
          }}
          disabled={busy || selected === undefined}
          data-testid="move-project-to-organization-move"
        >
          {busy ? MOVE_BUSY_LABEL : MOVE_LABEL}
        </Button>
      </div>
    </DialogModal>
  );
}
