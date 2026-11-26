import { ControlButton } from '../primitives/Button';
import { Stack, type SpaceRole } from '../primitives/Stack';
import {
  Children,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ShareAudience } from '@canopy/protocol/sharing';
import { Lock } from '../icons/AppIcons';
import {
  type SelectableShareAudience,
  shareAudienceLabel,
} from '../lib/share-audience-label';
import { CenteredLoadingSpinner } from '../primitives/CenteredLoadingSpinner';
import { ChoiceMark } from '../primitives/Choice';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { DisplayAvatar } from '../primitives/DisplayAvatar';
import { Fieldset } from '../primitives/Fieldset';
import { OverlayScrollArea } from '../primitives/OverlayScrollArea';
import { SearchEmptyState, SearchField } from '../primitives/SearchField';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '../primitives/SegmentedControl';
import { ErrorBanner } from '../primitives/StatusBlocks';
import type { TooltipLink } from '../primitives/Tooltip';

export {
  type SelectableShareAudience,
  shareAudienceLabel,
} from '../lib/share-audience-label';

/**
 * The one set of scope and target controls every share surface renders —
 * desktop Agents, Automations, Pipelines, Plans, Collections, Runs, Skills,
 * the invite modal's organization choice, and the web portal share dialogs:
 *
 * - `ShareScopeSelector`: the generic scope radio group.
 * - `ShareAudienceSelector`: the Team/Organization/Public selector,
 *   parameterized by the audiences a resource offers.
 * - `OrgTeamPicker`: the searchable team or organization list, with round
 *   initials avatars and a radio selection mark.
 * - `SharedTargetPicker`: the generic list `OrgTeamPicker` specializes, for
 *   targets that are not a team or organization (e.g. invitable members).
 *
 * Search/load behavior (debounce, stale-response guard, errors) lives beside
 * the host adapters in `@canopy/ui-app/sharing` (`useShareTargetSearch`), so
 * this file stays display-only.
 */

/**
 * A team or organization a resource can be shared with, normalized so every
 * share surface renders the same row. Hosts adapt their protocol summaries
 * with `toShareTarget` from `@canopy/ui-app/sharing`.
 */
export interface ShareTarget {
  readonly id: string;
  readonly name: string;
  /** Owning organization id, for a team. */
  readonly organizationId?: string;
  /** Rendered under the name — the owning organization, for a team. */
  readonly secondaryLabel?: string;
}

/** Tooltip content for an option the account can't use yet. */
export interface ShareScopeUnavailableReason {
  readonly label: string;
  /**
   * A next step, e.g. creating a team, offered under the reason. An in-app
   * step also runs when the option itself is activated.
   */
  readonly action?: TooltipLink;
  /** Test id for the reason sentence. */
  readonly testId?: string;
}

export interface ShareScopeSelectorOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Disables just this option, e.g. a scope the account cannot use yet. */
  readonly disabled?: boolean;
  /** Id of the sentence that explains this option. */
  readonly describedBy?: string;
  /**
   * Why a disabled option can't be picked yet, shown in its tooltip. The
   * option then stays focusable so the reason is reachable by keyboard.
   */
  readonly unavailable?: ShareScopeUnavailableReason;
  /** The option is fixed: a lock icon leads its label. */
  readonly locked?: boolean;
}

export interface ShareScopeSelectorProps<T extends string> {
  /** Visible legend and the radio group's accessible name. */
  legend: string;
  /** The selected option, or `null` when nothing is selected yet. */
  value: T | null;
  onChange: (next: T) => void;
  options: readonly ShareScopeSelectorOption<T>[];
  /** Disables every option, e.g. while a share is in flight. */
  disabled?: boolean;
  /**
   * Test id for the fieldset; each option gets `${dataTestId}-${value}`.
   */
  dataTestId?: string;
  /** Helper and upgrade copy rendered under the options. */
  children?: ReactNode;
  /** Own the options-to-content gaps when child content has no outer margins. */
  contentGap?: SpaceRole;
}

/**
 * An option the account can't use yet stays focusable with its reason in a
 * tooltip. That tooltip is portaled outside a dialog's focus trap and has no
 * hover on touch, so pressing the option runs its in-app next step. A fixed
 * option (an existing share's audience) leads its label with a lock.
 */
