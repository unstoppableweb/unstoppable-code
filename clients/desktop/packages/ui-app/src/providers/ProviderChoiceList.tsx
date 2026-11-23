'use client';

import { Fragment, useId, type JSX, type ReactNode } from 'react';
import {
  PROVIDER_CHOICE_GROUP_ORDER,
  type ProviderChoiceModel,
  type ProviderChoiceRow,
  type ProviderSourceId,
} from '@canopy/app-state/provider-choice';
import {
  AI_CREDITS_REOPEN_BILLING_LABEL,
  Button,
  Heading,
  PROVIDER_CHOICE_ACTION_LABELS,
  PROVIDER_CHOICE_GROUP_HEADINGS,
  PROVIDER_CHOICE_RECONNECT_LABEL,
  PROVIDER_CHOICE_ROW_COPY,
  PROVIDER_CHOICE_SETUP_SUFFIXES,
  SettingsRowsGroup,
  staysOn,
  type SettingsRowsGroupProps,
  switchesTo,
  type ProviderChoiceOutcomeWords,
  type ProviderChoiceSetupStep,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import { ProviderSourceRow } from './ProviderSourceRow';

/** How a host names and marks one source. */
export interface ProviderChoicePresentation {
  readonly icon?: ReactNode;
  /**
   * The row's name. The credits row carries the host's brand app name; a
   * user-named source (a gateway) wraps its name in the replay mask.
   */
  readonly name: ReactNode;
  /** The signed-in account, or what the source is, under the name. */
  readonly description?: ReactNode;
}

export type ProviderChoicePresentations = Readonly<
  Partial<Record<ProviderSourceId, ProviderChoicePresentation>>
>;

/** What a row's control needs to know about the list around it. */
export interface ProviderChoiceActionContext {
  /** The one row the list emphasizes: its button is the only primary. */
  readonly recommended: boolean;
}

/** The last row action's failure, shown on that row. */
export interface ProviderChoiceRowError {
  readonly source: ProviderSourceId;
  readonly message: string;
}

export interface ProviderChoiceListProps<TModel extends ProviderChoiceModel> {
  readonly rows: readonly ProviderChoiceRow<TModel>[];
  /** `choices.recommended`: the row whose button is primary, if any. */
  readonly recommended: ProviderSourceId | null;
  readonly presentation: ProviderChoicePresentations;
  /**
   * The row's trailing control. Hosts own sign-in and purchase mechanics;
   * return {@link ProviderChoiceActionButton} where the action is a plain
   * button (passing `recommended` through), or `null` for none.
   */
  readonly renderAction: (
    row: ProviderChoiceRow<TModel>,
    context: ProviderChoiceActionContext,
  ) => ReactNode;
  /** Formats a reset time for "Limit reached, resets at …". */
  readonly formatResetsAt?: (resetsAt: number) => string;
  /** The clock that decides whether a reset time has passed. */
  readonly now?: () => number;
  /** The chat's model, for "Stays on {model}" when a row doesn't name it. */
  readonly targetModelLabel?: string;
  /** The last action's failure, on the row that failed. */
  readonly rowError?: ProviderChoiceRowError | null;
  /** Under the groups. */
  readonly footer?: ReactNode;
  readonly ariaLabel?: string;
  readonly dataTestId?: string;
  /** The model a `run-model` list is for, for "Doesn't offer {model}". */
  readonly modelNotOfferedLabel?: string;
  /**
   * `grouped` (default): one heading per non-empty group, for recovery.
   * `flat`: one box in row order, no headings and no outcome line, for a
   * `set-up` list. A row still checking draws no dot until its read
   * settles. A row never changes parent there, so state a host renders
   * inside it (an inline editor) survives a connect.
   */
  readonly layout?: 'grouped' | 'flat';
  /** The rows' box surface. Grouped lists default to `plain`. */
  readonly surface?: SettingsRowsGroupProps['surface'];
  /** Rendered inside a row, under its lines: an inline editor. */
  readonly rowChildren?: (row: ProviderChoiceRow<TModel>) => ReactNode;
  /**
   * A host row that `presentation` and `renderAction` can't express without
   * a visual change. Return `undefined` to render the default row.
   */
  readonly renderRow?: (
    row: ProviderChoiceRow<TModel>,
    defaultRow: ReactNode,
  ) => ReactNode;
}

function statusTone(
  row: ProviderChoiceRow<ProviderChoiceModel>,
): ProviderStatusDotTone {
  switch (row.connection.kind) {
    case 'ready':
      return 'connected';
    case 'limited':
      return 'limited';
    case 'checking':
      return 'pending';
    case 'not-connected':
      return 'signed-out';
  }
}

/**
 * A row's one outcome line, as words: what choosing it does (`lead`, then
 * the `model` a row sets apart, then the step it needs first), or a plain
 * reason in `lead` alone.
 */
export interface ProviderChoiceRowOutcome extends ProviderChoiceOutcomeWords {
  readonly suffix?: string;
}

function plainOutcome(lead: string): ProviderChoiceRowOutcome {
  return { lead };
}

export interface ProviderChoiceRowOutcomeOptions {
  /** The chat's model, when the row's own outcome doesn't name it. */
  readonly modelLabel?: string;
  readonly formatResetsAt?: (resetsAt: number) => string;
  /** The clock that decides whether a reset time has passed. */
  readonly now?: () => number;
  /** The model a `run-model` list is for, for "Doesn't offer {model}". */
  readonly modelNotOfferedLabel?: string;
}

/** The step a row's action needs before its outcome applies. */
function setupStep(
  row: ProviderChoiceRow<ProviderChoiceModel>,
): ProviderChoiceSetupStep | undefined {
  switch (row.action) {
    case 'connect':
    case 'set-up':
      return row.isCurrent ? 'reconnect' : 'connect';
    case 'buy':
    case 'sign-in-to-buy':
      return 'add-credits';
    case 'check-again':
      return 'credits-arrive';
    case 'use':
    case 'ask-admin':
    case 'none':
      return undefined;
  }
}

/** The line for a row whose source can't take the chat now, if it has one. */
function unavailableLine<TModel extends ProviderChoiceModel>(
  outcome: Extract<
    ProviderChoiceRow<TModel>['outcome'],
    { kind: 'unavailable' }
  >,
  {
    formatResetsAt,
    now = Date.now,
    modelNotOfferedLabel,
    modelLabel,
  }: ProviderChoiceRowOutcomeOptions,
): string | undefined {
  switch (outcome.reason) {
    case 'desktop-only':
      return PROVIDER_CHOICE_ROW_COPY.desktopOnly;
    case 'cross-harness':
      return PROVIDER_CHOICE_ROW_COPY.crossHarness;
    case 'policy':
      return PROVIDER_CHOICE_ROW_COPY.policy;
    case 'limited':
      return PROVIDER_CHOICE_ROW_COPY.limited(
        // A reset time that has passed is dropped, as in the dialog subtitle.
        outcome.resetsAt != null &&
          outcome.resetsAt > now() &&
          formatResetsAt !== undefined
          ? formatResetsAt(outcome.resetsAt)
          : undefined,
      );
    case 'blocked':
      return outcome.detail;
    case 'no-runnable-model':
      return PROVIDER_CHOICE_ROW_COPY.noRunnableModel;
    case 'model-not-offered': {
      const label = modelNotOfferedLabel ?? modelLabel;
      return label !== undefined
        ? PROVIDER_CHOICE_ROW_COPY.modelNotOffered(label)
        : undefined;
    }
  }
}

/**
 * Every row's one outcome line, in precedence order (first match wins):
 * checking, the admin line, a gateway to set up whose models are unknown,
 * an unavailable reason, then what choosing it does ("Stays on" or
 * "Switches to") with the step it needs first (reconnect, connect, add
 * credits, credits arriving), and a fallback so no row is ever blank.
 */
export function providerChoiceRowOutcome<TModel extends ProviderChoiceModel>(
  row: ProviderChoiceRow<TModel>,
  options: ProviderChoiceRowOutcomeOptions = {},
): ProviderChoiceRowOutcome {
  if (row.connection.kind === 'checking') {
    return plainOutcome(PROVIDER_CHOICE_ROW_COPY.checking);
  }
  if (row.action === 'ask-admin') {
    return plainOutcome(PROVIDER_CHOICE_ROW_COPY.askAdmin);
  }
  const { outcome } = row;
  if (outcome.kind === 'unavailable') {
    // Not set up yet: its models are unknown until it is.
    if (
      outcome.reason === 'no-runnable-model' &&
      (row.action === 'set-up' || row.action === 'connect')
    ) {
      return plainOutcome(PROVIDER_CHOICE_ROW_COPY.pickModelOnceConnected);
    }
    const line = unavailableLine(outcome, options);
    return plainOutcome(line ?? PROVIDER_CHOICE_ROW_COPY.notAvailableNow);
  }
  const words =
    outcome.kind === 'same-model'
      ? staysOn(outcome.model?.label ?? options.modelLabel)
      : switchesTo(outcome.target.label);
  const step = setupStep(row);
  if (step !== undefined) {
    return { ...words, suffix: PROVIDER_CHOICE_SETUP_SUFFIXES[step] };
  }
  // A current source that still runs a locked model offers no button, and
  // stays on it.
  const usableCurrent =
    row.isCurrent &&
    row.connection.kind === 'ready' &&
    outcome.kind === 'same-model';
  if (row.action === 'use' || usableCurrent) return words;
  return plainOutcome(PROVIDER_CHOICE_ROW_COPY.notAvailableNow);
}

/** The outcome as the row's text, with the model set apart. */
function outcomeText(outcome: ProviderChoiceRowOutcome): ReactNode {
  return (
    <>
      {outcome.lead}
      {outcome.model !== undefined && (
        <>
          {' '}
          <span className="font-medium fg-primary">{outcome.model}</span>
        </>
      )}
      {outcome.suffix !== undefined && <> {outcome.suffix}</>}
    </>
  );
}

/**
 * The provider-choice rows, from `resolveProviderChoices`, under one heading
 * per non-empty group (Ready now, Needs setup, Not available). The same list
 * on every host: the recovery dialog and locked-model picks. Nothing here
 * branches on the host; unsupported rows come from the facts the host passed
 * the resolver.
 *
 * Each group is its own parent, so a row that changes group (a connect that
 * finishes, credits that arrive) remounts: no modal or in-flight state lives
 * in a row; hosts keep it above the list.
 *
 * The `flat` layout (a `set-up` list: first run, the web first-visit card)
 * is one box in row order with no headings and no outcome line. Its rows
 * keep their parent, so a host's inline editor (`rowChildren`) survives a
 * connect.
 */
export function ProviderChoiceList<TModel extends ProviderChoiceModel>({
  rows,
  recommended,
  presentation,
  renderAction,
  formatResetsAt,
  now,
  targetModelLabel,
  rowError = null,
  footer,
  ariaLabel,
  dataTestId,
  modelNotOfferedLabel,
  layout = 'grouped',
  surface,
  rowChildren,
  renderRow,
}: ProviderChoiceListProps<TModel>): JSX.Element {
  const idPrefix = useId();
  const flat = layout === 'flat';
  const outcomeOptions: ProviderChoiceRowOutcomeOptions = {
    ...(targetModelLabel !== undefined ? { modelLabel: targetModelLabel } : {}),
    ...(formatResetsAt !== undefined ? { formatResetsAt } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(modelNotOfferedLabel !== undefined ? { modelNotOfferedLabel } : {}),
  };
  const renderOne = (row: ProviderChoiceRow<TModel>): ReactNode => {
    const shown = presentation[row.source];
    const outcome = providerChoiceRowOutcome(row, outcomeOptions);
    const error =
      rowError !== null && rowError.source === row.source
        ? rowError.message
        : undefined;
    const defaultRow = (
      <ProviderSourceRow
        key={row.source}
        icon={shown?.icon}
        name={shown?.name ?? row.source}
        // A flat list has no outcome line to say a row is checking, so the
        // row's description says it and the dot waits for the read.
        {...(flat && row.connection.kind === 'checking'
          ? {}
          : { status: statusTone(row) })}
        // A grouped row still checking keeps its pending dot. A flat list has
        // no groups, so only an unavailable outcome quiets its row.
        unavailable={
          flat
            ? row.outcome.kind === 'unavailable'
            : row.group === 'unavailable' && row.connection.kind !== 'checking'
        }
        {...(row.isCurrent ? { badge: PROVIDER_CHOICE_ROW_COPY.current } : {})}
        description={shown?.description}
        {...(flat
          ? {}
          : {
              outcome: {
                text: outcomeText(outcome),
                testId: `provider-choice-detail-${row.source}`,
              },
            })}
        {...(error !== undefined
          ? {
              error,
              errorTestId: `switch-provider-dialog-error-${row.source}`,
            }
          : {})}
        control={renderAction(row, {
          recommended: row.source === recommended,
        })}
        dataTestId={`provider-choice-row-${row.source}`}
      >
        {rowChildren?.(row)}
      </ProviderSourceRow>
    );
    const custom = renderRow?.(row, defaultRow);
    return custom === undefined ? (
      defaultRow
    ) : (
      <Fragment key={row.source}>{custom}</Fragment>
    );
  };
  if (flat) {
    return (
      <div className="flex flex-col gap-3">
        <SettingsRowsGroup
          {...(surface !== undefined ? { surface } : {})}
          {...(ariaLabel !== undefined ? { ariaLabel } : {})}
          {...(dataTestId !== undefined ? { dataTestId } : {})}
        >
          {rows.map(renderOne)}
        </SettingsRowsGroup>
        {footer}
      </div>
    );
  }
  const groups = PROVIDER_CHOICE_GROUP_ORDER.map((group) => ({
    group,
    rows: rows.filter((row) => row.group === group),
  })).filter((entry) => entry.rows.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-4"
        {...(ariaLabel !== undefined
          ? { role: 'group', 'aria-label': ariaLabel }
          : {})}
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      >
        {groups.map(({ group, rows: groupRows }) => {
          const headingId = `${idPrefix}-${group}`;
          return (
            <div
              key={group}
              role="group"
              aria-labelledby={headingId}
              className="flex flex-col gap-1"
              data-testid={`provider-choice-group-${group}`}
            >
              <Heading level={3} variant="label" id={headingId}>
                {PROVIDER_CHOICE_GROUP_HEADINGS[group]}
              </Heading>
              <SettingsRowsGroup surface={surface ?? 'plain'}>
                {groupRows.map(renderOne)}
              </SettingsRowsGroup>
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

export interface CreditsRowPendingActionProps {
  readonly row: ProviderChoiceRow<ProviderChoiceModel>;
  /** The notice's tracked hand-off's Reopen billing, once it reports. */
  readonly onReopenBilling?: () => void;
  readonly reopenPending?: boolean;
  readonly onCheckAgain?: () => void;
  readonly checking?: boolean;
}

/**
 * The credits row's control while a purchase from the list is pending. The
 * notice already shows Check again, so the row offers Reopen billing, the
 * way back to a closed checkout tab. After a failed check the rule is to
 * retry with Check again, never Reopen billing, so the row offers that.
 */
export function CreditsRowPendingAction({
  row,
  onReopenBilling,
  reopenPending = false,
  onCheckAgain,
  checking = false,
}: CreditsRowPendingActionProps): JSX.Element {
  if (row.creditsPrompt?.secondary === 'reopen-billing') {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={(): void => onReopenBilling?.()}
        aria-busy={reopenPending || undefined}
        disabled={onReopenBilling === undefined || reopenPending}
        data-testid={`provider-choice-action-${row.source}`}
      >
        {AI_CREDITS_REOPEN_BILLING_LABEL}
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={(): void => onCheckAgain?.()}
      aria-busy={checking || undefined}
      disabled={onCheckAgain === undefined || checking}
      data-testid={`provider-choice-action-${row.source}`}
    >
      {PROVIDER_CHOICE_ACTION_LABELS['check-again']}
    </Button>
  );
}

export interface ProviderChoiceActionButtonProps {
  readonly source: ProviderSourceId;
  readonly action: ProviderChoiceRow<ProviderChoiceModel>['action'];
  readonly onClick: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** The list's one emphasized row: the only primary button. */
  readonly recommended?: boolean;
  /** The chat's current source: its Connect or Set up reads Reconnect. */
  readonly isCurrent?: boolean;
}

/**
 * A row action that is a plain button, labelled from its action. Primary
 * only on the recommended row, so a list has at most one; every other
 * button is secondary. Renders nothing for `none` and `ask-admin` (the
 * admin line is the row's outcome).
 */
export function ProviderChoiceActionButton({
  source,
  action,
  onClick,
  busy = false,
  disabled = false,
  recommended = false,
  isCurrent = false,
}: ProviderChoiceActionButtonProps): JSX.Element | null {
  if (action === 'none' || action === 'ask-admin') return null;
  const reconnect = isCurrent && (action === 'connect' || action === 'set-up');
  return (
    <Button
      variant={recommended ? 'primary' : 'secondary'}
      size="sm"
      onClick={onClick}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      data-testid={`provider-choice-action-${source}`}
      {...(recommended ? { 'data-recommended': 'true' } : {})}
    >
      {reconnect
        ? PROVIDER_CHOICE_RECONNECT_LABEL
        : PROVIDER_CHOICE_ACTION_LABELS[action]}
    </Button>
  );
}
