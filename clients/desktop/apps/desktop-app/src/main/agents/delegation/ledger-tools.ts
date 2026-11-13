import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { AGENT_DELEGATION_TASK_IDS_MAX } from '@canopy/protocol/delegation';
import type {
  DelegationContinuationCandidate,
  DelegationLineage,
} from '@canopy/desktop-shared/node/delegation/broker';
import type { LocalDelegationContext } from '@canopy/desktop-shared/node/delegation/local-runner';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import type {
  LedgerHarness,
  LedgerToolsHost,
  LedgerToolsRuntime,
} from '../../canopy-tools/ledger-tools-runtime';
import {
  buildAssignedLedgerEntriesPrompt,
  type AssignedLedgerEntry,
} from '../../canopy-tools/prompting';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { LedgerLiveDelegate } from '../../ledger/delegate-owners';

/*
 * The Agent Ledger for managed delegates (phase 07). Each run of a delegate
 * gets its own Ledger tools, served by the host like the rest of the child
 * projection: the delegate records as itself (role `managed_delegation`, the
 * durable delegation ID as actor) in the Ledger of the chat its delegation
 * belongs to, with the lineage and run generation the host holds. The tools
 * live exactly as long as the run: its caller binding is registered at the
 * run generation and revoked when the run ends, stops or is released, and
 * nothing persists across an app restart.
 */

/** One delegate run's Ledger tools, as the child projection serves them. */
export interface ChildLedgerTools extends LedgerToolsRuntime {
  /** The Ledger block for the child's instructions. */
  systemPrompt(): string;
  /** Revokes the run's caller binding. */
  dispose(): void;
}

/** What the host knows about a live delegate run beyond its request. */
export interface ChildLedgerRunContext {
  /** False once the run is stopping or its root session released it. */
  readonly isLive: () => boolean;
  /**
   * The delegation's lineage as the broker keeps it
   * (`AgentDelegationBroker.delegationLineage`), or undefined when the
   * broker has no record of it and the request's parent is used instead.
   */
  readonly lineage: DelegationLineage | undefined;
  /** The root chat's selected repository, for reference-file roots. */
  readonly selectedRepoId?: string;
  /** Defaults to the desktop host. */
  readonly host?: LedgerToolsHost;
}

function ledgerHarnessOf(harnessId: string): LedgerHarness | null {
  return harnessId === 'claude' || harnessId === 'codex' ? harnessId : null;
}

/**
 * Opens the Ledger tools of one delegate run when the Ledger is exposed to
 * its root chat (`canopy-ledger-enabled`, the "Agents add to the Feed"
 * setting and a Ledger scope for the chat). The parent is the chat for a
 * top-level delegate and the delegate one level up for a nested one, from
 * the lineage the broker keeps: a continuation's request names the caller
 * that continued it, such as the root chat or its recreated session. Null
 * when not exposed, so the child projection is exactly what it was without
 * the Ledger.
 */
