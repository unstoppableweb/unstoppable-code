import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { JSX } from 'react';
import { ChoiceField } from '../primitives/Choice';
import { ChoiceList } from '../primitives/ChoiceList';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SettingsRowsRow } from './settings/SettingsRows';

const ACCESS_LABEL = `Allow project agents to use ${ORCHESTRATOR_LABEL} chats and create automations`;

export type AppAdvisorProjectAgentAccessOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

export type AppAdvisorProjectAgentAccessControlMode =
  | 'enabled'
  | 'selected-owners'
  | 'disabled';

export interface AppAdvisorProjectAgentAccessValue {
  mode: AppAdvisorProjectAgentAccessControlMode;
  selectedOwners: AppAdvisorProjectAgentAccessOwner[];
}

export interface AppAdvisorProjectAgentAccessOwnerOption {
  readonly owner: AppAdvisorProjectAgentAccessOwner;
  readonly label: string;
  readonly unavailable?: boolean;
}

export interface AppAdvisorProjectAgentAccessControlProps {
  readonly value: AppAdvisorProjectAgentAccessValue;
  /** Host-ordered: Personal first, then organizations by name. Render in the given order; never re-sort. */
  readonly ownerOptions: readonly AppAdvisorProjectAgentAccessOwnerOption[];
  /** Always receives the complete next object (mode + selectedOwners). */
  readonly onChange: (next: AppAdvisorProjectAgentAccessValue) => void;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly testIdPrefix?: string;
}

interface OwnerRow {
  readonly owner: AppAdvisorProjectAgentAccessOwner;
  readonly label: string;
  readonly unavailable: boolean;
  readonly staleOrganizationId: string | null;
}

const MODE_DESCRIPTIONS: Record<
  AppAdvisorProjectAgentAccessControlMode,
  string
> = {
  enabled: `Code and cowork agents can message, read, and watch ${ORCHESTRATOR_LABEL} chats, and can create automations that prompt ${ORCHESTRATOR_LABEL}.`,
  'selected-owners': `Only agents in projects owned by the selected owners (Personal or an organization) can message, read, and watch ${ORCHESTRATOR_LABEL} chats or create ${ORCHESTRATOR_LABEL} automations.`,
  disabled: `Code and cowork agents can't message, read, or watch ${ORCHESTRATOR_LABEL} chats, or create automations that prompt ${ORCHESTRATOR_LABEL}. Automations that already exist keep running.`,
};

function ownerKey(owner: AppAdvisorProjectAgentAccessOwner): string {
  return owner.kind === 'personal'
    ? 'personal'
    : `organization:${owner.organizationId}`;
}

function ownersMatch(
  left: AppAdvisorProjectAgentAccessOwner,
  right: AppAdvisorProjectAgentAccessOwner,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'personal') return true;
  return (
    right.kind === 'organization' &&
    left.organizationId === right.organizationId
  );
}

function ownerTestId(
  testIdPrefix: string,
  owner: AppAdvisorProjectAgentAccessOwner,
): string {
  return owner.kind === 'personal'
    ? `${testIdPrefix}-owner-personal`
    : `${testIdPrefix}-owner-organization-${owner.organizationId}`;
}

