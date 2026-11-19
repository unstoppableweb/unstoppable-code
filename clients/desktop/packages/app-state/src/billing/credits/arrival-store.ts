import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { CreditsArrivalHandle } from './purchase-store';
import type {
  CreditsAccountIdentityReader,
  CreditsBalanceReading,
  CreditsChatTarget,
  CreditsScopeRequest,
  CreditsWorkScope,
} from './types';

/**
 * The arrival confirmation after credits bought from a chat surface: the
 * usage-limit notice or the No billing source notice (CAN-5160).
 *
 * Presentation state in host memory only. A browser hand-off is tracked from
 * the Buy AI Credits click; the first covered return of a hand-off that
 * opened the browser records ONE confirmation for its chat. The notice reads
 * the personal balance again and names the observed increase when a
 * comparable baseline was read before the browser opened.
 *
 * Mirrors the CAN-5027 unlock confirmation's lifecycle: one visible record,
 * hand-off ids remembered for the account session so a duplicate return
 * cannot revive a dismissed record, and the whole session dropped on
 * sign-out or an account switch. An observed increase is a balance change,
 * never a purchase receipt.
 *
 * Buying from a chat is consent to spend the credits there (CAN-5159). Once
 * the surface routes that chat through credits, the record is marked
 * `routed`: the notice never shows it again, and the "Using AI Credits" card
 * shows its evidence until the first credits turn starts or the user
 * switches back.
 *
 * Each record names the surface that started it, and only that surface
 * shows it. A newer hand-off from either surface still supersedes the
 * other's record for the chat: there is one visible record.
 */

export interface CreditsArrival<TOrigin extends string = string> {
  readonly handoffId: string;
  readonly accountId: string;
  /** The chat the hand-off started in; the notice shows only there. */
  readonly chatId: string;
  readonly scope: CreditsWorkScope;
  /** The surface that started the hand-off; only it shows the record. */
  readonly origin: TOrigin;
}

/**
 * What the balance reads established. `final` is false while reads are still
 * running; the notice shows generic availability until then.
 */
export interface CreditsArrivalEvidence {
  readonly handoffId: string;
  readonly final: boolean;
  readonly addedCredits: number | null;
  readonly balanceCredits: number | null;
}

export interface CreditsArrivalState<TOrigin extends string = string> {
  readonly accountReady: boolean;
  readonly arrival: CreditsArrival<TOrigin> | null;
  readonly evidence: CreditsArrivalEvidence | null;
  /** The surface routed the record's chat through credits; card only. */
  readonly routed: boolean;
}

/** Read offsets from the first attempt's start. Never overlapping. */
export const CREDITS_ARRIVAL_READ_OFFSETS_MS = [0, 1_500, 4_000] as const;
/**
 * A read that has not answered by then ends the budget rather than starting
 * another request beside it, so a hung bridge still reaches a final title.
 */
export const CREDITS_ARRIVAL_READ_TIMEOUT_MS = 4_000;

/**
 * One classified balance read. `definitive` is organization funding;
 * `reading` is the buyer's comparable personal reading, when there is one.
 */
export interface CreditsArrivalBalanceRead {
  readonly outcome: 'usable' | 'definitive' | 'retry';
  readonly reading: CreditsBalanceReading | null;
}

/** Reads and classifies once; never rejects. */
export type CreditsArrivalBalanceReader = (
  scope: CreditsWorkScope,
) => Promise<CreditsArrivalBalanceRead>;

export interface CreditsArrivalStorePorts {
  /** Looked up at each use; `null` when this host cannot read the account. */
  readonly accountIdentityReader: () => CreditsAccountIdentityReader | null;
  /** Looked up at each use; `null` when this host cannot read the balance. */
  readonly balanceReader: () => CreditsArrivalBalanceReader | null;
  readonly now?: () => number;
}

/**
 * A browser billing hand-off from a chat surface, from the click to the
 * first covered return. Every method is inert once the hand-off is
 * cancelled, recorded, or its account session ends.
 */
export interface CreditsArrivalHandoff extends CreditsArrivalHandle {
  readonly handoffId: string;
  /** Whether it can still record (not cancelled, same account session). */
  isLive(): boolean;
  /**
   * Call right before the external open. A baseline still loading then is
   * no longer known to precede the purchase, so it becomes unknown.
   */
  markExternalOpen(): void;
  /** The browser opened. Only a retained hand-off may record. */
  retain(): void;
  /**
   * The first covered completion. Records the arrival (or queues it while
   * the account is rechecked) and ends the hand-off. Call before announcing
   * the credits change.
   */
  recordCovered(): boolean;
  cancel(): void;
}

