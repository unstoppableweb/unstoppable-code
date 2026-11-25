import { useCallback, useEffect, useRef } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  nextUsageLimitResumeCheckAt,
  USAGE_RESUME_EXPIRY_MS,
} from '@canopy/desktop-shared/lib/usage-limit-resume-outlook';
import type {
  AgentProviderType,
  AgentUsageOverview,
  AiCreditsRoutingState,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import { classifyProviderUsageSnapshot } from '@/lib/providerLimitSnapshot';
import { scheduleAt } from '@/lib/scheduleAt';
import { useChatStore } from '@/stores/chatStore';
import { useObservabilityStore } from '@/stores/observabilityStore';

/** Shortest wait between two of the hook's own usage reads. */
const MIN_RECHECK_MS = 60_000;

interface ReadOutcome {
  /** The overview the refresh resolved with; absent when it rejected. */
  usage?: AgentUsageOverview;
  /** The provider's Retry-After, when its usage read was refused. */
  retryAt?: string;
}

/**
 * Lookup state for one routing activation of one chat. It lives in a ref so
 * an effect restart (the banner clearing, a model change) neither repeats a
 * read inside a Retry-After window nor forgets the provider that hit the limit.
 */
interface LookupRecord {
  /** `${chatId}:${activatedAt}`; each activation of each chat has its own. */
  key: string;
  /** Provider passed by the click that activated this routing. */
  remembered: AgentProviderType | undefined;
  /**
   * The provider checked for this activation once resolved; `null` when the
   * limit came from a provider whose usage can't be read here.
   */
  provider: NativeAccountProvider | null | undefined;
  firstReadSettled: boolean;
  /** When the next own read may start; `undefined` once retries expired. */
  nextCheckAt: number | undefined;
  /** A read that has not settled yet, shared across effect restarts. */
  inFlight: Promise<ReadOutcome> | undefined;
  /** Set once the reset time was written. */
  done: boolean;
}

function isNativeAccountProvider(
  provider: AgentProviderType,
): provider is NativeAccountProvider {
  return provider === 'claude' || provider === 'codex';
}

/** Stores `record`, dropping the chat's records for earlier activations. */
function replaceChatRecord(
  records: Map<string, LookupRecord>,
  chatId: string,
  record: LookupRecord,
): void {
  for (const key of records.keys()) {
    if (key.startsWith(`${chatId}:`)) records.delete(key);
  }
  records.set(record.key, record);
}

function createRecord(key: string): LookupRecord {
  return {
    key,
    remembered: undefined,
    provider: undefined,
    firstReadSettled: false,
    nextCheckAt: undefined,
    inFlight: undefined,
    done: false,
  };
}

/**
 * When the hook may read again after a read that wrote nothing: Retry-After
 * with a floor, a default interval otherwise, and never past the seven-day
 * expiry that also bounds Schedule Resume. `undefined` means stop reading.
 */
function nextCheckAfter(
  activatedAt: number,
  now: number,
  retryAt: string | undefined,
): number | undefined {
  const expiresAt = activatedAt + USAGE_RESUME_EXPIRY_MS;
  if (now >= expiresAt) return undefined;
  const suggested = Date.parse(
    nextUsageLimitResumeCheckAt({
      now,
      createdAt: activatedAt,
      ...(retryAt !== undefined ? { retryAt } : {}),
    }),
  );
  // The helper clamps to the expiry, which can sit inside the floor; the floor
  // keeps a clamp from turning into a tight loop.
  const at =
    Number.isFinite(suggested) && suggested > now + MIN_RECHECK_MS
      ? suggested
      : now + MIN_RECHECK_MS;
  return at > expiresAt ? undefined : at;
}

export interface SessionCreditsRoutingResetLookupInput {
  routing: AiCreditsRoutingState | undefined;
  /** `inEffect` from `useEffectiveAiCreditsRouting`. */
  inEffect: boolean;
  /** True when the chat can run on the provider subscription. */
  subscriptionUsable: boolean;
  /** `tab.llmProviderUsageLimitBanner?.provider`, when still present. */
  bannerProvider: AgentProviderType | undefined;
  billedProvider: NativeAccountProvider | undefined;
  /** Native model whose subscription windows apply to the billed provider. */
  model: string | undefined;
  target: { projectId: string; worktreeId: string; chatId: string } | null;
  /** Whether the chat's state is committed through the chat-state boundary. */
  live: boolean;
}

/**
 * Learns the reset time for "just this chat" AI Credits routing that started
 * without one (CAN-7484), so the auto-revert in `useEffectiveAiCreditsRouting`
 * can end it when the plan resets.
 *
 * While the routing is in effect with no `resetsAt` and the subscription could
 * pay, the hook reads the limited provider's usage, then reads again after the
 * provider's Retry-After (at least a minute apart, 15 minutes by default) until
 * a read shows a future reset, or until seven days after activation. Usage that
 * main pushes into the observability store after the first read counts too.
 * The first future reset that `classifyProviderUsageSnapshot` reports, the
 * same rule the routing card uses, is saved with `setAiCreditsRoutingResetsAt`;
 * the store ignores it if the routing changed meanwhile.
 *
 * The provider checked is the one whose limit caused the routing: the provider
 * given to `rememberLimitProvider` by the click that activated it, else the
 * tab's usage-limit banner, else the billed provider. A limit from a provider
 * whose usage can't be read here disables the lookup for that activation.
 *
 * Holds no React state and subscribes to the store outside render, so it adds
 * no renders. Mount once per chat, in `ChatInput`.
 */
export function useSessionCreditsRoutingResetLookup(
  input: SessionCreditsRoutingResetLookupInput,
): {
  /**
   * Records the provider whose limit caused the routing that a click wrote to
   * `chatId` at `activatedAt`. Takes the chat the routing was written to,
   * which can differ from the mounted chat once an async model switch settles.
   */
  rememberLimitProvider: (
    chatId: string,
    activatedAt: number,
    provider: AgentProviderType | undefined,
  ) => void;
} {
  const {
    routing,
    inEffect,
    subscriptionUsable,
    bannerProvider,
    billedProvider,
    model,
    target,
    live,
  } = input;
  // One record per chat, keyed by `${chatId}:${activatedAt}`, so a click that
  // routes another chat (an async model switch settling after navigation)
  // can't replace the mounted chat's record.
  const recordsRef = useRef(new Map<string, LookupRecord>());

  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  const activatedAt = routing?.activatedAt;
  const enabled =
    routing?.active === true &&
    routing.scope === 'session' &&
    routing.resetsAt === undefined &&
    inEffect &&
    subscriptionUsable &&
    target !== null &&
    // Only a live chat scope has committed state to read and write.
    live;

  const rememberLimitProvider = useCallback(
    (
      routedChatId: string,
      activated: number,
      provider: AgentProviderType | undefined,
    ): void => {
      const key = `${routedChatId}:${activated}`;
      const records = recordsRef.current;
      const current = records.get(key);
      if (current !== undefined) {
        if (current.provider === undefined) {
          current.remembered = provider ?? current.remembered;
        }
        return;
      }
      replaceChatRecord(records, routedChatId, {
        ...createRecord(key),
        remembered: provider,
      });
    },
    [],
  );

  useEffect(() => {
    if (
      !enabled ||
      activatedAt === undefined ||
      projectId === undefined ||
      worktreeId === undefined ||
      chatId === undefined
    ) {
      return;
    }
    const key = `${chatId}:${activatedAt}`;
    let current = recordsRef.current.get(key);
    if (current === undefined) {
      current = createRecord(key);
      replaceChatRecord(recordsRef.current, chatId, current);
    }
    const record = current;
    if (record.done) return;

    if (record.provider === undefined) {
      const limitProvider = record.remembered ?? bannerProvider;
      const resolved = limitProvider ?? billedProvider;
      if (resolved === undefined) return;
      // Never fall through to the billed provider when a different provider
      // hit the limit: its reset would end this routing at the wrong time.
      record.provider = isNativeAccountProvider(resolved) ? resolved : null;
    }
    const provider = record.provider;
    if (provider === null) return;
    // On the CAN-4900 path the chat moved to another provider's credits model;
    // that model id must not filter the limited provider's windows.
    const classifyModel = provider === billedProvider ? model : undefined;
    const chatTarget = { projectId, worktreeId, chatId };

    let cancelled = false;
    let disposeTimer: (() => void) | undefined;
    let lastHandled: AgentUsageOverview | undefined;

    const stopTimer = (): void => {
      disposeTimer?.();
      disposeTimer = undefined;
    };

    /** Saves a future reset from `usage`; returns whether it did. */
    const apply = (usage: AgentUsageOverview): boolean => {
      if (cancelled || record.done) return record.done;
      lastHandled = usage;
      const now = Date.now();
      let resetAt: number | undefined;
      try {
        const value = classifyProviderUsageSnapshot(
          usage,
          provider,
          now,
          classifyModel,
        );
        if (value.kind === 'limited') resetAt = value.resetAt;
      } catch (error) {
        reportClientAppError(error);
      }
      // A past reset would end the routing on a guess; keep checking instead.
      if (resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= now)
        return false;
      record.done = true;
      stopTimer();
      useChatStore
        .getState()
        .setAiCreditsRoutingResetsAt(
          { resetsAt: resetAt, activatedAt },
          chatTarget,
        );
      return true;
    };

    const startRead = (): Promise<ReadOutcome> => {
      if (record.inFlight) return record.inFlight;
      const read = useObservabilityStore
        .getState()
        .refreshProviderUsageSnapshot(provider)
        .then(
          (usage): ReadOutcome => {
            const retryAt = usage.providers.find(
              (summary) => summary.provider === provider,
            )?.errorInfo?.retryAt;
            return retryAt !== undefined ? { usage, retryAt } : { usage };
          },
          (error: unknown): ReadOutcome => {
            reportClientAppError(error);
            return {};
          },
        )
        .then((outcome) => {
          // Bookkeeping belongs to the activation, not to this effect run, so
          // a restart during the read still waits for the next check time.
          record.inFlight = undefined;
          record.firstReadSettled = true;
          record.nextCheckAt = nextCheckAfter(
            activatedAt,
            Date.now(),
            outcome.retryAt,
          );
          return outcome;
        });
      record.inFlight = read;
      return read;
    };

    const armNextCheck = (): void => {
      stopTimer();
      const at = record.nextCheckAt;
      if (at === undefined) return;
      disposeTimer = scheduleAt(at, () => {
        disposeTimer = undefined;
        void runRead();
      });
    };

    const runRead = async (): Promise<void> => {
      if (cancelled || record.done) return;
      const outcome = await startRead();
      if (cancelled || record.done) return;
      // A later read's store update already reached `apply` through the
      // subscription; don't classify the same overview twice.
      if (
        outcome.usage &&
        outcome.usage !== lastHandled &&
        apply(outcome.usage)
      )
        return;
      armNextCheck();
    };

    // Main pushes background usage refreshes into the store. Until this
    // activation's first read settles, cached usage can describe a previous
    // account, so pushes before it are ignored. A push never moves the timer.
    const unsubscribe = useObservabilityStore.subscribe((state) => {
      if (!record.firstReadSettled || state.usage === lastHandled) return;
      apply(state.usage);
    });

    if (!record.firstReadSettled) {
      void runRead();
    } else if (!apply(useObservabilityStore.getState().usage)) {
      if (record.inFlight) void runRead();
      else armNextCheck();
    }

    return (): void => {
      cancelled = true;
      stopTimer();
      unsubscribe();
    };
  }, [
    enabled,
    activatedAt,
    bannerProvider,
    billedProvider,
    model,
    projectId,
    worktreeId,
    chatId,
  ]);

  return { rememberLimitProvider };
}
