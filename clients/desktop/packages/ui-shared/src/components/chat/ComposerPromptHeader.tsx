'use client';

import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { ChevronLeftMediumIcon, CloseLargeIcon } from '../../icons/AppIcons';
import { ComposerIconButton } from './ComposerIconButton';
import {
  COMPOSER_PROMPT_HEADER_CLASS,
  COMPOSER_PROMPT_HEADER_WITH_GLYPH_CLASS,
} from './ComposerPrompt';
import { QuestionProgress } from './QuestionProgress';

export interface ComposerPromptHeaderProps {
  /**
   * The title block, with its own id for the prompt's `aria-labelledby`.
   * Prompts differ in what it holds (a question, a plan title, a title and
   * the agent's reason), so the caller lays it out.
   */
  readonly children: ReactNode;
  /** `center` for a one-line title; `start` keeps x on a wrapped title's first line. */
  readonly align?: 'start' | 'center';
  /** A Back circle in the numbers' column; the title then starts where answers' labels do. */
  readonly back?: {
    readonly label: string;
    readonly onBack: () => void;
    readonly disabled?: boolean;
    readonly testId: string;
  };
  /** Dots after the title when there is more than one step. */
  readonly progress?: { readonly step: number; readonly count: number };
  /** Header controls before x, in the composer's own button styles. */
  readonly actions?: ReactNode;
  readonly close?: { readonly onClose: () => void; readonly testId: string };
}

/**
 * The title row every composer prompt shares: optional Back, the title,
 * progress dots, extra actions, and x in send's column (see `ComposerPrompt`).
 */
export function ComposerPromptHeader({
  children,
  align = 'start',
  back,
  progress,
  actions,
  close,
}: ComposerPromptHeaderProps): JSX.Element {
  const rowClass = back
    ? COMPOSER_PROMPT_HEADER_WITH_GLYPH_CLASS
    : COMPOSER_PROMPT_HEADER_CLASS;
  const dots =
    progress !== undefined && progress.count > 1 ? progress : undefined;
  // An empty group would still take a gap from the title.
  const hasActions =
    actions !== undefined && actions !== null && actions !== false;
  const hasControls = dots !== undefined || hasActions || close !== undefined;
  return (
    <div
      className={`${rowClass} ${align === 'center' ? 'items-center' : 'items-start'}`}
    >
      {back && (
        <ComposerIconButton
          capsule
          tone="strong"
          aria-label={back.label}
          onClick={back.onBack}
          disabled={back.disabled}
          data-testid={back.testId}
        >
          <ChevronLeftMediumIcon size={16} />
        </ComposerIconButton>
      )}
      {children}
      {hasControls && (
        <div className="flex shrink-0 items-center gap-2">
          {dots && (
            <QuestionProgress
              count={dots.count}
              step={dots.step}
              density="compact"
            />
          )}
          {actions}
          {close && (
            <ComposerIconButton
              capsule
              tone="strong"
              aria-label="Close"
              onClick={close.onClose}
              data-testid={close.testId}
            >
              <CloseLargeIcon size={16} />
            </ComposerIconButton>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Closes a prompt on Escape from inside it. Escape from a portaled overlay
 * (a menu or dialog the prompt opened) belongs to that overlay: React still
 * bubbles its events here, but its DOM node sits outside the prompt.
 */
export function closeComposerPromptOnEscape(
  event: KeyboardEvent<HTMLElement>,
  onClose: () => void,
): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // The window's own `Node`, so a popped-out window's nodes match.
  const view = event.currentTarget.ownerDocument.defaultView;
  if (
    view !== null &&
    event.target instanceof view.Node &&
    !event.currentTarget.contains(event.target)
  )
    return;
  event.preventDefault();
  onClose();
}
