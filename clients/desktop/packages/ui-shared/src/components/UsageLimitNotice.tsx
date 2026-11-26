import type { JSX } from 'react';
import { TimeslotIcon } from '../icons/AppIcons';
import { Notice, type NoticeProps } from '../primitives/Notice';

export interface UsageLimitNoticeProps extends Omit<
  NoticeProps,
  'title' | 'intent'
> {
  readonly provider: 'claude' | 'codex';
  readonly 'data-testid'?: string;
  /**
   * A credits purchase is open in the browser (CAN-5160). The step replaces
   * the limit the user already acted on, in the neutral checkout treatment
   * every purchase path shares; only a failed check is a warning again. The
   * same element stays mounted, so the host's purchase controls keep their
   * state.
   */
  readonly purchaseStep?: { readonly title: string; readonly failed: boolean };
}

/**
 * Shared provider-limit presentation. Hosts supply their available recovery
 * actions and detail; billing, scheduling and dismissal state stay with them.
 */
export function UsageLimitNotice({
  provider,
  children,
  dismissLabel = 'Dismiss usage limit notice',
  purchaseStep,
  ...props
}: UsageLimitNoticeProps): JSX.Element {
  const title = `${provider === 'codex' ? 'Codex' : 'Claude'} usage limit reached`;
  const waiting = purchaseStep !== undefined && !purchaseStep.failed;
  return (
    <Notice
      {...props}
      intent={waiting ? 'neutral' : 'attention'}
      {...(waiting
        ? { icon: <TimeslotIcon size={16} aria-hidden="true" /> }
        : {})}
      title={purchaseStep?.title ?? title}
      dismissLabel={dismissLabel}
    >
      {children}
    </Notice>
  );
}
