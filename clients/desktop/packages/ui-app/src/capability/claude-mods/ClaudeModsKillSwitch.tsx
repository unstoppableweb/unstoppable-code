'use client';

import { useId, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import {
  Notice,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  CLAUDE_MODS_COPY,
  CLAUDE_MODS_UPDATE_ERROR_COPY,
} from './claudeModsCopy';
import { useClaudeMods } from './useClaudeMods';

export function ClaudeModsKillSwitch(): JSX.Element | null {
  const hasCapability = useCapabilities().claudeModAdmission === true;
  const { state, pending, error, update } = useClaudeMods();
  const generatedId = useId();
  if (!hasCapability || state?.enabled !== true) return null;

  const descriptionId = `claude-mods-kill-switch-description-${generatedId}`;
  const statusId = `claude-mods-kill-switch-status-${generatedId}`;
  const switchId = `claude-mods-kill-switch-${generatedId}`;
  const describedBy = state.authorityUnreadable
    ? `${descriptionId} ${statusId}`
    : descriptionId;

  return (
    <SettingsRowsSection
      title={CLAUDE_MODS_COPY.killSwitchTitle}
      headingId={`claude-mods-heading-${generatedId}`}
    >
      <SettingsRowsGroup>
        <SettingsRowsRow
          dataTestId="claude-mods-kill-switch"
          label={CLAUDE_MODS_COPY.killSwitchLabel}
          description={
            <span id={descriptionId}>
              {CLAUDE_MODS_COPY.killSwitchDescription}
            </span>
          }
          control={
            <ToggleSwitch
              id={switchId}
              checked={state.modsDisabled}
              disabled={pending || state.authorityUnreadable}
              busy={pending}
              label={CLAUDE_MODS_COPY.killSwitchLabel}
              describedBy={describedBy}
              dataTestId="claude-mods-kill-switch-toggle"
              onChange={(modsDisabled) =>
                update({ action: 'set-mods-disabled', modsDisabled })
              }
            />
          }
          htmlFor={switchId}
        >
          {state.authorityUnreadable || error ? (
            <div className="flex flex-col gap-2">
              {state.authorityUnreadable ? (
                <p
                  id={statusId}
                  data-testid="claude-mods-kill-switch-status"
                  className="text-xs text-pretty fg-secondary"
                >
                  {CLAUDE_MODS_COPY.status.authorityUnreadable}
                </p>
              ) : null}
              {error ? (
                <Notice
                  errorSource="claude-mods-kill-switch-error"
                  intent="destructive"
                  data-testid="claude-mods-kill-switch-error"
                >
                  {CLAUDE_MODS_UPDATE_ERROR_COPY[error]}
                </Notice>
              ) : null}
            </div>
          ) : null}
        </SettingsRowsRow>
      </SettingsRowsGroup>
    </SettingsRowsSection>
  );
}
