'use client';

import type { JSX, ReactNode } from 'react';
import { Notice } from '@canopy/ui-shared/components';

/**
 * What a pipeline's Definition says when `count` workflows use it
 * (CAN-5782, CAN-4224 phase 07): nothing for one, the reach of an edit for
 * two or more.
 */
export function sharedPipelineNoticeText(count: number): string | undefined {
  return count >= 2
    ? `Used by ${String(count)} workflows. Changes apply to all of them.`
    : undefined;
}

export interface SharedPipelineNoticeProps {
  /** How many workflows use the pipeline; the host counts them. */
  readonly count: number;
  /**
   * A way out of the shared edit, such as Duplicate, when the host can offer
   * one. Omitted when it can't, or can't yet tell.
   */
  readonly action?: ReactNode;
  /** Why the action can't run now, such as unsaved edits. */
  readonly actionNote?: string;
  /** The host's placement among the editor's other notices. */
  readonly className?: string;
}

/**
 * Says that an edit to a pipeline's steps reaches every workflow that uses
 * it, before the edit (CAN-5782). Renders nothing for a pipeline one
 * workflow uses.
 */
export function SharedPipelineNotice({
  count,
  action,
  actionNote,
  className,
}: SharedPipelineNoticeProps): JSX.Element | null {
  const text = sharedPipelineNoticeText(count);
  if (text === undefined) return null;
  return (
    <Notice
      intent="neutral"
      {...(action !== undefined ? { actions: action } : {})}
      {...(className !== undefined ? { className } : {})}
      data-testid="pipeline-editor-shared-notice"
    >
      {actionNote !== undefined ? `${text} ${actionNote}` : text}
    </Notice>
  );
}
