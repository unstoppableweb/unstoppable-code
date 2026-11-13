import { assertCoworkChatRootPresent } from '../lib/cowork-folder-guard';
import type {
  ChatWatcherHeldOutcome,
  WatcherDeliveryIngressCheck,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  revalidateAgentSenderRequest,
  revalidateAgentSteeringActor,
  isAgentSenderContextError,
  AgentSenderContextError,
  agentSendTargetReadiness,
} from '../agent-messaging/sender-context';
import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  presentationChatKey,
  recordPresentationTurn,
  resolvePresentationSource,
} from '../canopy-tools/presentation-state';
import {
  inputSettingsKeyMatchesNonApproval,
  inputRequestMatchesNonApprovalSettings,
  inputRequestMatchesSettings,
  validOrdinaryContinuation,
} from '@canopy/desktop-shared/chat-input-delivery';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { sessionApprovalWithinTurn } from '@canopy/desktop-shared/lib/send-approval-narrowing';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type {
  ChatInputDeliveryEvent,
  ChatInputDeliveryFailure,
  ChatInputAdmission,
  ChatInputRefusal,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import {
  chatInputDeliveryFailure,
  chatInputRefusal,
} from '@canopy/protocol/portal/input-delivery';
import type {
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatCoreMutation,
  ChatSendMessageRequest,
  PersistedPendingQuestion,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatScopeKey } from './chat-state-contracts';
import type { CanonicalChatState } from './chat-state-reducer';
import type { AgentSession, SteeringTarget } from '../agents/types';
import {
  claimDelegationDelivery,
  isDelegationDeliveryActive,
  releaseDelegationDelivery,
  retireDelegationDelivery,
} from '../agents/delegation/lifecycle';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  chatInputOrigin,
  recordChatInputDeliveryOutcome,
  unknownDeliveryOutcome,
  type ChatInputDeliveryOutcome,
} from '../lib/chat-input-delivery-diagnostics';
import { buildAutomationInfoMessage } from './automation-info-message';
import { reopenAsyncQuestionMutations } from './async-question-reopen';
import { isGeneratedInputRequest } from './chat-input-request-kind';
import {
  readSteeringApproval,
  steeringTurnApproval,
  type SteeringApprovalRead,
} from '../lib/chat-turn-approval-authority';
import {
  resolveActivePlanSystemInstruction,
  withActivePlanInstruction,
} from '../lib/active-plan-instruction';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import type { ChatStateV2Repository } from './chat-state-v2-repository';
import { readDeliveryHistory } from './chat-input-delivery-history';
import {
  releaseTurnBindingSlot,
  reserveTurnBindingSlot,
} from './chat-turn-binding-slots';
import { watcherDeliveryAuthorityGeneration } from './watcher-delivery-authority';
import {
  inputHistoryVerdict,
  inputSettingsKey,
  isInputLedger,
  isHistoryCandidate,
  observeInputDelivery,
  restoreInputLedger,
  resolveInputHistoryNotDelivered,
  type ChatPickupVerdict,
  type InputDeliveryObservation,
  type InputHistoryVerdict,
  type InputLedger,
  type InputRow,
} from './chat-input-delivery-state';

type Target = ChatScopeKey & { chatId: string };
type InputAttempt = InputRow['attempts'][number];
type Receipt = {
  commandId: string;
  outcome: 'applied';
  entityId: string;
  agentSteeringActor?: Extract<
    ChatCommandEnvelope['command'],
    { type: 'chat.steer_queued_message' }
  >['agentSteeringActor'];
};

/** How a settled attempt is recorded: the outcome plus its refusal or failure. */
interface AttemptSettlement {
  row: InputRow;
  attempt: InputAttempt;
  outcome: ChatInputDeliveryOutcome;
  refusal?: ChatInputRefusal;
  failure?: ChatInputDeliveryFailure;
  /** Observation time for an uncertainty that set no `uncertainAt`. */
  uncertainAt?: number;
}

interface PendingSubmitSettlementFence {
  rowId: string;
  epoch: number;
  matched: boolean;
}

interface HistoryResolutionFence {
  rowId: string;
  currentAttemptId: string;
  epoch: number;
  matched: boolean;
}

interface HistoryReadResults {
  results: Map<string, 'found' | 'not-found' | 'unreadable'>;
  queried: number;
}

// Bounds the in-process de-duplication set; attempt ids are random, so the
// oldest entries belong to long-settled attempts.
const MAX_RECORDED_OUTCOMES = 4096;
const MAX_HISTORY_ATTEMPTS_PER_PASS = 50;
const PROCESS_STARTED_AT = Date.now();

/**
 * An attempt whose row already reflects a settlement. A later pickup or
 * acknowledgement resolves the ledger but is not its first settlement.
 */
function attemptHasSettlementEvidence(attempt: InputAttempt): boolean {
  return (
    attempt.pickedUpAt !== undefined ||
    attempt.withdrawnAt !== undefined ||
    attempt.uncertainAt !== undefined
  );
}

function attemptWasSettled(row: InputRow, attempt: InputAttempt): boolean {
  return (
    attemptHasSettlementEvidence(attempt) ||
    (row.currentAttemptId === attempt.id &&
      (row.state === 'uncertain' ||
        row.state === 'cancelled' ||
        row.state === 'editing' ||
        row.state === 'queued'))
  );
}
type SessionLookup = (target: Target) => Promise<AgentSession | undefined>;
type InputDeliveryRepository = Pick<
  ChatStateV2Repository,
  'getRevision' | 'getState' | 'transactWith'
>;

interface OrdinaryInputContinuation {
  attemptId: string;
  epoch: number;
}

export type GeneratedSteeringResult =
  | { status: 'handled' | 'fallback' }
  | {
      status: 'requeue';
      rowId: string;
      epoch: number;
      continuation?: OrdinaryInputContinuation;
      /** Final watcher authorization refused this claimed attempt before provider I/O. */
      watcherDeliveryHeld?: ChatWatcherHeldOutcome;
    };

class RefusedSteerSettlementError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RefusedSteerSettlementError';
    this.cause = cause;
  }
}

class SteeringEligibilityLostError extends Error {
  constructor() {
    super('Steering is no longer eligible for the current queue operation');
    this.name = 'SteeringEligibilityLostError';
  }
}

/**
 * A delivery row's request with the text the user chose. Changed text is no
 * longer the async question's answer: like a queue edit, the request drops
 * its answer link so pickup writes ordinary text, and the question opens
 * again.
 */
function requestWithText(
  payload: ChatSendMessageRequest,
  text: string,
): { request: ChatSendMessageRequest; reopenedQuestionId?: string } {
  const { asyncQuestionId, ...ordinary } = payload;
  if (asyncQuestionId === undefined || text === payload.text)
    return { request: { ...payload, text } };
  return {
    request: { ...ordinary, text },
    reopenedQuestionId: asyncQuestionId,
  };
}

export class OrdinarySteerFallbackError extends Error {
  public readonly fallback = 'ordinary' as const;

  constructor() {
    super('Steering is unavailable for the current session');
    this.name = 'OrdinarySteerFallbackError';
  }
}

function materializePickedUpMessage(
  row: InputRow,
  pickedUpAttempt: InputRow['attempts'][number] | undefined,
  event: ChatInputDeliveryEvent,
  answeredQuestion?: PersistedPendingQuestion,
): PersistedChatTab['messages'][number] {
  const payload = pickedUpAttempt?.payloadSnapshot ?? row.payload;
  const startsTurn =
    event.startsTurn === true && event.turnRootAccepted !== false;
  return {
    id: row.id,
    role: 'user',
    userMessageSource: payload.agentSent
      ? 'agent'
      : payload.watcherFired
        ? 'watcher'
        : 'human',
    ...(payload.agentSent ? { agentSent: payload.agentSent } : {}),
    timestamp: pickedUpAttempt?.pickedUpAt ?? row.createdAt,
    // A delegate's message is hidden only while it waits. Once picked up it
    // shows, and every surface draws it as its request under its trusted
    // sender.
    ...(row.payload.watcherFired
      ? { watcherFired: row.payload.watcherFired }
      : {}),
    ...(row.payload.agentSent ? { agentSent: row.payload.agentSent } : {}),
    blocks: [
      ...(payload.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: payload.fileReferences,
            },
          ]
        : []),
      {
        type: 'text',
        text: pickedUpAttempt?.displayText ?? row.text,
        ...(answeredQuestion?.answers
          ? {
              asyncQuestionAnswer: {
                requestId: answeredQuestion.requestId,
                startsTurn,
                answers: answeredQuestion.answers,
              },
            }
          : {}),
        steering: {
          startsTurn,
          rootUserMessageId: pickedUpAttempt?.rootUserMessageId,
        },
      },
    ],
    ...(payload.attachmentPaths
      ? { attachmentPaths: payload.attachmentPaths }
      : {}),
    ...(payload.attachmentPromptContexts
      ? { attachmentPromptContexts: payload.attachmentPromptContexts }
      : {}),
    ...(payload.inputMode ? { inputMode: payload.inputMode } : {}),
  };
}

interface DelegationDeliveryOwnership {
  readonly deliveryId: string;
  isActive(): boolean;
  claim(): boolean;
  release(): void;
  retire(): void;
}

function delegationDeliveryOwnership(
  request: ChatSendMessageRequest,
): DelegationDeliveryOwnership | undefined {
  const deliveryId = request.managedDelegationDeliveryId;
  if (!isInternalChatRequest(request) || deliveryId === undefined)
    return undefined;
  const target: Target = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  return {
    deliveryId,
    isActive: () => isDelegationDeliveryActive(target, deliveryId),
    claim: () => claimDelegationDelivery(target, deliveryId),
    release: () => releaseDelegationDelivery(target, deliveryId),
    retire: () => retireDelegationDelivery(target, deliveryId),
  };
}

function requestContainsDeliveryId(
  request: ChatSendMessageRequest,
  deliveryIds: ReadonlySet<string>,
): boolean {
  return (
    deliveryIds.has(request.userMessageId) ||
    (request.consolidatedWatcherUserMessageIds ?? []).some((id) =>
      deliveryIds.has(id),
    )
  );
}

export type InputPickupObserver = (
  target: Target,
  row: InputRow,
  event: ChatInputDeliveryEvent,
) => Promise<void>;

function hasCommittedStartingPickupProof(
  state: CanonicalChatState,
  target: Target,
  event: ChatInputDeliveryEvent,
  expectedEpoch: number,
): boolean {
  if (
    event.phase !== 'picked-up' ||
    event.startsTurn !== true ||
    event.turnRootAccepted === false ||
    typeof event.userMessageId !== 'string'
  )
    return false;
  const liveTab = state.tabsFile.tabs.find(
    (candidate) => candidate.id === target.chatId,
  );
  const tab =
    liveTab ??
    state.archivesFile.archived.find((entry) => entry.tab.id === target.chatId)
      ?.tab;
  if (!tab || tab.kind === 'file' || !isInputLedger(tab.inputDelivery))
    return false;
  if (tab.inputDelivery.epoch !== expectedEpoch) return false;
  const row = tab.inputDelivery.rows.find(
    (candidate) => candidate.id === event.userMessageId,
  );
  if (!row || row.id !== event.userMessageId) return false;
  if (row.currentAttemptId !== event.attemptId) return false;
  const attempt = row.attempts.find(
    (candidate) =>
      candidate.id === event.attemptId &&
      candidate.generation === event.generation &&
      candidate.provider === event.provider,
  );
  if (
    !attempt ||
    attempt.pickedUpAt === undefined ||
    attempt.rootUserMessageId !== event.userMessageId ||
    attempt.turnOutcome !== undefined ||
    attempt.turnSettledAt !== undefined
  )
    return false;
  // Canonical runtime follows the turn's start, which can commit after the
  // pickup; the committed ledger alone proves it.
  return true;
}

