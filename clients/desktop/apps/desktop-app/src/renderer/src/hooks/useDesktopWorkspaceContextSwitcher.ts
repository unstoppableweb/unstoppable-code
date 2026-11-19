import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  contextKeysWithUpdates,
  sidebarContextSwitcherAvailable,
} from '@canopy/ui-app';
import type {
  CanopyCloudAccountPublicState,
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
import { usePendingSharedContainerInvitationsByContext } from '@/components/shared-containers/usePendingSharedContainerInvitationsByContext';
import { useForeignActivityProjection } from '@/hooks/useForeignActivityProjection';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { isGuestAccount } from '@/hooks/useIsGuestCredential';
import { useGitHubStore } from '@/stores/githubStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface DesktopWorkspaceContextSwitcher {
  /**
   * The org-projects flag is on and the account is signed in, not a guest
   * (`sidebarContextSwitcherAvailable`), with or without organizations.
   */
  readonly available: boolean;
  /** The last conclusive Cloud account read, or `null` before the first. */
  readonly account: CanopyCloudAccountPublicState | null;
  /** Signed in with a known account; a guest's device token is not. */
  readonly authenticated: boolean;
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  /** The current organization, or `null` in Personal. */
  readonly currentOrganization: WorkspaceContextOrganization | null;
  /** A switch is in flight. */
  readonly switching: boolean;
  /** Contexts with work left running, unread, or interrupted (CAN-2959). */
  readonly contextsWithUpdates: ReadonlySet<string>;
  /**
   * Pending share invitations per home context (CAN-4783), keyed like
   * {@link contextsWithUpdates}. The switcher shows only other listed contexts.
   */
  readonly pendingSharesByContext: ReadonlyMap<string, number>;
  readonly select: (context: WorkspaceContext) => void;
}

export interface DesktopWorkspaceContextAvailability {
  readonly account: CanopyCloudAccountPublicState | null;
  readonly orgProjectsEnabled: boolean;
  readonly authenticated: boolean;
  readonly available: boolean;
}

/** Account availability without subscribing the sidebar shell to activity. */
export function useDesktopWorkspaceContextAvailability(): DesktopWorkspaceContextAvailability {
  const orgProjectsEnabled = useCanopyOrgProjectsEnabled();
  const { account } = useCanopyCloudAccountState();
  const authenticated = account?.account != null && !isGuestAccount(account);
  return {
    account,
    orgProjectsEnabled,
    authenticated,
    available: sidebarContextSwitcherAvailable({
      orgProjectsEnabled,
      authenticated,
    }),
  };
}

/**
 * Desktop's Personal/organization scope state (CAN-2953), wired to the
 * workspace-context store. Main owns the switch; the store round-trips
 * through IPC. Drives the sidebar's top context switcher
 * (`DesktopSidebarContextSwitcher`).
 */
export function useDesktopWorkspaceContextSwitcher({
  account,
  orgProjectsEnabled,
  authenticated,
  available,
}: DesktopWorkspaceContextAvailability): DesktopWorkspaceContextSwitcher {
  const addToast = useGitHubStore((state) => state.addToast);
  const foreignActivity = useForeignActivityProjection(orgProjectsEnabled);
  const workspaceContext = useWorkspaceContextStore(
    useShallow((store) => ({
      context: store.state.context,
      organizations: store.state.organizations,
    })),
  );
  const setWorkspaceContext = useWorkspaceContextStore(
    (state) => state.setContext,
  );
  const [switching, setSwitching] = useState(false);
  // CAN-2959: activity left running, unread, or interrupted in another
  // context is flagged by a blue dot on that context in the picker's menu,
  // and on its trigger so the user knows to look. The shared rule (running,
  // unread, or interrupted) is the one the web portal applies to its own
  // carryover. Keyed `personal` or by organization id.
  const contextsWithUpdates = useMemo(
    () => contextKeysWithUpdates(foreignActivity),
    [foreignActivity],
  );
  // CAN-4783: an invitation waiting in another context gets the same dot,
  // with its count in the accessible names.
  const pendingSharesByContext =
    usePendingSharedContainerInvitationsByContext();
  const { context, organizations } = workspaceContext;
  return {
    available,
    account,
    authenticated,
    context,
    organizations,
    currentOrganization:
      context.kind === 'organization'
        ? (organizations.find(
            (organization) => organization.id === context.organizationId,
          ) ?? null)
        : null,
    switching,
    contextsWithUpdates,
    pendingSharesByContext,
    select: (next: WorkspaceContext): void => {
      setSwitching(true);
      void setWorkspaceContext(next)
        .catch((error: unknown) => {
          addToast("Couldn't switch context. Try again.", 'error', undefined, {
            caught: error,
          });
        })
        .finally(() => setSwitching(false));
    },
  };
}
