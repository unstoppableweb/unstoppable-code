'use client';

import { useId, type JSX, type ReactNode } from 'react';
import {
  Badge,
  FieldError,
  ProviderRowLabel,
  ProviderStatusDot,
  SettingsRowsRow,
  type ProviderStatusDotTone,
  type SettingsRowsRowProps,
} from '@canopy/ui-shared/components';

/**
 * What choosing a row does, as its one leading line, in words alone ("Stays
 * on", "Switches to"); the host sets the model apart inside `text`.
 */
export interface ProviderSourceRowOutcome {
  readonly text: ReactNode;
  readonly testId?: string;
}

/**
 * One provider as a Settings-style row: its mark, name and status dot, an
 * optional outcome line, a description and a trailing control. Purely
 * presentational, so first run ("Let's get started", Settings › Account)
 * and the provider-choice list render the same row; each host supplies the
 * control and its mechanics.
 *
 * One rule for both tables: with an `outcome` (the provider-choice list)
 * the outcome leads in primary ink and the description drops to tertiary;
 * without one (first run, which has no chat model to stay on) the
 * description stays in secondary ink.
 */
export interface ProviderSourceRowProps {
  /** The provider's mark at 16px. */
  readonly icon?: ReactNode;
  readonly name: ReactNode;
  /** The status dot's tone, or omitted while there is nothing to report. */
  readonly status?: ProviderStatusDotTone;
  /** Names the dot's state for assistive technology when the text doesn't. */
  readonly statusLabel?: string;
  /** The status dot's test id, for hosts whose tests read it. */
  readonly statusTestId?: string;
  /** A neutral badge after the name, such as "Current". */
  readonly badge?: string;
  readonly description?: ReactNode;
  /** What choosing the row does, before the description. */
  readonly outcome?: ProviderSourceRowOutcome;
  /**
   * The source can't take the chat now: the row drops its status dot and
   * quiets its name and mark, so the rows that can read first.
   */
  readonly unavailable?: boolean;
  /** Why the last action on this row failed, under its lines. */
  readonly error?: string;
  readonly errorTestId?: string;
  readonly control?: ReactNode;
  /** Under the row's line: a carryover note, a modal, attention text. */
  readonly children?: ReactNode;
  readonly contentGap?: SettingsRowsRowProps['contentGap'];
  readonly dataTestId?: string;
}

/** The name's trailing markers: the status dot, then the badge. */
function rowMarkers({
  status,
  statusLabel,
  statusTestId,
  badge,
  badgeTestId,
}: {
  readonly status: ProviderStatusDotTone | undefined;
  readonly statusLabel: string | undefined;
  readonly statusTestId: string | undefined;
  readonly badge: string | undefined;
  readonly badgeTestId: string | undefined;
}): JSX.Element | undefined {
  if (status === undefined && badge === undefined) return undefined;
  return (
    <>
      {status !== undefined && (
        <ProviderStatusDot
          tone={status}
          {...(statusLabel !== undefined ? { label: statusLabel } : {})}
          {...(statusTestId !== undefined
            ? { 'data-testid': statusTestId }
            : {})}
        />
      )}
      {badge !== undefined && (
        <Badge
          {...(badgeTestId !== undefined ? { 'data-testid': badgeTestId } : {})}
        >
          {badge}
        </Badge>
      )}
    </>
  );
}

/** The outcome, then the description, then a row error. */
function rowDescription({
  description,
  outcome,
  error,
  errorTestId,
  errorId,
}: Pick<
  ProviderSourceRowProps,
  'description' | 'outcome' | 'error' | 'errorTestId'
> & { readonly errorId: string }): ReactNode {
  if (outcome === undefined && error === undefined) return description;
  return (
    <span className="flex flex-col gap-0.5">
      {outcome !== undefined && (
        // The state in primary ink, its explanation below in tertiary: the
        // hierarchy is carried by ink, not size (docs/design/typography.md).
        <span data-testid={outcome.testId} className="fg-primary">
          {outcome.text}
        </span>
      )}
      {description !== undefined && (
        <span className={outcome !== undefined ? 'fg-tertiary' : undefined}>
          {description}
        </span>
      )}
      {error !== undefined && (
        <FieldError
          id={errorId}
          announce
          {...(errorTestId !== undefined ? { 'data-testid': errorTestId } : {})}
        >
          {error}
        </FieldError>
      )}
    </span>
  );
}

export function ProviderSourceRow({
  icon,
  name,
  status,
  statusLabel,
  statusTestId,
  badge,
  description,
  outcome,
  unavailable = false,
  error,
  errorTestId,
  control,
  children,
  contentGap,
  dataTestId,
}: ProviderSourceRowProps): JSX.Element {
  const errorId = useId();
  return (
    <SettingsRowsRow
      label={
        <ProviderRowLabel
          icon={
            unavailable && icon !== undefined ? (
              <span className="flex fg-tertiary">{icon}</span>
            ) : (
              icon
            )
          }
          name={
            unavailable ? <span className="fg-tertiary">{name}</span> : name
          }
          status={rowMarkers({
            status: unavailable ? undefined : status,
            statusLabel,
            statusTestId,
            badge,
            badgeTestId:
              dataTestId !== undefined ? `${dataTestId}-badge` : undefined,
          })}
        />
      }
      // Called, not rendered: the row draws its description block only
      // when there is one.
      description={rowDescription({
        description,
        outcome,
        error,
        errorTestId,
        errorId,
      })}
      control={control}
      {...(contentGap !== undefined ? { contentGap } : {})}
      {...(dataTestId !== undefined ? { dataTestId } : {})}
    >
      {children}
    </SettingsRowsRow>
  );
}