export class ChatInputDeliveryCoordinator {
  private readonly handoffsByAttempt = new Map<string, string[]>();
  private readonly suspended = new Map<string, number>();
  private readonly activeActions = new Set<string>();
  private readonly queueRestorations = new Map<string, Promise<void>>();
  private readonly historyResolutionRuns = new Map<
    string,
    { rerun: boolean }
  >();
  private readonly historyResolutionCursors = new Map<string, number>();
  /**
   * Attempts whose outcome this process recorded. Best effort only: a crash
   * between a commit and its record, or a restart, can lose or repeat one.
   */
  private readonly recordedOutcomes = new Set<string>();
  /** History findings are later evidence, not the attempt's first settlement. */
  private readonly recordedHistoryOutcomes = new Set<string>();
  constructor(
    private readonly repository: InputDeliveryRepository,
    private readonly sessionFor: SessionLookup,
    private readonly authorize: (
      target: ChatScopeKey & { tab: PersistedChatTab },
    ) => Promise<void>,
    private readonly onPickup: InputPickupObserver,
    private readonly resolveCwd: (
      target: Target,
    ) => Promise<string | undefined> = (): Promise<string | undefined> =>
      Promise.resolve(undefined),
    private readonly checkWatcherIngress: (
      request: ChatSendMessageRequest,
    ) => ReturnType<WatcherDeliveryIngressCheck>,
  ) {}

  private key(target: Target): string {
    return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
  }

  /** Records an attempt's first settlement; call only after it committed. */
  private recordOutcome(target: Target, settlement: AttemptSettlement): void {
    const { row, attempt } = settlement;
    // Every settlement passes here; a withdrawal before pickup frees the slot.
    if (settlement.outcome === 'withdrawn')
      releaseTurnBindingSlot(target, row.id);
    if (this.recordedOutcomes.has(attempt.id)) return;
    this.recordedOutcomes.add(attempt.id);
    if (this.recordedOutcomes.size > MAX_RECORDED_OUTCOMES) {
      const oldest = this.recordedOutcomes.values().next();
      if (!oldest.done) this.recordedOutcomes.delete(oldest.value);
    }
    recordChatInputDeliveryOutcome({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      provider: attempt.provider,
      attemptId: attempt.id,
      generation: attempt.generation,
      origin: chatInputOrigin(attempt.payloadSnapshot ?? row.payload),
      outcome: settlement.outcome,
      createdAt: attempt.createdAt,
      admittedAt: attempt.admittedAt,
      pickedUpAt: attempt.pickedUpAt,
      withdrawnAt: attempt.withdrawnAt,
      completedAt: attempt.completedAt,
      uncertainAt: settlement.uncertainAt ?? attempt.uncertainAt,
      refusal: settlement.refusal,
      failure: settlement.failure,
    });
  }

  private recordRowOutcome(
    target: Target,
    row: InputRow,
    attemptId: string,
    outcome: ChatInputDeliveryOutcome,
    detail: Pick<AttemptSettlement, 'refusal' | 'failure' | 'uncertainAt'>,
  ): void {
    const attempt = row.attempts.find(
      (candidate) => candidate.id === attemptId,
    );
    if (attempt)
      this.recordOutcome(target, { row, attempt, outcome, ...detail });
  }

  private recordHistoryOutcome(
    target: Target,
    row: InputRow,
    attemptId: string,
    outcome: 'history-delivered' | 'history-not-delivered',
  ): void {
    const attempt = row.attempts.find(
      (candidate) => candidate.id === attemptId,
    );
    if (!attempt || this.recordedHistoryOutcomes.has(attemptId)) return;
    this.recordedHistoryOutcomes.add(attemptId);
    if (this.recordedHistoryOutcomes.size > MAX_RECORDED_OUTCOMES) {
      const oldest = this.recordedHistoryOutcomes.values().next();
      if (!oldest.done) this.recordedHistoryOutcomes.delete(oldest.value);
    }
    recordChatInputDeliveryOutcome({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      provider: attempt.provider,
      attemptId: attempt.id,
      generation: attempt.generation,
      origin: chatInputOrigin(attempt.payloadSnapshot ?? row.payload),
      outcome,
      createdAt: attempt.createdAt,
      admittedAt: attempt.admittedAt,
      pickedUpAt: attempt.pickedUpAt,
      withdrawnAt: attempt.withdrawnAt,
      completedAt: attempt.completedAt,
      uncertainAt: attempt.uncertainAt,
    });
  }

  private async restoreQueueContinuation(
    target: Target,
    row: InputRow,
    epoch: number,
  ): Promise<void> {
    const queueIntent = row.queueIntent;
    if (!queueIntent) return;
    const restorationKey = `${this.key(target)}:${row.id}:${queueIntent.commandId}`;
    const existing = this.queueRestorations.get(restorationKey);
    if (existing) {
      await existing;
      return;
    }
    const restoration = (async (): Promise<void> => {
      const currentLedger = (await this.tab(target)).inputDelivery;
      if (!isInputLedger(currentLedger) || currentLedger.epoch !== epoch) {
        throw new Error('Stop or Interrupt superseded this message action');
      }
      const currentRow = currentLedger.rows.find(
        (candidate) => candidate.id === row.id,
      );
      if (currentRow?.state === 'queued' && !currentRow.queueIntent) return;
      if (
        currentRow?.state !== 'cancelled' ||
        currentRow.queueIntent?.commandId !== queueIntent.commandId
      ) {
        throw new Error('The input is no longer available to queue');
      }
      // Lazy by design: the queue service constructs this coordinator, so a
      // static reverse import would create an initialization cycle. The
      // packaged Electron main build exercises this local import path.
      const { getChatQueueService } = await import('./chat-queue-service');
      await getChatQueueService().restoreWithdrawnInput(
        currentRow.payload,
        currentRow.id,
        {
          commandId: queueIntent.commandId,
          outcome: 'applied',
          entityId: currentRow.id,
        },
        epoch,
        currentRow.origin,
      );
    })();
    this.queueRestorations.set(restorationKey, restoration);
    try {
      await restoration;
    } finally {
      if (this.queueRestorations.get(restorationKey) === restoration) {
        this.queueRestorations.delete(restorationKey);
      }
    }
  }

  /** Starts best-effort history reconciliation without adding latency to state reads. */
  scheduleHistoryResolution(target: Target): void {
    const key = this.key(target);
    const running = this.historyResolutionRuns.get(key);
    if (running) {
      running.rerun = true;
      return;
    }

    const state = { rerun: false };
    this.historyResolutionRuns.set(key, state);
    void (async (): Promise<void> => {
      do {
        state.rerun = false;
        try {
          await this.resolveHistoryPass(target);
        } catch {
          logMainProcessWarn(
            `[chat-input-delivery] Provider history reconciliation failed for ${target.projectId}/${target.worktreeId}/${target.chatId}.`,
          );
        }
      } while (state.rerun);
      if (this.historyResolutionRuns.get(key) === state)
        this.historyResolutionRuns.delete(key);
    })();
  }

  private async readHistoryResults(
    target: Target,
    row: InputRow,
    cwd: string | undefined,
    limit: number,
  ): Promise<HistoryReadResults> {
    const results = new Map<string, 'found' | 'not-found' | 'unreadable'>();
    let queried = 0;
    for (const attempt of row.attempts) {
      if (queried >= limit) break;
      if (
        !attempt.target ||
        (attempt.provider === 'claude' && cwd === undefined)
      )
        continue;
      queried += 1;
      try {
        results.set(
          attempt.id,
          await readDeliveryHistory({
            provider: attempt.provider,
            target: attempt.target,
            attemptId: attempt.id,
            rowId: row.id,
            rowAttemptCount: row.attempts.length,
            cwd: cwd ?? '',
            previousRun: attempt.createdAt < PROCESS_STARTED_AT,
          }),
        );
      } catch {
        results.set(attempt.id, 'unreadable');
        logMainProcessWarn(
          `[chat-input-delivery] Provider history lookup failed for ${target.projectId}/${target.worktreeId}/${target.chatId}/${attempt.id}.`,
        );
      }
    }
    return { results, queried };
  }

  private async historySnapshotMatches(
    target: Target,
    row: InputRow,
    epoch: number,
    currentAttemptId: string,
  ): Promise<boolean> {
    const tab = await this.tabIncludingArchived(target);
    return (
      isInputLedger(tab.inputDelivery) &&
      tab.inputDelivery.epoch === epoch &&
      tab.inputDelivery.rows.some(
        (candidate) =>
          candidate.id === row.id &&
          candidate.currentAttemptId === currentAttemptId,
      )
    );
  }

  private async resolveHistoryPickup(
    target: Target,
    row: InputRow,
    attempt: InputAttempt,
    epoch: number,
    currentAttemptId: string,
  ): Promise<boolean> {
    if (attempt.pickedUpAt !== undefined)
      return this.historySnapshotMatches(target, row, epoch, currentAttemptId);

    const fence: HistoryResolutionFence = {
      rowId: row.id,
      currentAttemptId,
      epoch,
      matched: false,
    };
    await this.observeWithResult(
      target,
      {
        type: 'canopy_input_delivery',
        provider: attempt.provider,
        generation: attempt.generation,
        attemptId: attempt.id,
        phase: 'picked-up',
      },
      undefined,
      fence,
    );
    return fence.matched;
  }

  private async resolveHistoryPass(target: Target): Promise<void> {
    const tab = await this.tabIncludingArchived(target);
    const ledger = tab.inputDelivery;
    // Cheap superset check before the capability and worktree lookups.
    if (
      !isInputLedger(ledger) ||
      !ledger.rows.some((row) => isHistoryCandidate(row))
    )
      return;
    const epoch = ledger.epoch;
    const capabilities = await this.capabilities(target).catch(() => undefined);
    const liveGeneration = capabilities?.generation;
    const cwd = await this.resolveCwd(target);
    let remaining = MAX_HISTORY_ATTEMPTS_PER_PASS;
    const key = this.key(target);
    const startIndex =
      (this.historyResolutionCursors.get(key) ?? 0) % ledger.rows.length;

    for (let offset = 0; offset < ledger.rows.length; offset += 1) {
      if (remaining <= 0) break;
      const rowIndex = (startIndex + offset) % ledger.rows.length;
      const row = ledger.rows[rowIndex];
      if (!row) continue;
      const currentAttemptId = row.currentAttemptId;
      if (!isHistoryCandidate(row, liveGeneration) || !currentAttemptId)
        continue;
      const { results, queried } = await this.readHistoryResults(
        target,
        row,
        cwd,
        remaining,
      );
      remaining -= queried;
      if (remaining <= 0)
        this.historyResolutionCursors.set(
          key,
          (rowIndex + 1) % ledger.rows.length,
        );
      const verdict: InputHistoryVerdict = inputHistoryVerdict(row, results);
      if (verdict.kind === 'unreadable') continue;

      if (verdict.kind === 'found') {
        let matched = true;
        for (const attempt of row.attempts) {
          if (
            attempt.pickedUpAt === undefined &&
            results.get(attempt.id) === 'found' &&
            !(await this.resolveHistoryPickup(
              target,
              row,
              attempt,
              epoch,
              currentAttemptId,
            ))
          ) {
            matched = false;
            break;
          }
        }
        if (
          matched &&
          !(await this.historySnapshotMatches(
            target,
            row,
            epoch,
            currentAttemptId,
          ))
        )
          matched = false;
        if (!matched) continue;
        for (const attempt of row.attempts) {
          if (results.get(attempt.id) === 'found')
            this.recordHistoryOutcome(
              target,
              row,
              attempt.id,
              'history-delivered',
            );
        }
        continue;
      }

      const notDelivered: { row?: InputRow } = {};
      await this.update(target, (current) => {
        const next = resolveInputHistoryNotDelivered(
          current,
          row.id,
          currentAttemptId,
          epoch,
          Date.now(),
          liveGeneration,
        );
        if (next !== current)
          notDelivered.row = next.rows.find(
            (candidate) => candidate.id === row.id,
          );
        return next;
      });
      const resolved = notDelivered.row;
      if (!resolved) continue;

      for (const attempt of row.attempts) {
        if (results.get(attempt.id) === 'not-found')
          this.recordHistoryOutcome(
            target,
            row,
            attempt.id,
            'history-not-delivered',
          );
      }
      if (isGeneratedInputRequest(resolved.payload)) {
        const { getChatQueueService } = await import('./chat-queue-service');
        await getChatQueueService().restoreWithdrawnInput(
          resolved.payload,
          resolved.id,
          undefined,
          epoch,
          resolved.origin ?? 'desktop',
          undefined,
          {
            ordinaryOnly: true,
            waitForQueue: true,
            continuation: { attemptId: currentAttemptId, epoch },
          },
        );
      }
    }
  }

