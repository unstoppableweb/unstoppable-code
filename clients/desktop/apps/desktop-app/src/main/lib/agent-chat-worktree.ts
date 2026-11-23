import type { BrowserWindow } from 'electron';
import type {
  WorktreeGitFailedEvent,
  WorktreeGitReadyEvent,
  WorktreeNeedsRepairEvent,
} from '@canopy/desktop-shared/types';
import type { AgentInterfacePort } from '../agents/agent-interface-port';
import { recordWorktreeCrudTelemetry } from './desktop-telemetry';
import { startProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { createWorktreeFromSelection } from './worktree-creation';
import { resolveWorktreeCreationSelection } from './worktree-creation-selection';
import { getWorkspaceType } from './workspace-registry';
import { startWorkspaceWorktreePostCreateSetup } from './workspace-worktree-runtime';

export type AgentChatWorktreeResult =
  | { status: 'created'; worktreeId: string }
  | { status: 'unavailable'; message: string }
  | { status: 'needs-repair'; message: string };

/**
 * CAN-5830: a new worktree for a chat an agent starts in a new worktree,
 * branched from the calling chat's worktree. It runs `core.worktree.create`
 * through the keyed W5 writer main callers use, with the setup the
 * renderer's create path starts, and announces the new row to every window.
 * App Advisor's `worktree.create` (CAN-5997) uses it with its own caller
 * source and an optional base worktree or base branch.
 */
export async function createAgentChatWorktree(input: {
  workspaceId: string;
  baseWorktreeId?: string;
  baseBranch?: string;
  idempotencyKey: string;
  callerSource?: 'agent-chat' | 'app-advisor';
  interfacePort: AgentInterfacePort;
}): Promise<AgentChatWorktreeResult> {
  const { workspaceId, baseWorktreeId, baseBranch, interfacePort } = input;
  const kind = getWorkspaceType(workspaceId);
  if (kind !== 'single-repo' && kind !== 'multi-repo')
    return { status: 'unavailable', message: 'Failed to create worktree.' };
  let replayed = false;
  const lifecycle = {
    workspaceId,
    ...resolveWorktreeCreationSelection(
      {
        ...(baseWorktreeId ? { baseWorktreeId } : {}),
        ...(baseBranch ? { baseBranch } : {}),
      },
      kind,
    ),
    idempotencyKey: input.idempotencyKey,
    callerSource: input.callerSource ?? 'agent-chat',
    onKeyedReplay: (): void => {
      replayed = true;
    },
    startPostCreateSetup: true,
    getWindow: (): BrowserWindow | null => interfacePort.legacyWindow(),
    deferGitSetup: true,
    onGitReady: (payload: WorktreeGitReadyEvent): void => {
      interfacePort.publishCreatedWorktreeGitReady(payload);
    },
    onGitFailed: (payload: WorktreeGitFailedEvent): void => {
      interfacePort.publishCreatedWorktreeGitFailed(payload);
    },
    // Keeps a root that needs repair pending for the repair flow, as the
    // renderer's create path does, so the held prompt waits for it.
    onNeedsRepair: (payload: WorktreeNeedsRepairEvent): void => {
      interfacePort.publishCreatedWorktreeNeedsRepair(payload);
    },
  };
  const outcome =
    kind === 'multi-repo'
      ? await createWorktreeFromSelection({
          ...lifecycle,
          workspaceKind: 'multi-repo',
          startWorkspacePostCreateSetup: startWorkspaceWorktreePostCreateSetup,
        })
      : await createWorktreeFromSelection({
          ...lifecycle,
          workspaceKind: 'single-repo',
          startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
        });
  interfacePort.publishCreatedWorktree(workspaceId);
  if (outcome.status === 'needs-repair')
    return {
      status: 'needs-repair',
      message: `Worktree creation needs repair before it can continue: ${outcome.repairIssues.map((issue) => issue.message).join('; ')}`,
    };
  if (!replayed)
    recordWorktreeCrudTelemetry({
      action: 'create',
      workspaceId,
      source: kind === 'multi-repo' ? 'multi_repo' : 'single_repo',
    });
  return { status: 'created', worktreeId: outcome.record.worktreeId };
}
