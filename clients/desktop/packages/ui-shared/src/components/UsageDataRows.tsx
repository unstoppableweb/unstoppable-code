import type { JSX } from 'react';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { SettingsRowsRow, SettingsRowsSubRow } from './settings/SettingsRows';
import { SettingsLockedLabel } from './SettingsLockedLabel';

/**
 * One switchable flow. A row's `children` are sub-rows that only matter while
 * it is on (Session recordings under Usage analytics): they render dimmed and
 * disabled while the parent is off or locked, and keep their stored value.
 */
export interface UsageDataRow<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly description: string;
  readonly children?: readonly UsageDataRow<K>[];
}

/**
 * Each row's lock reason, such as "Turned off by Acme". A locked row renders
 * off with the reason beside its label and never calls `onToggle`.
 */
export type UsageDataRowLocks<K extends string> = Partial<
  Readonly<Record<K, string | null>>
>;

export interface UsageDataRowsProps<K extends string> {
  readonly rows: readonly UsageDataRow<K>[];
  /** The member's stored choices; `null` while loading (rows show on). */
  readonly value: Readonly<Record<K, boolean>> | null;
  readonly locks?: UsageDataRowLocks<K>;
  /** False disables every row, for example while the values load. */
  readonly ready?: boolean;
  readonly onToggle: (key: K, checked: boolean) => void;
  /** DOM id prefix: each switch is `${idPrefix}-${key}`. */
  readonly idPrefix: string;
  /**
   * Test id prefix: `${testIdPrefix}-row-${key}`, `-toggle-${key}` and
   * `-lock-badge-${key}`.
   */
  readonly testIdPrefix: string;
}

/**
 * The Usage data switches, one per outbound flow the product works without.
 * Pure display shared by Settings → Privacy and the first-run "What you
 * share" card, so both read and behave the same. The host loads, saves and
 * resolves locks; this only renders the rows inside the host's group.
 */
export function UsageDataRows<K extends string>({
  rows,
  value,
  locks,
  ready = true,
  onToggle,
  idPrefix,
  testIdPrefix,
}: UsageDataRowsProps<K>): JSX.Element {
  const lockFor = (key: K): string | null => locks?.[key] ?? null;

  function renderToggle(
    row: UsageDataRow<K>,
    dependsOnOff: boolean,
  ): JSX.Element {
    const lock = lockFor(row.key);
    return (
      <ToggleSwitch
        id={`${idPrefix}-${row.key}`}
        // A locked row shows the flow as off; a row under a parent that is
        // off keeps its stored value, dimmed, so turning the parent back on
        // restores it.
        checked={lock ? false : (value?.[row.key] ?? true)}
        label={row.label}
        disabled={!ready || lock !== null || dependsOnOff}
        dataTestId={`${testIdPrefix}-toggle-${row.key}`}
        onChange={(checked): void => onToggle(row.key, checked)}
      />
    );
  }

  function renderLabel(row: UsageDataRow<K>): JSX.Element {
    return (
      <SettingsLockedLabel
        label={row.label}
        reason={lockFor(row.key)}
        dataTestId={`${testIdPrefix}-lock-badge-${row.key}`}
      />
    );
  }

  return (
    <>
      {rows.map((row) => {
        const lock = lockFor(row.key);
        const parentOff = lock !== null || value?.[row.key] === false;
        return (
          // The wrapper is the group's row: it carries the lock state the
          // row itself has no attribute for.
          <div
            key={row.key}
            data-testid={`${testIdPrefix}-row-${row.key}`}
            data-locked={lock ? 'true' : undefined}
          >
            <SettingsRowsRow
              label={renderLabel(row)}
              description={row.description}
              htmlFor={`${idPrefix}-${row.key}`}
              control={renderToggle(row, false)}
            >
              {row.children?.map((child) => (
                <div
                  key={child.key}
                  data-testid={`${testIdPrefix}-row-${child.key}`}
                  data-locked={lockFor(child.key) ? 'true' : undefined}
                >
                  <SettingsRowsSubRow
                    label={renderLabel(child)}
                    description={child.description}
                    htmlFor={`${idPrefix}-${child.key}`}
                    control={renderToggle(child, parentOff)}
                  />
                </div>
              ))}
            </SettingsRowsRow>
          </div>
        );
      })}
    </>
  );
}

/** The desktop Usage data flows, in Settings order. */
export type UsageDataRowKey =
  | 'productAnalytics'
  | 'sessionReplay'
  | 'errorReports'
  | 'activeUseSignal'
  | 'featureFlagIdentity'
  | 'skillSafetyCheck';

// Row hints are fragments without a closing period, like the Activity
// sharing rows below them in Settings.
const PRODUCT_ANALYTICS_ROW = {
  key: 'productAnalytics',
  label: 'Usage analytics',
  description: 'Which features you use and how the app performs',
  children: [
    {
      key: 'sessionReplay',
      label: 'Session recordings',
      description:
        'Replays of how you move through the app, with your content hidden',
    },
  ],
} as const satisfies UsageDataRow<UsageDataRowKey>;

const ERROR_REPORTS_ROW = {
  key: 'errorReports',
  label: 'Error reports',
  description: 'Details of crashes and errors so they can be fixed',
} as const satisfies UsageDataRow<UsageDataRowKey>;

const ACTIVE_USE_SIGNAL_ROW = {
  key: 'activeUseSignal',
  label: 'Active use count',
  description: 'A count of the messages you send, never their content',
} as const satisfies UsageDataRow<UsageDataRowKey>;

const FEATURE_FLAG_IDENTITY_ROW = {
  key: 'featureFlagIdentity',
  label: 'Personalized feature rollouts',
  description:
    'Use your account to decide which new features you get. When off, only your app version and organizations are used',
} as const satisfies UsageDataRow<UsageDataRowKey>;

/**
 * Skill safety check is protective rather than analytics: the first-run card
 * shows it only under Customize, outside the "Help improve the app" group.
 */
export const SKILL_SAFETY_CHECK_ROW = {
  key: 'skillSafetyCheck',
  label: 'Skill safety check',
  description:
    'Look up installed skills with a safety service to show their risk',
} as const satisfies UsageDataRow<UsageDataRowKey>;

/** The rows covered by the first-run "Help improve the app" group. */
export const USAGE_DATA_GROUP_ROWS: readonly UsageDataRow<UsageDataRowKey>[] = [
  PRODUCT_ANALYTICS_ROW,
  ERROR_REPORTS_ROW,
  ACTIVE_USE_SIGNAL_ROW,
  FEATURE_FLAG_IDENTITY_ROW,
];

/** Every desktop Usage data row, in Settings → Privacy order. */
export const USAGE_DATA_ROWS: readonly UsageDataRow<UsageDataRowKey>[] = [
  ...USAGE_DATA_GROUP_ROWS,
  SKILL_SAFETY_CHECK_ROW,
];
