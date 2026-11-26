import { useId, type JSX, type ReactNode } from 'react';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Heading } from '../primitives/Heading';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import {
  DATA_SHARING_PREREQUISITE_SCOPE,
  DATA_SHARING_SCOPE_LABELS,
  DATA_SHARING_SCOPE_ORDER,
  ONBOARDING_SYNC_FEATURE_IDS,
  dataSharingDependencyNote,
  dataSharingFeatureLabel,
  dataSharingScopeRowHint,
  type DataSharingScopeKey,
} from '../lib/data-sharing-features';
import { SettingsRowsGroup, SettingsRowsRow } from './settings/SettingsRows';
import {
  UsageDataRows,
  type UsageDataRow,
  type UsageDataRowLocks,
} from './UsageDataRows';

/** Where a group switch stands over the rows it covers. */
export type DataChoicesGroupState = 'on' | 'off' | 'mixed';

export interface DataChoicesGroupStatus {
  readonly state: DataChoicesGroupState;
  /** Every row in the group is locked: the switch renders off and inert. */
  readonly disabled: boolean;
}

interface GroupEntry<K extends string> {
  readonly key: K;
  readonly parent: K | null;
}

function groupEntries<K extends string>(
  rows: readonly UsageDataRow<K>[],
  locks: UsageDataRowLocks<K> | undefined,
): GroupEntry<K>[] {
  const locked = (key: K): boolean => (locks?.[key] ?? null) !== null;
  const entries: GroupEntry<K>[] = [];
  for (const row of rows) {
    if (locked(row.key)) {
      // A locked parent's children are dimmed too, so neither counts or is
      // ever written by the group switch.
      continue;
    }
    entries.push({ key: row.key, parent: null });
    for (const child of row.children ?? []) {
      if (!locked(child.key)) {
        entries.push({ key: child.key, parent: row.key });
      }
    }
  }
  return entries;
}

/**
 * The group switch's state: on when every unlocked row is on, off when every
 * one is off, otherwise mixed ("Some on"). A child row counts as off while
 * its parent is off, so a dimmed child never makes the group mixed. Locked
 * rows are ignored; with every row locked the switch is off and disabled.
 */
export function resolveDataChoicesGroupStatus<K extends string>(
  rows: readonly UsageDataRow<K>[],
  value: Readonly<Record<K, boolean>>,
  locks?: UsageDataRowLocks<K>,
): DataChoicesGroupStatus {
  const entries = groupEntries(rows, locks);
  if (entries.length === 0) {
    return { state: 'off', disabled: true };
  }
  const onCount = entries.filter(
    (entry) =>
      value[entry.key] && (entry.parent === null || value[entry.parent]),
  ).length;
  const state: DataChoicesGroupState =
    onCount === entries.length ? 'on' : onCount === 0 ? 'off' : 'mixed';
  return { state, disabled: false };
}

/**
 * A click on the group switch: from off every unlocked row turns on; from on
 * or mixed every unlocked row turns off. Locked rows keep their value.
 */
export function toggleDataChoicesGroup<K extends string>(
  rows: readonly UsageDataRow<K>[],
  value: Readonly<Record<K, boolean>>,
  locks?: UsageDataRowLocks<K>,
): Readonly<Record<K, boolean>> {
  const status = resolveDataChoicesGroupStatus(rows, value, locks);
  if (status.disabled) {
    return value;
  }
  const nextOn = status.state === 'off';
  const next: Record<K, boolean> = { ...value };
  for (const entry of groupEntries(rows, locks)) {
    next[entry.key] = nextOn;
  }
  return next;
}

const SOME_ON_LABEL = 'Some on';

function GroupSwitch({
  id,
  label,
  status,
  onToggle,
  dataTestId,
}: {
  readonly id: string;
  readonly label: string;
  readonly status: DataChoicesGroupStatus;
  readonly onToggle: () => void;
  readonly dataTestId: string;
}): JSX.Element {
  const mixedId = `${id}-mixed`;
  const mixed = status.state === 'mixed';
  return (
    <>
      {mixed ? (
        <span
          id={mixedId}
          className="text-xs fg-secondary"
          data-testid={`${dataTestId}-mixed`}
        >
          {SOME_ON_LABEL}
        </span>
      ) : null}
      <ToggleSwitch
        id={id}
        checked={status.state !== 'off'}
        label={label}
        describedBy={mixed ? mixedId : undefined}
        disabled={status.disabled}
        dataTestId={dataTestId}
        onChange={onToggle}
      />
    </>
  );
}