  private async checkHistoryBeforeResend(
    target: Target,
    row: InputRow,
    epoch: number,
  ): Promise<boolean> {
    const capabilities = await this.capabilities(target).catch(() => undefined);
    const liveGeneration = capabilities?.generation;
    const currentAttemptId = row.currentAttemptId;
    if (!isHistoryCandidate(row, liveGeneration) || !currentAttemptId)
      return false;
    let cwd: string | undefined;
    try {
      cwd = await this.resolveCwd(target);
    } catch {
      logMainProcessWarn(
        `[chat-input-delivery] Provider history working directory lookup failed for ${target.projectId}/${target.worktreeId}/${target.chatId}.`,
      );
      return false;
    }
    const { results } = await this.readHistoryResults(
      target,
      row,
      cwd,
      MAX_HISTORY_ATTEMPTS_PER_PASS,
    );
    const verdict = inputHistoryVerdict(row, results);
    if (verdict.kind === 'not-found') {
      for (const attempt of row.attempts) {
        if (results.get(attempt.id) === 'not-found')
          this.recordHistoryOutcome(
            target,
            row,
            attempt.id,
            'history-not-delivered',
          );
      }
      return false;
    }
    if (verdict.kind !== 'found') return false;

    let matched = true;
    for (const attempt of row.attempts) {
      if (
        attempt.pickedUpAt === undefined &&
        results.get(attempt.id) === 'found' &&
        !(await this.resolveHistoryPickup(
          target,
          row,
          attempt,
          epoch,
          currentAttemptId,
        ))
      ) {
        matched = false;
        break;
      }
    }
    if (
      matched &&
      !(await this.historySnapshotMatches(target, row, epoch, currentAttemptId))
    )
      matched = false;
    if (matched) {
      for (const attempt of row.attempts) {
        if (results.get(attempt.id) === 'found')
          this.recordHistoryOutcome(
            target,
            row,
            attempt.id,
            'history-delivered',
          );
      }
    }
    // Any positive result suppresses a retry, even when a concurrent change
    // made this read stale and therefore prevented its ledger commit.
    return true;
  }

  isSuspended(target: Target): boolean {
    return (this.suspended.get(this.key(target)) ?? 0) > 0;
  }

