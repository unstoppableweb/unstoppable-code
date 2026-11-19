import { create } from 'zustand';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import {
  aiCreditsConfirmationBalanceLoader,
  personalBalanceReading,
  readAiCreditsConfirmationBalance,
  type AiCreditsConfirmationBalanceOutcome,
  type PersonalBalanceReading,
} from '@/lib/aiCreditsConfirmationBalance';
import type { PendingModelUnlockIntent } from '@/lib/modelUnlockIntent';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';

/**
 * The in-chat confirmation of a confirmed advanced-model unlock (CAN-5027).
 *
 * Presentation state only, kept in renderer memory and deliberately apart
 * from the pending intent in `modelUnlockIntent`: navigation drops a pending
 * intent's follow-up, but the purchase it confirmed still happened, so the
 * confirmation stays until it is dismissed, replaced by a newer one, or its
 * account goes away.
 *
 * Bounded to ONE visible confirmation. The request ids seen in this account
 * session are remembered separately, so a duplicate or late delivery of a
 * request the user already dismissed (or one a newer confirmation replaced)
 * can never bring it back. Both are dropped with the account session.
 *
 * Whether the model is selected is NOT stored here: the notice reads the
 * chat's live model, so an apply failure, a retry, and a manual change all
 * show as what is actually true.
 */

export interface ModelUnlockConfirmation {
  readonly requestId: string;
  readonly accountId: string;
  /** `personal` or `org:<id>`, as checkout was opened for. */
  readonly owner: string;
  /** The chat the purchase started in; the notice shows only there. */
  readonly chatId: string;
  readonly scope: Readonly<Extract<AiCreditsScopeRequest, { kind: 'work' }>>;
  /** The model the unlock was for, when there was one. */
  readonly modelId: string | null;
  /** The balance read before checkout opened, when there was one. */
  readonly startingBalance: PersonalBalanceReading | null;
}

/**
 * The refreshed balance read for one confirmation under one scope. `credits`
 * is set only for a usable (finite, positive) personal balance.
 */
interface ModelUnlockConfirmationBalance {
  readonly requestId: string;
  readonly scopeKey: string;
  readonly credits: number | null;
  /**
   * The increase over the starting balance, only when both readings are the
   * same wallet.
   */
  readonly addedCredits: number | null;
}

interface ModelUnlockConfirmationState {
  readonly accountReady: boolean;
  readonly confirmation: ModelUnlockConfirmation | null;
  readonly balance: ModelUnlockConfirmationBalance | null;
}

export const useModelUnlockConfirmationStore =
  create<ModelUnlockConfirmationState>(() => ({
    accountReady: true,
    confirmation: null,
    balance: null,
  }));

/**
 * Delays after the first balance read finishes at which it is retried while
 * the purchase may still be settling. Two retries, then the fallback stays.
 */
export const MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS = [1_500, 4_000] as const;

/**
 * The account this session's confirmations belong to. `undefined` until the
 * first confirmation or account read establishes it; `null` once signed out.
 */
let sessionAccountKey: string | null | undefined;
/** Every request confirmed in this account session, dismissed or not. */
const seenRequestIds = new Set<string>();

interface BalanceRun {
  readonly requestId: string;
  readonly scopeKey: string;
  readonly scope: AiCreditsScopeRequest;
  consumers: number;
  attempts: number;
  firstFinishedAt: number | null;
  finished: boolean;
  credits: number | null;
  /** The last usable personal reading, for the amount added. */
  reading: PersonalBalanceReading | null;
  generation: number;
  pending: boolean;
  wake: (() => void) | null;
}

// Only the visible confirmation owns runs. Keep each scope's spent budget and
// snapshot through navigation; clearing/replacing the confirmation drops all.
const balanceRuns = new Map<string, BalanceRun>();
let balanceRun: BalanceRun | null = null;

function suspendBalanceRun(run: BalanceRun): void {
  run.generation++;
  run.wake?.();
  run.wake = null;
  if (balanceRun === run) balanceRun = null;
}

function cancelBalanceRun(): void {
  balanceRuns.forEach(suspendBalanceRun);
  balanceRuns.clear();
}

/**
 * Remember a confirmed unlock for its chat. Returns whether it is now the
 * visible confirmation.
 *
 * Refused for an intent with no chat (the toast alone covers it, and it must
 * not replace another chat's confirmation), for a request already seen in
 * this account session, and for an intent from another account session.
 */
