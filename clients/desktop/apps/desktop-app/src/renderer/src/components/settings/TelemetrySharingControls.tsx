import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type {
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SegmentedControl,
  SettingsLockedLabel,
} from '@canopy/ui-shared/components';
import { DataSharingFeaturePills } from '@canopy/ui-shared/components/DataSharingFeaturePills';
import { Lock } from '@canopy/ui-shared/icons/AppIcons';
import {
  DATA_SHARING_PREREQUISITE_SCOPE,
  dataSharingDependencyNote,
  dataSharingOrganizationAccessNote,
} from '@canopy/ui-shared/lib/data-sharing-features';
import type { JSX } from 'react';
import { SettingsGroup, SettingsRow } from './SettingsLayout';
import {
  sharesWithOrganization,
  TELEMETRY_DATA_TYPES,
  TELEMETRY_SCOPE_DESCRIPTIONS,
  TELEMETRY_SCOPE_LABELS,
  TELEMETRY_SCOPE_ORDER,
} from './telemetry-sharing';
import {
  NO_LOCKS,
  type TelemetryLockMap,
  type TelemetryLockValue,
} from './telemetryLocks';

/**
 * Agent Ledger entries sync under the Session summaries choice (LD02), so
 * that row says so while the Ledger is available.
 */
const LEDGER_SHARING_NOTE = 'Also covers Feed entries';

interface TelemetrySharingControlsProps {
  /** Per-data-type selections used for *display* (which pill reads active). */
  value: TelemetrySharingPreferences;
  /**
   * As-persisted selections used as the base when building the next value to
   * save. Defaults to {@link value} when omitted, so editing one scope keeps
   * each sibling's stored visibility.
   */
  rawValue?: TelemetrySharingPreferences;
  /** Invoked with the next full preferences object whenever a selection changes. */
  onChange: (next: TelemetrySharingPreferences) => void;
  /**
   * Scopes the user may select. Always includes `off` / `private` ("Just me");
   * `organization` is present only when the linked account belongs to one.
   * `team` is never offered as a choice, but a value persisted earlier still
   * renders as a read-only fallback in its canonical slot.
   */
  availableScopes: readonly TelemetrySharingVisibility[];
  /** Disable all controls (e.g. while preferences are loading). */
  disabled?: boolean;
  /**
   * Per-scope org enforcement. A locked scope is pinned to its enforced value
   * (`organization` when required, `off` when prohibited), its selector is
   * disabled, and a tooltip explains the lock. The All activity control
   * never overrides a locked scope.
   */
  locked?: TelemetryLockMap;
  /** Tooltip shown on a REQUIRED scope, e.g. "Managed by Acme. Contact an admin to change." */
  lockTooltip?: string;
  /** Tooltip shown on a PROHIBITED scope, explaining that the block applies everywhere. */
  blockedTooltip?: string;
  /**
   * The selected org that holds the locks, named in each locked row's inline
   * badge ("Required by Acme" / "Turned off by Acme").
   */
  lockOrganizationName?: string;
  /**
   * Per-visibility tooltip copy. Defaults to the context-free descriptions;
   * surfaces pass {@link resolveTelemetryScopeDescriptions} so `Organization`
   * names the selected org, or explains that Personal work stays private.
   */
  scopeDescriptions?: Record<TelemetrySharingVisibility, string>;
}

interface ScopeSelectorProps {
  /** The data type the row sets, naming the picker for assistive tech. */
  label: string;
  /** `null` when no single scope applies, such as the All activity row over mixed choices. */
  selected: TelemetrySharingVisibility | null;
  scopes: readonly TelemetrySharingVisibility[];
  disabled: boolean;
  /** Org-enforced value: pin to it, show a lock icon on it, fold the lock note into each button's tooltip. */
  locked: TelemetryLockValue | null;
  /** Sentence appended to the per-scope tooltip when locked, e.g. "Managed by Acme. Contact an admin to change." */
  lockNote?: string;
  descriptions: Record<TelemetrySharingVisibility, string>;
  testIdPrefix: string;
  onSelect: (scope: TelemetrySharingVisibility) => void;
}