  private async tab(target: Target): Promise<PersistedChatTab> {
    const state = await this.repository.getState(target);
    const tab = state.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === target.chatId && candidate.kind !== 'file',
    );
    if (!tab) throw new Error('Chat is no longer available');
    return tab;
  }

  /**
   * The chat's tab, read after what deciding a steer into it needs
   * (`readSteeringApproval`), so a later approval change shows in the read's
   * revisions.
   */
  private async tabForSteering(
    request: ChatSendMessageRequest,
  ): Promise<{ tab: PersistedChatTab; read: SteeringApprovalRead }> {
    const read = await readSteeringApproval(request, await this.tab(request));
    return { tab: await this.tab(request), read };
  }

  /**
   * Whether `request` may steer into `session`: its other settings match the
   * chat's, and the session applies no more approval authority than the
   * request's own turn would start with (CAN-4821).
   */
  private steerable(
    request: ChatSendMessageRequest,
    tab: PersistedChatTab,
    session: AgentSession,
    read: SteeringApprovalRead,
  ): boolean {
    const turn = steeringTurnApproval(request, tab, read);
    return (
      turn !== undefined &&
      inputRequestMatchesSettings(
        request,
        tab,
        turn,
        session.getAppliedApprovalMode?.(),
        session.getAppliedApprovalRules?.(),
      )
    );
  }

  private async tabIncludingArchived(
    target: Target,
  ): Promise<PersistedChatTab> {
    const state = await this.repository.getState(target);
    const liveTab = state.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === target.chatId && candidate.kind !== 'file',
    );
    const tab =
      liveTab ??
      state.archivesFile.archived.find(
        (entry) => entry.tab.id === target.chatId,
      )?.tab;
    if (!tab) throw new Error('Chat is no longer available');
    return tab;
  }

  private async attemptIsDurable(
    target: Target,
    rowId: string,
    attemptId: string,
  ): Promise<boolean | undefined> {
    try {
      const tab = await this.tabIncludingArchived(target);
      return (
        isInputLedger(tab.inputDelivery) &&
        tab.inputDelivery.rows.some(
          (row) =>
            row.id === rowId &&
            row.attempts.some((attempt) => attempt.id === attemptId),
        )
      );
    } catch {
      return undefined;
    }
  }

  private async update(
    target: Target,
    change: (
      ledger: InputLedger,
      tab: PersistedChatTab,
      rootUserMessageId: string | undefined,
    ) => InputLedger,
    receipt?: Receipt,
    extra:
      | ChatCoreMutation[]
      | ((current: CanonicalChatState) => ChatCoreMutation[]) = [],
  ): Promise<void> {
    await this.repository.transactWith(
      target,
      (current) => {
        const extraMutations =
          typeof extra === 'function' ? extra(current) : extra;
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        const archived = liveTab
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === target.chatId,
            );
        const tab = liveTab ?? archived?.tab;
        if (!tab) throw new Error('Chat is no longer available');
        if (
          tab.inputDelivery !== undefined &&
          !isInputLedger(tab.inputDelivery)
        )
          throw new Error(
            'This message history requires a newer application version',
          );
        const ledger = tab.inputDelivery ?? { version: 1, epoch: 0, rows: [] };
        const next = change(
          ledger,
          tab,
          current.runtimeByChatId[target.chatId]?.activeTurn?.userMessageId,
        );
        if (next === ledger && !receipt && extraMutations.length === 0)
          return [];
        if (archived)
          return [
            {
              type: 'archive.upserted',
              entry: { ...archived, tab: { ...tab, inputDelivery: next } },
            },
          ];
        return [
          {
            type: 'tab.metadata_patched',
            tabId: target.chatId,
            patch: { inputDelivery: next },
          },
          ...extraMutations,
        ];
      },
      {
        source: receipt ? 'renderer-command' : 'provider',
        mutationId: receipt?.commandId ?? randomUUID(),
        ...(receipt ? { commandResult: receipt } : {}),
        chatIds: [target.chatId],
      },
    );
  }

  private async prepare(
    request: ChatSendMessageRequest,
    session?: AgentSession,
  ): Promise<string> {
    if (
      request.agentSent ||
      request.agentSenderProvenance ||
      request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(request);
    if (
      request.agentSendSetup &&
      (await agentSendTargetReadiness(request)) === 'pending'
    )
      throw new AgentSenderContextError(
        'target_not_ready',
        'The target task is still being set up.',
      );
    await assertCoworkChatRootPresent(request.projectId, request.worktreeId);
    const attachmentBaseDir = resolveAgentAttachmentsDir(
      request.projectId,
      request.worktreeId,
    );
    // A steered input bypasses the dispatch funnel, so it resolves the active
    // plan captured with it here. Resolution never throws.
    const activePlanInstruction = await resolveActivePlanSystemInstruction({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      activePlan: request.activePlan,
    });
    const text = buildSubmittedMessageText({
      ...request,
      pendingSystemInstructions: withActivePlanInstruction(
        request.pendingSystemInstructions,
        activePlanInstruction,
      ),
      attachmentBaseDir,
      cwd: session?.getSteeringWorkingDirectory?.(),
    });
    // Assets are never silently omitted or replaced with a path that no longer exists.
    await Promise.all(
      (request.attachmentPaths ?? []).map((path) => access(path)),
    );
    return request.hiddenContext?.text
      ? `${request.hiddenContext.text}\n\n${text}`
      : text;
  }

  /**
   * Steers a host-generated input (a fired watcher, an answer, a named
   * automation send or a delegate's message to its root chat) on arrival.
   * Watcher retries share the durable delivery identity, including cancelled
   * inputs. `onClaimed` runs once the ledger durably owns the input.
   */
  async steerGenerated(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    origin: 'desktop' | 'portal',
    allowSteering: boolean,
    canSteerNow: () => boolean = () => allowSteering,
    onClaimed?: () => void,
  ): Promise<GeneratedSteeringResult> {
    const isSteeringEligible = (): boolean => allowSteering && canSteerNow();
    const tab = await this.tab(request);
    if (tab.inputDelivery?.rows.some((row) => row.id === request.userMessageId))
      return { status: 'handled' };
    if (!isSteeringEligible()) return { status: 'fallback' };
    const session = await this.sessionFor(request);
    if (
      !isSteeringEligible() ||
      !session?.getSteeringCapabilities?.().steer ||
      !session.submitSteeringInput ||
      session.isDisposed?.()
    )
      return { status: 'fallback' };
    const steering = await this.tabForSteering(request);
    if (!this.steerable(request, steering.tab, session, steering.read))
      return { status: 'fallback' };
    const epoch = tab.inputDelivery?.epoch ?? 0;
    let claimed = false;
    let sent: boolean;
    try {
      sent = await this.steerQueuedInternal(
        request,
        queuedIds,
        {
          commandId: `watcher-steer-${request.userMessageId}`,
          outcome: 'applied',
          entityId: request.chatId,
        },
        () => {
          claimed = true;
          onClaimed?.();
        },
        origin,
        'requeue',
        isSteeringEligible,
        true,
      );
    } catch (error) {
      if (error instanceof RefusedSteerSettlementError) throw error;
      if (error instanceof SteeringEligibilityLostError && !claimed)
        return { status: 'fallback' };
      // A durable attempt is never retried as a full turn after ambiguous I/O.
      // Before admission, a turn ending during preparation can safely fall back.
      const latest = await this.tab(request);
      if (
        latest.inputDelivery?.rows.some(
          (row) => row.id === request.userMessageId,
        )
      )
        return { status: 'handled' };
      if (
        !claimed &&
        !this.isSuspended(request) &&
        (latest.inputDelivery?.epoch ?? 0) === epoch &&
        (!isSteeringEligible() || !session.getSteeringCapabilities?.().steer)
      )
        return { status: 'fallback' };
      throw error;
    }
    const latest = await this.tab(request);
    const deliveryOwner = delegationDeliveryOwnership(request);
    if (!sent && deliveryOwner && !deliveryOwner.isActive())
      return { status: 'handled' };
    if (
      !sent &&
      !this.isSuspended(request) &&
      latest.inputDelivery?.epoch === epoch &&
      isInputLedger(latest.inputDelivery)
    ) {
      const row = latest.inputDelivery.rows.find(
        (candidate) =>
          candidate.id === request.userMessageId &&
          candidate.state === 'cancelled',
      );
      const continuation = row
        ? validOrdinaryContinuation(latest.inputDelivery, row)
        : undefined;
      if (row && (continuation || row.ordinaryContinuation === undefined))
        return {
          status: 'requeue',
          rowId: request.userMessageId,
          epoch,
          ...(continuation ? { continuation } : {}),
        };
    }
    return { status: 'handled' };
  }

  /**
   * Steer a watcher delivery already owned by the host queue. The caller's
   * synchronous guard retains queue ownership until the durable claim; after
   * `claimed` it may validate the claimed operation instead of queue presence.
   */
  async steerQueuedGenerated(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    origin: 'desktop' | 'portal',
    canSteerNow: () => boolean,
    claimed: () => void,
  ): Promise<GeneratedSteeringResult> {
    const deliveryOwner = delegationDeliveryOwnership(request);
    const tab = await this.tab(request);
    const existing = tab.inputDelivery?.rows.find(
      (row) => row.id === request.userMessageId,
    );
    // A cancelled or editing row was never delivered and its queue row is
    // still the only copy of the input, so the queue keeps it. Every other
    // state means delivery already owns the input.
    if (existing?.state === 'cancelled' || existing?.state === 'editing')
      return { status: 'fallback' };
    if (existing && existing.state !== 'queued') return { status: 'handled' };
    if (this.isSuspended(request) || !canSteerNow())
      return { status: 'fallback' };
    const session = await this.sessionFor(request);
    if (
      !canSteerNow() ||
      !session?.submitSteeringInput ||
      !session.getSteeringCapabilities?.().steer ||
      session.isDisposed?.()
    )
      return { status: 'fallback' };
    // The session applies no more approval authority than the delivery's own
    // turn would start with (CAN-4821).
    const steering = await this.tabForSteering(request);
    if (!this.steerable(request, steering.tab, session, steering.read))
      return { status: 'fallback' };

    const epoch = tab.inputDelivery?.epoch ?? 0;
    let didClaim = false;
    let watcherDeliveryHeld: ChatWatcherHeldOutcome | undefined;
    let sent: boolean;
    try {
      sent = await this.steerQueuedInternal(
        request,
        queuedIds,
        {
          commandId: `watcher-queued-steer-${randomUUID()}`,
          outcome: 'applied',
          entityId: request.chatId,
        },
        () => {
          didClaim = true;
          claimed();
        },
        origin,
        'requeue',
        canSteerNow,
        true,
        (held): void => {
          watcherDeliveryHeld = held;
        },
      );
    } catch (error) {
      if (error instanceof RefusedSteerSettlementError) throw error;
      if (error instanceof SteeringEligibilityLostError && !didClaim)
        return { status: 'fallback' };
      if (!didClaim && error instanceof OrdinarySteerFallbackError)
        return { status: 'fallback' };
      throw error;
    }

    const latest = await this.tab(request);
    if (!sent && deliveryOwner && !deliveryOwner.isActive())
      return { status: 'handled' };
    if (
      !sent &&
      !this.isSuspended(request) &&
      latest.inputDelivery?.epoch === epoch &&
      isInputLedger(latest.inputDelivery)
    ) {
      const row = latest.inputDelivery.rows.find(
        (candidate) =>
          candidate.id === request.userMessageId &&
          candidate.state === 'cancelled',
      );
      const continuation = row
        ? validOrdinaryContinuation(latest.inputDelivery, row)
        : undefined;
      if (row && (continuation || row.ordinaryContinuation === undefined))
        return {
          status: 'requeue',
          rowId: request.userMessageId,
          epoch,
          ...(continuation ? { continuation } : {}),
          ...(watcherDeliveryHeld ? { watcherDeliveryHeld } : {}),
        };
    }
    return { status: 'handled' };
  }

  /** Returns false only when this attempt was definitively never sent. */
  async steerQueued(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    receipt: Receipt,
    claimed: () => void,
    origin: 'desktop' | 'portal' = 'desktop',
    ordinaryFallback: 'restore' | 'requeue' = 'restore',
  ): Promise<boolean> {
    return this.steerQueuedInternal(
      request,
      queuedIds,
      receipt,
      claimed,
      origin,
      ordinaryFallback,
      () => true,
      false,
    );
  }

  private async steerQueuedInternal(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    receipt: Receipt,
    claimed: () => void,
    origin: 'desktop' | 'portal',
    ordinaryFallback: 'restore' | 'requeue',
    canSteerNow: () => boolean,
    checkLiveEligibility: boolean,
    onWatcherHeld?: (held: ChatWatcherHeldOutcome) => void,
  ): Promise<boolean> {
    const handoffsAtSend = browserHandoffs.captureOrigin({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatTabId: request.chatId,
    });
    const deliveryOwner = delegationDeliveryOwnership(request);
    const assertEligible = (): void => {
      if (!canSteerNow() || (deliveryOwner && !deliveryOwner.isActive()))
        throw new SteeringEligibilityLostError();
    };
    if (this.isSuspended(request)) {
      if (checkLiveEligibility) throw new SteeringEligibilityLostError();
      else throw new Error('The chat is stopping or interrupting');
    }
    assertEligible();
    const { tab, read } = await this.tabForSteering(request);
    assertEligible();
    const workOwner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
    });
    assertEligible();
    const modelBlocked = await isModelBlockedByStoredPolicy(
      request.model ?? tab.model,
      workOwner,
    );
    assertEligible();
    if (modelBlocked) {
      if (checkLiveEligibility) throw new SteeringEligibilityLostError();
      throw new Error('This model is blocked by your organization policy.');
    }
    await this.authorize({ ...request, tab });
    assertEligible();
    const session = await this.sessionFor(request);
    assertEligible();
    const caps = session?.getSteeringCapabilities?.();
    if (
      !session?.submitSteeringInput ||
      !caps ||
      session.isDisposed?.() ||
      (checkLiveEligibility && !caps.steer)
    ) {
      if (checkLiveEligibility) throw new SteeringEligibilityLostError();
      throw new Error('Steering is unavailable for the current session');
    }
    if (!inputRequestMatchesNonApprovalSettings(request, tab)) {
      if (checkLiveEligibility) throw new SteeringEligibilityLostError();
      throw new Error(
        'The queued message uses different settings. Keep it queued to send with those settings.',
      );
    }
    if (!caps.steer) {
      if (checkLiveEligibility) throw new SteeringEligibilityLostError();
      throw new OrdinarySteerFallbackError();
    }
    // A refused approval check still transfers the input to ordinary delivery.
    const steeringRead = this.steerable(request, tab, session, read)
      ? read
      : undefined;
    const settingsKey = inputSettingsKey(tab);
    const initialEpoch = tab.inputDelivery?.epoch ?? 0;
    // A picked-up async answer preserves its exact provider payload. Ordinary
    // and manually steered inputs still receive their captured instructions,
    // plan context and attachment prompt.
    const text =
      checkLiveEligibility && request.asyncQuestionId
        ? request.text
        : await this.prepare(request, session);
    assertEligible();
    const attemptId = randomUUID();
    const now = Date.now();
    const steeringTarget: SteeringTarget | undefined =
      session.getSteeringTarget?.();
    let epoch = 0;
    let claimCapabilities = caps;
    let hostClaimed = false;
    if (deliveryOwner) {
      assertEligible();
      hostClaimed = deliveryOwner.claim();
      if (!hostClaimed) throw new SteeringEligibilityLostError();
    }
    try {
      await this.repository.transactWith(
        request,
        (current) => {
          const liveCapabilities = checkLiveEligibility
            ? session.getSteeringCapabilities?.()
            : claimCapabilities;
          if (
            checkLiveEligibility &&
            (!canSteerNow() ||
              !liveCapabilities?.steer ||
              !session.submitSteeringInput ||
              session.isDisposed?.())
          )
            throw new SteeringEligibilityLostError();
          if (deliveryOwner && !deliveryOwner.isActive())
            throw new SteeringEligibilityLostError();
          const latest = current.tabsFile.tabs.find(
            (t) => t.id === request.chatId,
          );
          if (
            !latest ||
            !inputSettingsKeyMatchesNonApproval(latest, settingsKey) ||
            this.isSuspended(request) ||
            session.isDisposed?.()
          )
            throw new Error(
              'Chat settings or execution changed. The message remains queued.',
            );
          if (
            latest.inputDelivery !== undefined &&
            !isInputLedger(latest.inputDelivery)
          )
            throw new Error('Unsupported message history version');
          const ledger = latest.inputDelivery ?? {
            version: 1 as const,
            epoch: 0,
            rows: [],
          };
          if (ledger.epoch !== initialEpoch)
            throw new Error(
              'Stop or Interrupt superseded the steering request',
            );
          if (
            ledger.rows.some(
              (row) =>
                row.id === request.userMessageId && row.state !== 'queued',
            )
          )
            throw new Error('This message already has a delivery attempt');
          epoch = ledger.epoch;
          // The attempt records the capabilities read inside the claim. Submit
          // refuses it if the session's provider or generation has moved on.
          if (checkLiveEligibility && liveCapabilities)
            claimCapabilities = liveCapabilities;
          const previous = ledger.rows.find(
            (row) => row.id === request.userMessageId,
          );
          const row: InputRow = {
            id: request.userMessageId,
            revision: (previous?.revision ?? 0) + 1,
            createdAt: previous?.createdAt ?? now,
            state: 'sending',
            text: request.text,
            payload: request,
            settingsKey,
            origin,
            currentAttemptId: attemptId,
            attempts: [
              ...(previous?.attempts ?? []),
              {
                id: attemptId,
                generation: claimCapabilities.generation,
                provider: claimCapabilities.provider,
                createdAt: now,
                submittedText: text,
                displayText: request.text,
                payloadSnapshot: structuredClone(request),
                ...(steeringTarget ? { target: steeringTarget } : {}),
                rootUserMessageId:
                  current.runtimeByChatId[request.chatId]?.activeTurn
                    ?.userMessageId,
              },
            ],
          };
          const currentRuntime = current.runtimeByChatId[request.chatId];
          const deliveryIds: ReadonlySet<string> | undefined =
            checkLiveEligibility
              ? new Set<string>([
                  request.userMessageId,
                  ...(request.consolidatedWatcherUserMessageIds ?? []),
                ])
              : undefined;
          const queuedMessagesToRemove = new Set<string>();
          const queuedMessages = currentRuntime?.queuedMessages?.filter(
            (queuedMessage) => {
              const matchesClaimedDelivery =
                deliveryIds !== undefined &&
                requestContainsDeliveryId(queuedMessage.request, deliveryIds);
              if (matchesClaimedDelivery) {
                queuedMessagesToRemove.add(queuedMessage.id);
                queuedMessagesToRemove.add(queuedMessage.request.userMessageId);
                for (const id of queuedMessage.request
                  .consolidatedWatcherUserMessageIds ?? []) {
                  queuedMessagesToRemove.add(id);
                }
              }
              return !matchesClaimedDelivery;
            },
          );
          deliveryIds?.forEach((id) => queuedMessagesToRemove.add(id));
          return [
            {
              type: 'tab.metadata_patched',
              tabId: request.chatId,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: [...ledger.rows.filter((r) => r.id !== row.id), row],
                },
              },
            },
            {
              type: 'runtime.patched',
              chatId: request.chatId,
              runtime: {
                ...(current.runtimeByChatId[request.chatId] ?? {
                  status: 'streaming',
                }),
                queuedMessageIds: queuedIds().filter(
                  (id) => !queuedMessagesToRemove.has(id),
                ),
                ...(currentRuntime?.queuedMessages && queuedMessages
                  ? { queuedMessages }
                  : {}),
              },
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: receipt.commandId,
          commandResult: receipt,
          chatIds: [request.chatId],
          beforePublish: () => {
            if (checkLiveEligibility && !canSteerNow())
              throw new SteeringEligibilityLostError();
            if (deliveryOwner && !deliveryOwner.isActive())
              throw new SteeringEligibilityLostError();
          },
        },
      );
    } catch (error) {
      if (deliveryOwner && hostClaimed) {
        const durable = await this.attemptIsDurable(
          request,
          request.userMessageId,
          attemptId,
        );
        if (durable === false) {
          deliveryOwner.release();
        } else {
          deliveryOwner.retire();
          try {
            claimed();
          } catch {
            // Retiring is the fail-closed boundary if queue cleanup also fails.
          }
        }
      }
      throw error;
    }
    try {
      claimed(); // The queue may restore on failure only before this durable boundary.
    } catch (error) {
      deliveryOwner?.retire();
      throw error;
    }
    try {
      return await this.submit(
        request,
        session,
        request.userMessageId,
        attemptId,
        epoch,
        text,
        steeringRead,
        ordinaryFallback,
        canSteerNow,
        checkLiveEligibility,
        deliveryOwner,
        receipt.agentSteeringActor,
        handoffsAtSend,
        onWatcherHeld,
      );
    } catch (error) {
      deliveryOwner?.retire();
      throw error;
    }
  }

  private async submit(
    target: Target,
    session: AgentSession,
    rowId: string,
    attemptId: string,
    epoch: number,
    text: string,
    read: SteeringApprovalRead | undefined,
    ordinaryFallback: 'restore' | 'requeue' = 'restore',
    canSteerNow: () => boolean = () => true,
    checkLiveEligibility = false,
    deliveryOwner?: DelegationDeliveryOwnership,
    steeringActor?: Receipt['agentSteeringActor'],
    capturedHandoffs?: string[],
    onWatcherHeld?: (held: ChatWatcherHeldOutcome) => void,
  ): Promise<boolean> {
    const presentationOrigin = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatTabId: target.chatId,
    };
    const handoffsAtSend =
      capturedHandoffs ?? browserHandoffs.captureOrigin(presentationOrigin);
    let tab = await this.tab(target);
    let row = tab.inputDelivery?.rows.find(
      (candidate) => candidate.id === rowId,
    );
    const markNeverSentAndRelease = async (
      reason: string,
      refusal: ChatInputRefusal | undefined,
    ): Promise<void> => {
      try {
        await this.markNeverSent(
          target,
          rowId,
          attemptId,
          undefined,
          reason,
          refusal,
        );
      } catch (error) {
        deliveryOwner?.retire();
        throw error;
      }
      deliveryOwner?.release();
    };
    const notSteerable = chatInputRefusal('session-not-steerable');
    // Preparation, durable admission and the final snapshot can all outlive
    // watcher authority. Revalidate at the last awaited provider boundary.
    if (row?.payload.watcherFired && row.payload.watcherDeliveryId) {
      const authority = watcherDeliveryAuthorityGeneration();
      const check = await this.checkWatcherIngress(row.payload);
      if (check.allowed) {
        // Stop or a settings change can land during authorization.
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
      }
      // An access, account or owner change during authorization or the
      // re-read makes the decision stale. Hold so the queue reauthorizes.
      const heldReason = !check.allowed
        ? check.reason
        : watcherDeliveryAuthorityGeneration() !== authority
          ? 'runtime_unavailable'
          : undefined;
      if (heldReason) {
        try {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            heldReason,
            ordinaryFallback,
            undefined,
          );
          if (!restored)
            await this.markNeverSent(
              target,
              rowId,
              attemptId,
              undefined,
              heldReason,
              undefined,
            );
        } catch (error) {
          deliveryOwner?.retire();
          throw new RefusedSteerSettlementError(error);
        }
        deliveryOwner?.release();
        onWatcherHeld?.({ outcome: 'held', reason: heldReason });
        return false;
      }
    }
    // The steering agent may have lost access while delivery was prepared.
    if (steeringActor) {
      const authority = watcherDeliveryAuthorityGeneration();
      let allowed = true;
      try {
        await revalidateAgentSteeringActor(
          steeringActor,
          target.projectId,
          row?.payload.agentSenderProvenance,
        );
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
      } catch (error) {
        if (!isAgentSenderContextError(error)) throw error;
        allowed = false;
      }
      if (!allowed || watcherDeliveryAuthorityGeneration() !== authority) {
        try {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            'agent_send:not_found',
            ordinaryFallback,
            undefined,
          );
          if (!restored)
            await this.markNeverSent(
              target,
              rowId,
              attemptId,
              undefined,
              'agent_send:not_found',
              undefined,
            );
        } catch (error) {
          deliveryOwner?.retire();
          throw new RefusedSteerSettlementError(error);
        }
        deliveryOwner?.release();
        // Report the refusal to the steering caller rather than a steer.
        throw new AgentSenderContextError(
          'not_found',
          'The target chat is not available.',
        );
      }
    }
    if (row?.payload.agentSenderProvenance) {
      try {
        const authority = watcherDeliveryAuthorityGeneration();
        await revalidateAgentSenderRequest(row.payload);
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
        if (watcherDeliveryAuthorityGeneration() !== authority)
          throw new AgentSenderContextError(
            'owner_context_unavailable',
            'Agent send authority changed during delivery.',
          );
      } catch (error) {
        if (!isAgentSenderContextError(error)) throw error;
        await markNeverSentAndRelease(
          `agent_send:${error.code === 'authorization_conflict' ? 'owner_boundary' : error.code}`,
          undefined,
        );
        return false;
      }
    }
    if (
      this.isSuspended(target) ||
      !isInputLedger(tab.inputDelivery) ||
      tab.inputDelivery.epoch !== epoch ||
      !session.submitSteeringInput
    ) {
      await markNeverSentAndRelease(
        'Submission was superseded by Stop or Interrupt',
        chatInputRefusal('handoff-interrupted'),
      );
      return false;
    }
    const caps = session.getSteeringCapabilities?.();
    row = tab.inputDelivery.rows.find((candidate) => candidate.id === rowId);
    const attempt = row?.attempts.find(
      (candidate) => candidate.id === attemptId,
    );
    if (
      !caps ||
      session.isDisposed?.() ||
      !row ||
      !inputSettingsKeyMatchesNonApproval(tab, row.settingsKey) ||
      row.currentAttemptId !== attemptId ||
      !attempt
    ) {
      await markNeverSentAndRelease(
        'The active session no longer accepts steering',
        notSteerable,
      );
      return false;
    }
    // The session may have applied a looser mode or gained a grant, or the
    // chat's authority narrowed, while the message was being prepared; the
    // message then gets its own turn (CAN-4821). Recomputed from this tab and
    // the read made before the steer, which it refuses once stale. Reuses the
    // refusal above, so no new row copy is shown.
    const turn = read && steeringTurnApproval(row.payload, tab, read);
    if (
      turn === undefined ||
      !sessionApprovalWithinTurn(
        session.getAppliedApprovalMode?.(),
        session.getAppliedApprovalRules?.(),
        turn,
        tab.sessionApprovalRules ?? [],
      )
    ) {
      const reason = 'The active session no longer accepts steering';
      try {
        const restored = await this.restoreRejectedAsOrdinary(
          target,
          rowId,
          attemptId,
          epoch,
          reason,
          ordinaryFallback,
          notSteerable,
        );
        if (restored) {
          deliveryOwner?.release();
          return false;
        }
      } catch (error) {
        deliveryOwner?.retire();
        throw new RefusedSteerSettlementError(error);
      }
      await markNeverSentAndRelease(reason, notSteerable);
      return false;
    }
    const steerable =
      caps.steer &&
      attempt.generation === caps.generation &&
      attempt.provider === caps.provider &&
      (!checkLiveEligibility || canSteerNow()) &&
      (!deliveryOwner || deliveryOwner.isActive());
    // A turn binds at most 64 distinct inputs (contracts §9.7): take this
    // input's slot before the provider sees it, or leave it for the next turn.
    if (!steerable || !reserveTurnBindingSlot(target, rowId)) {
      const [reason, refusal] = steerable
        ? [
            'The active turn has no binding slot left',
            chatInputRefusal('not-steerable'),
          ]
        : ['The active session no longer accepts steering', notSteerable];
      try {
        const restored = await this.restoreRejectedAsOrdinary(
          target,
          rowId,
          attemptId,
          epoch,
          reason,
          ordinaryFallback,
          refusal,
        );
        if (restored) {
          deliveryOwner?.release();
          return false;
        }
      } catch (error) {
        deliveryOwner?.retire();
        throw new RefusedSteerSettlementError(error);
      }
      await markNeverSentAndRelease(reason, refusal);
      return false;
    }
    // No await between final epoch/capability check and provider handoff.
    let result: Awaited<
      ReturnType<NonNullable<AgentSession['submitSteeringInput']>>
    >;
    if (handoffsAtSend.length)
      this.handoffsByAttempt.set(attemptId, handoffsAtSend);
    try {
      result = await session.submitSteeringInput(
        text,
        attemptId,
        rowId,
        attempt.target,
      );
    } catch {
      // The error is not kept: its message can quote the submitted input.
      deliveryOwner?.retire();
      await this.observe(target, {
        type: 'canopy_input_delivery',
        provider: caps.provider,
        generation: caps.generation,
        attemptId,
        phase: 'unknown',
        failure: chatInputDeliveryFailure('handoff-error'),
      });
      return true;
    }

    if (result.kind === 'rejected') {
      // A proven refusal frees the slot; an uncertain outcome keeps it.
      releaseTurnBindingSlot(target, rowId);
      this.handoffsByAttempt.delete(attemptId);
      try {
        if (result.fallback === 'ordinary') {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            result.reason,
            ordinaryFallback,
            result.refusal,
          );
          if (restored) {
            deliveryOwner?.release();
            return false;
          }
        }
        await this.markNeverSent(
          target,
          rowId,
          attemptId,
          undefined,
          result.reason,
          result.refusal,
        );
        deliveryOwner?.release();
        return false;
      } catch (error) {
        deliveryOwner?.retire();
        throw new RefusedSteerSettlementError(error);
      }
    }

    if (result.kind === 'pending') {
      const settlement = result.settlement?.then(
        (admission) => ({ settled: true as const, admission }),
        () => ({ settled: false as const }),
      );
      // The provider holds the input but has not confirmed it yet. The row
      // reads as sending without counterfeit admission evidence; the
      // attempt stays correlated, so a later event settles it.
      await this.markAwaitingConfirmation(target, rowId, attemptId, epoch);
      if (settlement) {
        void settlement
          .then((resolution) => {
            if (!resolution.settled) {
              logMainProcessWarn(
                '[chat-input-delivery] Late steering settlement could not be applied.',
              );
              return;
            }
            if (resolution.admission.attemptId === attemptId) {
              if (resolution.admission.kind === 'accepted')
                this.settleAcceptedSteerHandoffs(
                  target,
                  row,
                  attemptId,
                  handoffsAtSend,
                );
              else if (resolution.admission.kind === 'rejected')
                this.handoffsByAttempt.delete(attemptId);
            }
            return this.applyLateSubmitSettlement(
              target,
              caps,
              rowId,
              attemptId,
              epoch,
              ordinaryFallback,
              resolution.admission,
              deliveryOwner,
            );
          })
          .catch(() => {
            logMainProcessWarn(
              '[chat-input-delivery] Late steering settlement could not be applied.',
            );
          });
      }
      return true;
    }

    if (result.kind === 'accepted')
      this.settleAcceptedSteerHandoffs(target, row, attemptId, handoffsAtSend);
    if (result.kind === 'unknown') deliveryOwner?.retire();

    await this.observe(
      target,
      result.kind === 'accepted'
        ? {
            type: 'canopy_input_delivery',
            provider: caps.provider,
            generation: caps.generation,
            attemptId,
            phase: 'accepted',
          }
        : {
            type: 'canopy_input_delivery',
            provider: caps.provider,
            generation: caps.generation,
            attemptId,
            phase: 'unknown',
            ...(result.failure ? { failure: result.failure } : {}),
          },
    );
    return true;
  }

  /**
   * An accepted steer answers the browser handoffs pinned when it was sent:
   * a person's reply releases them, and an automation or hook turn records
   * its presentation source instead.
   */
  private settleAcceptedSteerHandoffs(
    target: Target,
    row: InputRow | undefined,
    attemptId: string,
    handoffsAtSend: readonly string[],
  ): void {
    this.handoffsByAttempt.delete(attemptId);
    if (!row) return;
    const presentationOrigin = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatTabId: target.chatId,
    };
    const source = resolvePresentationSource(
      row.payload,
      row.origin === 'portal' ? 'portal' : 'user',
    );
    if (source === 'user' || source === 'portal') {
      for (const id of handoffsAtSend) browserHandoffs.release(id);
    } else if (source === 'automation' || source === 'hook') {
      const active = capturePresentationTurn(presentationOrigin);
      recordPresentationTurn(
        presentationChatKey(presentationOrigin),
        active?.turnId ?? row.id,
        source,
      );
    }
  }

  private async applyLateSubmitSettlement(
    target: Target,
    capabilities: ChatSteeringCapabilities,
    rowId: string,
    attemptId: string,
    epoch: number,
    ordinaryFallback: 'restore' | 'requeue',
    result: ChatInputAdmission,
    deliveryOwner?: DelegationDeliveryOwnership,
  ): Promise<void> {
    if (result.attemptId !== attemptId) return;

    if (result.kind === 'rejected') {
      releaseTurnBindingSlot(target, rowId);
      try {
        if (result.fallback === 'ordinary') {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            result.reason,
            ordinaryFallback,
            result.refusal,
            true,
          );
          if (restored) {
            deliveryOwner?.release();
            return;
          }
        }
        const markedNeverSent = await this.markNeverSent(
          target,
          rowId,
          attemptId,
          epoch,
          result.reason,
          result.refusal,
        );
        if (markedNeverSent) deliveryOwner?.release();
        else deliveryOwner?.retire();
      } catch (error) {
        deliveryOwner?.retire();
        throw error;
      }
      return;
    }

    const fence: PendingSubmitSettlementFence = {
      rowId,
      epoch,
      matched: false,
    };
    if (result.kind === 'unknown') deliveryOwner?.retire();
    try {
      await this.observeWithResult(
        target,
        result.kind === 'accepted'
          ? {
              type: 'canopy_input_delivery',
              provider: capabilities.provider,
              generation: capabilities.generation,
              attemptId,
              phase: 'accepted',
            }
          : {
              type: 'canopy_input_delivery',
              provider: capabilities.provider,
              generation: capabilities.generation,
              attemptId,
              phase: 'unknown',
              ...(result.failure ? { failure: result.failure } : {}),
            },
        fence,
      );
      if (!fence.matched) deliveryOwner?.retire();
    } catch (error) {
      deliveryOwner?.retire();
      throw error;
    }
  }

  private async markAwaitingConfirmation(
    target: Target,
    rowId: string,
    attemptId: string,
    epoch: number,
  ): Promise<void> {
    await this.update(target, (ledger) =>
      ledger.epoch === epoch &&
      !this.isSuspended(target) &&
      ledger.rows.some(
        (row) =>
          row.id === rowId &&
          row.currentAttemptId === attemptId &&
          row.state === 'sending',
      )
        ? {
            ...ledger,
            rows: ledger.rows.map((row) =>
              row.id === rowId
                ? { ...row, revision: row.revision + 1, state: 'pending' }
                : row,
            ),
          }
        : ledger,
    );
  }

  private async restoreRejectedAsOrdinary(
    target: Target,
    rowId: string,
    attemptId: string,
    epoch: number,
    reason: string,
    ordinaryFallback: 'restore' | 'requeue',
    refusal: ChatInputRefusal | undefined,
    lateSettlement = false,
  ): Promise<boolean> {
    const fallback: { row?: InputRow } = {};
    await this.update(target, (ledger, tab) => {
      fallback.row = undefined;
      const row = ledger.rows.find((candidate) => candidate.id === rowId);
      if (
        !row ||
        ledger.epoch !== epoch ||
        this.isSuspended(target) ||
        // Ordinary delivery re-reads approval authority when its turn starts,
        // so a message narrower than the chat still goes that way.
        !inputRequestMatchesNonApprovalSettings(row.payload, tab)
      ) {
        return ledger;
      }
      if (
        row.currentAttemptId !== attemptId ||
        !['sending', 'pending'].includes(row.state)
      ) {
        return ledger;
      }
      const {
        ordinaryContinuation: _previousContinuation,
        ...rowWithoutContinuation
      } = row;
      void _previousContinuation;
      const cancelled: InputRow = {
        ...rowWithoutContinuation,
        revision: row.revision + 1,
        state: 'cancelled',
        reason: `${reason}. Falling back to ordinary delivery.`,
        ...(isGeneratedInputRequest(row.payload)
          ? { ordinaryContinuation: { attemptId, epoch: ledger.epoch } }
          : {}),
      };
      fallback.row = cancelled;
      return {
        ...ledger,
        rows: ledger.rows.map((candidate) =>
          candidate.id === rowId ? cancelled : candidate,
        ),
      };
    });
    const cancelled = fallback.row;
    if (!cancelled) return false;
    // Carry the captured intent even if evidence already invalidates it. The
    // queue transaction must reject that intent, not fall back to an unfenced
    // typed restore that could overwrite a pickup or an explicit user action.
    const continuation = cancelled.ordinaryContinuation;
    // The requeue caller hands the cancelled row back to its queue.
    if (ordinaryFallback === 'requeue') {
      if (lateSettlement) {
        const { getChatQueueService } = await import('./chat-queue-service');
        try {
          await getChatQueueService().restoreWithdrawnInput(
            cancelled.payload,
            cancelled.id,
            undefined,
            epoch,
            cancelled.origin,
            undefined,
            {
              ordinaryOnly: true,
              waitForQueue: true,
              ...(continuation ? { continuation } : {}),
            },
          );
        } catch (error) {
          this.recordRowOutcome(
            target,
            cancelled,
            attemptId,
            'rejected-final',
            {
              refusal,
            },
          );
          throw error;
        }
      }
      this.recordRowOutcome(target, cancelled, attemptId, 'rejected-requeued', {
        refusal,
      });
      return true;
    }
    const { getChatQueueService } = await import('./chat-queue-service');
    try {
      await getChatQueueService().restoreWithdrawnInput(
        cancelled.payload,
        cancelled.id,
        undefined,
        epoch,
        cancelled.origin,
        undefined,
        continuation
          ? {
              ordinaryOnly: true,
              ...(lateSettlement ? { waitForQueue: true } : {}),
              continuation,
            }
          : lateSettlement
            ? { waitForQueue: true }
            : undefined,
      );
    } catch (error) {
      this.recordRowOutcome(target, cancelled, attemptId, 'rejected-final', {
        refusal,
      });
      throw error;
    }
    this.recordRowOutcome(target, cancelled, attemptId, 'rejected-requeued', {
      refusal,
    });
    return true;
  }

  private async markNeverSent(
    target: Target,
    rowId: string,
    attemptId: string,
    epoch: number | undefined,
    reason: string,
    refusal: ChatInputRefusal | undefined,
  ): Promise<boolean> {
    this.handoffsByAttempt.delete(attemptId);
    const settled: { row?: InputRow } = {};
    await this.update(target, (ledger) => {
      settled.row = undefined;
      if (
        epoch !== undefined &&
        (ledger.epoch !== epoch || this.isSuspended(target))
      )
        return ledger;
      return {
        ...ledger,
        rows: ledger.rows.map((row) => {
          if (
            row.id !== rowId ||
            row.currentAttemptId !== attemptId ||
            !['sending', 'pending'].includes(row.state)
          )
            return row;
          const cancelled: InputRow = {
            ...row,
            revision: row.revision + 1,
            state: 'cancelled',
            reason,
          };
          settled.row = cancelled;
          return cancelled;
        }),
      };
    });
    if (settled.row)
      this.recordRowOutcome(target, settled.row, attemptId, 'rejected-final', {
        refusal,
      });
    return settled.row !== undefined;
  }

  async observe(
    target: Target,
    event: ChatInputDeliveryEvent,
  ): Promise<boolean> {
    return (await this.observeWithResult(target, event)).observed;
  }

  async observeWithResult(
    target: Target,
    event: ChatInputDeliveryEvent,
    settlementFence?: PendingSubmitSettlementFence,
    historyFence?: HistoryResolutionFence,
  ): Promise<InputDeliveryObservation> {
    let matched = false;
    let wroteFreshRuntimeRoot = false;
    const pickup: { row?: InputRow } = {};
    const pickupQuestion: { question?: PersistedPendingQuestion } = {};
    const restoredQueuePickup: { rowId?: string } = {};
    const queueContinuation: { row?: InputRow; epoch?: number } = {};
    const settlement: { value?: AttemptSettlement } = {};
    const rootEpoch = event.startsTurn
      ? (await this.tabIncludingArchived(target)).inputDelivery?.epoch
      : undefined;
    // Only the owning session's live generation can vouch for a late
    // acknowledgement, so it is read before the transaction. A failed lookup
    // leaves uncertainty in place.
    const live = event.startsTurn
      ? await this.capabilities(target)
      : await this.capabilities(target).catch(() => undefined);
    const liveGeneration =
      live?.provider === event.provider ? live.generation : undefined;
    let committedEvent = event;
    const commit = await this.repository.transactWith(
      target,
      (current) => {
        settlement.value = undefined;
        if (historyFence) historyFence.matched = false;
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        const archived = liveTab
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === target.chatId,
            );
        const tab = liveTab ?? archived?.tab;
        if (!tab || !isInputLedger(tab.inputDelivery)) return [];
        const acceptsRoot =
          event.startsTurn === true &&
          event.turnRootAccepted !== false &&
          rootEpoch === tab.inputDelivery.epoch &&
          !this.isSuspended(target);
        const effectiveEvent =
          event.startsTurn === true && !acceptsRoot
            ? { ...event, turnRootAccepted: false }
            : event;
        committedEvent = effectiveEvent;
        const previousRow = tab.inputDelivery.rows.find((candidate) =>
          candidate.attempts.some(
            (attempt) =>
              attempt.id === event.attemptId &&
              attempt.generation === event.generation &&
              attempt.provider === event.provider,
          ),
        );
        const previousAttempt = previousRow?.attempts.find(
          (attempt) =>
            attempt.id === event.attemptId &&
            attempt.generation === event.generation &&
            attempt.provider === event.provider,
        );
        if (historyFence) {
          historyFence.matched =
            tab.inputDelivery.epoch === historyFence.epoch &&
            !this.isSuspended(target) &&
            previousRow?.id === historyFence.rowId &&
            previousRow.currentAttemptId === historyFence.currentAttemptId;
          if (!historyFence.matched) return [];
        }
        if (settlementFence) {
          settlementFence.matched =
            tab.inputDelivery.epoch === settlementFence.epoch &&
            !this.isSuspended(target) &&
            previousRow?.id === settlementFence.rowId &&
            previousRow.currentAttemptId === event.attemptId &&
            previousRow.state === 'pending';
          if (!settlementFence.matched) return [];
        }
        const next = observeInputDelivery(
          tab.inputDelivery,
          effectiveEvent,
          Date.now(),
          liveGeneration,
        );
        const row = next.rows.find((candidate) =>
          candidate.attempts.some(
            (attempt) =>
              attempt.id === event.attemptId &&
              attempt.generation === event.generation &&
              attempt.provider === event.provider,
          ),
        );
        const pickedUpAttempt = row?.attempts.find(
          (attempt) => attempt.id === event.attemptId,
        );
        matched =
          pickedUpAttempt?.pickedUpAt !== undefined &&
          event.phase === 'picked-up';
        if (matched && row) {
          pickup.row = row;
          const pickupPayload = pickedUpAttempt?.payloadSnapshot ?? row.payload;
          const asyncQuestionId = pickupPayload.asyncQuestionId;
          const question = asyncQuestionId
            ? current.tabsFile.pendingQuestions?.find(
                (candidate) =>
                  candidate.chatId === target.chatId &&
                  candidate.requestId === asyncQuestionId &&
                  candidate.delivery === 'async' &&
                  candidate.answeredAt !== undefined &&
                  candidate.answers !== undefined,
              )
            : undefined;
          if (question) pickupQuestion.question = question;
        }
        if (
          matched &&
          (pickedUpAttempt?.withdrawnAt !== undefined || historyFence) &&
          row
        ) {
          restoredQueuePickup.rowId = row.id;
        }
        if (
          !archived &&
          event.phase === 'withdrawn' &&
          row?.state === 'cancelled' &&
          row.queueIntent
        ) {
          queueContinuation.row = row;
          queueContinuation.epoch = row.queueIntent.epoch ?? next.epoch;
        }
        if (next === tab.inputDelivery) return [];
        if (
          row &&
          previousRow &&
          previousAttempt &&
          pickedUpAttempt &&
          !attemptWasSettled(previousRow, previousAttempt)
        ) {
          if (
            event.phase === 'picked-up' &&
            pickedUpAttempt.pickedUpAt !== undefined
          ) {
            settlement.value = {
              row,
              attempt: pickedUpAttempt,
              outcome: 'picked-up',
            };
          } else if (
            event.phase === 'withdrawn' &&
            pickedUpAttempt.withdrawnAt !== undefined
          ) {
            settlement.value = {
              row,
              attempt: pickedUpAttempt,
              outcome: 'withdrawn',
            };
          } else if (
            event.phase === 'unknown' &&
            pickedUpAttempt.uncertainAt !== undefined
          ) {
            settlement.value = {
              row,
              attempt: pickedUpAttempt,
              ...unknownDeliveryOutcome(event.failure),
            };
          }
        }
        const pickedUpPayload =
          pickedUpAttempt?.payloadSnapshot ?? row?.payload;
        const existingPickedUpMessage = row
          ? tab.messages.find((message) => message.id === row.id)
          : undefined;
        const shouldMaterialize =
          matched && row !== undefined && !existingPickedUpMessage;
        const shouldUpdateRecognizedAnswer =
          matched &&
          row !== undefined &&
          existingPickedUpMessage !== undefined &&
          pickupQuestion.question !== undefined;
        const shouldWritePickedUpMessage =
          shouldMaterialize || shouldUpdateRecognizedAnswer;
        const automationInfoMessage =
          shouldMaterialize && row && pickedUpPayload
            ? buildAutomationInfoMessage(
                pickedUpPayload,
                row.id,
                tab.messages,
                row.createdAt,
              )
            : null;
        const shouldAddAutomationInfoMessage =
          automationInfoMessage !== null &&
          !tab.messages.some(
            (message) => message.id === automationInfoMessage.id,
          );
        const consumed = pickedUpPayload?.pendingSystemInstructions ?? [];
        const remaining = tab.pendingSystemInstructions?.filter(
          (instruction) =>
            !consumed.some(
              (sent) =>
                sent.id === instruction.id && sent.text === instruction.text,
            ),
        );
        const shouldConsumeInstructions =
          matched &&
          remaining !== undefined &&
          remaining.length !== tab.pendingSystemInstructions?.length;
        if (archived) {
          const messages =
            shouldWritePickedUpMessage && row
              ? existingPickedUpMessage
                ? tab.messages.map((message) =>
                    message.id === row.id
                      ? materializePickedUpMessage(
                          row,
                          pickedUpAttempt,
                          effectiveEvent,
                          pickupQuestion.question,
                        )
                      : message,
                  )
                : [
                    ...tab.messages,
                    ...(shouldAddAutomationInfoMessage && automationInfoMessage
                      ? [automationInfoMessage]
                      : []),
                    materializePickedUpMessage(
                      row,
                      pickedUpAttempt,
                      effectiveEvent,
                      pickupQuestion.question,
                    ),
                  ]
              : tab.messages;
          const archivedTab = {
            ...tab,
            inputDelivery: next,
            messages,
            ...(shouldConsumeInstructions
              ? { pendingSystemInstructions: remaining }
              : {}),
          };
          return [
            {
              type: 'archive.upserted',
              entry: {
                ...archived,
                tab: archivedTab,
                turnCount: messages.filter((message) => message.role === 'user')
                  .length,
              },
            },
          ];
        }
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: target.chatId,
            patch: { inputDelivery: next },
          },
        ];
        if (shouldWritePickedUpMessage && row) {
          if (shouldConsumeInstructions) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: target.chatId,
              patch: { pendingSystemInstructions: remaining },
            });
          }
          if (shouldAddAutomationInfoMessage && automationInfoMessage) {
            mutations.push({
              type: 'message.upserted',
              chatId: target.chatId,
              message: automationInfoMessage,
            });
          }
          mutations.push({
            type: 'message.upserted',
            chatId: target.chatId,
            message: materializePickedUpMessage(
              row,
              pickedUpAttempt,
              effectiveEvent,
              pickupQuestion.question,
            ),
          });
          if (shouldMaterialize && acceptsRoot) {
            // Canonical turn state owns the root timer row and runtime.
            wroteFreshRuntimeRoot =
              acceptsRoot &&
              event.phase === 'picked-up' &&
              event.startsTurn === true &&
              event.turnRootAccepted !== false &&
              event.userMessageId === row.id &&
              previousRow?.id === row.id &&
              previousRow?.currentAttemptId === event.attemptId &&
              previousAttempt?.pickedUpAt === undefined &&
              previousAttempt?.turnOutcome === undefined &&
              previousAttempt?.turnSettledAt === undefined;
          }
        }
        return mutations;
      },
      {
        source: 'provider',
        mutationId: `input:${event.generation}:${event.attemptId}:${event.phase}`,
        chatIds: [target.chatId],
      },
    );
    if (commit.applied && settlement.value)
      this.recordOutcome(target, settlement.value);
    if (commit.applied && matched && pickup.row) {
      // The provider has the request now. Its delivery id leaves the root's
      // admitted set, so nothing can replay it and the set stays bounded.
      delegationDeliveryOwnership(pickup.row.payload)?.retire();
      const source = resolvePresentationSource(
        pickup.row.payload,
        pickup.row.origin === 'portal' ? 'portal' : 'user',
      );
      const handoffsAtSend = this.handoffsByAttempt.get(event.attemptId) ?? [];
      this.handoffsByAttempt.delete(event.attemptId);
      if (source === 'user' || source === 'portal') {
        for (const id of handoffsAtSend) browserHandoffs.release(id);
      }
      if (
        committedEvent.startsTurn &&
        committedEvent.turnRootAccepted !== false
      ) {
        recordPresentationTurn(
          presentationChatKey({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatTabId: target.chatId,
          }),
          pickup.row.id,
          resolvePresentationSource(
            pickup.row.payload,
            pickup.row.origin === 'portal' ? 'portal' : 'user',
          ),
        );
      }
      await this.onPickup(target, pickup.row, committedEvent);
    }
    if (commit.applied && restoredQueuePickup.rowId) {
      const { getChatQueueService } = await import('./chat-queue-service');
      await getChatQueueService().consumeRestoredInput(
        target,
        restoredQueuePickup.rowId,
      );
    }
    if (queueContinuation.row && queueContinuation.epoch !== undefined) {
      await this.restoreQueueContinuation(
        target,
        queueContinuation.row,
        queueContinuation.epoch,
      );
    }
    const observed = commit.applied && matched;
    const isStartingPickup =
      event.phase === 'picked-up' && event.startsTurn === true;
    let pickupVerdict: ChatPickupVerdict | undefined;
    if (isStartingPickup) {
      const proofEpoch = rootEpoch;
      const hasCommittedProof =
        proofEpoch !== undefined &&
        hasCommittedStartingPickupProof(
          commit.state,
          target,
          event,
          proofEpoch,
        );
      const routingAccepted = event.turnRootAccepted !== false;
      const notSuspended = !this.isSuspended(target);
      if (
        commit.applied &&
        wroteFreshRuntimeRoot &&
        hasCommittedProof &&
        routingAccepted &&
        notSuspended
      ) {
        pickupVerdict = 'accepted';
      } else if (
        // Acceptance epochs are not persisted on attempts. Restrict repeat
        // proof to epoch zero: a ledger-only Stop can advance the epoch while
        // leaving the old active root intact, so a later repeat in a nonzero
        // epoch is indistinguishable from that stale root. Rejecting it also
        // means an ambiguous commit retry at nonzero epoch cannot be proven.
        proofEpoch === 0 &&
        hasCommittedStartingPickupProof(commit.state, target, event, 0) &&
        routingAccepted &&
        notSuspended
      ) {
        pickupVerdict = 'already-accepted';
      } else {
        pickupVerdict = 'rejected';
      }
    }
    return {
      observed,
      ...(pickupVerdict !== undefined ? { pickup: pickupVerdict } : {}),
    };
  }

  async capabilities(
    target: Target,
  ): Promise<ChatSteeringCapabilities | undefined> {
    const session = await this.sessionFor(target);
    return session && !session.isDisposed?.()
      ? session.getSteeringCapabilities?.()
      : undefined;
  }

  /**
   * `observed` is the ledger the caller already read. When restoring it would
   * change nothing, no transaction runs: a row added since carries the live
   * generation, and one that went stale since is recovered on the next read.
   */
  async recover(target: Target, observed?: InputLedger): Promise<void> {
    const session = await this.sessionFor(target);
    const liveGeneration =
      session && !session.isDisposed?.()
        ? session.getSteeringCapabilities?.().generation
        : undefined;
    if (observed && restoreInputLedger(observed, liveGeneration) === observed)
      return;
    const settled: { rows: InputRow[]; at: number } = { rows: [], at: 0 };
    await this.update(target, (ledger) => {
      const next = restoreInputLedger(ledger, liveGeneration);
      settled.at = Date.now();
      settled.rows = next.rows.filter(
        (row, index) => row !== ledger.rows[index],
      );
      return next;
    });
    for (const row of settled.rows) {
      const attempt = row.attempts.find(
        (candidate) => candidate.id === row.currentAttemptId,
      );
      // Recovery only touches sending, pending and cancelling rows, so the
      // attempt's own evidence tells whether it settled before the restart.
      if (!attempt || attemptHasSettlementEvidence(attempt)) continue;
      this.recordOutcome(target, {
        row,
        attempt,
        outcome: 'unknown-restart',
        failure: chatInputDeliveryFailure('host-restart'),
        uncertainAt: settled.at,
      });
    }
  }

  async stop(target: Target, operation: () => Promise<void>): Promise<void> {
    const key = this.key(target);
    this.suspended.set(key, (this.suspended.get(key) ?? 0) + 1);
    try {
      try {
        // Provider cleanup must still run if the session disappears while
        // Stop is taking ownership of the delivery ledger.
        const capabilities = await this.capabilities(target).catch(
          () => undefined,
        );
        const stopped: {
          settlements: AttemptSettlement[];
        } = { settlements: [] };
        await this.update(target, (ledger) => {
          stopped.settlements = [];
          const now = Date.now();
          return {
            ...ledger,
            epoch: ledger.epoch + 1,
            rows: ledger.rows.map((row) => {
              const attempt = row.attempts.find(
                (candidate) => candidate.id === row.currentAttemptId,
              );
              // A pending row without admission evidence was handed over
              // unconfirmed, so the provider may hold it just the same.
              if (
                row.state === 'pending' &&
                capabilities?.withdraw === false &&
                attempt !== undefined &&
                attempt.pickedUpAt === undefined
              ) {
                const uncertain: InputRow = {
                  ...row,
                  revision: row.revision + 1,
                  state: 'uncertain',
                  reason:
                    'The turn was stopped before pickup could be confirmed. This message will not be resent automatically.',
                };
                if (!attemptWasSettled(row, attempt))
                  stopped.settlements.push({
                    row: uncertain,
                    attempt,
                    outcome: 'unknown-restart',
                    failure: chatInputDeliveryFailure('stopped'),
                    uncertainAt: now,
                  });
                return uncertain;
              }
              return row.state === 'editing'
                ? {
                    ...row,
                    revision: row.revision + 1,
                    state: 'cancelled',
                    editResubmits: false,
                  }
                : row;
            }),
          };
        });
        for (const settlement of stopped.settlements)
          this.recordOutcome(target, settlement);
      } finally {
        await operation();
      }
    } finally {
      const remaining = (this.suspended.get(key) ?? 1) - 1;
      if (remaining) this.suspended.set(key, remaining);
      else this.suspended.delete(key);
    }
  }

  async action(envelope: ChatCommandEnvelope): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.input_delivery_action')
      throw new Error('Invalid delivery action');
    const target = {
      projectId: envelope.projectId,
      worktreeId: envelope.worktreeId,
      chatId: command.chatId,
    };
    const actionKey = `${this.key(target)}:${command.rowId}`;
    if (this.activeActions.has(actionKey) || this.isSuspended(target))
      throw new Error('Another message action is in progress');
    this.activeActions.add(actionKey);
    try {
      const tab = await this.tab(target);
      const ledger = tab.inputDelivery;
      if (!isInputLedger(ledger))
        throw new Error('Message history is unavailable');
      let row = ledger.rows.find((r) => r.id === command.rowId);
      const resumesInterruptedQueue =
        command.action === 'queue' &&
        row?.state === 'cancelled' &&
        row.queueIntent?.commandId === envelope.commandId;
      if (
        !row ||
        (row.revision !== command.rowRevision && !resumesInterruptedQueue)
      )
        throw new Error(
          'The message changed. Review its current status before trying again.',
        );
      if (row.dismissedAt !== undefined)
        throw new Error(
          'This action is unavailable for the current message status',
        );
      const epoch = ledger.epoch;
      let actionRevision = row.revision;
      if (
        row.payload.projectId !== target.projectId ||
        row.payload.worktreeId !== target.worktreeId ||
        row.payload.chatId !== target.chatId ||
        row.payload.userMessageId !== row.id
      )
        throw new Error('This message belongs to another chat');
      const session =
        command.action === 'dismiss'
          ? undefined
          : await this.sessionFor(target);
      const receipt: Receipt = {
        commandId: envelope.commandId,
        outcome: 'applied',
        entityId: command.rowId,
      };
      let receiptCommitted = false;
      const replace = async (
        change: (
          r: InputRow,
          rootUserMessageId: string | undefined,
        ) => InputRow,
        commandReceipt?: Receipt,
        reopenedQuestionId?: string,
      ): Promise<void> => {
        await this.update(
          target,
          (current, _tab, rootUserMessageId) => {
            if (current.epoch !== epoch || this.isSuspended(target))
              throw new Error(
                'Stop or Interrupt superseded this message action',
              );
            const currentRow = current.rows.find((r) => r.id === command.rowId);
            if (!currentRow || currentRow.revision !== actionRevision)
              throw new Error(
                'The message changed before this action could complete',
              );
            actionRevision++;
            return {
              ...current,
              rows: current.rows.map((r) =>
                r.id === command.rowId
                  ? {
                      ...change(r, rootUserMessageId),
                      revision: r.revision + 1,
                    }
                  : r,
              ),
            };
          },
          commandReceipt,
          reopenedQuestionId
            ? (state): ChatCoreMutation[] =>
                reopenAsyncQuestionMutations(
                  state.tabsFile.pendingQuestions,
                  target.chatId,
                  reopenedQuestionId,
                )
            : [],
        );
      };
      if (
        command.action === 'resend' &&
        row.state === 'uncertain' &&
        (await this.checkHistoryBeforeResend(target, row, epoch))
      ) {
        return {
          commandId: envelope.commandId,
          revision: await this.repository.getRevision(target),
          outcome: 'applied',
          entityId: command.rowId,
        };
      }
      if (
        command.action === 'dismiss' &&
        (row.state === 'uncertain' ||
          // A cancelled row still owing its queue restore is not settled yet.
          (row.state === 'cancelled' &&
            row.queueIntent === undefined &&
            validOrdinaryContinuation(ledger, row) === undefined))
      ) {
        await replace((r) => ({ ...r, dismissedAt: Date.now() }), receipt);
      } else if (
        ['cancel', 'queue', 'edit'].includes(command.action) &&
        (row.state === 'pending' ||
          (command.action === 'queue' && row.state === 'cancelling'))
      ) {
        const attempt = row.attempts.find(
          (a) => a.id === row?.currentAttemptId,
        );
        const caps = session?.getSteeringCapabilities?.();
        if (
          !attempt ||
          !session?.withdrawSteeringInput ||
          !caps?.withdraw ||
          caps.generation !== attempt.generation
        )
          throw new Error('This session cannot safely withdraw the message');
        if (row.state === 'pending') {
          const commitBeforeWithdrawal = command.action !== 'queue';
          await replace(
            (r) => ({
              ...r,
              state: 'cancelling',
              ...(command.action === 'queue'
                ? {
                    queueIntent: {
                      commandId: envelope.commandId,
                      epoch,
                    },
                  }
                : {}),
            }),
            commitBeforeWithdrawal ? receipt : undefined,
          );
          receiptCommitted = commitBeforeWithdrawal;
        }
        const outcome = await session.withdrawSteeringInput(attempt.id);
        if (outcome.kind !== 'withdrawn') {
          await this.observe(target, {
            type: 'canopy_input_delivery',
            provider: attempt.provider,
            generation: attempt.generation,
            attemptId: attempt.id,
            phase: outcome.kind === 'picked-up' ? 'picked-up' : 'unknown',
          });
          if (!receiptCommitted) {
            const observed = (await this.tab(target)).inputDelivery?.rows.find(
              (candidate) => candidate.id === command.rowId,
            );
            if (observed) actionRevision = observed.revision;
            await this.update(
              target,
              (current) => ({
                ...current,
                rows: current.rows.map((candidate) =>
                  candidate.id === command.rowId
                    ? {
                        ...candidate,
                        revision: candidate.revision + 1,
                        queueIntent: undefined,
                      }
                    : candidate,
                ),
              }),
              receipt,
            );
          }
          return {
            commandId: envelope.commandId,
            revision: await this.repository.getRevision(target),
            outcome: 'applied',
          };
        }
        await this.observe(target, {
          type: 'canopy_input_delivery',
          provider: attempt.provider,
          generation: attempt.generation,
          attemptId: attempt.id,
          phase: 'withdrawn',
        });
        if (command.action === 'queue') {
          const observedLedger = (await this.tab(target)).inputDelivery;
          const observedRow = isInputLedger(observedLedger)
            ? observedLedger.rows.find(
                (candidate) => candidate.id === command.rowId,
              )
            : undefined;
          if (observedRow?.state === 'cancelled' && observedRow.queueIntent) {
            await this.restoreQueueContinuation(
              target,
              observedRow,
              observedRow.queueIntent.epoch ?? observedLedger?.epoch ?? epoch,
            );
          }
        }
        // Lazy by design: the queue service constructs this coordinator, so a
        // static reverse import would create an initialization cycle. The
        // packaged Electron main build exercises this local import path.
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().releaseInputOwnership(target);
        const current = (await this.tab(target)).inputDelivery;
        row = current?.rows.find((r) => r.id === command.rowId);
        if (row) actionRevision = row.revision;
        if (command.action === 'queue' && row?.state === 'queued')
          receiptCommitted = true;
        else if (!row || row.state !== 'cancelled')
          throw new Error('Withdrawal was superseded by provider pickup');
        if (command.action === 'edit')
          await replace((r) => ({
            ...r,
            state: 'editing',
            draft: r.text,
            editResubmits: true,
          }));
      } else if (command.action === 'edit' && row.state === 'cancelled') {
        await replace(
          (r) => ({
            ...r,
            state: 'editing',
            draft: r.draft ?? r.text,
            editResubmits: false,
          }),
          receipt,
        );
      } else if (command.action === 'close-editor' && row.state === 'editing') {
        await replace(
          (r) => ({
            ...r,
            state: 'cancelled',
            draft: command.text ?? r.draft,
            editResubmits: false,
          }),
          receipt,
        );
      } else if (command.action === 'save-draft' && row.state === 'editing') {
        await replace(
          (r) => ({ ...r, draft: command.text ?? r.draft }),
          receipt,
        );
      } else if (
        command.action === 'save' &&
        row.state === 'editing' &&
        !row.editResubmits
      ) {
        const saved = requestWithText(
          row.payload,
          command.text ?? row.draft ?? row.text,
        );
        await replace(
          (r) => ({
            ...r,
            state: 'cancelled',
            text: saved.request.text,
            payload: saved.request,
            draft: undefined,
          }),
          receipt,
          saved.reopenedQuestionId,
        );
      } else if (
        !(
          ['resend', 'resend-original', 'save', 'queue'].includes(
            command.action,
          ) &&
          (['cancelled', 'editing'].includes(row.state) ||
            (command.action === 'resend' && row.state === 'uncertain'))
        )
      ) {
        throw new Error(
          'This action is unavailable for the current message status',
        );
      }
      if (command.action === 'queue' && !receiptCommitted) {
        const queued = requestWithText(row.payload, row.draft ?? row.text);
        const queuedRequest = queued.request;
        await this.prepare(queuedRequest, session);
        // Host queue insertion is handled through its canonical persistence hook.
        // Keep the reverse queue import lazy to avoid the coordinator/queue
        // initialization cycle; the packaged Electron main build covers it.
        const { getChatQueueService } = await import('./chat-queue-service');
        await getChatQueueService().restoreWithdrawnInput(
          queuedRequest,
          command.rowId,
          receiptCommitted ? undefined : receipt,
          epoch,
          row.origin,
          queued.reopenedQuestionId,
        );
      } else if (
        command.action === 'resend' ||
        command.action === 'resend-original' ||
        (command.action === 'save' && row.editResubmits)
      ) {
        const latest = await this.tab(target);
        if (!inputSettingsKeyMatchesNonApproval(latest, row.settingsKey))
          throw new Error(
            'Chat settings changed. The message is retained; use Queue to send it with its saved settings.',
          );
        const resent = requestWithText(
          row.payload,
          command.action === 'resend-original'
            ? row.text
            : (command.text ?? row.draft ?? row.text),
        );
        const request = resent.request;
        const workOwner = await resolveAiCreditsScopeOwner({
          kind: 'work',
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        });
        if (
          await isModelBlockedByStoredPolicy(
            request.model ?? latest.model,
            workOwner,
          )
        )
          throw new Error('This model is blocked by your organization policy.');
        await this.authorize({ ...target, tab: latest });
        const text = await this.prepare(request, session);
        const steeringRead = await readSteeringApproval(request, latest);
        const approvalRefused =
          session !== undefined &&
          !this.steerable(request, latest, session, steeringRead);
        if (
          approvalRefused ||
          !session?.getSteeringCapabilities?.().steer ||
          session.isDisposed?.()
        ) {
          const runtime = (await this.repository.getState(target))
            .runtimeByChatId[target.chatId];
          if (
            !approvalRefused &&
            runtime &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            )
          )
            throw new Error(
              'The active session cannot accept this message. Use Queue.',
            );
          // Queue ownership transfer and drain use the same atomic persistence
          // path as Move to queued, including when the chat is already idle.
          // Keep the reverse queue import lazy to avoid the coordinator/queue
          // initialization cycle; the packaged Electron main build covers it.
          const { getChatQueueService } = await import('./chat-queue-service');
          await getChatQueueService().restoreWithdrawnInput(
            request,
            command.rowId,
            receipt,
            epoch,
            row.origin,
            resent.reopenedQuestionId,
            command.action === 'resend' && row.state === 'uncertain'
              ? { allowUncertain: true }
              : undefined,
          );
        } else {
          const caps = session.getSteeringCapabilities();
          const attemptId = randomUUID();
          const steeringTarget: SteeringTarget | undefined =
            session.getSteeringTarget?.();
          await replace(
            (r, rootUserMessageId) => ({
              ...r,
              state: 'sending',
              text: request.text,
              payload: request,
              draft: undefined,
              queueIntent: undefined,
              currentAttemptId: attemptId,
              attempts: [
                ...r.attempts,
                {
                  id: attemptId,
                  generation: caps.generation,
                  provider: caps.provider,
                  createdAt: Date.now(),
                  submittedText: text,
                  displayText: request.text,
                  payloadSnapshot: structuredClone(request),
                  ...(steeringTarget ? { target: steeringTarget } : {}),
                  rootUserMessageId,
                },
              ],
            }),
            receipt,
            resent.reopenedQuestionId,
          );
          await this.submit(
            target,
            session,
            command.rowId,
            attemptId,
            epoch,
            text,
            steeringRead,
          );
        }
      }
      return {
        commandId: envelope.commandId,
        revision: await this.repository.getRevision(target),
        outcome: 'applied',
        entityId: command.rowId,
      };
    } finally {
      this.activeActions.delete(actionKey);
    }
  }
}
