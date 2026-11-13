import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { validateId } from '../lib/validation';
import { toAdvisorJson } from './advisor-json';

export const ADVISOR_SHARING_ACTION_TYPES = [
  'agents.import_shared',
  'agents.delete_shared',
  'agents.publish_public_share',
  'agents.revoke_public_share',
  'plan.share',
  'plan.unshare',
  'runs.share',
  'runs.unshare',
] as const;

export type AdvisorSharingAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_SHARING_ACTION_TYPES)[number] }
>;

export function isAdvisorSharingAction(
  action: AppAdvisorAction,
): action is AdvisorSharingAction {
  return ADVISOR_SHARING_ACTION_TYPES.some((type) => type === action.type);
}

export interface ChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** The main owners App Advisor's sharing actions use (CAN-6003). */
export interface AdvisorSharingActionHost {
  /** The organization the window's sidebar scopes to, if one. */
  selectedOrganizationId(): string | undefined;
  /**
   * The organizations the signed-in account belongs to now, read from the
   * account itself, not the organization-projects rollout's projection.
   */
  memberOrganizationIds(): Promise<ReadonlySet<string>>;
  /** Whether the tracked plan is in the named worktree. */
  planExists(
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<boolean>;
  /** Whether the tracked plan carries a share (CAN-5904); false when missing. */
  planShared(
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<boolean>;
  /**
   * The chat's stored tab, `archived` when the chat is only in the
   * worktree's archive, or null when the worktree has no such chat.
   */
  readChat(target: ChatTarget): Promise<{
    kind?: string;
    sharedRun?: SharedRunMetadata;
    archived?: true;
  } | null>;
  importSharedAgent(agentId: string): Promise<unknown>;
  deleteSharedAgent(agentId: string): Promise<void>;
  publishAgentPublicShare(agentId: string): Promise<{
    externalId: string;
    pinnedContentHash: string;
    upToDate: boolean;
    sharePath: string;
    createdAt: string;
    updatedAt: string;
  }>;
  revokeAgentPublicShare(agentId: string): Promise<void>;
  /** Tells an open window the agent's public link changed. */
  announceAgentsChanged(): void;
  /** Asks a person in this chat; only a person's answer confirms. */
  confirmPublicShare(
    agentId: string,
  ): Promise<'confirmed' | 'declined' | 'no_person'>;
  sharePlan(request: {
    projectId: string;
    worktreeId: string;
    planId: string;
    shareScope: 'private' | 'team' | 'organization';
    teamId?: string;
    organizationId?: string;
  }): Promise<
    ShareOperationResult<{
      id: string;
      share?: {
        remoteId?: string;
        syncStatus?: string;
        shareScope?: string;
      };
    } | null>
  >;
  shareRun(
    request: ChatTarget & {
      shareScope: 'team' | 'organization';
      teamId?: string;
      organizationId?: string;
    },
  ): Promise<ShareOperationResult<{ externalId?: string | null }>>;
  /** Stops sharing the plan; the answered plan has no `share`. */
  unsharePlan(request: {
    projectId: string;
    worktreeId: string;
    planId: string;
  }): Promise<ShareOperationResult<{ id: string } | null>>;
  unshareRun(target: ChatTarget): Promise<{ unshared: boolean }>;
  /** core.chat.update chat.patch_tab_settings {sharedRun} on this chat only. */
  setSharedRunMarker(
    target: ChatTarget,
    sharedRun: SharedRunMetadata | null,
  ): Promise<void>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

const ARCHIVED_CHAT_MESSAGE =
  'This chat is archived. Restore it, then share or unshare its run.';

function failure(
  code:
    | 'invalid_target'
    | 'not_found'
    | 'execution_failed'
    | 'surface_unavailable',
  message: string,
  retryable?: boolean,
): Response {
  return {
    ok: false,
    error: { code, message, ...(retryable ? { retryable: true } : {}) },
  };
}

const ORGANIZATION_SHARE_CONTEXT_MESSAGE =
  'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.';

/**
 * The organization a share targets: an explicit id only when the account
 * belongs to it now, otherwise the one the window's sidebar scopes to. A
 * forged or former organization is refused before any hosted call.
 */
export async function resolveOrganization(
  action: { shareScope?: string; organizationId?: string },
  host: Pick<
    AdvisorSharingActionHost,
    'memberOrganizationIds' | 'selectedOrganizationId'
  >,
): Promise<{ organizationId?: string } | { response: Response }> {
  if (action.organizationId !== undefined) {
    if (!(await host.memberOrganizationIds()).has(action.organizationId))
      return {
        response: failure(
          'invalid_target',
          "You aren't a member of that organization.",
        ),
      };
    return { organizationId: action.organizationId };
  }
  if (action.shareScope !== 'organization') return {};
  const selected = host.selectedOrganizationId();
  return selected
    ? { organizationId: selected }
    : {
        response: failure(
          'surface_unavailable',
          ORGANIZATION_SHARE_CONTEXT_MESSAGE,
        ),
      };
}

/** A hosted share's failure, retryable only when nothing was published. */
export function shareFailure(
  result: Extract<ShareOperationResult<unknown>, { ok: false }>,
): Response {
  return failure(
    'execution_failed',
    result.failure.message,
    result.failure.retryable && result.failure.commitState === 'not-committed',
  );
}

async function run(
  action: AdvisorSharingAction,
  host: AdvisorSharingActionHost,
): Promise<Response> {
  switch (action.type) {
    case 'agents.import_shared':
      validateId(action.agentId, 'shared agent id');
      return {
        ok: true,
        result: toAdvisorJson(await host.importSharedAgent(action.agentId)),
      };
    case 'agents.delete_shared':
      validateId(action.agentId, 'shared agent id');
      await host.deleteSharedAgent(action.agentId);
      return { ok: true, result: { agentId: action.agentId } };
    case 'agents.publish_public_share': {
      validateId(action.agentId, 'shared agent id');
      // Anyone with the link can read a public share: only a person's
      // confirmation publishes one.
      const confirmed = await host.confirmPublicShare(action.agentId);
      if (confirmed === 'no_person')
        return failure(
          'surface_unavailable',
          'No person confirmed publishing a public link, so nothing was published.',
        );
      if (confirmed === 'declined')
        return failure(
          'execution_failed',
          'The public link was not published.',
        );
      const publicShare = await host.publishAgentPublicShare(action.agentId);
      host.announceAgentsChanged();
      return {
        ok: true,
        result: {
          agentId: action.agentId,
          publicShare: {
            externalId: publicShare.externalId,
            pinnedContentHash: publicShare.pinnedContentHash,
            upToDate: publicShare.upToDate,
            sharePath: publicShare.sharePath,
            createdAt: publicShare.createdAt,
            updatedAt: publicShare.updatedAt,
          },
        },
      };
    }
    case 'agents.revoke_public_share':
      validateId(action.agentId, 'shared agent id');
      await host.revokeAgentPublicShare(action.agentId);
      host.announceAgentsChanged();
      return { ok: true, result: { agentId: action.agentId } };
    case 'plan.share': {
      const organization = await resolveOrganization(action, host);
      if ('response' in organization) return organization.response;
      // Only a plan in the named worktree, as the window's Share shares.
      if (
        !(await host.planExists(
          action.projectId,
          action.worktreeId,
          action.planId,
        ))
      )
        return failure(
          'not_found',
          `Tracked plan ${action.planId} was not found or could not be shared.`,
        );
      const shared = await host.sharePlan({
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        planId: action.planId,
        shareScope: action.shareScope,
        ...(action.teamId ? { teamId: action.teamId } : {}),
        ...organization,
      });
      if (!shared.ok) return shareFailure(shared);
      const plan = shared.value;
      if (!plan)
        return failure(
          'not_found',
          `Tracked plan ${action.planId} was not found or could not be shared.`,
        );
      return {
        ok: true,
        result: {
          planId: plan.id,
          remoteId: plan.share?.remoteId ?? null,
          syncStatus: plan.share?.syncStatus ?? null,
          shareScope: plan.share?.shareScope ?? null,
        },
      };
    }
    case 'plan.unshare': {
      // Only a plan in the named worktree, as the window's Stop sharing.
      if (
        !(await host.planExists(
          action.projectId,
          action.worktreeId,
          action.planId,
        ))
      )
        return failure(
          'not_found',
          `Tracked plan ${action.planId} was not found.`,
        );
      if (
        !(await host.planShared(
          action.projectId,
          action.worktreeId,
          action.planId,
        ))
      )
        return { ok: true, result: { planId: action.planId, unshared: false } };
      const unshared = await host.unsharePlan({
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        planId: action.planId,
      });
      if (!unshared.ok) return shareFailure(unshared);
      // The plan was removed after the checks above, so nothing was unshared.
      if (unshared.value === null)
        return failure(
          'not_found',
          `Tracked plan ${action.planId} was not found.`,
        );
      return { ok: true, result: { planId: action.planId, unshared: true } };
    }
    case 'runs.share': {
      const organization = await resolveOrganization(action, host);
      if ('response' in organization) return organization.response;
      const target = {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
      };
      // Only a chat of the named worktree, as the window's Share shares.
      const chat = await host.readChat(target);
      if (chat?.archived)
        return failure('invalid_target', ARCHIVED_CHAT_MESSAGE);
      if (!chat || chat.kind === 'file')
        return failure('not_found', `Chat ${action.chatId} was not found.`);
      const shared = await host.shareRun({
        ...target,
        shareScope: action.shareScope,
        ...(action.teamId ? { teamId: action.teamId } : {}),
        ...organization,
      });
      if (!shared.ok) return shareFailure(shared);
      if (!shared.value.externalId)
        return failure(
          'execution_failed',
          `Chat ${action.chatId} could not be shared as a run.`,
        );
      return { ok: true, result: { externalId: shared.value.externalId } };
    }
    case 'runs.unshare': {
      const target = {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
      };
      const chat = await host.readChat(target);
      // Its consent marker is in the archive, which core.chat.update cannot
      // clear; a hosted delete alone would be undone on restore (CAN-6068).
      if (chat?.archived)
        return failure('invalid_target', ARCHIVED_CHAT_MESSAGE);
      if (!chat || chat.kind === 'file')
        return failure('not_found', `Chat ${action.chatId} was not found.`);
      const prior = chat.sharedRun;
      // Clear the consent marker first, so a turn finishing meanwhile cannot
      // share the run again while the hosted grant is deleted.
      await host.setSharedRunMarker(target, null);
      try {
        const result = await host.unshareRun(target);
        return { ok: true, result: { unshared: result.unshared } };
      } catch (error) {
        if (prior) {
          // The run stays shared as it was.
          await host.setSharedRunMarker(target, prior).catch(() => undefined);
        }
        return failure(
          'execution_failed',
          error instanceof Error ? error.message : 'Failed to unshare the run.',
        );
      }
    }
  }
}

/**
 * App Advisor's sharing actions in Electron main (CAN-6003) on the hosted
 * clients the window's handlers use: the organization from the window's
 * sidebar or an explicit current membership; only plans and chats of the
 * named worktree; a public agent link only after a person confirms.
 */
export async function dispatchAdvisorSharingAction(
  action: AdvisorSharingAction,
  host: AdvisorSharingActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return failure(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}