export function recordModelUnlockConfirmation(
  intent: PendingModelUnlockIntent,
): boolean {
  if (!useModelUnlockConfirmationStore.getState().accountReady) return false;
  if (
    intent.chatId === null ||
    intent.scope?.kind !== 'work' ||
    intent.scope.chatId !== intent.chatId
  )
    return false;
  if (sessionAccountKey === undefined) {
    sessionAccountKey = intent.accountId;
  } else if (sessionAccountKey !== intent.accountId) {
    return false;
  }
  if (seenRequestIds.has(intent.requestId)) return false;
  seenRequestIds.add(intent.requestId);
  cancelBalanceRun();
  useModelUnlockConfirmationStore.setState({
    confirmation: {
      requestId: intent.requestId,
      accountId: intent.accountId,
      owner: intent.owner,
      chatId: intent.chatId,
      scope: { ...intent.scope },
      modelId: intent.modelId,
      startingBalance: intent.startingBalance ?? null,
    },
    balance: null,
  });
  return true;
}

/**
 * Dismiss one confirmation. Naming the request means a late dismissal of an
 * older notice cannot remove the newer one that replaced it.
 */
export function dismissModelUnlockConfirmation(requestId: string): void {
  if (
    useModelUnlockConfirmationStore.getState().confirmation?.requestId !==
    requestId
  ) {
    return;
  }
  cancelBalanceRun();
  useModelUnlockConfirmationStore.setState({
    confirmation: null,
    balance: null,
  });
}

/**
 * Bring the confirmation in line with the saved account. Sign-out (`null`),
 * an unreadable account, and an account switch all end the session: the
 * confirmation, its balance, and the seen request ids go with it.
 */
export function reconcileModelUnlockConfirmationAccount(
  accountKey: string | null,
): void {
  useModelUnlockConfirmationStore.setState({ accountReady: true });
  if (sessionAccountKey === accountKey) return;
  const hadSession = sessionAccountKey !== undefined;
  sessionAccountKey = accountKey;
  if (!hadSession && accountKey !== null) return;
  seenRequestIds.clear();
  cancelBalanceRun();
  useModelUnlockConfirmationStore.setState({
    confirmation: null,
    balance: null,
  });
}

/** Hide account-bound state and invalidate reads while identity is rechecked. */
export function suspendModelUnlockConfirmationAccount(): void {
  balanceRuns.forEach(suspendBalanceRun);
  useModelUnlockConfirmationStore.setState({ accountReady: false });
}

/** Whether an account change has anything here to reconcile. */
export function hasModelUnlockConfirmationSession(): boolean {
  return sessionAccountKey !== undefined;
}

/** The confirmation to show for this complete work identity, or null. */
export function selectModelUnlockConfirmationForChat(
  state: ModelUnlockConfirmationState,
  target: ChatBannerTarget | null,
): ModelUnlockConfirmation | null {
  const { confirmation } = state;
  return state.accountReady &&
    target !== null &&
    confirmation?.chatId === target.chatId &&
    confirmation.scope.projectId === target.projectId &&
    (confirmation.scope.worktreeId ?? '') === target.worktreeId
    ? confirmation
    : null;
}

/**
 * The usable balance read for exactly this request and scope. Another
 * request's or scope's answer is never returned, even while a new read loads.
 */
export function selectModelUnlockConfirmationCredits(
  state: ModelUnlockConfirmationState,
  requestId: string | undefined,
  scopeKey: string,
): number | null {
  const { balance } = state;
  return state.accountReady &&
    balance !== null &&
    balance.requestId === requestId &&
    balance.scopeKey === scopeKey
    ? balance.credits
    : null;
}

/** The increase for exactly this request and scope, or null. */
export function selectModelUnlockConfirmationAdded(
  state: ModelUnlockConfirmationState,
  requestId: string | undefined,
  scopeKey: string,
): number | null {
  const { balance } = state;
  return state.accountReady &&
    balance !== null &&
    balance.requestId === requestId &&
    balance.scopeKey === scopeKey
    ? balance.addedCredits
    : null;
}

/**
 * The credits added since checkout opened. Claimed only when both readings
 * are the same wallet. A balance change, never a receipt.
 */
function addedSinceStart(
  start: PersonalBalanceReading | null,
  run: BalanceRun,
): number | null {
  const end = run.reading;
  if (start === null || end === null) return null;
  if (start.source !== end.source || start.email !== end.email) return null;
  const added = Math.round((end.credits - start.credits) * 100) / 100;
  return added > 0 ? added : null;
}