function segmentForShareScope<T extends string>(
  {
    value,
    label,
    disabled,
    describedBy,
    unavailable,
    locked,
  }: ShareScopeSelectorOption<T>,
  groupDisabled: boolean,
  dataTestId: string | undefined,
): SegmentedControlOption<T> {
  const optionTestId =
    dataTestId === undefined ? undefined : `${dataTestId}-${value}`;
  const explained = disabled === true && !groupDisabled;
  const action = explained ? unavailable?.action : undefined;
  return {
    value,
    label,
    describedBy,
    dataTestId: optionTestId,
    ...(locked === true
      ? {
          leading: (
            <Lock
              aria-hidden
              className="size-3 shrink-0"
              data-testid={
                optionTestId === undefined ? undefined : `${optionTestId}-lock`
              }
            />
          ),
        }
      : {}),
    ...(explained && unavailable !== undefined
      ? {
          unavailable: true,
          tooltip: (
            <span data-testid={unavailable.testId}>{unavailable.label}</span>
          ),
          tooltipLink: action,
          onUnavailablePress:
            action !== undefined && 'onClick' in action
              ? action.onClick
              : undefined,
        }
      : { disabled }),
  };
}

/**
 * The share scope radio group: a legend over a `SegmentedControl`, with
 * helper copy underneath.
 */
export function ShareScopeSelector<T extends string>({
  legend,
  value,
  onChange,
  options,
  disabled = false,
  dataTestId,
  children,
  contentGap,
}: ShareScopeSelectorProps<T>): JSX.Element {
  const optionsRow = (
    <SegmentedControl<T>
      label={legend}
      semantics="radio"
      width="content"
      touchTarget
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={options.map((option) =>
        segmentForShareScope(option, disabled, dataTestId),
      )}
    />
  );
  return (
    // `role="none"`: the segmented control is the named radiogroup, so the
    // fieldset's own group would announce the same name twice.
    <Fieldset
      role="none"
      gap="control"
      data-testid={dataTestId}
      legend={<span className="text-s font-medium fg-primary">{legend}</span>}
    >
      <div className="text-s">
        {contentGap === undefined ? (
          <>
            {optionsRow}
            {children}
          </>
        ) : (
          <Stack gap={contentGap}>
            <div>{optionsRow}</div>
            {Children.map(children, (child) => (
              <div className="empty:hidden">{child}</div>
            ))}
          </Stack>
        )}
      </div>
    </Fieldset>
  );
}

/** Fixed display order; `offered` only filters it. */
const SHARE_AUDIENCE_ORDER: readonly SelectableShareAudience[] = [
  'team',
  'organization',
  'public',
];

export interface ShareAudienceSelectorProps {
  /** Audiences this resource offers. Order is fixed; this only filters. */
  offered: readonly ShareAudience[];
  /**
   * Which offered audiences the account can use right now. An unavailable
   * audience renders disabled, never hidden (`docs/ux-writing.md`). Omitted
   * audiences are available.
   */
  availability: Partial<Record<ShareAudience, boolean>>;
  /** The selected audience, or `null` when the author has not picked one. */
  value: ShareAudience | null;
  onChange: (next: ShareAudience) => void;
  legend: string;
  labelForAudience?: (audience: SelectableShareAudience) => string;
  /** Helper sentence under the selector for the selected audience. */
  descriptions?: Partial<Record<ShareAudience, string>>;
  /** Shown under the selector when an offered audience needs an upgrade. */
  upgradeHint?: string;
  /** Extra hint content under the selector, e.g. an organization setup CTA. */
  hint?: ReactNode;
  /** Share the parent-owned gap with margin-free custom hint content. */
  contentGap?: SpaceRole;
  disabled?: boolean;
  /** Fieldset test id; options get `${dataTestId}-${audience}`. */
  dataTestId?: string;
  /**
   * Keep the selector, with its disabled options and hints, even when only
   * one audience is usable, for a disabled audience whose reason must stay
   * visible. Off by default, which hides a choice that isn't one.
   */
  keepDisabledVisible?: boolean;
  /** Id of the sentence that explains an option, keyed by audience. */
  optionDescribedBy?: Partial<Record<ShareAudience, string>>;
  /**
   * Why an unavailable audience can't be picked yet, keyed by audience, shown
   * in a tooltip on its disabled pill. The reason's test id is
   * `${dataTestId}-${audience}-reason`.
   */
  unavailableReasons?: Partial<
    Record<ShareAudience, Omit<ShareScopeUnavailableReason, 'testId'>>
  >;
  /**
   * The selected audience can't change (an existing share's audience): its
   * pill shows a lock icon. The other audiences carry their own reasons.
   */
  locked?: boolean;
}

