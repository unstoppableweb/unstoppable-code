'use client';

import type { JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';

/**
 * Asked before republishing an artifact that has a public link. Built for
 * CAN-8018: republish is desktop-only, so nothing mounts it yet.
 */
export function RepublishPublicArtifactConfirmDialog({
  busy,
  errorMessage,
  onConfirm,
  onCancel,
}: {
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  return (
    <ConfirmDialog
      title={SHARED_ARTIFACT_COPY.republishTitle}
      message={SHARED_ARTIFACT_COPY.republishBody}
      confirmLabel={SHARED_ARTIFACT_COPY.republishConfirm}
      busyLabel={SHARED_ARTIFACT_COPY.republishBusy}
      busy={busy}
      errorMessage={errorMessage}
      errorSource="shared-artifact-republish-public"
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId="shared-artifact-republish-confirm"
      confirmTestId="shared-artifact-republish-confirm-action"
    />
  );
}
