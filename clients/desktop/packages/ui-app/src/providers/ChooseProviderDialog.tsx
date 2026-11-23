'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import type {
  ProviderChoiceModel,
  ProviderChoiceRow,
  ProviderChoices,
  ProviderChoiceTarget,
} from '@canopy/app-state/provider-choice';
import {
  DialogModal,
  ErrorBanner,
  providerChoiceReason,
  switchProviderDialogTitle,
  usageLimitReasonAfterName,
  type ProviderChoiceConditionKey,
} from '@canopy/ui-shared/components';
import {
  ProviderChoiceList,
  type ProviderChoiceActionContext,
  type ProviderChoicePresentations,
  type ProviderChoiceRowError,
} from './ProviderChoiceList';

export interface ChooseProviderDialogProps<TModel extends ProviderChoiceModel> {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The resolved rows, the current source and the recommended row. */
  readonly choices: Pick<
    ProviderChoices<TModel>,
    'rows' | 'current' | 'recommended'
  >;
  readonly target: ProviderChoiceTarget<TModel>;
  /**
   * Why the dialog is open, for its title and subtitle. `null` (the
   * Components Lab, or a condition cleared while open) reads "Choose a
   * provider" with no subtitle.
   */
  readonly condition: ProviderChoiceConditionKey | null;
  readonly presentation: ProviderChoicePresentations;
  readonly renderAction: (
    row: ProviderChoiceRow<TModel>,
    context: ProviderChoiceActionContext,
  ) => ReactNode;
  /** The notice's own reset formatter, so both show the same time. */
  readonly formatResetsAt?: (resetsAt: number) => string;
  /**
   * The last row action's failure, shown on that row; under the rows only
   * when the source has no row, so a failure is never shown twice.
   */
  readonly rowError?: ProviderChoiceRowError | null;
  /** The control that opened the dialog; focus returns to it on close. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly footer?: ReactNode;
  readonly dataTestId?: string;
  /** The clock for "resets at", so a past reset drops its clause. */
  readonly now?: () => number;
  /** Inline editors under a row, as in {@link ProviderChoiceList}. */
  readonly rowChildren?: (row: ProviderChoiceRow<TModel>) => ReactNode;
  /** A host row, as in {@link ProviderChoiceList}. */
  readonly renderRow?: (
    row: ProviderChoiceRow<TModel>,
    defaultRow: ReactNode,
  ) => ReactNode;
}

/**
 * The subtitle: why the dialog is open and that the conversation carries
 * over. A usage limit names the limited current source as a node (a
 * gateway's name is user-written and masked), with its reset time when it
 * is known and still ahead.
 */
function dialogSubtitle<TModel extends ProviderChoiceModel>({
  target,
  condition,
  current,
  presentation,
  formatResetsAt,
  now,
}: {
  readonly target: ProviderChoiceTarget<TModel>;
  readonly condition: ProviderChoiceConditionKey | null;
  readonly current: ProviderChoiceRow<TModel> | null;
  readonly presentation: ProviderChoicePresentations;
  readonly formatResetsAt: ((resetsAt: number) => string) | undefined;
  readonly now: () => number;
}): ReactNode {
  if (target.kind === 'run-model' || target.kind === 'set-up') return undefined;
  if (
    condition === 'quota_limit' &&
    current !== null &&
    current.connection.kind === 'limited'
  ) {
    const { resetsAt } = current.connection;
    const resetsLabel =
      resetsAt != null && resetsAt > now() && formatResetsAt !== undefined
        ? formatResetsAt(resetsAt)
        : undefined;
    const name = presentation[current.source]?.name ?? current.source;
    return (
      <>
        {name} {usageLimitReasonAfterName(resetsLabel)}
      </>
    );
  }
  return providerChoiceReason(condition);
}

/**
 * The provider list as a dialog: what a recovery notice's Switch provider
 * (or Choose provider) and a locked-model pick open. Its header says why it
 * opened, so the current source drops out of the list unless it offers an
 * action (Reconnect, Buy). Primary actions only, so it has no footer; the X
 * or the backdrop dismisses it (docs/design/overlays.md). Hosts close it
 * before opening anything a row starts (a sign-in, a switch dialog, a
 * checkout), so two modals never stack. A `set-up` target (opened from any
 * flow to connect providers) reads "Choose a provider" with no subtitle, in
 * the flat layout.
 */
export function ChooseProviderDialog<TModel extends ProviderChoiceModel>({
  open,
  onClose,
  choices,
  target,
  condition,
  presentation,
  renderAction,
  formatResetsAt,
  rowError = null,
  restoreFocusRef,
  footer,
  dataTestId = 'switch-provider-dialog',
  now = Date.now,
  rowChildren,
  renderRow,
}: ChooseProviderDialogProps<TModel>): JSX.Element | null {
  if (!open) return null;
  const modelLabel =
    target.kind === 'run-model' ? target.model.label : undefined;
  const targetModelLabel =
    target.kind === 'continue-chat' ? target.model?.label : undefined;
  const subtitle = dialogSubtitle({
    target,
    condition,
    current: choices.current,
    presentation,
    formatResetsAt,
    now,
  });
  const errorHasRow =
    rowError !== null &&
    choices.rows.some((row) => row.source === rowError.source);
  return (
    <DialogModal
      title={switchProviderDialogTitle({
        condition: target.kind === 'set-up' ? null : condition,
        ...(modelLabel !== undefined ? { modelLabel } : {}),
      })}
      {...(subtitle !== undefined ? { subtitle } : {})}
      onClose={onClose}
      maxWidth="md"
      dataTestId={dataTestId}
      // Focus moves into the list when it opens, including when a host
      // opens it on its own, and returns on close.
      trapFocus
      {...(restoreFocusRef !== undefined ? { restoreFocusRef } : {})}
    >
      <div className="flex flex-col gap-3">
        <ProviderChoiceList
          rows={choices.rows}
          recommended={choices.recommended}
          presentation={presentation}
          renderAction={renderAction}
          {...(formatResetsAt !== undefined ? { formatResetsAt } : {})}
          now={now}
          {...(targetModelLabel !== undefined ? { targetModelLabel } : {})}
          {...(modelLabel !== undefined
            ? { modelNotOfferedLabel: modelLabel }
            : {})}
          rowError={errorHasRow ? rowError : null}
          {...(footer !== undefined ? { footer } : {})}
          dataTestId="provider-choice-list"
          {...(target.kind === 'set-up'
            ? { layout: 'flat' as const, surface: 'plain' as const }
            : {})}
          {...(rowChildren !== undefined ? { rowChildren } : {})}
          {...(renderRow !== undefined ? { renderRow } : {})}
        />
        <ErrorBanner
          error={rowError !== null && !errorHasRow ? rowError.message : null}
          errorSource="switch-provider-dialog"
          className=""
          testId={`${dataTestId}-error`}
        />
      </div>
    </DialogModal>
  );
}