function ScopeSelector({
  label,
  selected,
  scopes,
  disabled,
  locked,
  lockNote,
  descriptions,
  testIdPrefix,
  onSelect,
}: ScopeSelectorProps): JSX.Element {
  // Always render the currently-selected scope even when it is not in the
  // available set (e.g. a persisted `team`/`organization` value while the
  // account is still resolving, or after membership was lost). Without this the
  // active button would be filtered out and the row would look unselected while
  // the stored value is still in effect. Canonical order is preserved.
  const renderedScopes = TELEMETRY_SCOPE_ORDER.filter(
    (scope) => scopes.includes(scope) || scope === selected,
  );
  return (
    // The shared picker's track does not shrink, which is load-bearing here:
    // the row is a flex container and this selector sits opposite a long
    // description. Squeezed below its content width, the labels would spill
    // past the rounded track and each row would land on a different width
    // instead of sitting flush right. Content width rather than the control
    // column: every segment sits under a tooltip and sizes to its label, so
    // the column's minimum left an empty run of track after the last one.
    <SegmentedControl
      value={selected}
      options={renderedScopes.map((scope) => {
        // Fold the lock note into the existing scope-description tooltip so a
        // locked segment shows one combined tooltip, not two stacked ones.
        const description = descriptions[scope];
        // A prohibition pins the row to `off`, so its note replaces the scope
        // description rather than extending it: the description explains a
        // value the member cannot select, which reads as a contradiction.
        const lockedLabel =
          locked === 'off' ? lockNote : `${description} ${lockNote}`;
        const tooltip = locked !== null && lockNote ? lockedLabel : description;
        // Show the lock inside the enforced segment so it reads as "this
        // value is pinned", rather than floating beside the whole control.
        // Anchored to the enforced value rather than to whichever segment
        // reads active, so a prohibited scope pinned to `off` shows the lock
        // too — and so does a row whose displayed value is momentarily stale.
        return {
          value: scope,
          label: TELEMETRY_SCOPE_LABELS[scope],
          dataTestId: `${testIdPrefix}-${scope}`,
          tooltip,
          leading:
            locked === scope ? (
              <Lock
                size="sm"
                className="shrink-0"
                aria-hidden="true"
                data-testid={`${testIdPrefix}-lock`}
              />
            ) : undefined,
        };
      })}
      onChange={onSelect}
      label={label}
      width="content"
      disabled={disabled}
      dataTestId={`${testIdPrefix}-selector`}
    />
  );
}

/**
 * The visibility every data type shares, or `null` when they differ, so the
 * All activity row shows no segment selected over mixed choices.
 */
function commonScope(
  value: TelemetrySharingPreferences,
): TelemetrySharingVisibility | null {
  const [first, ...rest] = TELEMETRY_DATA_TYPES.map(
    (dataType) => value[dataType.key],
  );
  if (first === undefined) {
    return null;
  }
  return rest.every((scope) => scope === first) ? first : null;
}

/**
 * A data type row's description: what it is, the Ledger note for session
 * summaries, and what Organization lets the organization's owners do.
 */
function TelemetryScopeDescription({
  description,
  ledgerNote,
  accessNote,
  scope,
}: {
  readonly description: string;
  readonly ledgerNote: string | null;
  readonly accessNote: string | null;
  readonly scope: string;
}): JSX.Element | string {
  if (ledgerNote === null && accessNote === null) return description;
  return (
    <>
      <p>{description}</p>
      {ledgerNote === null ? null : (
        <p data-testid="telemetry-sharing-ledger-note">{ledgerNote}</p>
      )}
      {accessNote === null ? null : (
        <p data-testid={`telemetry-sharing-owner-access-note-${scope}`}>
          {accessNote}
        </p>
      )}
    </>
  );
}

/**
 * Presentational telemetry sharing controls: one settings group holding an
 * "All activity" row plus a per-data-type visibility selector, one row
 * per data-sharing scope, each disclosing the product features that row
 * powers (or would enable). Pure — it takes `value` + `onChange` and never
 * touches `window.api`.
 *
 * A member changing their own sharing affects only themselves, so there is no
 * confirmation step here; the org-side card confirms because an admin's change
 * reaches every member.
 */
