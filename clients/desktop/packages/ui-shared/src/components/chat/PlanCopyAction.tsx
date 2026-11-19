'use client';

import {
  useCallback,
  useId,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { CheckIcon } from '../../icons/CheckIcon';
import { CopyIcon } from '../../icons/CopyIcon';
import { Button } from '../Button';
import { CLEAN_ICON_BUTTON_VARIANT } from '../chat-look';
import { CopyStatusRegion, useAnnouncedCopy } from '../copy-feedback';
import { Tooltip } from '../Tooltip';
import type { PlanTurnResolution } from './exit-plan-mode-plan';

/** The action's name on every surface (CAN-5354). */
export const COPY_PLAN_LABEL = 'Copy plan';
/**
 * Its visible label: every surface already reads as the plan's, so the
 * button only says `Copy`, and the name keeps `plan` for screen readers.
 */
const COPY_PLAN_VISIBLE_LABEL = 'Copy';
const COPY_PLAN_FAILED = "Couldn't copy the plan";

/**
 * What a Copy plan action can copy. `ready` holds the plan's exact Markdown;
 * `loading` and `unavailable` keep the action in view, inert, with the reason
 * as its description. A recognized plan never falls back to other text.
 */
export type PlanCopyState =
  | { readonly status: 'ready'; readonly markdown: string }
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable'; readonly reason: string };

const LOADING_REASON = 'Loading the plan…';
const MISSING_REASON = "The plan's text isn't available";
const TRUNCATED_REASON = 'Only part of the plan arrived here';

/** The Copy plan state of a turn that proposes a plan. */
export function planCopyStateFromResolution(
  resolution: Exclude<PlanTurnResolution, { kind: 'none' }>,
): PlanCopyState {
  if (resolution.kind === 'complete') {
    return { status: 'ready', markdown: resolution.markdown };
  }
  return {
    status: 'unavailable',
    reason:
      resolution.reason === 'truncated' ? TRUNCATED_REASON : MISSING_REASON,
  };
}

/** The Copy plan state for plan Markdown a host has, or is still loading. */
export function planCopyStateFromMarkdown(
  markdown: string | null | undefined,
  options: { readonly loading?: boolean } = {},
): PlanCopyState {
  if (typeof markdown === 'string' && markdown.trim() !== '') {
    return { status: 'ready', markdown };
  }
  return options.loading === true
    ? { status: 'loading' }
    : { status: 'unavailable', reason: MISSING_REASON };
}

/**
 * Where the action sits: `footer` is a turn's quiet icon beside its stamp,
 * `composer` the labeled capsule beside Open plan, `control` the 28px
 * secondary button beside Share, and `card` the plan card's `compact`
 * secondary capsule beside its other actions.
 */
export type PlanCopyAppearance = 'footer' | 'composer' | 'control' | 'card';

export interface PlanCopyActionProps {
  readonly state: PlanCopyState;
  readonly appearance: PlanCopyAppearance;
  readonly dataTestId: string;
  /** `control` only: icon-only, its name in a tooltip, in a narrow row. */
  readonly compact?: boolean;
  /** Host clipboard writer; defaults to the browser clipboard. */
  readonly write?: (text: string, ownerDocument?: Document) => Promise<boolean>;
}

/**
 * The persistent Copy plan action (CAN-5354): copies a plan's raw Markdown,
 * exactly, and a polite status announces `Copied` after every successful
 * copy, or that copying failed. Every turn, prompt, header and card that
 * offers a plan mounts this one control so its behavior cannot drift.
 *
 * Without copyable Markdown the action stays in view and focusable but inert
 * (`aria-disabled`), its reason in the tooltip and description. Changing the
 * Markdown remounts the control, dropping feedback from the previous plan.
 */
export function PlanCopyAction(props: PlanCopyActionProps): JSX.Element {
  const key =
    props.state.status === 'ready'
      ? `ready:${props.state.markdown}`
      : props.state.status;
  return <PlanCopyActionControl key={key} {...props} />;
}

function PlanCopyActionControl({
  state,
  appearance,
  dataTestId,
  compact = false,
  write,
}: PlanCopyActionProps): JSX.Element {
  const reasonId = useId();
  const { copied, failed, announcement, copy } = useAnnouncedCopy({
    failureAnnouncement: COPY_PLAN_FAILED,
    ...(write !== undefined ? { write } : {}),
  });
  const markdown = state.status === 'ready' ? state.markdown : null;
  const reason =
    state.status === 'ready'
      ? undefined
      : state.status === 'loading'
        ? LOADING_REASON
        : state.reason;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      if (markdown === null) return;
      void copy(markdown, event.currentTarget.ownerDocument);
    },
    [copy, markdown],
  );

  const name = copied ? 'Copied' : COPY_PLAN_LABEL;
  const tooltip = reason ?? (failed ? COPY_PLAN_FAILED : name);
  const unavailable = markdown === null;
  const buttonProps: PlanCopyButtonProps = {
    onClick: handleClick,
    // Interactive plan cards also handle Enter/Space. Keep activation on the
    // native button, without letting the card cancel it and navigate instead.
    onKeyDown: (event): void => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    },
    'aria-label': name,
    'aria-disabled': unavailable ? true : undefined,
    'aria-describedby': unavailable ? reasonId : undefined,
    'data-testid': dataTestId,
    'data-state': copied ? 'copied' : state.status,
  };
  const control = renderPlanCopyControl({
    appearance,
    compact,
    copied,
    buttonProps,
  });

  // Icon-only looks name themselves in the tooltip; labeled ones only need
  // it to explain why they cannot copy yet.
  const iconOnly =
    appearance === 'footer' || (appearance === 'control' && compact);
  return (
    <span className="relative inline-flex shrink-0">
      <Tooltip label={tooltip} suppressed={!iconOnly && reason === undefined}>
        {control}
      </Tooltip>
      {reason !== undefined && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
      <CopyStatusRegion
        announcement={announcement}
        dataTestId={`${dataTestId}-status`}
      />
    </span>
  );
}

