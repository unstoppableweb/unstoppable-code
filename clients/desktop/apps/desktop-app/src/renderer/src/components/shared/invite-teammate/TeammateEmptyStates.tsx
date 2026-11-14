import { type JSX, useCallback, useEffect, useState, useRef } from 'react';
import { DoneCheckIcon, MagnifyingGlassIcon } from '@canopy/ui-shared/icons';
import { UserPlus } from '@canopy/ui-shared/icons/AppIcons';
import { Button, EmptyState, ErrorBanner } from '@canopy/ui-shared/components';
import { OrganizationInviteButton } from '@canopy/ui-app/sharing';
import {
  InviteToOrganizationDialog,
  type InviteToOrganizationTarget,
} from '@canopy/ui-app/sharing/InviteToOrganizationDialog';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { desktopPersonalOrganizationUpgradePort } from '@/lib/personal-organization-upgrade-port';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import { openSettingsPathOrWebReported } from '@/lib/navigation/settings-destinations';
import { NO_QUERY_MATCH_PREFIX, NO_QUERY_MATCH_SUFFIX } from './shareCopy';

/**
 * The four reasons there is nobody to invite.
 *
 * These used to be one label - "No teammates available to invite." - covering
 * unrelated situations, which left the owner with a search box over an
 * empty set and no idea which of them they were in.
 *
 * Only the first is colored. It is the one genuinely good outcome: everybody
 * who could be invited already has access. A green check over "you're the only
 * person in this org" would read as a lie, and if all three were green the
 * color would stop meaning anything.
 */

export interface EveryoneHasAccessEmptyStateProps {
  organizationName: string;
}

/**
 * No action: People with access renders directly below, so the list this
 * state used to link to is already on screen.
 */
export function EveryoneHasAccessEmptyState({
  organizationName,
}: EveryoneHasAccessEmptyStateProps): JSX.Element {
  return (
    <div data-testid="shared-container-invite-modal-empty-everyone-has-access">
      <EmptyState
        icon={<DoneCheckIcon size="xl" className="fg-success" />}
        title={`Everyone in ${organizationName} already has access.`}
        subtitle="There is nobody left to invite from this organization."
      />
    </div>
  );
}

export interface OnlyMemberEmptyStateProps {
  organizationId: string;
  organizationName: string;
  /**
   * Runs once the members page opened inside Settings, so the host can close
   * its modal. Not called for the web, where the modal stays open.
   */
  onOpened?: () => void;
}