/** Pure shared control for the saved project-agent access preference. */
export function AppAdvisorProjectAgentAccessControl({
  value,
  ownerOptions,
  onChange,
  disabled = false,
  saving = false,
  testIdPrefix = 'app-advisor-project-agent-access',
}: AppAdvisorProjectAgentAccessControlProps): JSX.Element {
  const optionOwnerKeys = new Set(
    ownerOptions.map(({ owner }) => ownerKey(owner)),
  );
  const selectedOwnersWithoutOptions = value.selectedOwners.filter(
    (owner, index, selectedOwners) =>
      !optionOwnerKeys.has(ownerKey(owner)) &&
      selectedOwners.findIndex((candidate) => ownersMatch(candidate, owner)) ===
        index,
  );

  const ownerRows: OwnerRow[] = [
    ...ownerOptions.map(
      (option): OwnerRow => ({
        owner: option.owner,
        label: option.label,
        unavailable: option.unavailable === true,
        staleOrganizationId: null,
      }),
    ),
    ...selectedOwnersWithoutOptions.map(
      (owner): OwnerRow =>
        owner.kind === 'personal'
          ? {
              owner,
              label: 'Personal',
              unavailable: false,
              staleOrganizationId: null,
            }
          : {
              owner,
              label: 'Unavailable organization',
              unavailable: true,
              staleOrganizationId: owner.organizationId,
            },
    ),
  ];

  const handleModeChange = (
    mode: AppAdvisorProjectAgentAccessControlMode,
  ): void => {
    if (mode === value.mode) return;
    onChange({ mode, selectedOwners: [...value.selectedOwners] });
  };

  const handleOwnerToggle = (
    owner: AppAdvisorProjectAgentAccessOwner,
    unavailable: boolean,
    selected: boolean,
  ): void => {
    if (disabled || saving || (unavailable && !selected)) return;
    const selectedOwners = selected
      ? value.selectedOwners.filter(
          (selectedOwner) => !ownersMatch(selectedOwner, owner),
        )
      : [...value.selectedOwners, owner];
    onChange({ mode: 'selected-owners', selectedOwners });
  };

  return (
    <div
      className="flex flex-col gap-3"
      data-testid={testIdPrefix}
      aria-busy={saving || undefined}
    >
      <SettingsRowsRow
        label={ACCESS_LABEL}
        labelId={`${testIdPrefix}-label`}
        description={
          <>
            Controls whether code and cowork agents can use {ORCHESTRATOR_LABEL}{' '}
            tools and create automations that prompt {ORCHESTRATOR_LABEL}.
          </>
        }
        control={
          <SegmentedControl<AppAdvisorProjectAgentAccessControlMode>
            value={value.mode}
            options={[
              {
                value: 'enabled',
                label: 'Enabled',
                dataTestId: `${testIdPrefix}-mode-enabled`,
              },
              {
                value: 'selected-owners',
                label: 'Select owners',
                dataTestId: `${testIdPrefix}-mode-selected-owners`,
              },
              {
                value: 'disabled',
                label: 'Disabled',
                dataTestId: `${testIdPrefix}-mode-disabled`,
              },
            ]}
            onChange={handleModeChange}
            label={ACCESS_LABEL}
            width="control"
            disabled={disabled || saving}
            dataTestId={`${testIdPrefix}-mode`}
          />
        }
      />
      <div
        className="text-xs fg-secondary"
        aria-live="polite"
        data-testid={`${testIdPrefix}-mode-description`}
      >
        {MODE_DESCRIPTIONS[value.mode]}
      </div>
      {value.mode === 'selected-owners' ? (
        <>
          <ChoiceList
            aria-label="Owners"
            data-testid={`${testIdPrefix}-owner-list`}
          >
            {ownerRows.map((row, index) => {
              const selected = value.selectedOwners.some((owner) =>
                ownersMatch(owner, row.owner),
              );
              return (
                <ChoiceField
                  key={`${ownerKey(row.owner)}-${index}`}
                  layout="row"
                  checked={selected}
                  aria-disabled={
                    row.unavailable && !selected ? 'true' : undefined
                  }
                  data-testid={ownerTestId(testIdPrefix, row.owner)}
                  data-unavailable={row.unavailable ? 'true' : undefined}
                  disabled={disabled || saving}
                  onChange={(): void =>
                    handleOwnerToggle(row.owner, row.unavailable, selected)
                  }
                  label={
                    row.staleOrganizationId !== null ? (
                      <>
                        <span className="block truncate font-medium">
                          {row.label}
                        </span>
                        <span className="block truncate font-mono text-xs fg-secondary">
                          {row.staleOrganizationId}
                        </span>
                      </>
                    ) : (
                      <span
                        className={`block truncate font-medium ${
                          row.owner.kind === 'organization'
                            ? REPLAY_MASK_CLASS
                            : ''
                        }`}
                      >
                        {row.label}
                        {row.unavailable ? ' (unavailable)' : ''}
                      </span>
                    )
                  }
                />
              );
            })}
          </ChoiceList>
          {value.selectedOwners.length === 0 ? (
            <div
              className="text-xs fg-secondary"
              data-testid={`${testIdPrefix}-no-owners`}
            >
              No owners selected, so no project agents can use{' '}
              {ORCHESTRATOR_LABEL}.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
