'use client';

import { useState, type JSX } from 'react';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsConfirmDialog, useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { deleteOrganization } from './team-api';
import type { SettingsFailure } from '../errors';

/** Failures of `organization.delete` that have their own copy. */
const DELETE_ORGANIZATION_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // A live (active, past-due or unpaid) subscription blocks the delete.
    status: 409,
    copy: "Couldn't delete this organization while it has a live subscription. Cancel the subscription in Billing, then try again.",
  },
];

interface TeamDangerZoneProps {
  detail: OrganizationDetail;
  /** Called after the org is deleted so the page can navigate away. */
  onDeleted: () => void;
}

/**
 * OWNER-only row at the bottom of General for deleting the organization, in
 * a box of its own with no heading.
 * Returns `null` for non-owners so the destructive action is never rendered
 * for members or admins.
 */
export function TeamDangerZone({
  detail,
  onDeleted,
}: TeamDangerZoneProps): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.delete');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  if (detail.viewerRole !== 'OWNER') {
    return null;
  }

  const handleDelete = async (): Promise<void> => {
    try {
      setDeleting(true);
      setError(null);
      await deleteOrganization(client, detail.id);
      onDeleted();
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'delete the organization',
          known: DELETE_ORGANIZATION_KNOWN_ERRORS,
        }),
      );
      setDeleting(false);
      // Close the dialog on failure. The ErrorBanner renders in the section
      // behind the modal, so leaving the dialog open hides the reason the
      // delete was refused (e.g. the 409 for a live subscription).
      setConfirmingDelete(false);
    }
  };

  return (
    <section
      className={SETTINGS_CARD_GROUP_CLASS}
      aria-label="Delete organization"
      data-testid="team-danger-zone"
    >
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className="min-w-0">
          <div className="text-s font-medium fg-primary">
            Delete organization
          </div>
          <p className="text-xs text-pretty fg-secondary">
            Removes it for everyone in it, with its teams, pending invites and
            settings. Billing and usage history is kept. Cancel an active
            subscription first. This can&apos;t be undone.
          </p>
        </div>
        <Button
          size="compact"
          variant="ghost-destructive"
          onClick={() => setConfirmingDelete(true)}
          data-testid="team-delete"
        >
          Delete…
        </Button>
      </div>
      {error ? (
        <div className="pb-3">
          <ErrorBanner
            errorSource="team-danger-zone"
            error={error?.copy}
            details={error?.details}
          />
        </div>
      ) : null}

      {confirmingDelete && (
        <SettingsConfirmDialog
          title={`Delete “${detail.name}”?`}
          message="Shared worktrees, chats and Cowork entries are deleted. Members keep their local files, but this organization's projects move to their Personal space. This can't be undone."
          confirmLabel="Delete organization"
          busyLabel="Deleting…"
          busy={deleting}
          destructive
          dataTestId="team-delete-dialog"
          confirmTestId="team-delete-confirm"
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </section>
  );
}
