'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import {
  AI_CREDITS_PURCHASE_LABEL,
  CONTACT_ORG_ADMIN_COPY,
  MESSAGE_QUEUED_TITLE,
  CREDIT_HELD_MESSAGE_WARNING_COPY,
} from './creditsPromptCopy';
import { Notice, NoticeButton, type NoticeProps } from '../primitives/Notice';
import { outOfAiCreditsCopy } from './creditsPromptCopy';

type RecoveryNoticeProps<Props> = Props extends unknown
  ? Omit<Props, 'children'>
  : never;

export type CreditsRecoveryNoticeProps = RecoveryNoticeProps<NoticeProps> & {
  readonly children?: ReactNode;
  /** Omitted when the host cannot connect the provider. */
  readonly connectAction?: {
    readonly onConnect: () => void;
    readonly label: string;
    readonly variant?: 'primary' | 'secondary';
    readonly testId?: string;
  };
  /** Opens the host's owner-scoped credit purchase flow. */
  readonly onBuyCredits?: () => void;
  /** The saved credit-held prompt occupies the same recovery surface on every host. */
  readonly queued?: boolean;
  /** Billing refusal uses the same approved recovery card on every host. */
  readonly outOfCredits?: boolean;
  readonly orgPoolUnavailable?: boolean;
  readonly canConnectClaude?: boolean;
  /**
   * Supporting sentences after the message, in this order. They run on in
   * the same paragraph rather than starting lines of their own.
   */
  readonly detailLines?: readonly ReactNode[];
  /**
   * Follow the message with the sentence telling an org member to ask an
   * admin, ahead of `detailLines`, so an alternative there reads as one to
   * asking.
   */
  readonly contactAdmin?: boolean;
  readonly contactAdminTestId?: string;
  readonly 'data-testid'?: string;
};

/** Whether a sentence renders anything, so no stray space joins it. */
function rendersContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/**
 * CAN-4764 — the in-chat out-of-credits recovery notice, shared by the desktop
 * no-billing-source banner and the web cloud credit recovery notice. Purely
 * presentational: the host decides whether it shows, which copy applies, and
 * what the actions do.
 *
 * Everything after the title reads as one paragraph: the message, the
 * contact-admin sentence, then the detail sentences, wrapping together with
 * no line of their own. A changing status goes in `detail`, on its own line.
 */
export function CreditsRecoveryNotice({
  queued = false,
  outOfCredits = false,
  orgPoolUnavailable = false,
  connectAction,
  canConnectClaude = connectAction !== undefined,
  onBuyCredits,
  actions,
  detailLines = [],
  contactAdmin = false,
  contactAdminTestId,
  children,
  ...props
}: CreditsRecoveryNoticeProps): JSX.Element {
  const recovery = outOfCredits
    ? outOfAiCreditsCopy(canConnectClaude, orgPoolUnavailable)
    : null;
  const message =
    recovery?.message ?? (queued ? CREDIT_HELD_MESSAGE_WARNING_COPY : children);
  const sentences = [
    message,
    ...(contactAdmin && !outOfCredits
      ? [
          <span key="contact-admin" data-testid={contactAdminTestId}>
            {CONTACT_ORG_ADMIN_COPY}
          </span>,
        ]
      : []),
    ...detailLines,
  ].filter(rendersContent);
  return (
    <Notice
      {...props}
      title={recovery?.title ?? (queued ? MESSAGE_QUEUED_TITLE : props.title)}
      actions={
        connectAction || onBuyCredits || actions ? (
          <>
            {connectAction?.onConnect && (
              <NoticeButton
                variant={connectAction.variant ?? 'primary'}
                onClick={connectAction.onConnect}
                data-testid={connectAction.testId}
              >
                {connectAction.label}
              </NoticeButton>
            )}
            {onBuyCredits && (
              <NoticeButton
                variant={connectAction ? 'secondary' : 'primary'}
                onClick={onBuyCredits}
              >
                {AI_CREDITS_PURCHASE_LABEL}
              </NoticeButton>
            )}
            {actions}
          </>
        ) : undefined
      }
    >
      {sentences.map((sentence, index) => (
        // A host may drop a sentence between renders, shifting the others'
        // indexes. Sentences are stateless display content, so an index key
        // only re-renders them.
        <Fragment key={index}>
          {index > 0 && ' '}
          {sentence}
        </Fragment>
      ))}
    </Notice>
  );
}
