'use client';

import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
} from 'react';
import {
  Button,
  ErrorBanner,
  SettingsRowsRow,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { ALLOWED_AVATAR_MIME_TYPES } from '@canopy/protocol/settings/account';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import { OrganizationLogo } from './OrganizationLogo';
import { renameOrganization } from './team-api';
import { useOrgLogoEditor } from './use-org-logo-editor';
import type { SettingsFailure } from '../errors';

const LOGO_INPUT_ACCEPT = ALLOWED_AVATAR_MIME_TYPES.join(',');

interface TeamBrandingSettingsSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

/**
 * Owner/admin rows for the organization's identity on General: its logo
 * (moderated upload, or remove) and its name. Each change saves at once and
 * returns a fresh {@link OrganizationDetail}, which replaces the in-memory
 * detail so the settings rail's scope picker catches up.
 */
export function TeamBrandingSettingsSection({
  detail,
  onDetailChange,
}: TeamBrandingSettingsSectionProps): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.overview');
  const logoEditor = useOrgLogoEditor(detail.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(detail.name);
  const [savedName, setSavedName] = useState(detail.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<SettingsFailure | null>(null);
  // A rename elsewhere (another tab, a refresh) replaces the field's value.
  if (detail.name !== savedName) {
    setSavedName(detail.name);
    setName(detail.name);
  }

  if (!canEditOrg(detail.viewerRole)) {
    return null;
  }

  const handlePick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file re-triggers `onChange`.
    event.target.value = '';
    if (!file) return;
    void logoEditor.uploadLogo(file).then((updated) => {
      if (updated) onDetailChange(updated);
    });
  };

  const handleRemove = (): void => {
    void logoEditor.removeLogo().then((updated) => {
      if (updated) onDetailChange(updated);
    });
  };

  const saveName = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(detail.name);
      return;
    }
    if (trimmed === detail.name || savingName) return;
    try {
      setSavingName(true);
      setNameError(null);
      onDetailChange(await renameOrganization(client, detail.id, trimmed));
    } catch (err) {
      setNameError(
        errorCopy.actionFailure(err, { action: 'rename the organization' }),
      );
    } finally {
      setSavingName(false);
    }
  };

  const handleNameSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void saveName();
  };

  const logoError = logoEditor.error;

  return (
    <SettingsCard title="Organization" testId="team-branding-settings-section">
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className="min-w-0">
          <div className="text-s font-medium fg-primary">Logo</div>
          <p className="text-xs text-pretty fg-secondary">
            PNG, JPEG or GIF up to 5 MB, shown as a rounded square.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <OrganizationLogo
            name={detail.name}
            logoUrl={detail.logoUrl}
            size="lg"
          />
          <Button
            size="compact"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={logoEditor.busy}
            data-testid="org-logo-edit"
          >
            {detail.logoUrl ? 'Change' : 'Add logo'}
          </Button>
          {detail.logoUrl ? (
            <Button
              size="compact"
              variant="secondary"
              onClick={handleRemove}
              disabled={logoEditor.busy}
              data-testid="org-logo-remove"
            >
              Remove
            </Button>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_INPUT_ACCEPT}
            className="sr-only"
            data-testid="org-logo-input"
            onChange={handlePick}
          />
        </div>
      </div>
      {logoError ? (
        <div className="pb-3">
          <ErrorBanner
            errorSource="team-branding-settings-section-logo"
            error={logoError.copy}
            details={logoError.details}
          />
        </div>
      ) : null}
      <form className={SETTINGS_CARD_ROW_CLASS} onSubmit={handleNameSubmit}>
        <div className="min-w-0 flex-1">
          <SettingsRowsRow
            label="Name"
            htmlFor="team-name-input"
            control={
              <div className="w-52 shrink-0">
                <TextInput
                  id="team-name-input"
                  density="settings"
                  required
                  maxLength={120}
                  value={name}
                  disabled={savingName}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => void saveName()}
                  data-testid="team-name-input"
                />
              </div>
            }
          />
        </div>
      </form>
      {nameError ? (
        <div className="pb-3">
          <ErrorBanner
            errorSource="team-branding-settings-section-name"
            error={nameError?.copy}
            details={nameError?.details}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}