export function TelemetrySharingControls({
  value,
  rawValue,
  onChange,
  availableScopes,
  disabled = false,
  locked = NO_LOCKS,
  lockTooltip,
  blockedTooltip,
  lockOrganizationName,
  scopeDescriptions = TELEMETRY_SCOPE_DESCRIPTIONS,
}: TelemetrySharingControlsProps): JSX.Element {
  const ledgerEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key),
  );
  // Persist edits from the stored preference so display-only org locks are
  // never baked into storage; fall back to `value` when no raw value is supplied.
  const persistBase = rawValue ?? value;
  const orderedScopes = TELEMETRY_SCOPE_ORDER.filter((scope) =>
    availableScopes.includes(scope),
  );

  /**
   * Show every locked scope at its enforced value, leaving user-controlled
   * scopes untouched. Pinning to the lock's own value (rather than assuming
   * `organization`) is what shows a prohibited scope at `off`.
   *
   * Display only (CAN-3459): locks describe the selected org's policy, which
   * main applies per item to that org's work. They are never written into the
   * saved preference, which always holds the member's own choice.
   */
  function applyLocks(
    next: TelemetrySharingPreferences,
  ): TelemetrySharingPreferences {
    const result = { ...next };
    for (const dataType of TELEMETRY_DATA_TYPES) {
      const lockValue = locked[dataType.key];
      if (lockValue !== null) {
        result[dataType.key] = lockValue;
      }
    }
    return result;
  }

  const displayValue = applyLocks(value);

  // The All activity control can't honor a mixed locked/unlocked state —
  // every locked scope stays pinned to its enforced value regardless. Hide it
  // once any scope is org-enforced so the only controls shown are the ones that
  // actually apply; members adjust the remaining unlocked scopes individually.
  const anyLocked = TELEMETRY_DATA_TYPES.some(
    (dataType) => locked[dataType.key] !== null,
  );

  // Every dependent scope silently uploads nothing while Usage metadata is not
  // reaching the organization, so each sharing row below flags that dependency
  // inline rather than leaving the member to discover the dead end later.
  const prerequisiteShared = sharesWithOrganization(
    displayValue[DATA_SHARING_PREREQUISITE_SCOPE],
  );

  function handleBulk(scope: TelemetrySharingVisibility): void {
    onChange({
      transcripts: scope,
      plans: scope,
      metadata: scope,
      summaries: scope,
    });
  }

  function handleType(
    key: keyof TelemetrySharingPreferences,
    scope: TelemetrySharingVisibility,
  ): void {
    if (locked[key] !== null) {
      return;
    }
    // Build from `persistBase` (not the display `value`) so changing one
    // scope preserves each sibling's genuine stored visibility. Locks are
    // deliberately NOT applied here: they are display only, and the
    // saved preference keeps the member's own choice for every scope. Main
    // enforces each org's policy per item against the org that owns the work,
    // so pinning the selected org's values would leak them into Personal and
    // other orgs' work (CAN-3459).
    onChange({ ...persistBase, [key]: scope });
  }

  return (
    // One group: the All activity row, then one row per data type. The All
    // activity row is the same picker as the rows under it, with no segment
    // selected while their choices differ. Its segments keep the bulk test
    // ids (`telemetry-sharing-bulk-<scope>`).
    <SettingsGroup dataTestId="telemetry-sharing-controls">
      {anyLocked ? null : (
        <SettingsRow
          label="All activity"
          description="Set every type below at once"
          control={
            <ScopeSelector
              label="All activity"
              selected={commonScope(displayValue)}
              scopes={orderedScopes}
              disabled={disabled}
              locked={null}
              descriptions={scopeDescriptions}
              testIdPrefix="telemetry-sharing-bulk"
              onSelect={handleBulk}
            />
          }
        />
      )}

      {TELEMETRY_DATA_TYPES.map((dataType) => {
        const lockValue = locked[dataType.key];
        const isLocked = lockValue !== null;
        const shared = sharesWithOrganization(displayValue[dataType.key]);
        const showDependencyNote =
          shared &&
          !prerequisiteShared &&
          dataType.key !== DATA_SHARING_PREREQUISITE_SCOPE;
        return (
          // The wrapper is the group's row: it carries the lock state the
          // row itself has no attribute for.
          <div
            key={dataType.key}
            data-testid={`telemetry-sharing-row-${dataType.key}`}
            data-locked={isLocked ? 'true' : undefined}
          >
            <SettingsRow
              label={
                <SettingsLockedLabel
                  label={dataType.label}
                  reason={
                    isLocked && lockOrganizationName
                      ? `${lockValue === 'off' ? 'Turned off by' : 'Required by'} ${lockOrganizationName}`
                      : null
                  }
                  dataTestId={`telemetry-sharing-lock-badge-${dataType.key}`}
                />
              }
              description={
                <TelemetryScopeDescription
                  description={dataType.description}
                  ledgerNote={
                    ledgerEnabled && dataType.key === 'summaries'
                      ? LEDGER_SHARING_NOTE
                      : null
                  }
                  accessNote={dataSharingOrganizationAccessNote(dataType.key)}
                  scope={dataType.key}
                />
              }
              control={
                <ScopeSelector
                  label={dataType.label}
                  selected={displayValue[dataType.key]}
                  scopes={orderedScopes}
                  disabled={disabled || isLocked}
                  locked={lockValue}
                  lockNote={lockValue === 'off' ? blockedTooltip : lockTooltip}
                  descriptions={scopeDescriptions}
                  testIdPrefix={`telemetry-sharing-${dataType.key}`}
                  onSelect={(scope): void => handleType(dataType.key, scope)}
                />
              }
            >
              {/*
                Unlike the org admin card, a member's setting always has a
                consequence, so the pills render on every row rather than only
                on the rows an org has an opinion about. `includeEnforcementOnly`
                is false because run sharing bypasses the ambient gate: claiming
                the member's own Transcripts-off turns off Shared runs would be
                a lie.
              */}
              <DataSharingFeaturePills
                scope={dataType.key}
                sharing={shared}
                includeEnforcementOnly={false}
                tone="quiet"
                dataTestId={`telemetry-sharing-features-${dataType.key}`}
              />
              {showDependencyNote ? (
                <p
                  className="text-xs fg-warning"
                  data-testid={`telemetry-sharing-dependency-note-${dataType.key}`}
                >
                  {dataSharingDependencyNote(dataType.key)}
                </p>
              ) : null}
            </SettingsRow>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