export interface CreditsArrivalStore<TOrigin extends string = string> {
  readonly useStore: UseBoundStore<StoreApi<CreditsArrivalState<TOrigin>>>;
  /**
   * Start tracking a hand-off for a chat's work scope, reading the baseline
   * balance at once without waiting for it. Null for a scope with no chat, or
   * when this host cannot read the account. Store-backed hosts supply their
   * purchase scope so independent navigation contexts cannot supersede each
   * other.
   */
  beginHandoff(
    scope: CreditsScopeRequest | undefined,
    origin: TOrigin,
    purchaseScopeKey?: string,
  ): CreditsArrivalHandoff | null;
  /**
   * Clear one record: dismissal, or a credit action the user took from it.
   * Naming the hand-off means a late clear cannot remove a newer record.
   */
  clear(handoffId: string): void;
  /**
   * The surface routed this record's chat through credits. The record leaves
   * the notice for the card; its evidence and any running read stay.
   */
  markRouted(handoffId: string): void;
  /** Retire this chat's confirmation before a user action, even while hidden. */
  clearForChat(target: CreditsChatTarget): void;
  /** Hide account-bound state while identity is rechecked. */
  suspendAccount(): void;
  /**
   * Bring records in line with the saved account. The same account restores
   * the record, any queued record, and any answer read meanwhile. Sign-out
   * (`null`), an unreadable account, and a switch end the session.
   */
  reconcileAccount(accountKey: string | null): void;
  /** Whether an account change has anything here to reconcile. */
  hasSession(): boolean;
}

type BaselineState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly reading: CreditsBalanceReading };

interface QueuedArrival<TOrigin extends string> {
  readonly arrival: CreditsArrival<TOrigin>;
  readonly baseline: CreditsBalanceReading | null;
  readonly seq: number;
  readonly ownerKey: string;
  readonly sessionGeneration: number;
}

