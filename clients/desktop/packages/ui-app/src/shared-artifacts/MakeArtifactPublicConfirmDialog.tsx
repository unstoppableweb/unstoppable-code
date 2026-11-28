'use client';

import type { JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';

/**
 * Asked on every off-to-on change of the public link, not only the first,
 * because the content may have changed since. Cancel sends nothing.
 */
export function MakeArtifactPublicConfirmDialog({
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
      title={SHARED_ARTIFACT_COPY.makePublicTitle}
      message={SHARED_ARTIFACT_COPY.makePublicBody}
      confirmLabel={SHARED_ARTIFACT_COPY.makePublicConfirm}
      busyLabel={SHARED_ARTIFACT_COPY.makePublicBusy}
      busy={busy}
      errorMessage={errorMessage}
      errorSource="shared-artifact-make-public"
      focusCancel
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId="shared-artifact-make-public-confirm"
      confirmTestId="shared-artifact-make-public-confirm-action"
    />
  );
}
