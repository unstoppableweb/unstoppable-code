import { useEffect, useSyncExternalStore, type JSX } from 'react';
import { WorkspaceFilesList } from '@canopy/ui-app/workspace-files';
import { AttachmentIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatByteSize, formatDate } from '@canopy/ui-shared/lib';
import {
  PanelSection,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import {
  cloudWorkspaceFileList,
  cloudWorkspaceFilesHeader,
  ensureCloudWorkspaceFiles,
  refreshCloudWorkspaceFiles,
  subscribeCloudWorkspaceFileLists,
  type CloudWorkspaceFileList,
} from '@/cloud-chats/cloud-workspace-file-list';
import { webCoreLocalId } from '@/lib/chat-authority';
import type { ActivitySectionRenderProps } from './activity-sections';

/**
 * A cloud project's shared workspace files in the activity rail (CAN-6568),
 * through the web's own list. Desktop lists them only: adding, opening and
 * removing them stay on the web for now.
 */

function useCloudWorkspaceFileList(
  projectId: string,
): CloudWorkspaceFileList | undefined {
  const workspaceId = webCoreLocalId(projectId);
  const list = useSyncExternalStore(subscribeCloudWorkspaceFileLists, () =>
    workspaceId === null ? undefined : cloudWorkspaceFileList(workspaceId),
  );
  useEffect(() => {
    if (workspaceId === null) return;
    ensureCloudWorkspaceFiles(window.canopyCore, workspaceId);
    // A file added on the web, or by an agent, shows when the window is back.
    const visible = (): void => {
      if (document.visibilityState === 'visible')
        void refreshCloudWorkspaceFiles(window.canopyCore, workspaceId);
    };
    document.addEventListener('visibilitychange', visible);
    return (): void =>
      document.removeEventListener('visibilitychange', visible);
  }, [workspaceId]);
  return list;
}

/** The rail's header for the section, read before the section mounts. */
export function useCloudWorkspaceFilesHeaderChrome(projectId: string): {
  readonly subtitle: string | undefined;
  readonly collapsedIconColor: CollapsedIconColor;
  readonly hasContent: boolean;
} {
  return cloudWorkspaceFilesHeader(useCloudWorkspaceFileList(projectId));
}

export function CloudWorkspaceFilesSection({
  projectId,
}: ActivitySectionRenderProps): JSX.Element {
  const list = useCloudWorkspaceFileList(projectId);
  const chrome = useCloudWorkspaceFilesHeaderChrome(projectId);
  const workspaceId = webCoreLocalId(projectId);
  const rows = list?.kind === 'ready' ? list.rows : [];
  return (
    <PanelSection
      icon={<AttachmentIcon />}
      title="Workspace files"
      subtitle={chrome.subtitle}
      collapsedIconColor={chrome.collapsedIconColor}
      hasExpandableContent={rows.length > 0 || list?.kind === 'error'}
    >
      {list?.kind === 'unavailable' ? (
        <p className="text-xs fg-secondary">
          Workspace files aren't available for this project.
        </p>
      ) : (
        <WorkspaceFilesList
          phase={
            list === undefined || list.kind === 'loading'
              ? 'loading'
              : list.kind === 'error'
                ? 'error'
                : 'ready'
          }
          rows={rows.map((row) => ({
            id: row.id,
            name: row.name,
            meta: `${formatByteSize(row.sizeBytes)} · Added ${formatDate(row.createdAt)}`,
          }))}
          onRetry={(): void => {
            if (workspaceId !== null)
              void refreshCloudWorkspaceFiles(window.canopyCore, workspaceId);
          }}
          emptySubtitle="Send an attachment in any chat, or add one on the web."
        />
      )}
    </PanelSection>
  );
}
