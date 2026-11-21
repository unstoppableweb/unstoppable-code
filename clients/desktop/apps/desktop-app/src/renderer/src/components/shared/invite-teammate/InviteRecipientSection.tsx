import { type JSX, useEffect, useRef } from 'react';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import type { SharedContainerMemberSummary } from '@canopy/protocol/shared-containers';
import type { SharedContainerInviteAudience } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  EmailRecipientInput,
  Notice,
  SharedTargetPicker,
  isEmailRecipientValid,
} from '@canopy/ui-shared/components';
import {
  EMAIL_ALREADY_INVITED_LABEL,
  EMAIL_DESCRIPTION,
  EMAIL_LABEL,
  MEMBER_LOADING_LABEL,
  MEMBER_SEARCH_PLACEHOLDER,
  noQueryMatchLabel,
} from './shareCopy';
import { ShareScopePanel } from './ShareScopePanel';
import {
  CAPPED_PAGE_LABEL,
  EveryoneHasAccessEmptyState,
  NoQueryMatchEmptyState,
  OnlyMemberEmptyState,
  SearchForMoreTeammatesEmptyState,
} from './TeammateEmptyStates';
import type { UseSharePreviewResult } from './useSharePreview';
import type { UseShareMembersResult } from './useShareMembers';

/** The Public audience's single-address field. */
export interface InviteRecipientEmail {
  value: string;
  onChange: (next: string) => void;
  /** Lower-cased addresses that already hold an invite or grant. */
  existing: Set<string>;
  /**
   * Shown for an organization-owned share: people outside the organization
   * will be able to view it. Absent for a personal share.
   */
  externalNotice?: string;
}

/** What the member list on screen proves, and what the section shows for it. */
export interface MemberPickerState {
  everyoneHasAccess: boolean;
  onlyMember: boolean;
  noQueryMatch: boolean;
  cappedPageExhausted: boolean;
  /**
   * The search box is hidden: nobody is left to invite. The scope panel then
   * moves to People with access, which is the only place it still describes
   * a real share.
   */
  hideSearch: boolean;
  trimmedQuery: string;
}

/**
 * Derives the member picker's empty states from the member search.
 *
 * Exported so the modal can decide where the one `ShareScopePanel` renders
 * without re-deriving the rule it depends on.
 */
export function memberPickerState(
  members: UseShareMembersResult,
  eligible: boolean,
): MemberPickerState {
  const trimmedQuery = members.memberQuery.trim();
  const settled =
    eligible &&
    members.membersResolved &&
    !members.membersLoading &&
    !members.membersError;
  const noSelectable = members.selectableMembers.length === 0;

  /**
   * Whether the unfiltered member list on screen is provably the entire
   * organization.
   *
   * Two things have to hold. The search has to have settled - an unresolved
   * (or skipped) fetch is not evidence that the organization is empty, and
   * rendering an empty label over it was the original dead end. And the page
   * has to have come back under the server's ceiling: a capped page says
   * nothing about the members it did not return, so an organization larger
   * than one page would otherwise be described by its alphabetically-first
   * slice.
   */
  const pageIsWholeOrganization =
    settled && !members.membersTruncated && trimmedQuery === '';

  // Both of these are claims about every member of the organization, so
  // neither may be made from a page that is only part of it.
  const everyoneHasAccess =
    pageIsWholeOrganization && noSelectable && members.members.length > 0;
  // An empty page cannot have been capped, so the guard above is redundant
  // here - it is kept so both claims visibly rest on the same evidence.
  const onlyMember = pageIsWholeOrganization && members.members.length === 0;
  const noQueryMatch = settled && noSelectable && trimmedQuery !== '';
  /**
   * Nothing selectable on a capped page, with no query to blame. The picker
   * stays, and says why: searching by name is how the owner reaches the
   * members this page left out.
   */
  const cappedPageExhausted =
    settled && noSelectable && trimmedQuery === '' && members.membersTruncated;

  return {
    everyoneHasAccess,
    onlyMember,
    noQueryMatch,
    cappedPageExhausted,
    // The search box is hidden only for the two states a query genuinely
    // cannot change, and only once the page above is known to be the whole
    // organization. A search input over an empty set is what made this screen
    // useless; removing it while members remain unlisted is worse.
    hideSearch: everyoneHasAccess || onlyMember,
    trimmedQuery,
  };
}

export interface RecipientReadiness {
  /** The frame's Share button can send this recipient. */
  canSubmit: boolean;
  emailAlreadyInvited: boolean;
}

/** Whether the picked member, or the typed address, can be invited now. */
export function recipientReadiness(
  audience: SharedContainerInviteAudience,
  email: Pick<InviteRecipientEmail, 'value' | 'existing'>,
  selectedMember: SharedContainerMemberSummary | null,
): RecipientReadiness {
  if (audience !== 'public') {
    return { canSubmit: selectedMember !== null, emailAlreadyInvited: false };
  }
  const emailValid = isEmailRecipientValid(email.value);
  const emailAlreadyInvited =
    emailValid && email.existing.has(email.value.trim().toLowerCase());
  return { canSubmit: emailValid && !emailAlreadyInvited, emailAlreadyInvited };
}