/**
 * The Team/Organization/Public selector every share dialog renders,
 * parameterized by what the resource offers. With one audience to choose
 * from (a single one offered, or several offered but only one usable) there
 * is no choice to make: the pills and the setup/upgrade hints are hidden and
 * only the selected audience's description remains, so the dialog still
 * discloses who can see the share and where it appears
 * (`docs/ux-writing.md`).
 */
export function ShareAudienceSelector({
  offered,
  availability,
  value,
  onChange,
  legend,
  labelForAudience = shareAudienceLabel,
  descriptions,
  upgradeHint,
  hint,
  contentGap,
  disabled = false,
  dataTestId,
  keepDisabledVisible = false,
  optionDescribedBy,
  unavailableReasons,
  locked = false,
}: ShareAudienceSelectorProps): JSX.Element | null {
  const options = SHARE_AUDIENCE_ORDER.filter((audience) =>
    offered.includes(audience),
  );
  if (options.length === 0) return null;
  const description = value === null ? undefined : descriptions?.[value];
  const usable = options.filter((audience) => availability[audience] !== false);
  if (options.length === 1 || (usable.length <= 1 && !keepDisabledVisible)) {
    if (description === undefined || description === '') return null;
    return (
      <p
        className="text-xs fg-secondary"
        data-testid={
          dataTestId === undefined ? undefined : `${dataTestId}-description`
        }
      >
        {description}
      </p>
    );
  }
  return (
    <ShareScopeSelector<ShareAudience>
      contentGap={contentGap}
      legend={legend}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={options.map((audience) => ({
        value: audience,
        label: labelForAudience(audience),
        disabled: availability[audience] === false,
        ...(locked && audience === value ? { locked: true } : {}),
        ...(optionDescribedBy?.[audience] !== undefined
          ? { describedBy: optionDescribedBy[audience] }
          : {}),
        ...(unavailableReasons?.[audience] !== undefined
          ? {
              unavailable: {
                ...unavailableReasons[audience],
                ...(dataTestId !== undefined
                  ? { testId: `${dataTestId}-${audience}-reason` }
                  : {}),
              },
            }
          : {}),
      }))}
      dataTestId={dataTestId}
    >
      {description !== undefined && description !== '' && (
        <p
          className={
            contentGap === undefined
              ? 'pt-2 text-xs fg-secondary'
              : 'text-xs fg-secondary'
          }
          data-testid={
            dataTestId === undefined ? undefined : `${dataTestId}-description`
          }
        >
          {description}
        </p>
      )}
      {upgradeHint !== undefined && upgradeHint !== '' && (
        <p
          className={
            contentGap === undefined
              ? 'pt-2 text-xs fg-secondary'
              : 'text-xs fg-secondary'
          }
          data-testid={
            dataTestId === undefined ? undefined : `${dataTestId}-upgrade-hint`
          }
        >
          {upgradeHint}
        </p>
      )}
      {hint}
    </ShareScopeSelector>
  );
}

