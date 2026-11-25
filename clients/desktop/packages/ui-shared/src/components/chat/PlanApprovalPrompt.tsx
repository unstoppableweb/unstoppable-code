'use client';

import { ControlButton } from '../Button';
import {
  forwardRef,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MapIcon, MessageIcon } from '../../icons/AppIcons';
import { ComposerIconButton } from './ComposerIconButton';
import {
  COMPOSER_PROMPT_BOX_CLASS,
  COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS,
  COMPOSER_PROMPT_ROW_GLYPH_CLASS,
  COMPOSER_PROMPT_ROWS_CLASS,
  COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS,
} from './ComposerPrompt';
import {
  ComposerPromptHeader,
  closeComposerPromptOnEscape,
} from './ComposerPromptHeader';
import { ComposerPromptTextRow } from './ComposerPromptTextRow';
import { PlanCopyAction, type PlanCopyState } from './PlanCopyAction';

/** One answer row of the plan prompt. */
export interface PlanApprovalOption {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

/**
 * Comments on the waiting plan that the agent has not received. The host
 * counts them and sends them; the prompt only warns and offers the action.
 */
export interface PlanApprovalUnsentComments {
  readonly count: number;
  readonly onSend: () => void;
  /** A send is in flight; the action is disabled until it settles. */
  readonly sending?: boolean;
}

const ROW_GLYPH_CLASS = COMPOSER_PROMPT_ROW_GLYPH_CLASS;

/**
 * One numbered answer row of a composer prompt: the plan prompt's answers and
 * the question prompt's options. The caller supplies the circle and label.
 */
export const ComposerPromptRowButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'>
>(function ComposerPromptRowButton(props, ref): JSX.Element {
  return (
    <ControlButton
      ref={ref}
      type="button"
      {...props}
      presentation="plan-approval-start"
    />
  );
});

/**
 * The unsent comments row's circle: the numbers' circle in the warning ink,
 * so the row reads as an answer that needs attention.
 */
const UNSENT_COMMENTS_GLYPH_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-full bg-warning-subtle inset-ring-[length:var(--border-hairline)] inset-ring-line-attention fg-warning';

function unsentCommentsLabel({
  count,
  sending,
}: PlanApprovalUnsentComments): string {
  if (sending === true) return 'Sending…';
  return count === 1
    ? 'Address 1 comment first'
    : `Address ${count} comments first`;
}

/** The composer box while the prompt shows; see {@link COMPOSER_PROMPT_BOX_CLASS}. */
export const PLAN_APPROVAL_BOX_CLASS = COMPOSER_PROMPT_BOX_CLASS;

/** The text row, led by its pen; see {@link COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS}. */
export const PLAN_APPROVAL_TEXT_ROW_CLASS =
  COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS;

/** The text row's editor container; see {@link COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS}. */
export const PLAN_APPROVAL_EDITOR_CONTAINER_CLASS =
  COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS;

/**
 * The composer while the agent waits for its plan to be approved: it asks
 * `Implement this plan?` and offers numbered answers above the text row,
 * where typing tells the agent what to change instead. The host renders the
 * text row (its editor, microphone and send) as `children`, inside
 * {@link PLAN_APPROVAL_TEXT_ROW_CLASS}.
 *
 * Copy plan sits beside Open plan and only copies: it never answers, opens
 * or closes the prompt (CAN-5354).
 *
 * An answer acts as soon as it is clicked. With focus on an answer, 1-9 pick
 * one, the arrow keys move between them, and Escape (anywhere in the prompt)
 * closes it; the plan keeps waiting. A host whose prompt does not close, such
 * as the Feed's, omits `onClose` and with it the close button.
 *
 * With `unsentComments`, one more answer above the text row offers to send
 * comments the agent has not received. Numbers approve and icons give
 * feedback, so it leads with a message icon in the warning ink, beside the
 * text row's pen. Implement stays available; the row warns, not gates.
 *
 * With `revised`, the plan is a revision the agent made after feedback, and
 * the prompt asks `Implement the revised plan?` instead (CAN-5431).
 */
export function PlanApprovalPrompt({
  options,
  revised = false,
  expanded = true,
  onOpenPlan,
  planCopy,
  onClose,
  unsentComments,
  children,
}: {
  readonly options: readonly PlanApprovalOption[];
  /** The waiting plan is revision 2 or later of the tracked plan. */
  readonly revised?: boolean;
  /** Collapse only the controls, retaining the mounted draft editor. */
  readonly expanded?: boolean;
  /** Opens the plan to read; absent until the plan is tracked. */
  readonly onOpenPlan?: () => void;
  /**
   * The waiting plan's Markdown for Copy plan, matched to this proposal by
   * the host; absent, the prompt offers no Copy plan.
   */
  readonly planCopy?: PlanCopyState;
  /** Closes the prompt and keeps the plan waiting; absent when it can't close. */
  readonly onClose?: () => void;
  /** Comments on this plan the agent has not received; absent when none. */
  readonly unsentComments?: PlanApprovalUnsentComments;
  /** The text row. */
  readonly children: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const comments =
    unsentComments && unsentComments.count > 0 ? unsentComments : null;
  // The arrow keys also reach the comments row, after the numbered answers.
  const rowCount = options.length + (comments ? 1 : 0);

  const focusRow = (index: number): void => {
    rowRefs.current[index]?.focus();
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      focusRow((index + step + rowCount) % rowCount);
      return;
    }
    const picked = Number.parseInt(event.key, 10);
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) {
      event.preventDefault();
      const option = options[picked - 1];
      if (option && option.disabled !== true) option.onSelect();
    }
  };