/** The activity sharing choice: one on/off per data-sharing type. */
export type DataChoicesActivityValue = Readonly<
  Record<DataSharingScopeKey, boolean>
>;

const ACTIVITY_ROWS: readonly UsageDataRow<DataSharingScopeKey>[] =
  DATA_SHARING_SCOPE_ORDER.map((scope) => ({
    key: scope,
    label: DATA_SHARING_SCOPE_LABELS[scope],
    description: dataSharingScopeRowHint(scope),
  }));

export interface DataChoicesCardProps<K extends string> {
  /** The rows the "Help improve the app" group switch covers. */
  readonly rows: readonly UsageDataRow<K>[];
  /** The usage group's explanation under "Help improve the app". */
  readonly usageDescription: string;
  /**
   * Rows shown only under Customize, after the group's rows, that the group
   * switch never sets (desktop Skill safety check, web Marketing tracking).
   */
  readonly extraRows?: readonly UsageDataRow<K>[];
  readonly value: Readonly<Record<K, boolean>>;
  readonly locks?: UsageDataRowLocks<K>;
  readonly onChange: (next: Readonly<Record<K, boolean>>) => void;
  /** The activity sync choice; the web omits it. */
  readonly activity?: {
    readonly value: DataChoicesActivityValue;
    readonly onChange: (next: DataChoicesActivityValue) => void;
  };
  readonly expanded: boolean;
  readonly onExpandedChange: (next: boolean) => void;
  readonly footnote?: ReactNode;
  /** Disables every switch, for example while the choices save. */
  readonly disabled?: boolean;
  /**
   * Prefix for DOM ids and test ids: `${idPrefix}-data-choices`,
   * `-customize`, `-group-usage`, `-group-activity`, the usage rows under
   * `${idPrefix}-usage-data` and the activity rows under
   * `${idPrefix}-activity`.
   */
  readonly idPrefix: string;
}

/**
 * "What you share": the first-run data choices on the desktop Welcome gate
 * and the web's signed-in sheet. Collapsed, it shows one switch per group;
 * Customize opens the same per-flow rows as Settings in place. Pure display:
 * the host seeds the values, resolves locks and saves.
 */