export interface SharedTargetPickerProps<T> {
  searchValue: string;
  onSearchChange: (next: string) => void;
  placeholder: string;
  loadingLabel: string;
  emptyLabel: string;
  /**
   * Optional replacement for the plain `emptyLabel` paragraph.
   *
   * A picker can be empty for reasons that need more than one sentence - "no
   * results for this query" wants the search glyph and the query echoed back,
   * while a bare label leaves the user unsure whether the search or the source
   * list is at fault. When provided this renders instead of `emptyLabel`;
   * `emptyLabel` stays required so a caller cannot end up with no empty copy
   * at all.
   */
  emptyContent?: ReactNode;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  items: readonly T[];
  getKey: (item: T) => string;
  isSelected: (item: T) => boolean;
  onSelect: (item: T) => void;
  renderRow: (item: T) => ReactNode;
  /**
   * Display name for the row's round initials avatar.
   *
   * Optional because the avatar is a treatment, not information: a caller
   * whose targets have no name to initial simply gets rows without one, and
   * the selection indicator still carries the affordance. Every current
   * caller passes it, so the pickers look alike across share surfaces.
   */
  getAvatarLabel?: (item: T) => string;
  /**
   * Who the targets are. A person's avatar is blocked from session replay;
   * a team's or organization's (`group`) is recorded. A caller that renders
   * a person's name or email in `renderRow` blocks that element itself.
   */
  targetSubject?: 'person' | 'group';
  /**
   * Test id for the picker root; each row gets
   * `${dataTestId}-option-${getKey(item)}`.
   */
  dataTestId?: string;
  /** Accessible name of the results, a radio group: `Teams`. */
  listLabel?: string;
}

export function SharedTargetPicker<T>({
  searchValue,
  onSearchChange,
  placeholder,
  loadingLabel,
  emptyLabel,
  emptyContent,
  loading,
  error,
  disabled,
  items,
  getKey,
  isSelected,
  onSelect,
  renderRow,
  getAvatarLabel,
  targetSubject = 'person',
  dataTestId,
  listLabel,
}: SharedTargetPickerProps<T>): JSX.Element {
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedIndex = items.findIndex(isSelected);
  // One Tab stop; arrows move to the next result and choose it, as in a radio group.
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    const radios = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ??
        [],
    );
    const current = radios.findIndex((radio) => radio === event.target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? radios.length - 1
          : step === 0 || current === -1
            ? -1
            : (current + step + radios.length) % radios.length;
    const item = items[next];
    if (next === -1 || item === undefined) return;
    event.preventDefault();
    radios[next].focus();
    onSelect(item);
  };
  return (
    <Stack gap="inline" data-testid={dataTestId}>
      {/*
        The glyph is not decoration. The results list used to repeat this
        control's exact chrome - same radius, same fill, same hairline - so a
        single-result picker read as a second, oddly-populated text field.
        The search box now announces itself, and the rows below dropped the
        box entirely.
      */}
      <SearchField
        ref={searchRef}
        value={searchValue}
        onValueChange={onSearchChange}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
      />
      {loading && (
        // A spinner, not a measured skeleton: rows are host-rendered and have no sample to measure.
        <DelayedLoadingPlaceholder slowNote={loadingLabel}>
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner
        errorSource="shared-target-picker"
        className=""
        error={error}
      />
      {!loading &&
        !error &&
        items.length === 0 &&
        (emptyContent ??
          (searchValue.trim() === '' ? (
            <p className="text-xs fg-secondary">{emptyLabel}</p>
          ) : (
            <SearchEmptyState
              title={emptyLabel}
              actionLabel="Clear search"
              onAction={() => {
                // The button unmounts with the empty state; keep focus in the dialog.
                onSearchChange('');
                searchRef.current?.focus();
              }}
            />
          )))}
      {!loading && !error && items.length > 0 && (
        /*
          Deliberately unboxed: no border, no fill, no radius of its own. The
          rows are the visual unit, and each one carries an avatar and a
          selection indicator, so a one-result list reads as one selectable
          person rather than as a filled input.
        */
        <OverlayScrollArea className="-mx-1 max-h-56" contentClassName="px-1">
          <ul
            ref={listRef}
            role="radiogroup"
            aria-label={listLabel}
            onKeyDown={onListKeyDown}
            className="grid grid-cols-1 content-start gap-0.5"
          >
            {items.map((item, index) => {
              const key = getKey(item);
              const selected = isSelected(item);
              const avatarLabel = getAvatarLabel?.(item);
              return (
                <li key={key} role="none">
                  <ControlButton
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelect(item)}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={
                      index === (selectedIndex === -1 ? 0 : selectedIndex)
                        ? 0
                        : -1
                    }
                    data-testid={
                      dataTestId === undefined
                        ? undefined
                        : `${dataTestId}-option-${key}`
                    }
                    presentation="share-scope-option"
                    appearance={{ selected }}
                  >
                    {avatarLabel !== undefined && (
                      <TargetAvatar
                        label={avatarLabel}
                        subject={targetSubject}
                      />
                    )}
                    <span className="min-w-0 flex-1">{renderRow(item)}</span>
                    <SelectionIndicator
                      selected={selected}
                      disabled={disabled}
                    />
                  </ControlButton>
                </li>
              );
            })}
          </ul>
        </OverlayScrollArea>
      )}
    </Stack>
  );
}