  return (
    <div
      data-testid={expanded ? 'chat-plan-approval' : undefined}
      className={expanded ? 'flex flex-col gap-1' : undefined}
      onKeyDown={(event): void => {
        if (expanded && onClose !== undefined)
          closeComposerPromptOnEscape(event, onClose);
      }}
    >
      {expanded && (
        <>
          <ComposerPromptHeader
            align="center"
            // The composer's own controls in the primary ink: Copy and Open
            // as labeled capsules led by an icon, named for the plan.
            actions={
              (planCopy || onOpenPlan) && (
                <>
                  {planCopy && (
                    <PlanCopyAction
                      state={planCopy}
                      appearance="composer"
                      dataTestId="chat-plan-copy"
                    />
                  )}
                  {onOpenPlan && (
                    <ComposerIconButton
                      capsule
                      autoWidth
                      tone="strong"
                      aria-label="Open plan"
                      onClick={onOpenPlan}
                      data-testid="chat-plan-explore"
                    >
                      <MapIcon size={14} aria-hidden="true" />
                      <span>Open</span>
                    </ComposerIconButton>
                  )}
                </>
              )
            }
            {...(onClose
              ? { close: { onClose, testId: 'chat-plan-approval-close' } }
              : {})}
          >
            <p
              id={titleId}
              className="min-w-0 flex-1 truncate text-s font-medium fg-primary"
            >
              {revised ? 'Implement the revised plan?' : 'Implement this plan?'}
            </p>
          </ComposerPromptHeader>
          <div
            role="group"
            aria-labelledby={titleId}
            className={COMPOSER_PROMPT_ROWS_CLASS}
          >
            {options.map((option, index) => (
              <ComposerPromptRowButton
                key={option.testId}
                ref={(element): void => {
                  rowRefs.current[index] = element;
                }}
                disabled={option.disabled}
                data-testid={option.testId}
                onClick={option.onSelect}
                onKeyDown={(event): void => handleRowKeyDown(event, index)}
              >
                <span aria-hidden className={ROW_GLYPH_CLASS}>
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </ComposerPromptRowButton>
            ))}
            {comments && (
              <ComposerPromptRowButton
                ref={(element): void => {
                  rowRefs.current[options.length] = element;
                }}
                disabled={comments.sending === true}
                data-testid="chat-plan-send-comments"
                onClick={comments.onSend}
                onKeyDown={(event): void =>
                  handleRowKeyDown(event, options.length)
                }
              >
                <span aria-hidden className={UNSENT_COMMENTS_GLYPH_CLASS}>
                  <MessageIcon size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {unsentCommentsLabel(comments)}
                </span>
              </ComposerPromptRowButton>
            )}
          </div>
        </>
      )}
      {/* The note is one more answer: a pen in the numbers' column. */}
      <ComposerPromptTextRow withPen={expanded} plain={!expanded}>
        {children}
      </ComposerPromptTextRow>
    </div>
  );
}
