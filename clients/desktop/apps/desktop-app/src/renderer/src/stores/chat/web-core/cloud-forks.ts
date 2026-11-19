import { create } from 'zustand';
import { webCoreScopeId } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { forkWebCoreChat } from './index';
import type { CloudForkOutcome } from './web-core-chat-backend';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { cloudProjectIsCowork } from '@/cloud-chats/cloud-project-kind';
import type { CoreCoworkProject } from '@canopy/app-state/core-cowork';

/** The cloud chat a fork starts from. */
export interface CloudForkTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * A cloud chat's fork that hasn't opened its new task (CAN-7007). `pending`
 * while the web core answers; `unknown` when no answer said whether it
 * forked, keeping the claim so only a retry with it follows; `refused` when
 * the web core answered and made no fork.
 */
export type CloudForkState =
  | { readonly status: 'pending'; readonly claimId: string }
  | { readonly status: 'unknown'; readonly claimId: string }
  | { readonly status: 'refused'; readonly reason: string };

interface CloudForkStore {
  readonly forks: Readonly<Record<string, CloudForkState>>;
}

export const useCloudForkStore = create<CloudForkStore>(() => ({ forks: {} }));

export function cloudForkKey(target: CloudForkTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

function setFork(key: string, state: CloudForkState | undefined): void {
  useCloudForkStore.setState(({ forks }) => {
    const next = { ...forks };
    if (state === undefined) delete next[key];
    else next[key] = state;
    return { forks: next };
  });
}

/**
 * Whether this window could open the task a fork creates: only a listed
 * cowork project's. A repository project's fork stays in its worktree,
 * which the desktop can't open yet (`workspaceContents: false`, CAN-6177),
 * so nothing forks there.
 */
export function cloudForkOpensItsTask(
  projectId: string,
  projects: readonly CoreCoworkProject[] = cloudCoworkStore.getState().projects,
): boolean {
  return cloudProjectIsCowork(projectId, projects);
}

/**
 * Forks a cloud chat into a new task and opens it. One fork per chat runs
 * at a time. After an unknown outcome the next press retries the same claim,
 * which the web core keys, so it never forks twice; nothing retries on its
 * own.
 */
export async function forkCloudChat(
  target: CloudForkTarget,
): Promise<CloudForkOutcome | { readonly kind: 'busy' }> {
  const key = cloudForkKey(target);
  const current = useCloudForkStore.getState().forks[key];
  if (current?.status === 'pending') return { kind: 'busy' };
  if (!cloudForkOpensItsTask(target.projectId)) {
    const refused = { kind: 'refused', reason: 'not_openable' } as const;
    setFork(key, { status: 'refused', reason: refused.reason });
    return refused;
  }
  const claimId =
    current?.status === 'unknown' ? current.claimId : crypto.randomUUID();
  setFork(key, { status: 'pending', claimId });
  const outcome = await forkWebCoreChat(target, claimId);
  switch (outcome.kind) {
    case 'forked':
      setFork(key, undefined);
      openCoworkWorkEntryFromSidebar(
        target.projectId,
        webCoreScopeId(outcome.taskId),
      );
      break;
    case 'refused':
      setFork(key, { status: 'refused', reason: outcome.reason });
      break;
    case 'unknown':
      setFork(key, { status: 'unknown', claimId });
      break;
  }
  return outcome;
}

/** Clears a refused fork's notice. An unknown fork keeps its claim. */
export function dismissCloudFork(target: CloudForkTarget): void {
  const key = cloudForkKey(target);
  if (useCloudForkStore.getState().forks[key]?.status === 'refused')
    setFork(key, undefined);
}

export function clearCloudForks(): void {
  useCloudForkStore.setState({ forks: {} });
}
