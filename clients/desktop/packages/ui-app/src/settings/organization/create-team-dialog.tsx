'use client';

import { useId, useState, type FormEvent, type JSX } from 'react';
import {
  Button,
  DialogFormField,
  DialogModal,
  ErrorBanner,
  TextInput,
} from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { createOrganization } from './team-api';
import type { SettingsFailure } from '../errors';

/** Failures of `organization.create` that have their own copy. */
const CREATE_ORGANIZATION_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The viewer already owns as many organizations as their limit allows.
    status: 409,
    copy: "You've reached the limit of organizations you can own. Delete one you no longer use, then try again.",
  },
];

interface CreateTeamDialogProps {
  onClose: () => void;
  /** Invoked with the freshly created org so the caller can navigate to it. */
  onCreated: (detail: OrganizationDetail) => void;
}

/**
 * Modal form for creating a new organization (Organization). Any ACTIVE user
 * may create one and becomes its OWNER. On success the parent navigates to the
 * new `/organization/[orgId]` route.
 */
export function CreateTeamDialog({
  onClose,
  onCreated,
}: CreateTeamDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organizations');
  const nameId = useId();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const detail = await createOrganization(client, trimmed);
      onCreated(detail);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'create the organization',
          known: CREATE_ORGANIZATION_KNOWN_ERRORS,
        }),
      );
      setSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={onClose}
      title="Create an organization"
      subtitle="Spin up a shared space for your collaborators. You'll be its owner."
      maxWidth="md"
      dataTestId="create-team-dialog"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="create-team-dialog"
          error={error?.copy}
          details={error?.details}
        />
        <DialogFormField label="Organization name" htmlFor={nameId}>
          <TextInput
            id={nameId}
            density="settings"
            type="text"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Engineering"
            data-testid="create-team-name-input"
          />
        </DialogFormField>
        {/* No Cancel: the dialog closes from its X, Escape, or the backdrop. */}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={submitting || !name.trim()}
            data-testid="create-team-submit"
          >
            {submitting ? 'Creating…' : 'Create organization'}
          </Button>
        </div>
      </form>
    </DialogModal>
  );
}
