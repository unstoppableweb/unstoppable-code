import { useMemo } from 'react';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  PERSONAL_WORKSPACE_CONTEXT,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { isWebCoreScope } from '@/lib/chat-authority';

/**
 * Owner scoping for AI Credits reads (CAN-3463).
 *
 * AI Credits spill only onto the pool of the organization that owns the work,
 * so every availability, balance, and usage read is a question about ONE owner.
 * The renderer caches those reads per scope key: a key change (another chat,
 * another context) must never show the previous owner's answer, even for a
 * frame.
 *
 * The navigation context is part of every key. Main resolves an uncaptured
 * work scope against the live navigation context, so the same chat can map to
 * a different owner after a context switch.
 */

/** `personal` or `org:<uuid>`, from the live navigation context. */
export function useNavigationScopeKey(): string {
  return useWorkspaceContextStore((store) =>
    serializeWorkspaceContext(store.state.context),
  );
}

/** Non-reactive read of the navigation key, for module-level helpers. */
export function readNavigationScopeKey(): string {
  try {
    return serializeWorkspaceContext(
      useWorkspaceContextStore.getState().state.context,
    );
  } catch {
    return serializeWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT);
  }
}

/** Stable cache key for one scope under one navigation context. */
export function aiCreditsScopeKey(
  scope: AiCreditsScopeRequest | undefined,
  navigationKey: string,
): string {
  if (!scope || scope.kind === 'navigation') {
    return `nav|${navigationKey}`;
  }
  return [
    'work',
    scope.projectId,
    scope.worktreeId ?? '',
    scope.chatId ?? '',
    navigationKey,
  ].join('|');
}

/**
 * Scope for a chat surface. App Advisor is always Personal work, which main
 * resolves from its sentinel project id, so it takes the same shape.
 */
export function chatAiCreditsScope(
  projectId: string | null | undefined,
  worktreeId?: string | null,
  chatId?: string | null,
): AiCreditsScopeRequest | undefined {
  if (!projectId) return undefined;
  // main resolves a work scope's owner from its local project; a cloud
  // project is placed in its owner's context, so the navigation scope names
  // the same owner without sending main a web core id (CAN-6175 D1).
  if (isWebCoreScope(projectId)) return undefined;
  return {
    kind: 'work',
    projectId,
    ...(worktreeId ? { worktreeId } : {}),
    ...(chatId ? { chatId } : {}),
  };
}

/** App Advisor is Personal work regardless of the navigation context. */
export const APP_ADVISOR_AI_CREDITS_SCOPE: AiCreditsScopeRequest = {
  kind: 'work',
  projectId: APP_ADVISOR_PROJECT_ID,
};

/**
 * Keep a caller's scope object referentially stable across renders while its
 * key is unchanged, so effects keyed on it do not re-run every render.
 */
export function useStableAiCreditsScope(
  scope: AiCreditsScopeRequest | undefined,
): { scope: AiCreditsScopeRequest | undefined; key: string } {
  const navigationKey = useNavigationScopeKey();
  const key = aiCreditsScopeKey(scope, navigationKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value
  const stableScope = useMemo(() => scope, [key]);
  return { scope: stableScope, key };
}

/**
 * The purchase scope a credits checkout hand-off belongs to (CAN-5534): the
 * chat's project and worktree under one navigation context, without the chat.
 * Every chat in it shares one pending hand-off, so a sibling chat offers the
 * return controls instead of a second checkout.
 *
 * A suppression boundary, not proof of which billing wallet pays: two
 * projects or worktrees funded by the same organization still get separate
 * hand-offs. `null` for a target without a project.
 */
export function aiCreditsWalletKey(
  target:
    | { readonly projectId: string; readonly worktreeId?: string }
    | null
    | undefined,
  navigationKey: string,
): string | null {
  const scope = chatAiCreditsScope(target?.projectId, target?.worktreeId);
  return scope ? aiCreditsScopeKey(scope, navigationKey) : null;
}

/** {@link aiCreditsWalletKey} under the live navigation context. */
export function useAiCreditsWalletKey(
  target:
    | { readonly projectId: string; readonly worktreeId?: string }
    | null
    | undefined,
): string | null {
  return aiCreditsWalletKey(target, useNavigationScopeKey());
}

/** Memoized scope for a chat banner target (`null` = navigation context). */
export function useChatTargetAiCreditsScope(
  target:
    | {
        readonly projectId: string;
        readonly worktreeId?: string;
        readonly chatId?: string;
      }
    | null
    | undefined,
): AiCreditsScopeRequest | undefined {
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  return useMemo(
    () => chatAiCreditsScope(projectId, worktreeId, chatId),
    [projectId, worktreeId, chatId],
  );
}