export function DataChoicesCard<K extends string>({
  rows,
  usageDescription,
  extraRows,
  value,
  locks,
  onChange,
  activity,
  expanded,
  onExpandedChange,
  footnote,
  disabled = false,
  idPrefix,
}: DataChoicesCardProps<K>): JSX.Element {
  const headingId = useId();
  const bodyId = useId();
  const usageStatus = resolveDataChoicesGroupStatus(rows, value, locks);
  const activityStatus = activity
    ? resolveDataChoicesGroupStatus(ACTIVITY_ROWS, activity.value)
    : null;
  const rowsPrefix = `${idPrefix}-usage-data`;

  const usageGroupRow = (
    <SettingsRowsRow
      dataTestId={`${idPrefix}-group-usage`}
      label="Help improve the app"
      description={usageDescription}
      htmlFor={`${idPrefix}-group-usage-switch`}
      control={
        <GroupSwitch
          id={`${idPrefix}-group-usage-switch`}
          label="Help improve the app"
          status={usageStatus}
          dataTestId={`${idPrefix}-group-usage-toggle`}
          onToggle={(): void =>
            onChange(toggleDataChoicesGroup(rows, value, locks))
          }
        />
      }
    />
  );

  const activityGroupRow =
    activity && activityStatus ? (
      <SettingsRowsRow
        dataTestId={`${idPrefix}-group-activity`}
        label="Sync activity to your account"
        description={
          expanded
            ? 'Secrets are scrubbed and transcripts are encrypted.'
            : 'Turn this on to use the features below.'
        }
        htmlFor={`${idPrefix}-group-activity-switch`}
        control={
          <GroupSwitch
            id={`${idPrefix}-group-activity-switch`}
            label="Sync activity to your account"
            status={activityStatus}
            dataTestId={`${idPrefix}-group-activity-toggle`}
            onToggle={(): void =>
              activity.onChange(
                toggleDataChoicesGroup(ACTIVITY_ROWS, activity.value),
              )
            }
          />
        }
      >
        {expanded ? null : (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid={`${idPrefix}-activity-features`}
          >
            {ONBOARDING_SYNC_FEATURE_IDS.map((id) => (
              <Badge key={id} muted={activityStatus.state === 'off'}>
                {dataSharingFeatureLabel(id)}
              </Badge>
            ))}
          </div>
        )}
      </SettingsRowsRow>
    ) : null;

  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-testid={`${idPrefix}-data-choices`}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="flex items-center justify-between gap-3">
        <Heading level={2} variant="section" id={headingId}>
          What you share
        </Heading>
        <Button
          aria-expanded={expanded}
          aria-controls={bodyId}
          data-testid={`${idPrefix}-customize`}
          onClick={(): void => onExpandedChange(!expanded)}
          variant="link"
          data-settings-control="link"
        >
          {expanded ? 'Done' : 'Customize'}
        </Button>
      </div>
      <div
        id={bodyId}
        className="flex flex-col gap-2"
        inert={disabled}
        aria-disabled={disabled || undefined}
      >
        {/* Collapsed, both group switches share one card; Customize splits
            them into a card per group, each with its per-flow rows. */}
        {expanded ? (
          <>
            <SettingsRowsGroup ariaLabel="Help improve the app">
              {usageGroupRow}
              <UsageDataRows
                rows={extraRows ? [...rows, ...extraRows] : rows}
                value={value}
                locks={locks}
                ready={!disabled}
                idPrefix={rowsPrefix}
                testIdPrefix={rowsPrefix}
                onToggle={(key, checked): void =>
                  onChange({ ...value, [key]: checked })
                }
              />
            </SettingsRowsGroup>
            {activity && activityGroupRow ? (
              <SettingsRowsGroup ariaLabel="Sync activity to your account">
                {activityGroupRow}
                {DATA_SHARING_SCOPE_ORDER.map((scope) => {
                  const switchId = `${idPrefix}-activity-${scope}`;
                  const needsPrerequisite =
                    scope !== DATA_SHARING_PREREQUISITE_SCOPE &&
                    activity.value[scope] &&
                    !activity.value[DATA_SHARING_PREREQUISITE_SCOPE];
                  return (
                    <div
                      key={scope}
                      data-testid={`${idPrefix}-activity-row-${scope}`}
                    >
                      <SettingsRowsRow
                        label={DATA_SHARING_SCOPE_LABELS[scope]}
                        description={dataSharingScopeRowHint(scope)}
                        htmlFor={switchId}
                        control={
                          <ToggleSwitch
                            id={switchId}
                            checked={activity.value[scope]}
                            label={DATA_SHARING_SCOPE_LABELS[scope]}
                            disabled={disabled}
                            dataTestId={`${idPrefix}-activity-toggle-${scope}`}
                            onChange={(checked): void =>
                              activity.onChange({
                                ...activity.value,
                                [scope]: checked,
                              })
                            }
                          />
                        }
                      >
                        {needsPrerequisite ? (
                          <div
                            className="text-xs text-pretty fg-secondary"
                            data-testid={`${idPrefix}-activity-note-${scope}`}
                          >
                            {dataSharingDependencyNote(scope)}
                          </div>
                        ) : null}
                      </SettingsRowsRow>
                    </div>
                  );
                })}
              </SettingsRowsGroup>
            ) : null}
          </>
        ) : (
          <SettingsRowsGroup>
            {usageGroupRow}
            {activityGroupRow}
          </SettingsRowsGroup>
        )}
      </div>
      {footnote ? (
        <div className="text-xs text-pretty fg-secondary">{footnote}</div>
      ) : null}
    </section>
  );
}