type BalanceAttempt = AiCreditsConfirmationBalanceOutcome;

/**
 * Read the refreshed personal balance for the visible confirmation, once per
 * confirmation and scope however many notices mount or effects replay.
 *
 * One read now, then up to two retries at
 * {@link MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS} after the first finishes,
 * never overlapping. Stops on a usable balance or a definitive organization
 * pool. The caller has already established that
 * the work's owner is the personal wallet the purchase funded.
 *
 * A positive balance can still precede the purchase's settlement; it is
 * reported as the available balance, never as the amount purchased.
 */
export function ensureModelUnlockConfirmationBalance(
  requestId: string,
  scope: AiCreditsScopeRequest,
  scopeKey: string,
): () => void {
  const { confirmation } = useModelUnlockConfirmationStore.getState();
  if (
    !useModelUnlockConfirmationStore.getState().accountReady ||
    confirmation?.requestId !== requestId
  )
    return (): void => {};
  const load = aiCreditsConfirmationBalanceLoader();
  if (load === null) return (): void => {};
  const run: BalanceRun = balanceRuns.get(scopeKey) ?? {
    requestId,
    scopeKey,
    scope,
    consumers: 0,
    attempts: 0,
    firstFinishedAt: null,
    finished: false,
    credits: null,
    reading: null,
    generation: 0,
    pending: false,
    wake: null,
  };
  balanceRuns.set(scopeKey, run);
  run.consumers++;
  if (balanceRun !== null && balanceRun !== run) suspendBalanceRun(balanceRun);
  balanceRun = run;
  const generation = run.generation;
  const isLive = (): boolean =>
    balanceRun === run &&
    run.generation === generation &&
    run.consumers > 0 &&
    useModelUnlockConfirmationStore.getState().confirmation?.requestId ===
      requestId;

  const attempt = async (): Promise<BalanceAttempt> => {
    run.attempts++;
    const read = await readAiCreditsConfirmationBalance(load, run.scope);
    if (!isLive()) return 'retry';
    if (read.outcome === 'usable') {
      run.credits = read.credits;
      run.reading = personalBalanceReading(read.response);
    }
    return read.outcome;
  };

  const publish = (): void => {
    if (!isLive()) return;
    const addedCredits = addedSinceStart(
      useModelUnlockConfirmationStore.getState().confirmation
        ?.startingBalance ?? null,
      run,
    );
    const previous = useModelUnlockConfirmationStore.getState().balance;
    if (
      previous?.requestId === requestId &&
      previous.scopeKey === scopeKey &&
      previous.credits === run.credits &&
      previous.addedCredits === addedCredits
    )
      return;
    useModelUnlockConfirmationStore.setState({
      balance: { requestId, scopeKey, credits: run.credits, addedCredits },
    });
  };

  const pump = async (): Promise<void> => {
    if (run.pending || !isLive()) return;
    if (run.finished) {
      publish();
      return;
    }
    run.pending = true;
    try {
      while (isLive() && !run.finished) {
        if (run.attempts >= 3) {
          run.finished = true;
          break;
        }
        const offset = MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS[run.attempts - 1];
        if (run.firstFinishedAt !== null && offset !== undefined) {
          const wait = Math.max(0, run.firstFinishedAt + offset - Date.now());
          await new Promise<void>((resolve) => {
            const timer = setTimeout((): void => {
              run.wake = null;
              resolve();
            }, wait);
            run.wake = (): void => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        if (!isLive()) break;
        const outcome = await attempt();
        run.firstFinishedAt ??= Date.now();
        if (!isLive()) break;
        run.finished = outcome !== 'retry' || run.attempts >= 3;
      }
      if (run.finished) publish();
    } finally {
      run.pending = false;
      // A remount may have retained this run while an invalidated IPC read
      // was pending. Resume only after it settles, using the remaining budget.
      if (!isLive() && balanceRun === run && run.consumers > 0) {
        const release = ensureModelUnlockConfirmationBalance(
          requestId,
          scope,
          scopeKey,
        );
        release();
      }
    }
  };
  void pump();
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    run.consumers--;
    // Strict Mode replays cleanup/setup synchronously. Let that matching
    // consumer retain the original read rather than spending another attempt.
    // A genuinely hidden run is already ineligible through consumers === 0.
    if (run.consumers === 0) {
      void Promise.resolve().then((): void => {
        if (run.consumers === 0) suspendBalanceRun(run);
      });
    }
  };
}
