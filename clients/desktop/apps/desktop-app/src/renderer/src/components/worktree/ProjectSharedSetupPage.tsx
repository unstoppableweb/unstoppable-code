import { useMemo, useRef, type JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import {
  createDesktopProjectLocalSetup,
  projectLocalSetupKey,
} from '@/lib/projectLocalSetup';
import { ProjectSetupPanel } from '@canopy/ui-app/capability/project-setup/ProjectSetupPanel';

/** Commands in script and hook rows are blocked from session replay. */
const REPLAY_PRIVACY = {
  blockClassName: POSTHOG_REPLAY_BLOCK_CLASS,
  maskClassName: POSTHOG_REPLAY_MASK_CLASS,
} as const;

/**
 * The hosted settings client the shared project setup panel reads and saves
 * through, when this window has one; main answers its entries through the
 * web core as the signed-in account (CAN-6239).
 */
function useProjectSetupClient(): AccountOrganizationSettingsClient | null {
  const client = useOptionalCanopyClient();
  return client?.capabilities.accountOrganizationSettings === true
    ? (client.settings ?? null)
    : null;
}

/**
 * Whether project settings show the Shared setup page: only for a project
 * an organization owns, in a window with the hosted settings client.
 * Personal projects have no shared setup.
 */
export function useShowsProjectSharedSetup(
  owner: WorkspaceOwnerBinding | undefined,
): boolean {
  const client = useProjectSetupClient();
  return client !== null && owner?.type === 'organization';
}

/**
 * The Shared setup page of an organization project's settings. Its scripts
 * and hooks come from this checkout (CAN-6239); opening a local `canopy.json`
 * runs `onClose`, so the file shows.
 */
export function ProjectSharedSetupPage({
  workspace,
  onClose,
}: {
  workspace: SingleRepoSidebarItem | MultiRepoSidebarItem;
  onClose: () => void;
}): JSX.Element | null {
  const client = useProjectSetupClient();
  const latest = useRef(workspace);
  latest.current = workspace;
  const close = useRef(onClose);
  close.current = onClose;
  const key = projectLocalSetupKey(workspace);
  const localSetup = useMemo(
    () =>
      createDesktopProjectLocalSetup(
        () => latest.current,
        () => close.current(),
      ),
    // A new port, and so a new read, only when what it reads changes.
    [key],
  );
  // Organization Agents install only while organization projects are on
  // (CAN-6237, phase 10a), so only then does the panel list them.
  const agentsAndPipelinesEnabled = useCanopyOrgProjectsEnabled();
  const owner = workspace.owner;
  if (client === null || owner?.type !== 'organization') return null;
  return (
    <ProjectSetupPanel
      client={client}
      projectId={owner.projectId}
      localSetup={localSetup}
      privacy={REPLAY_PRIVACY}
      agentsAndPipelinesEnabled={agentsAndPipelinesEnabled}
    />
  );
}