export interface InviteRecipientSectionProps {
  /** Team and Organization pick members; Public takes an email address. */
  audience: SharedContainerInviteAudience;
  email: InviteRecipientEmail;
  organizationId: string;
  organizationName: string;
  containerType: SharedContainerType;
  /**
   * Whether eligibility has actually resolved to "yes". While it is
   * unresolved - or resolved to a refusal - the member area renders nothing at
   * all. The member fetch is skipped in those cases, so a picker here would
   * show either a permanent spinner or, as it originally did, a false
   * "nobody to invite" over a list that was never requested.
   */
  eligible: boolean;
  members: UseShareMembersResult;
  pickerState: MemberPickerState;
  readiness: RecipientReadiness;
  share: UseSharePreviewResult;
  isBusy: boolean;
  /** The one scope panel lives here while another recipient can be picked. */
  showScopePanel: boolean;
  /**
   * Bumped after each successful invite: the cleared recipient field takes
   * focus again, so the next invite needs no extra click.
   */
  focusToken: number;
  onQueryChange: (query: string) => void;
  onSelectMember: (member: SharedContainerMemberSummary | null) => void;
  /** Enter in the email field sends, like the frame's Share button. */
  onSubmit: () => void;
  /** Closes the modal once a page opened inside Settings. */
  onClose?: () => void;
}

/**
 * The container share dialog's content slot: pick a teammate or type an
 * address, and see in one line what leaves this machine. The frame's footer
 * sends it.
 *
 * The information architecture is the point. Wherever there is somebody to
 * invite, one summary sentence is visible; the explanation, the withheld
 * notices, and the approval controls live behind a collapsed `Details`
 * expander. Anything that would *prevent* publishing stays out here where it
 * cannot be missed.
 */
export function InviteRecipientSection({
  audience,
  email,
  organizationId,
  organizationName,
  containerType,
  eligible,
  members,
  pickerState,
  readiness,
  share,
  isBusy,
  showScopePanel,
  focusToken,
  onQueryChange,
  onSelectMember,
  onSubmit,
  onClose,
}: InviteRecipientSectionProps): JSX.Element {
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const byEmail = audience === 'public';
  const {
    everyoneHasAccess,
    noQueryMatch,
    cappedPageExhausted,
    hideSearch,
    trimmedQuery,
  } = pickerState;

  useEffect(() => {
    if (focusToken === 0) return;
    fieldRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focusToken]);

  return (
    <>
      {!eligible ? null : byEmail ? (
        <div
          ref={fieldRef}
          className="flex flex-col gap-3"
          data-testid="shared-container-invite-modal-email"
        >
          <EmailRecipientInput
            label={EMAIL_LABEL}
            description={EMAIL_DESCRIPTION}
            value={email.value}
            onChange={email.onChange}
            onSubmit={readiness.canSubmit && !isBusy ? onSubmit : undefined}
            {...(readiness.emailAlreadyInvited
              ? { helperText: EMAIL_ALREADY_INVITED_LABEL }
              : {})}
            disabled={isBusy}
            dataTestId="shared-container-invite-modal-email-input"
          />
          {email.externalNotice && (
            <Notice
              intent="attention"
              data-testid="shared-container-invite-modal-external-notice"
            >
              {email.externalNotice}
            </Notice>
          )}
        </div>
      ) : hideSearch ? (
        everyoneHasAccess ? (
          <EveryoneHasAccessEmptyState organizationName={organizationName} />
        ) : (
          <OnlyMemberEmptyState
            organizationId={organizationId}
            organizationName={organizationName}
            {...(onClose ? { onOpened: onClose } : {})}
          />
        )
      ) : (
        <div ref={fieldRef}>
          <SharedTargetPicker<SharedContainerMemberSummary>
            searchValue={members.memberQuery}
            onSearchChange={onQueryChange}
            placeholder={MEMBER_SEARCH_PLACEHOLDER}
            loadingLabel={MEMBER_LOADING_LABEL}
            emptyLabel={
              noQueryMatch
                ? noQueryMatchLabel(trimmedQuery)
                : cappedPageExhausted
                  ? CAPPED_PAGE_LABEL
                  : MEMBER_LOADING_LABEL
            }
            emptyContent={
              noQueryMatch ? (
                <NoQueryMatchEmptyState query={trimmedQuery} />
              ) : cappedPageExhausted ? (
                <SearchForMoreTeammatesEmptyState
                  organizationName={organizationName}
                />
              ) : undefined
            }
            loading={members.membersLoading || !members.membersResolved}
            error={members.membersError}
            disabled={isBusy}
            items={members.selectableMembers}
            getKey={(member) => member.userId}
            isSelected={(member) =>
              member.userId === members.selectedMember?.userId
            }
            onSelect={onSelectMember}
            listLabel="Teammates"
            renderRow={(member) => (
              // A teammate's name: replay records a same-size box. The row
              // button around it stays recorded so its click is too.
              <span
                className={`${POSTHOG_REPLAY_BLOCK_CLASS} block truncate text-s fg-primary`}
              >
                {member.name}
              </span>
            )}
            getAvatarLabel={(member) => member.name}
            dataTestId="shared-container-invite-modal-member-picker"
          />
        </div>
      )}

      {/*
        The scope panel answers "what am I about to share?". Over the two
        empty states there is nobody to share it with, so the answer is noise
        on a screen whose whole job is to read as a dead end - People with
        access carries it instead once somebody holds a grant. It stays here
        for the capped-page and no-match states, where typing a name still
        reaches somebody invitable.
      */}
      {eligible && showScopePanel && (
        <ShareScopePanel containerType={containerType} share={share} />
      )}
    </>
  );
}
