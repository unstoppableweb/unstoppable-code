import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  PERSONAL_CONNECTOR_SCOPE,
  connectorScopeForOwnership,
  type ConnectorScope,
} from '@canopy/desktop-shared/lib/connector-scope';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { pluginDefaultsWorkspaceId } from './plugin-defaults-revision';
import { subscribeWorkspaceConfigWritten } from './project-plugin-defaults-cache';

/** Where a chat or run's connectors are resolved. */
export interface ConnectorScopeTarget {
  projectId: string;
  worktreeId: string;
}

/**
 * The connector scope of a chat or run (CAN-6231), from its workspace's
 * persisted ownership. Surfaces outside a workspace (App Advisor, the
 * pipeline editor, a standalone chat with no workspace) are Personal, as are
 * plan and review chats, which inherit no defaults
 * (`chatSurfaceUsesGlobalPluginDefaults`). Never throws: an owner that cannot
 * be read is the organization case it cannot rule out
 * (`connectorScopeForOwnership`).
 */
export async function resolveConnectorScope(
  target: ConnectorScopeTarget,
): Promise<ConnectorScope> {
  if (
    target.projectId === APP_ADVISOR_PROJECT_ID ||
    target.projectId === PIPELINE_EDITOR_PROJECT_ID ||
    target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    target.projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    (target.projectId === STANDALONE_CHAT_PROJECT_ID && !target.worktreeId)
  )
    return PERSONAL_CONNECTOR_SCOPE;
  try {
    return connectorScopeForOwnership(
      await readWorkspaceOwnership(pluginDefaultsWorkspaceId(target)),
    );
  } catch {
    return { kind: 'org-workspace' };
  }
}

/**
 * Each workspace's connector scope, read once and kept until the workspace's
 * config is written again, so a turn's plugin resolution reads no file for
 * it (CAN-6237). A read that fails is not kept.
 */
const scopes = new Map<string, Promise<ConnectorScope>>();
let subscribed = false;

/** {@link resolveConnectorScope}, served from memory between config writes. */
export function resolveCachedConnectorScope(
  target: ConnectorScopeTarget,
): Promise<ConnectorScope> {
  if (!subscribed) {
    subscribed = true;
    subscribeWorkspaceConfigWritten((workspaceId) =>
      scopes.delete(workspaceId),
    );
  }
  const workspaceId = pluginDefaultsWorkspaceId(target);
  const cached = scopes.get(workspaceId);
  if (cached) return cached;
  const read = resolveConnectorScope(target);
  scopes.set(workspaceId, read);
  // An unreadable owner is answered but not kept: the next turn reads again.
  void read.then((scope) => {
    if (scope.kind === 'org-workspace' && scope.organizationId === undefined)
      scopes.delete(workspaceId);
  });
  return read;
}
