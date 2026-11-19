import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { registerIpcHandler } from './register';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import { onSidebarItemGroupsChanged } from '../lib/sidebar-item-groups';
import { sendToAllWindows } from '../lib/window-send';
import { scheduleDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';

let stopProjection: (() => void) | undefined;

/** Additive, unmigrated core-owned host IPC; the canonical registry writers stay in place. */
export function registerSidebarItemGroupHandlers(): void {
  stopProjection?.();
  stopProjection = onSidebarItemGroupsChanged((workspaceId) => {
    const scope: SidebarItemGroupScope =
      // Default Bot only: the Portal scope has a dedicated Orchestrator key.
      workspaceId === 'app-advisor'
        ? { appAdvisor: true }
        : { workspaceLocalId: workspaceId };
    sendToAllWindows(IPC_CHANNELS.sidebarItemGroupsChanged, scope);
    scheduleDesktopSessionSnapshotInvalidation();
  });
  registerIpcHandler<[SidebarItemGroupScope], SidebarItemGroup[]>(
    IPC_CHANNELS.sidebarItemGroupsList,
    (_event, scope) => sidebarItemGroupsService.list(scope),
  );
  registerIpcHandler<[unknown], SidebarItemGroup>(
    IPC_CHANNELS.sidebarItemGroupsCreate,
    (_event, request) => sidebarItemGroupsService.create(request),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.sidebarItemGroupsUpdate,
    (_event, request) => sidebarItemGroupsService.update(request),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.sidebarItemGroupsUngroup,
    (_event, request) => sidebarItemGroupsService.ungroup(request),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.sidebarItemGroupsMoveItem,
    (_event, request) => sidebarItemGroupsService.moveItem(request),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.sidebarItemGroupsMoveGroup,
    (_event, request) => sidebarItemGroupsService.moveGroup(request),
  );
}
