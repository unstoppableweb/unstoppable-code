'use client';

import { useId, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import type { ClaudeModsChatContext } from '@canopy/protocol/claude-mods';
import {
  Notice,
  SettingsRowsGroup,
  SettingsRowsRow,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  claudeModAdmissionSwitchState,
  claudeModAdmissionUpdate,
} from './claudeModAdmissionModel';
import {
  CLAUDE_MODS_COPY,
  CLAUDE_MODS_UPDATE_ERROR_COPY,
} from './claudeModsCopy';
import { useClaudeMods } from './useClaudeMods';

export interface ClaudeModAdmissionControlProps {
  readonly pluginId: string;
  /** The chat the control acts for, when it sits in one. */
  readonly context?: ClaudeModsChatContext;
}

export function ClaudeModAdmissionControl({
  pluginId,
  context,
}: ClaudeModAdmissionControlProps): JSX.Element | null {
  const hasCapability = useCapabilities().claudeModAdmission === true;
  const { state, pending, error, update } = useClaudeMods(pluginId, context);
  const generatedId = useId();
  if (!hasCapability || state?.enabled !== true || !state.plugin) return null;

  // The desktop may name the plugin by its Claude id rather than `pluginId`.
  const plugin = state.plugin;
  const descriptionId = `claude-mod-admission-description-${generatedId}`;
  const statusId = `claude-mod-admission-status-${generatedId}`;
  const switchId = `claude-mod-admission-switch-${generatedId}`;
  const { checked, disabled, statusText } = claudeModAdmissionSwitchState(
    state,
    plugin,
    pending,
  );
  const describedBy = statusText
    ? `${descriptionId} ${statusId}`
    : descriptionId;

  return (
    <div data-testid="claude-mod-admission-control">
      <SettingsRowsGroup>
        <SettingsRowsRow
          label={CLAUDE_MODS_COPY.admissionLabel}
          description={
            <span id={descriptionId}>
              {CLAUDE_MODS_COPY.admissionDescription}
            </span>
          }
          control={
            <ToggleSwitch
              id={switchId}
              checked={checked}
              disabled={disabled}
              busy={pending}
              label={CLAUDE_MODS_COPY.admissionLabel}
              describedBy={describedBy}
              dataTestId="claude-mod-admission-switch"
              onChange={(next) => {
                const nextUpdate = claudeModAdmissionUpdate(plugin, next);
                if (nextUpdate) update(nextUpdate);
              }}
            />
          }
          htmlFor={switchId}
        >
          {statusText || error ? (
            <div className="flex flex-col gap-2">
              {statusText ? (
                <p
                  id={statusId}
                  data-testid="claude-mod-admission-status"
                  className="text-xs text-pretty fg-secondary"
                >
                  {statusText}
                </p>
              ) : null}
              {error ? (
                <Notice
                  errorSource="claude-mod-admission-error"
                  intent="destructive"
                  data-testid="claude-mod-admission-error"
                >
                  {CLAUDE_MODS_UPDATE_ERROR_COPY[error]}
                </Notice>
              ) : null}
            </div>
          ) : null}
        </SettingsRowsRow>
      </SettingsRowsGroup>
    </div>
  );
}
