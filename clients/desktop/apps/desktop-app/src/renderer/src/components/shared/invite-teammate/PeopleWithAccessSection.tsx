import { Stack, Divider, Heading } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import type { SharedContainerPublicationState } from '@canopy/desktop-shared/types';
import type {
  SharedContainerGrantSummary,
  SharedContainerType,
} from '@canopy/protocol/shared-containers';
import {
  Button,
  CapabilityPill,
  ConfirmDialog,
  StatusPill,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  INVITED_LABEL,
  JOINED_WITH_LINK_LABEL,
  MEMBER_LOADING_LABEL,
  NO_RECIPIENTS_LABEL,
  PEOPLE_WITH_ACCESS_LABEL,
  REMOVED_BY_RECIPIENT_LABEL,
  RECIPIENTS_ERROR_LABEL,
  RECIPIENTS_PARTIAL_ERROR_LABEL,
  REVOKE_LABEL,
  containerNoun,
} from './shareCopy';
import { SharePublishIssue, SharePublishStatus } from './SharePublishStatus';
import { ShareScopePanel } from './ShareScopePanel';
import type { UseSharePreviewResult } from './useSharePreview';
import type { UseShareRecipientsResult } from './useShareRecipients';

export interface PeopleWithAccessSectionProps {
  containerType: SharedContainerType;
  recipients: UseShareRecipientsResult;
  share: UseSharePreviewResult;
  publicationState: SharedContainerPublicationState | undefined;
  /**
   * A capability link is on. Anyone with it can open the share, so its
   * contents publish even while nobody holds a grant yet.
   */
  linkLive?: boolean;
  /** The scope panel moves here only when the invite picker has no recipient. */
  showScopePanel: boolean;
  /** Freshly invited grant, briefly called out at the top of the list. */
  highlightedGrantId?: string | null;
  /** Locks grant mutations while the parent is committing another mutation. */
  accessActionsDisabled?: boolean;
  /**
   * Rules the section off from the invite form above it. Off when the section
   * is the whole body (managing existing access), where a rule would divide
   * it from nothing.
   */
  separated?: boolean;
}

/**
 * How a recipient reads in the list. Anything created from an email address
 * renders as that address, whether it became an account grant or is still a
 * pending invite, so the owner never learns whether the address has an
 * account.
 */
function grantRecipientLabel(grant: SharedContainerGrantSummary): string {
  return grant.recipient.kind === 'email'
    ? grant.recipient.email
    : grant.recipient.name;
}

/** Test-id suffix: a member's user id, or the grant id of an email row. */
function grantRowKey(grant: SharedContainerGrantSummary): string {
  return grant.recipient.kind === 'member' ? grant.recipient.userId : grant.id;
}

/**
 * The always-visible access section: publish status on its heading, recipient
 * grants, publication issues, the one scope panel when the picker is absent,
 * and revocation.
 */