interface BalanceRun {
  readonly handoffId: string;
  readonly sessionGeneration: number;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function arrivalChatKey(scope: CreditsWorkScope): string {
  return `${scope.projectId}/${scope.worktreeId ?? ''}/${scope.chatId ?? ''}`;
}

function arrivalMatchesChat<TOrigin extends string>(
  arrival: CreditsArrival<TOrigin> | null,
  target: CreditsChatTarget | null,
): arrival is CreditsArrival<TOrigin> {
  return (
    target !== null &&
    arrival !== null &&
    arrival.chatId === target.chatId &&
    arrival.scope.projectId === target.projectId &&
    (arrival.scope.worktreeId ?? '') === target.worktreeId
  );
}

/** Resolves `null` after `ms` unless cancelled first. */
function readDeadline(ms: number): {
  readonly promise: Promise<null>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout((): void => resolve(null), ms);
  });
  return {
    promise,
    cancel: (): void => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * The unrouted record the notice shows for this complete work identity, or
 * null. A routed record belongs to the card. Only the surface that started
 * the hand-off sees its record.
 */
export function selectCreditsArrivalForChat<TOrigin extends string>(
  state: CreditsArrivalState<TOrigin>,
  target: CreditsChatTarget | null,
  origin: TOrigin | readonly TOrigin[],
): CreditsArrival<TOrigin> | null {
  const origins: readonly TOrigin[] =
    typeof origin === 'string' ? [origin] : origin;
  return state.accountReady &&
    !state.routed &&
    state.arrival !== null &&
    origins.includes(state.arrival.origin) &&
    arrivalMatchesChat(state.arrival, target)
    ? state.arrival
    : null;
}

/** The routed record the card shows for this work identity, or null. */
export function selectRoutedCreditsArrivalForChat<TOrigin extends string>(
  state: CreditsArrivalState<TOrigin>,
  target: CreditsChatTarget | null,
): CreditsArrival<TOrigin> | null {
  return state.accountReady &&
    state.routed &&
    arrivalMatchesChat(state.arrival, target)
    ? state.arrival
    : null;
}

/** The final evidence for exactly this record, or null while reading. */
export function selectCreditsArrivalEvidence<TOrigin extends string>(
  state: CreditsArrivalState<TOrigin>,
  handoffId: string | undefined,
): CreditsArrivalEvidence | null {
  const { evidence } = state;
  return state.accountReady &&
    evidence !== null &&
    evidence.final &&
    evidence.handoffId === handoffId
    ? evidence
    : null;
}

/** Create the arrival confirmation a host keeps for its session. */
export function createCreditsArrivalStore<TOrigin extends string = string>(
  ports: CreditsArrivalStorePorts,
): CreditsArrivalStore<TOrigin> {
  type Queued = QueuedArrival<TOrigin>;
  const now = ports.now ?? Date.now;
  const useStore = create<CreditsArrivalState<TOrigin>>(() => ({
    accountReady: true,
    arrival: null,
    evidence: null,
    routed: false,
  }));

  /**
   * The account this session's records belong to. `undefined` until a
   * hand-off or account read establishes it; `null` once signed out.
   */
  let sessionAccountKey: string | null | undefined;
  /** Bumped whenever the account session ends; fences every async result. */
  let sessionGeneration = 0;
  /** Initiation order across every chat; never reused. */
  let handoffSeq = 0;
  /**
   * The newest initiated hand-off per purchase scope (or chat for local
   * hosts). A retained purchase survives a hand-off in another navigation
   * context, even for the same chat (CAN-5534).
   */
  const latestSeqByScope = new Map<string, number>();
  /** Identifying hand-offs also need account-change fencing before a key exists. */
  const identifyingHandoffs = new Set<string>();
  /** Every hand-off recorded in this account session, dismissed or not. */
  const seenHandoffIds = new Set<string>();
  /** The visible record's sequence; a lower one can never replace it. */
  let visibleSeq = 0;
  let visibleOwnerKey: string | null = null;
  /** A record made while the account was being rechecked. At most one. */
  let queued: Queued | null = null;
  let balanceRun: BalanceRun | null = null;
  /** A final answer read while the account was being rechecked. */
  let heldEvidence: CreditsArrivalEvidence | null = null;
  let heldGeneration = -1;
  let handoffCounter = 0;

  const isCurrentSession = (generation: number): boolean =>
    generation === sessionGeneration;

  function cancelBalanceRun(): void {
    if (balanceRun === null) return;
    balanceRun.cancelled = true;
    if (balanceRun.timer !== null) clearTimeout(balanceRun.timer);
    balanceRun = null;
  }

  function publishEvidence(evidence: CreditsArrivalEvidence): void {
    const state = useStore.getState();
    if (state.arrival?.handoffId !== evidence.handoffId) return;
    const previous = state.evidence;
    if (
      previous?.handoffId === evidence.handoffId &&
      previous.final === evidence.final &&
      previous.addedCredits === evidence.addedCredits &&
      previous.balanceCredits === evidence.balanceCredits
    )
      return;
    useStore.setState({ evidence });
  }

  /**
   * Read the balance for the visible record: immediately, then at
   * {@link CREDITS_ARRIVAL_READ_OFFSETS_MS}, one request at a time. Ends
   * early only on a reliable positive increase, organization funding, or a
   * positive balance with no baseline to compare. A stale or unchanged
   * balance keeps reading; at the end the best valid fallback stands.
   *
   * The budget is spent once per hand-off. Reads keep running while the
   * account is rechecked, but nothing they find shows until the same session
   * returns.
   */
  function startBalanceRun(
    handoffId: string,
    scope: CreditsWorkScope,
    baseline: CreditsBalanceReading | null,
  ): void {
    cancelBalanceRun();
    const run: BalanceRun = {
      handoffId,
      sessionGeneration,
      cancelled: false,
      timer: null,
    };
    balanceRun = run;
    const read = ports.balanceReader();
    const isLive = (): boolean =>
      !run.cancelled &&
      balanceRun === run &&
      isCurrentSession(run.sessionGeneration) &&
      useStore.getState().arrival?.handoffId === handoffId;

    let attempts = 0;
    let firstStartedAt: number | null = null;
    let bestBalance: number | null = null;

    const finish = (
      addedCredits: number | null,
      balanceCredits: number | null,
    ): void => {
      if (!isLive()) return;
      const evidence: CreditsArrivalEvidence = {
        handoffId,
        final: true,
        addedCredits,
        balanceCredits,
      };
      if (balanceRun === run) balanceRun = null;
      if (!useStore.getState().accountReady) {
        // Shown only if the recheck returns the same session.
        heldEvidence = evidence;
        heldGeneration = run.sessionGeneration;
        return;
      }
      publishEvidence(evidence);
    };

    const attempt = async (): Promise<void> => {
      if (!isLive()) return;
      if (read === null) {
        finish(null, null);
        return;
      }
      firstStartedAt ??= now();
      attempts++;
      const deadline = readDeadline(CREDITS_ARRIVAL_READ_TIMEOUT_MS);
      const answer = await Promise.race([read(scope), deadline.promise]);
      deadline.cancel();
      if (!isLive()) return;
      if (answer === null) {
        // Do not stack a request on a hung one: end with what is known.
        finish(null, bestBalance);
        return;
      }
      if (answer.outcome === 'definitive') {
        // Organization funding: say only that credits are available.
        finish(null, null);
        return;
      }
      const reading = answer.reading;
      if (reading !== null) {
        if (reading.credits > 0) bestBalance = reading.credits;
        if (baseline === null) {
          if (reading.credits > 0) {
            finish(null, reading.credits);
            return;
          }
        } else if (
          reading.source === baseline.source &&
          reading.email === baseline.email
        ) {
          const added =
            Math.round((reading.credits - baseline.credits) * 100) / 100;
          if (added > 0 && reading.credits > 0) {
            finish(added, reading.credits);
            return;
          }
        }
      }
      if (attempts >= CREDITS_ARRIVAL_READ_OFFSETS_MS.length) {
        finish(null, bestBalance);
        return;
      }
      const offset = CREDITS_ARRIVAL_READ_OFFSETS_MS[attempts] ?? 0;
      const wait = Math.max(0, (firstStartedAt ?? now()) + offset - now());
      run.timer = setTimeout((): void => {
        run.timer = null;
        void attempt();
      }, wait);
    };

    useStore.setState({
      evidence: {
        handoffId,
        final: false,
        addedCredits: null,
        balanceCredits: null,
      },
    });
    void attempt();
  }

  function commitArrival(entry: Queued): boolean {
    if (!isCurrentSession(entry.sessionGeneration)) return false;
    if (sessionAccountKey !== entry.arrival.accountId) return false;
    // Initiation order survives dismissal and does not depend on which return
    // completed first. A superseded hand-off can never publish again.
    if (entry.seq !== latestSeqByScope.get(entry.ownerKey)) return false;
    if (seenHandoffIds.has(entry.arrival.handoffId)) return false;
    // A record from an older hand-off cannot replace a newer one in its scope.
    const visibleArrival = useStore.getState().arrival;
    if (
      visibleArrival !== null &&
      visibleOwnerKey === entry.ownerKey &&
      entry.seq < visibleSeq
    )
      return false;
    seenHandoffIds.add(entry.arrival.handoffId);
    visibleSeq = entry.seq;
    visibleOwnerKey = entry.ownerKey;
    heldEvidence = null;
    useStore.setState({
      arrival: entry.arrival,
      evidence: null,
      routed: false,
    });
    startBalanceRun(
      entry.arrival.handoffId,
      entry.arrival.scope,
      entry.baseline,
    );
    return true;
  }

  function clear(handoffId: string): void {
    if (useStore.getState().arrival?.handoffId !== handoffId) return;
    cancelBalanceRun();
    heldEvidence = null;
    useStore.setState({ arrival: null, evidence: null, routed: false });
  }

  function beginHandoff(
    scope: CreditsScopeRequest | undefined,
    origin: TOrigin,
    purchaseScopeKey?: string,
  ): CreditsArrivalHandoff | null {
    if (
      scope?.kind !== 'work' ||
      scope.chatId === undefined ||
      scope.chatId === ''
    )
      return null;
    const workScope: CreditsWorkScope = { ...scope };
    const chatId = scope.chatId;
    const ownerKey = purchaseScopeKey ?? arrivalChatKey(workScope);
    const generation = sessionGeneration;
    const seq = ++handoffSeq;
    latestSeqByScope.set(ownerKey, seq);
    const handoffId = `arrival-${now().toString(36)}-${++handoffCounter}`;
    let cancelled = false;
    let retained = false;
    let externalOpened = false;
    let baseline: BaselineState = { kind: 'pending' };
    let accountId: string | null | undefined;
    let coveredWhileIdentifying = false;

    const isLive = (): boolean =>
      !cancelled &&
      isCurrentSession(generation) &&
      seq === latestSeqByScope.get(ownerKey);
    const record = (): boolean => {
      if (!isLive() || typeof accountId !== 'string') return false;
      cancelled = true;
      const entry: Queued = {
        arrival: { handoffId, accountId, chatId, scope: workScope, origin },
        baseline: baseline.kind === 'known' ? baseline.reading : null,
        seq,
        ownerKey,
        sessionGeneration: generation,
      };
      if (!useStore.getState().accountReady) {
        if (queued === null || queued.seq < seq) queued = entry;
        return false;
      }
      return commitArrival(entry);
    };

    // Identity: the established session when there is one, else the saved
    // account, which must still be this session when it answers.
    if (sessionAccountKey !== undefined && useStore.getState().accountReady) {
      accountId = sessionAccountKey;
    } else {
      const readIdentity = ports.accountIdentityReader();
      if (readIdentity === null) return null;
      identifyingHandoffs.add(handoffId);
      void readIdentity().then(
        (identity): void => {
          identifyingHandoffs.delete(handoffId);
          if (!isLive()) return;
          if (identity.kind !== 'account') {
            cancelled = true;
            return;
          }
          const key = identity.key;
          if (sessionAccountKey === undefined) sessionAccountKey = key;
          if (sessionAccountKey !== key) {
            cancelled = true;
            return;
          }
          accountId = key;
          if (coveredWhileIdentifying) record();
        },
        (): void => {
          identifyingHandoffs.delete(handoffId);
          cancelled = true;
        },
      );
    }

    const read = ports.balanceReader();
    if (read === null) {
      baseline = { kind: 'unknown' };
    } else {
      void read(workScope).then((answer): void => {
        if (!isLive() || baseline.kind !== 'pending') return;
        baseline =
          answer.reading === null || externalOpened
            ? { kind: 'unknown' }
            : { kind: 'known', reading: answer.reading };
      });
    }

    return {
      handoffId,
      get accountKey(): string | null | undefined {
        return isLive() ? accountId : undefined;
      },
      isLive,
      markExternalOpen(): void {
        if (!isLive()) return;
        externalOpened = true;
        if (baseline.kind === 'pending') baseline = { kind: 'unknown' };
      },
      retain(): void {
        if (isLive()) retained = true;
      },
      recordCovered(): boolean {
        if (!isLive() || !retained) return false;
        if (accountId === undefined) {
          // Identity is still being read; record once it matches.
          coveredWhileIdentifying = true;
          return false;
        }
        return record();
      },
      cancel(): void {
        cancelled = true;
        identifyingHandoffs.delete(handoffId);
      },
    };
  }

  return {
    useStore,
    beginHandoff,
    clear,
    markRouted(handoffId: string): void {
      const state = useStore.getState();
      if (state.arrival?.handoffId !== handoffId || state.routed) return;
      useStore.setState({ routed: true });
    },
    clearForChat(target: CreditsChatTarget): void {
      const { arrival } = useStore.getState();
      if (arrivalMatchesChat(arrival, target)) clear(arrival.handoffId);
      if (queued !== null && arrivalMatchesChat(queued.arrival, target)) {
        queued = null;
      }
    },
    suspendAccount(): void {
      // Without an originating identity, an async answer cannot prove it
      // still belongs to the click's account after a notification. Reject
      // it, even if the eventual answer names the newly signed-in account.
      if (sessionAccountKey === undefined && identifyingHandoffs.size > 0) {
        sessionGeneration++;
        identifyingHandoffs.clear();
      }
      useStore.setState({ accountReady: false });
    },
    reconcileAccount(accountKey: string | null): void {
      const hadSession = sessionAccountKey !== undefined;
      if (sessionAccountKey !== accountKey) {
        sessionAccountKey = accountKey;
        if (hadSession || accountKey === null) {
          sessionGeneration++;
          identifyingHandoffs.clear();
          seenHandoffIds.clear();
          latestSeqByScope.clear();
          queued = null;
          heldEvidence = null;
          visibleSeq = 0;
          visibleOwnerKey = null;
          cancelBalanceRun();
          useStore.setState({
            accountReady: true,
            arrival: null,
            evidence: null,
            routed: false,
          });
          return;
        }
      }
      useStore.setState({ accountReady: true });
      const held = heldEvidence;
      heldEvidence = null;
      if (held !== null && isCurrentSession(heldGeneration))
        publishEvidence(held);
      const next = queued;
      queued = null;
      if (next !== null) commitArrival(next);
    },
    hasSession(): boolean {
      return sessionAccountKey !== undefined || identifyingHandoffs.size > 0;
    },
  };
}