export function OnlyMemberEmptyState({
  organizationId,
  organizationName,
  onOpened,
}: OnlyMemberEmptyStateProps): JSX.Element {
  const [openFailed, setOpenFailed] = useState(false);
  const [account, setAccount] = useState<CanopyCloudAccountPublicState | null>(
    null,
  );
  const [inviting, setInviting] = useState<{
    accountId: string;
    target: InviteToOrganizationTarget;
  } | null>(null);
  const accountIdentity = useRef<string | undefined>(undefined);
  useEffect(() => setInviting(null), [organizationId]);
  useEffect(() => {
    let current = true;
    let reloadGeneration = 0;
    const reload = (): void => {
      const generation = ++reloadGeneration;
      void window.api
        ?.loadCanopyCloudAccount?.()
        .then((value): void => {
          if (current && generation === reloadGeneration) {
            if (accountIdentity.current !== value.account?.id)
              setInviting(null);
            accountIdentity.current = value.account?.id;
            setAccount(value);
          }
        })
        .catch(() => undefined);
    };
    reload();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    return (): void => {
      current = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    };
  }, []);
  const personal = account?.personalOrganizationId === organizationId;
  const role = personal
    ? 'OWNER'
    : account?.organizations?.find((org) => org.id === organizationId)?.role;
  const canInvite =
    account?.account?.id !== undefined &&
    account.authMode !== 'guest' &&
    (role === 'OWNER' || role === 'ADMIN') &&
    window.api.personalOrganizationUpgrade !== undefined;

  /**
   * Opens the organization members page: inside Settings when hosted settings
   * are openable here, otherwise on the web already signed in, through the
   * existing magic-link bridge.
   *
   * The bridge reports whether a page actually opened, so a failed mint keeps
   * the button and says so rather than stranding the user on a dead click -
   * the same discipline the billing-page handoff uses.
   *
   * Missing role or transport retains the existing management handoff.
   */
  const handleOpenMembers = useCallback((): void => {
    setOpenFailed(false);
    void openSettingsPathOrWebReported(
      settingsRouteToPath({
        scope: 'organization',
        organizationId,
        page: 'members',
      }),
    ).then((opened) => {
      if (opened === 'failed') setOpenFailed(true);
      if (opened === 'settings') onOpened?.();
    });
  }, [organizationId, onOpened]);

  return (
    <div data-testid="shared-container-invite-modal-empty-only-member">
      <EmptyState
        icon={<UserPlus className="h-5 w-5 fg-secondary" />}
        title={`You're the only person in ${organizationName}.`}
        subtitle={`A teammate has to join ${organizationName} before you can share this with them.`}
        action={
          <div className="flex flex-col gap-2">
            <div>
              {/* Invite or Manage members: whichever shows is the one primary. */}
              {canInvite ? (
                <OrganizationInviteButton
                  testId="shared-container-invite-modal-invite-teammate"
                  onClick={() => {
                    if (!account?.account?.id) return;
                    setInviting({
                      accountId: account.account.id,
                      target: personal
                        ? {
                            kind: 'personal',
                            personalOrganizationId: organizationId,
                          }
                        : { kind: 'team', organizationId, organizationName },
                    });
                  }}
                />
              ) : (
                <Button
                  variant="primary"
                  size="compact"
                  data-testid="shared-container-invite-modal-manage-members"
                  onClick={handleOpenMembers}
                >
                  {`Manage members in ${organizationName}`}
                </Button>
              )}
            </div>
            <ErrorBanner
              errorSource="only-member-empty-state-open-failed"
              className=""
              error={openFailed ? 'Could not open that page. Try again.' : null}
            />
          </div>
        }
      />
      {inviting && canInvite && account?.account?.id === inviting.accountId && (
        <InviteToOrganizationDialog
          key={`${inviting.accountId}:${organizationId}`}
          target={inviting.target}
          accountKey={inviting.accountId}
          port={desktopPersonalOrganizationUpgradePort(
            inviting.accountId,
            inviting.target.kind === 'personal',
            true,
          )}
          inviteRequired
          onPromoted={() => {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }}
          onClose={() => setInviting(null)}
        />
      )}
    </div>
  );
}

/**
 * The label for a capped page whose members all already hold a grant.
 *
 * Exported so the picker's `emptyLabel` fallback and the state below cannot
 * drift apart, the same way the `NO_QUERY_MATCH_*` copy binds the no-results pair.
 */
export const CAPPED_PAGE_LABEL = 'Everyone in this list already has access.';

export interface SearchForMoreTeammatesEmptyStateProps {
  organizationName: string;
}

/**
 * Nothing left to select, but the member page came back at the server's
 * ceiling - so this says nothing about the members it did not return.
 *
 * Deliberately not `EveryoneHasAccessEmptyState`: that one is a claim about
 * the whole organization, and one capped page cannot support it. The search
 * box stays alongside this, because typing a name is the only way to reach
 * the members the page left out.
 */
export function SearchForMoreTeammatesEmptyState({
  organizationName,
}: SearchForMoreTeammatesEmptyStateProps): JSX.Element {
  return (
    <div data-testid="shared-container-invite-modal-empty-search-for-more">
      <EmptyState
        icon={<MagnifyingGlassIcon size="xl" className="fg-secondary" />}
        title={CAPPED_PAGE_LABEL}
        subtitle={`${organizationName} has more members than this list shows. Search by name to find someone else.`}
      />
    </div>
  );
}

export interface NoQueryMatchEmptyStateProps {
  query: string;
}

export function NoQueryMatchEmptyState({
  query,
}: NoQueryMatchEmptyStateProps): JSX.Element {
  return (
    <div data-testid="shared-container-invite-modal-empty-no-match">
      <EmptyState
        // The same glyph the search input uses, so this state visibly belongs
        // to the query rather than to the organization.
        icon={<MagnifyingGlassIcon size="xl" className="fg-secondary" />}
        // The echoed query may be a person's name: replay records a box for
        // it, and the rest of the sentence stays recorded.
        title={
          <>
            {NO_QUERY_MATCH_PREFIX}
            <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{query}</span>
            {NO_QUERY_MATCH_SUFFIX}
          </>
        }
        subtitle="Try a different name."
      />
    </div>
  );
}
