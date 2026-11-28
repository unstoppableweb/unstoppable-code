'use client';

import type { JSX } from 'react';
import { SettingsRowsRow, ToggleSwitch } from '@canopy/ui-shared/components';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';

/**
 * The organization's "Allow public artifacts" setting, for Owners and
 * Admins, off by default (CAN-8017). Presentational: the settings protocol
 * doesn't carry `allowPublicArtifactSharing` yet (CAN-8016 adds it), so
 * nothing mounts this until the organization Policies card can save it.
 * No confirmation in either direction: it's reversible, and the description
 * says that turning it off pauses existing public links.
 */
export function AllowPublicArtifactsSettingRow({
  checked,
  busy,
  onChange,
}: {
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <SettingsRowsRow
      label={SHARED_ARTIFACT_COPY.allowPublicTitle}
      description={SHARED_ARTIFACT_COPY.allowPublicDescription}
      control={
        <ToggleSwitch
          label={SHARED_ARTIFACT_COPY.allowPublicTitle}
          checked={checked}
          busy={busy}
          disabled={busy}
          dataTestId="allow-public-artifacts-switch"
          onChange={onChange}
        />
      }
    />
  );
}
