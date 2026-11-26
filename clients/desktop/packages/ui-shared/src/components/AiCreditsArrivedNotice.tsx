'use client';

import type { JSX } from 'react';
import {
  AI_CREDITS_ARRIVAL_COPY,
  aiCreditsArrivalTitle,
  type AiCreditsArrivalEvidence,
} from './aiCreditsArrival';
import { Notice, type NoticeProps } from '../primitives/Notice';

export interface AiCreditsArrivedNoticeProps
  extends
    Omit<NoticeProps, 'title' | 'intent' | 'role'>,
    AiCreditsArrivalEvidence {
  readonly 'data-testid'?: string;
}

/**
 * The positive confirmation that replaces the usage-limit warning once
 * credits bought from it are available (CAN-5160). The host keeps its
 * continuation sentence, detail, and actions; only the title and treatment
 * change. One polite status region carries the confirmation.
 */
export function AiCreditsArrivedNotice({
  addedCredits,
  balanceCredits,
  dismissLabel = AI_CREDITS_ARRIVAL_COPY.dismiss,
  children,
  ...props
}: AiCreditsArrivedNoticeProps): JSX.Element {
  return (
    <Notice
      {...props}
      intent="positive"
      role="status"
      liveRegionScope="content"
      dismissLabel={dismissLabel}
      title={aiCreditsArrivalTitle({ addedCredits, balanceCredits })}
    >
      {children}
    </Notice>
  );
}