export type OrgTeamPickerKind = 'team' | 'organization';

export interface OrgTeamPickerCopy {
  readonly placeholder: string;
  readonly loading: string;
  readonly empty: string;
}

const ORG_TEAM_PICKER_COPY: Record<OrgTeamPickerKind, OrgTeamPickerCopy> = {
  team: {
    placeholder: 'Search teams',
    loading: 'Still loading teams…',
    empty: 'No teams found.',
  },
  organization: {
    placeholder: 'Search organizations',
    loading: 'Still loading organizations…',
    empty: 'No organizations found.',
  },
};

/** Default picker copy for a kind, for hosts that echo it elsewhere. */
export function orgTeamPickerCopy(kind: OrgTeamPickerKind): OrgTeamPickerCopy {
  return ORG_TEAM_PICKER_COPY[kind];
}

export interface OrgTeamPickerProps<T extends ShareTarget = ShareTarget> {
  kind: OrgTeamPickerKind;
  items: readonly T[];
  selectedId: string | null;
  onSelect: (target: T) => void;
  searchValue: string;
  onSearchChange: (next: string) => void;
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  /** Picker root test id; rows get `${dataTestId}-option-${id}`. */
  dataTestId?: string;
  /** Overrides over the kind's default copy. */
  copy?: Partial<OrgTeamPickerCopy>;
}

/**
 * The team or organization picker every share surface renders: search, then
 * one row per target with an initials avatar, the name, the secondary label
 * (a team's organization) and the selection indicator.
 */
export function OrgTeamPicker<T extends ShareTarget = ShareTarget>({
  kind,
  items,
  selectedId,
  onSelect,
  searchValue,
  onSearchChange,
  loading,
  error,
  disabled = false,
  dataTestId,
  copy: copyOverrides,
}: OrgTeamPickerProps<T>): JSX.Element {
  const copy: OrgTeamPickerCopy = {
    ...ORG_TEAM_PICKER_COPY[kind],
    ...copyOverrides,
  };
  return (
    <SharedTargetPicker<T>
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      placeholder={copy.placeholder}
      loadingLabel={copy.loading}
      emptyLabel={copy.empty}
      loading={loading}
      error={error}
      disabled={disabled}
      items={items}
      getKey={(item) => item.id}
      isSelected={(item) => item.id === selectedId}
      onSelect={onSelect}
      renderRow={(item) => (
        <>
          <span className="block text-s font-medium fg-primary">
            {item.name}
          </span>
          {item.secondaryLabel !== undefined && item.secondaryLabel !== '' && (
            <span className="block text-xs fg-secondary">
              {item.secondaryLabel}
            </span>
          )}
        </>
      )}
      getAvatarLabel={(item) => item.name}
      targetSubject="group"
      dataTestId={dataTestId}
      listLabel={kind === 'team' ? 'Teams' : 'Organizations'}
    />
  );
}

/**
 * Round initials avatar for one share target, deterministic in both color
 * modes. `aria-hidden` on purpose: the name it initials is already the row's
 * accessible name, so announcing "AQ Aaron Quirk" would only be noise - and
 * every caller's row selector still matches on the name alone.
 */
function TargetAvatar({
  label,
  subject,
}: {
  label: string;
  subject: 'person' | 'group';
}): JSX.Element {
  return <DisplayAvatar name={label} subject={subject} />;
}

/**
 * The trailing pick state, the shared radio mark. It is what makes an
 * unselected row legible as a *choice* rather than as static text, which is
 * the whole reason the list gave up its box.
 */
function SelectionIndicator({
  selected,
  disabled,
}: {
  selected: boolean;
  disabled: boolean;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-selected={selected ? 'true' : 'false'}
      data-testid="shared-target-picker-selection-indicator"
      className="flex shrink-0"
    >
      <ChoiceMark kind="radio" checked={selected} disabled={disabled} />
    </span>
  );
}