export async function openChildLedgerTools(
  request: AgentRunRequest,
  context: ChildLedgerRunContext,
): Promise<ChildLedgerTools | null> {
  const harness = ledgerHarnessOf(request.route.harnessId);
  if (harness === null) return null;
  const parent = request.parent;
  const lineage = context.lineage ?? parent;
  // Deferred: the Ledger runtime's module graph subscribes to cloud account
  // changes when it loads, and loading the delegation bundle alone must not.
  // Chat sessions have already loaded it by the time a delegate runs, so this
  // resolves from the module cache.
  const { openLedgerDelegateTools } =
    await import('../../canopy-tools/ledger-tools-runtime');
  const ledger = await openLedgerDelegateTools({
    target: {
      projectId: parent.projectId,
      worktreeId: parent.worktreeId,
      chatId: parent.chatId,
    },
    harness,
    readSettings: () => ({
      model: request.route.runtimeModelId,
      thinkingEffort: request.route.effectiveThinkingLevel ?? null,
      planMode: false,
    }),
    ...(context.selectedRepoId === undefined
      ? {}
      : { selectedRepoId: context.selectedRepoId }),
    delegate: {
      delegationId: request.delegationId,
      description: request.task.description,
      runGeneration: request.runGeneration,
      parent:
        lineage.parentDelegationId === undefined
          ? { kind: 'chat' }
          : {
              kind: 'managed_delegation',
              delegationId: lineage.parentDelegationId,
              description: lineage.parentDescription ?? null,
            },
      isLive: context.isLive,
    },
    ...(context.host === undefined ? {} : { host: context.host }),
  });
  if (ledger === null) return null;

  const taskIds = (request.task.taskIds ?? []).slice(
    0,
    AGENT_DELEGATION_TASK_IDS_MAX,
  );
  const feedRuntime = ledger.delegationFeed;
  if (taskIds.length === 0 || feedRuntime === undefined) return ledger;

  // Read only IDs from the trusted spawn request, through the runtime bound
  // to this delegate's Feed ownership. The request's IDs alone never enter
  // the prompt; the child sees only IDs confirmed by its Feed runtime.
  const requestedIds = new Set(taskIds);
  const titlesById = new Map<string, string>();
  try {
    for (const entry of await feedRuntime.readAssignedEntries(taskIds)) {
      if (requestedIds.has(entry.entryId) && !titlesById.has(entry.entryId))
        titlesById.set(entry.entryId, entry.title);
    }
  } catch {
    logMainProcessWarn(
      '[delegation] Unable to read assigned Feed entries for delegate prompt',
    );
    return ledger;
  }
  const assignedEntries: AssignedLedgerEntry[] = taskIds.flatMap((entryId) => {
    const title = titlesById.get(entryId);
    return title === undefined ? [] : [{ entryId, title }];
  });
  const assignmentPrompt = buildAssignedLedgerEntriesPrompt(
    harness,
    assignedEntries,
  );
  if (assignmentPrompt.length === 0) return ledger;

  return {
    execute: (key, rawArgs, invocation) =>
      ledger.execute(key, rawArgs, invocation),
    systemPrompt: () => `${ledger.systemPrompt()}\n${assignmentPrompt}`,
    dispose: () => ledger.dispose(),
    ...(ledger.delegationFeed === undefined
      ? {}
      : { delegationFeed: ledger.delegationFeed }),
  };
}

/**
 * A runner's Ledger tools for one run: opened only for a child with a live
 * delegation parent, and disposed with the run's other resources, so the
 * run's caller binding ends with the run.
 */
export async function retainChildLedgerTools(
  context: LocalDelegationContext,
  delegation: DelegationParent | undefined,
  open:
    | ((
        context: LocalDelegationContext,
      ) => Promise<ChildLedgerTools | undefined>)
    | undefined,
): Promise<ChildLedgerTools | undefined> {
  if (delegation === undefined || open === undefined) return undefined;
  const ledger = await open(context);
  if (ledger !== undefined) {
    const { configureDelegationFeed } = await import('./service');
    context.retain(
      () => {
        // The hand-off registration ends with the run, before its runtime.
        configureDelegationFeed(delegation, undefined);
        ledger.dispose();
        return Promise.resolve();
      },
      { label: 'ledger-tools', phase: 'parent' },
    );
    configureDelegationFeed(delegation, ledger);
  }
  return ledger;
}

/** The Ledger block appended to a child's instructions, when exposed. */
export function childLedgerGuidance(
  ledger: ChildLedgerTools | undefined,
): string {
  return ledger === undefined ? '' : `\n${ledger.systemPrompt()}`;
}

/**
 * Retained delegates that can accept a continuation, as the Ledger offers
 * them as owners: the delegation ID as actor, the task description as name,
 * the current run generation for the eligibility token and the root chat.
 */
export function toLedgerLiveDelegates(
  candidates: readonly DelegationContinuationCandidate[],
): LedgerLiveDelegate[] {
  return candidates.map(
    (candidate): LedgerLiveDelegate => ({
      delegationId: candidate.delegationId,
      description: candidate.description,
      runGeneration: candidate.runGeneration,
      rootChatId: candidate.chatId,
      createdAt: isoTime(candidate.createdAt),
    }),
  );
}

function isoTime(epochMs: number): string | null {
  const time = new Date(epochMs);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}