export function PeopleWithAccessSection({
  containerType,
  recipients,
  share,
  publicationState,
  linkLive = false,
  showScopePanel,
  highlightedGrantId,
  accessActionsDisabled = false,
  separated = true,
}: PeopleWithAccessSectionProps): JSX.Element {
  const noun = containerNoun();
  const recipientsKnownEmpty =
    !recipients.recipientsLoading &&
    !recipients.recipientsError &&
    recipients.recipients.length === 0;
  // Publishing follows the whole audience, people and link alike.
  const audienceKnownEmpty = recipientsKnownEmpty && !linkLive;
  return (
    <section
      className="flex flex-col gap-7"
      data-testid="shared-container-invite-people"
    >
      {/*
        A hairline plus the frame's gap makes this a section of its own
        rather than one more field of the invite form above it.
      */}
      {separated && (
        <Divider
          className=""
          aria-hidden
          data-testid="shared-container-invite-people-divider"
        />
      )}
      <Stack gap="item">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Heading level={3} variant="title">
            {PEOPLE_WITH_ACCESS_LABEL}
          </Heading>
          {recipients.containerId && (
            <SharePublishStatus
              publicationState={publicationState}
              serverRevision={recipients.serverRevision}
              recipientsKnownEmpty={audienceKnownEmpty}
            />
          )}
        </div>
        <Stack
          gap="inline"
          data-testid="shared-container-invite-modal-recipients"
        >
          <SharePublishIssue
            publicationState={publicationState}
            serverRevision={recipients.serverRevision}
            recipientsKnownEmpty={audienceKnownEmpty}
            budgetPush={share.budgetPush}
            onRetry={share.retryPublication}
            retrying={share.fileScopeSaving}
          />
          {recipients.recipientsLoading &&
            recipients.recipients.length === 0 && (
              <p className="text-xs fg-secondary">{MEMBER_LOADING_LABEL}</p>
            )}
          {!recipients.recipientsLoading && recipients.recipientsError && (
            <ErrorBanner
              errorSource="people-with-access-section"
              className=""
              error={
                recipients.recipients.length > 0
                  ? RECIPIENTS_PARTIAL_ERROR_LABEL
                  : RECIPIENTS_ERROR_LABEL
              }
            />
          )}
          {recipientsKnownEmpty && (
            <p className="text-xs fg-secondary">{NO_RECIPIENTS_LABEL}</p>
          )}
          {recipients.recipients.length > 0 && (
            // One compact line per person, no card per row: the list has to
            // stay scannable at ten recipients, not just one. The negative
            // inset keeps the text on the heading's edge while leaving the
            // new-grant highlight room to breathe.
            <ul className="-mx-2">
              {recipients.recipients.map((grant) => (
                <li
                  key={grant.id}
                  className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 transition-colors duration-200 ${
                    highlightedGrantId === grant.id ? 'bg-success-subtle' : ''
                  }`}
                  data-testid={`shared-container-invite-modal-recipient-${grantRowKey(grant)}`}
                >
                  {/* A person's name or email: replay records a same-size box. */}
                  <span
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-w-0 truncate text-s fg-primary`}
                  >
                    {grantRecipientLabel(grant)}
                  </span>
                  {/*
                  One pill per capability, rendered from the server's array and
                  never a hard-coded viewer label, so a container that grows a
                  capability beyond VIEW still renders without a code change.
                */}
                  <span className="flex shrink-0 items-center gap-1">
                    {grant.recipient.kind === 'email' && (
                      <StatusPill
                        data-testid={`shared-container-invite-modal-invited-${grant.id}`}
                      >
                        {INVITED_LABEL}
                      </StatusPill>
                    )}
                    {grant.via === 'link' && (
                      <StatusPill
                        data-testid={`shared-container-invite-modal-joined-with-link-${grantRowKey(grant)}`}
                      >
                        {JOINED_WITH_LINK_LABEL}
                      </StatusPill>
                    )}
                    {grant.dismissedAt !== undefined ? (
                      // The recipient removed the share and may still restore
                      // it. The row is revoke-only: its capabilities are a
                      // snapshot of the removed grant, not live access.
                      <StatusPill
                        data-testid={`shared-container-invite-modal-removed-by-recipient-${grantRowKey(grant)}`}
                      >
                        {REMOVED_BY_RECIPIENT_LABEL}
                      </StatusPill>
                    ) : (
                      grant.capabilities.map((capability) => (
                        <CapabilityPill
                          key={capability}
                          capability={capability}
                        />
                      ))
                    )}
                  </span>
                  <Button
                    variant="ghost-destructive"
                    size="compact"
                    className="ml-auto"
                    disabled={
                      accessActionsDisabled || recipients.revokingId !== null
                    }
                    data-testid={`shared-container-invite-modal-revoke-${grantRowKey(grant)}`}
                    onClick={() => recipients.requestRevoke(grant)}
                  >
                    {REVOKE_LABEL}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {/*
        What those recipients can actually see. It moves here from the invite
        content when the picker has no recipient, but only once somebody holds
        a grant. With an empty list there
        is no share for it to describe, and the panel would be describing a
        hypothetical over "Nobody has access yet."
      */}
          {showScopePanel && recipients.recipients.length > 0 && (
            <ShareScopePanel containerType={containerType} share={share} />
          )}
          {recipients.pendingRevokeGrant && (
            <ConfirmDialog
              dataTestId="shared-container-invite-modal-revoke-confirmation"
              title={
                <>
                  Remove access for{' '}
                  <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                    {grantRecipientLabel(recipients.pendingRevokeGrant)}
                  </span>
                  ?
                </>
              }
              message={`They will immediately lose access to this ${noun}.`}
              confirmLabel="Remove access"
              destructive
              confirmDisabled={accessActionsDisabled}
              onCancel={recipients.cancelRevoke}
              onConfirm={recipients.confirmRevoke}
            />
          )}
        </Stack>
      </Stack>
    </section>
  );
}
