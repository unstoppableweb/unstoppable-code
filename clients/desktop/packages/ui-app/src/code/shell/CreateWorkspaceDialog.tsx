'use client';

import { useId, useState, type JSX } from 'react';
import type { WorkspaceCreateResult } from '@canopy/app-core';
import {
  normalizeRepositoryCloneUrl,
  remoteControlRepositoryCloneErrorMessage,
  type RemoteControlWorkspaceCreatePayload,
} from '@canopy/protocol/remote-control/shell';
import {
  Button,
  FormField,
  DialogModal,
  LoadingSpinner,
  RepositoryCloneError,
  TextInput,
} from '@canopy/ui-shared/components';

export interface CreateWorkspaceDialogTestIds {
  readonly dialog?: string;
  readonly remoteUrl?: string;
  readonly submit?: string;
  readonly error?: string;
}

export interface CreateWorkspaceDialogProps {
  readonly mode: 'remote-clone';
  readonly onCreate?: (
    payload: RemoteControlWorkspaceCreatePayload,
  ) => Promise<WorkspaceCreateResult>;
  readonly onClose: () => void;
  readonly testIds?: CreateWorkspaceDialogTestIds;
}

export function CreateWorkspaceDialog({
  mode,
  onCreate,
  onClose,
  testIds,
}: CreateWorkspaceDialogProps): JSX.Element {
  const [remoteUrl, setRemoteUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remoteUrlId = useId();
  const generatedErrorId = useId();
  const errorId = testIds?.error ?? generatedErrorId;
  const trimmedUrl = remoteUrl.trim();
  const canSubmit =
    mode === 'remote-clone' &&
    onCreate !== undefined &&
    trimmedUrl.length > 0 &&
    !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit || !onCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        kind: 'remote-clone',
        remoteUrl: normalizeRepositoryCloneUrl(trimmedUrl),
      });
      onClose();
    } catch (createError: unknown) {
      setError(remoteControlRepositoryCloneErrorMessage(createError));
      setSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={submitting ? (): void => undefined : onClose}
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      title="Add project"
      maxWidth="md"
      dataTestId={testIds?.dialog}
    >
      <div className="flex flex-col gap-4">
        <FormField
          label="Git repository URL"
          id={remoteUrlId}
          description="The desktop clones the repo into its default repositories folder and names the project after it."
        >
          <TextInput
            id={remoteUrlId}
            type="text"
            value={remoteUrl}
            onChange={(event) => {
              setRemoteUrl(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="https://github.com/org/repo.git"
            autoFocus
            disabled={submitting || onCreate === undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            data-testid={testIds?.remoteUrl}
          />
        </FormField>
        {error && (
          <RepositoryCloneError id={errorId} testId={errorId} message={error} />
        )}
        <div className="flex items-center justify-end gap-2">
          <Button size="compact" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid={testIds?.submit}
          >
            {submitting && <LoadingSpinner />}
            {submitting ? 'Cloning…' : 'Create'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
