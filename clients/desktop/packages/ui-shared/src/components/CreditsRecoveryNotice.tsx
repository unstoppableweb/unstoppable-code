'use client';

import type { JSX, ReactNode } from 'react';
import {
  CONTACT_ORG_ADMIN_COPY,
  MESSAGE_QUEUED_TITLE,
  CREDIT_HELD_MESSAGE_WARNING_COPY,
} from './creditsRecoveryCopy';
import { Notice, NoticeButton, type NoticeProps } from './Notice';
import { AI_CREDITS_PURCHASE_LABEL } from './aiCreditsPurchaseCopy';

type RecoveryNoticeProps<Props> = Props extends unknown
  ? Omit<Props, 'detail' | 'children'>
  : never;

export type CreditsRecoveryNoticeProps = RecoveryNoticeProps<NoticeProps> & {
  readonly detail?: never;
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
  /** Supporting lines under the message, one per line, in this order. */
  readonly detailLines?: readonly ReactNode[];
  /** Close the detail with the line telling an org member to ask an admin. */
  readonly contactAdmin?: boolean;
  readonly contactAdminTestId?: string;
  readonly 'data-testid'?: string;
};

/**
 * CAN-4764 — the in-chat out-of-credits recovery notice, shared by the desktop
 * no-billing-source banner and the web cloud credit recovery notice. Purely
 * presentational: the host decides whether it shows, which copy applies, and
 * what the actions do.
 */
export function CreditsRecoveryNotice({
  queued = false,
  connectAction,
  onBuyCredits,
  actions,
  detailLines = [],
  contactAdmin = false,
  contactAdminTestId,
  children,
  ...props
}: CreditsRecoveryNoticeProps): JSX.Element {
  const hasDetail = detailLines.length > 0 || contactAdmin;
  return (
    <Notice
      {...props}
      title={queued ? MESSAGE_QUEUED_TITLE : props.title}
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
      {...(hasDetail
        ? {
            detail: (
              <>
                {detailLines.map((line, index) => (
                  // A host may drop a line between renders, shifting the
                  // others' indexes. Lines are stateless display content, so
                  // an index key only re-renders them.
                  <span key={index} className="block">
                    {line}
                  </span>
                ))}
                {contactAdmin ? (
                  <span className="block" data-testid={contactAdminTestId}>
                    {CONTACT_ORG_ADMIN_COPY}
                  </span>
                ) : null}
              </>
            ),
          }
        : {})}
    >
      {queued ? CREDIT_HELD_MESSAGE_WARNING_COPY : children}
    </Notice>
  );
}