interface PlanCopyButtonProps {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly 'aria-label': string;
  readonly 'aria-disabled': true | undefined;
  readonly 'aria-describedby': string | undefined;
  readonly 'data-testid': string;
  readonly 'data-state': string;
}

function planCopyGlyph(copied: boolean): ReactNode {
  return copied ? (
    <CheckIcon size="sm" aria-hidden="true" />
  ) : (
    <CopyIcon size="sm" aria-hidden="true" />
  );
}

/** The action's button in its surface's look. */
function renderPlanCopyControl({
  appearance,
  compact,
  copied,
  buttonProps,
}: {
  readonly appearance: PlanCopyAppearance;
  readonly compact: boolean;
  readonly copied: boolean;
  readonly buttonProps: PlanCopyButtonProps;
}): JSX.Element {
  const visibleLabel = copied ? 'Copied' : COPY_PLAN_VISIBLE_LABEL;
  // An inert action keeps its geometry and stays reachable; it only reads
  // as unavailable. `Button` styles `aria-disabled` itself.
  switch (appearance) {
    case 'footer':
      return (
        <Button
          variant={CLEAN_ICON_BUTTON_VARIANT}
          size="sm"
          iconOnly
          {...buttonProps}
        >
          {planCopyGlyph(copied)}
        </Button>
      );
    case 'composer':
      return (
        <Button size="compact" variant="ghost" {...buttonProps}>
          {planCopyGlyph(copied)}
          <span>{visibleLabel}</span>
        </Button>
      );
    case 'card':
      return (
        <Button size="compact" variant="secondary" {...buttonProps}>
          {planCopyGlyph(copied)}
          {visibleLabel}
        </Button>
      );
    case 'control':
      return compact ? (
        <Button size="compact" variant="secondary" iconOnly {...buttonProps}>
          {planCopyGlyph(copied)}
        </Button>
      ) : (
        <Button size="compact" variant="secondary" {...buttonProps}>
          {planCopyGlyph(copied)}
          {visibleLabel}
        </Button>
      );
  }
}
