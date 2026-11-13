import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { isOrgDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import { isWebCoreScope } from './chat-authority';
import { isRegisteredCoworkWorkspaceId } from './cowork-registry';

/**
 * Returns true when `projectId` identifies a cowork chat target — a chat
 * surface that is not tied to a project/worktree sidebar item.
 *
 * This covers the standalone-chat sentinel, real cowork workspace ids
 * tracked by the projects store, and the App Advisor workspace: App Advisor
 * chats are entry-keyed `(app-advisor, <workEntryId>)` targets rendered in
 * the popout window with full cowork panel/archive semantics. App Advisor is
 * matched against `APP_ADVISOR_PROJECT_ID` directly (NOT through
 * `cowork-registry`, which is cleared/rebuilt during `projectsStore`
 * synchronization and never contains the App Advisor pseudo-workspace).
 *
 * It reads the module-level registry in `./cowork-registry` rather than
 * `projectsStore` directly — see that module's doc comment for why (avoiding
 * an import cycle through `chatStore.ts`). `projectsStore.ts` keeps the
 * registry in sync whenever its `projects` state changes, so this stays a
 * plain synchronous `projectId`-only check for the ~35 existing call sites.
 *
 * A web core project is a cloud cowork project (CAN-6175 D2): desktop opens
 * only cowork tasks from the cloud, so its chats are cowork chats too.
 */
export function isCoworkChatTarget(projectId: string): boolean {
  return (
    projectId === STANDALONE_CHAT_PROJECT_ID ||
    projectId === APP_ADVISOR_PROJECT_ID ||
    isOrgDefaultCoworkWorkspaceId(projectId) ||
    isRegisteredCoworkWorkspaceId(projectId) ||
    isWebCoreScope(projectId)
  );
}

/**
 * Pure variant for callers that already have a `projects` (`SidebarItem[]`)
 * list on hand, such as navigation guards that also need other project
 * data. Does not consult the registry or recognize the standalone-chat
 * sentinel — it only reports whether `projectId` matches a real cowork
 * workspace entry in `projects`.
 */
export function isCoworkWorkspaceId(
  projectId: string,
  projects: SidebarItem[],
): boolean {
  return projects.some(
    (project) => project.id === projectId && project.type === 'cowork',
  );
}
