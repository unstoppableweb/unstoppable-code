import type {
  AutomationAction,
  ProviderUsageSummary,
  UsageLimitedChatEntry,
  UsageLimitedChatTarget,
  UsageLimitResumeInterruption,
} from '@canopy/desktop-shared/types';
import {
  classifyUsageLimitResume,
  nextUsageLimitResumeCheckAt,
  normalizeUsageResumeAccount,
  USAGE_RESUME_EXPIRED,
  USAGE_RESUME_EXPIRY_MS,
  USAGE_RESUME_FRESHNESS_MS,
  USAGE_RESUME_UNCHECKABLE,
} from '@canopy/desktop-shared/lib/usage-limit-resume-outlook';

export const USAGE_RESUME_INELIGIBLE =
  'This scheduled resume no longer matches an eligible interruption.';
export { USAGE_RESUME_EXPIRED };
const BATCH_TIMEOUT_MS = 15_000;

type Provider = UsageLimitResumeInterruption['provider'];
type SessionPrompt = Extract<
  AutomationAction,
  { type: 'worktree_session_prompt' }
>;
export type UsageResumeAction = SessionPrompt & {
  resumeWhen: 'provider_usage_clear';
};

export function isUsageResumeAction(
  action: AutomationAction,
): action is UsageResumeAction {
  return (
    action.type === 'worktree_session_prompt' &&
    action.resumeWhen === 'provider_usage_clear'
  );
}

export function usageResumeTarget(
  action: SessionPrompt,
): UsageLimitedChatTarget {
  return {
    projectId: action.workspaceId,
    worktreeId: action.worktreeId,
    chatId: action.chatId,
  };
}

export function findUsageResumeEntry(
  entries: UsageLimitedChatEntry[],
  target: UsageLimitedChatTarget,
): UsageLimitedChatEntry | undefined {
  return entries.find(
    (entry) =>
      entry.projectId === target.projectId &&
      entry.worktreeId === target.worktreeId &&
      entry.chatId === target.chatId,
  );
}

export function usageResumeBinding(
  entry: UsageLimitedChatEntry | undefined,
): UsageLimitResumeInterruption | undefined {
  if (
    !entry ||
    entry.accountProxyConnectionId ||
    (entry.resumeReason && entry.resumeReason !== 'usage_limit') ||
    (entry.provider !== 'claude' && entry.provider !== 'codex') ||
    !entry.interruptedUserMessageId ||
    !Number.isFinite(entry.detectedAt) ||
    entry.detectedAt <= 0
  )
    return undefined;
  const accountEmail = normalizeUsageResumeAccount(
    entry.usageResumeAccountEmail,
  );
  if (!accountEmail) return undefined;
  return {
    provider: entry.provider,
    detectedAt: entry.detectedAt,
    userMessageId: entry.interruptedUserMessageId,
    accountEmail,
  };
}

export function matchesUsageResumeBinding(
  expected: UsageLimitResumeInterruption | undefined,
  actual: UsageLimitResumeInterruption | undefined,
): boolean {
  return (
    !!expected &&
    !!actual &&
    expected.provider === actual.provider &&
    expected.detectedAt === actual.detectedAt &&
    expected.userMessageId === actual.userMessageId &&
    typeof expected.accountEmail === 'string' &&
    normalizeUsageResumeAccount(expected.accountEmail) === actual.accountEmail
  );
}

export function usageResumeExpired(createdAt: number, now: number): boolean {
  return now >= createdAt + USAGE_RESUME_EXPIRY_MS;
}

interface UsageRead {
  summary: ProviderUsageSummary | undefined;
  freshnessMs: number;
  currentAccountEmail: string | undefined;
  refreshFailed?: boolean;
}

interface GateDependencies {
  now: () => number;
  readRegistry: () => Promise<UsageLimitedChatEntry[]>;
  refresh: (provider: Provider) => Promise<UsageRead>;
  waitForTimeout?: (signal: AbortSignal) => Promise<undefined>;
}

export interface UsageResumeCheck {
  action: UsageResumeAction;
  createdAt: number;
}

export type UsageResumeDecision =
  | { kind: 'stop'; reason: string }
  | { kind: 'defer'; runAt: string }
  | { kind: 'dispatch' };

export interface UsageResumeQualification {
  check: UsageResumeCheck;
  entry: UsageLimitedChatEntry | undefined;
  checkedRegistry: boolean;
  decision: UsageResumeDecision;
}

async function readNativeUsage(
  provider: Provider,
  refresh: boolean,
): Promise<UsageRead> {
  const { getObservabilityService } = await import('../observability');
  const {
    peekProviderAccountIdentity,
    peekProviderNativeAuthAvailability,
    peekUsageResumeAuthProbeFailed,
  } = await import('../auth/provider-auth-state');
  const service = getObservabilityService();
  if (refresh)
    await service.refreshProviderUsage(provider, { joinInFlight: true });
  const summary = service.nativeUsageForResume(provider);
  const nativeAvailability = peekProviderNativeAuthAvailability()[provider];
  return {
    summary:
      nativeAvailability === false
        ? { ...summary, authState: 'unauthenticated' }
        : summary,
    freshnessMs: USAGE_RESUME_FRESHNESS_MS,
    currentAccountEmail:
      peekProviderAccountIdentity(provider)?.accountEmail ??
      (provider === 'codex' && nativeAvailability === undefined
        ? summary.accountEmail
        : undefined),
    refreshFailed:
      peekUsageResumeAuthProbeFailed(provider) ||
      service.nativeUsageResumeAuthDisagrees(provider),
  };
}

export async function usageStillClear(
  interruption: UsageLimitResumeInterruption,
): Promise<boolean> {
  return (
    classifyUsageLimitResume({
      ...(await readNativeUsage(interruption.provider, false)),
      interruption,
      now: Date.now(),
    }).kind === 'clear'
  );
}

export const desktopUsageResumeGate: GateDependencies = {
  now: () => Date.now(),
  readRegistry: async () =>
    (await import('../lib/usage-limited-chats-registry')).readUsageLimitedChats(
      true,
    ),
  refresh: (provider) => readNativeUsage(provider, true),
};

function waitForCheckDeadline(signal: AbortSignal): Promise<undefined> {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(BATCH_TIMEOUT_MS),
  ]);
  return new Promise((resolve) => {
    deadline.addEventListener('abort', () => resolve(undefined), {
      once: true,
    });
  });
}

export async function qualifyUsageResumeChecks(
  checks: UsageResumeCheck[],
  dependencies: GateDependencies = desktopUsageResumeGate,
): Promise<UsageResumeQualification[]> {
  const startedAt = dependencies.now();
  const deadline = startedAt + BATCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = (dependencies.waitForTimeout ?? waitForCheckDeadline)(
    controller.signal,
  ).catch(() => undefined);
  try {
    const entries = checks.every(({ createdAt }) =>
      usageResumeExpired(createdAt, startedAt),
    )
      ? undefined
      : await Promise.race([
          Promise.resolve()
            .then(dependencies.readRegistry)
            .catch(() => undefined),
          timeout,
        ]);
    const refreshes = new Map<Provider, Promise<UsageRead | undefined>>();
    return await Promise.all(
      checks.map(async (check): Promise<UsageResumeQualification> => {
        const { action, createdAt } = check;
        const entry =
          entries && findUsageResumeEntry(entries, usageResumeTarget(action));
        const binding = usageResumeBinding(entry);
        const basis = { check, entry, checkedRegistry: entries !== undefined };
        const defer = (
          now: number,
          retryAt?: string,
          usageResetAt?: string,
        ): UsageResumeQualification => ({
          ...basis,
          decision: {
            kind: 'defer',
            runAt: nextUsageLimitResumeCheckAt({
              now,
              createdAt,
              retryAt,
              usageResetAt,
              bannerResetAt: entry?.resetsAt,
            }),
          },
        });
        const expires = (): UsageResumeQualification => ({
          ...basis,
          decision: { kind: 'stop', reason: USAGE_RESUME_EXPIRED },
        });
        const nowBeforeRead = dependencies.now();
        if (usageResumeExpired(createdAt, nowBeforeRead)) return expires();
        if (!entries) return defer(nowBeforeRead);
        if (
          !entry ||
          (entry.resumeReason && entry.resumeReason !== 'usage_limit') ||
          action.usageResumeInterruption?.detectedAt !== entry.detectedAt ||
          action.usageResumeInterruption.userMessageId !==
            entry.interruptedUserMessageId ||
          action.usageResumeInterruption.provider !== entry.provider
        ) {
          return {
            ...basis,
            decision: { kind: 'stop', reason: USAGE_RESUME_INELIGIBLE },
          };
        }
        if (
          !binding ||
          !matchesUsageResumeBinding(action.usageResumeInterruption, binding)
        ) {
          return {
            ...basis,
            decision: { kind: 'stop', reason: USAGE_RESUME_UNCHECKABLE },
          };
        }
        if (nowBeforeRead >= deadline) return defer(nowBeforeRead);
        let refresh = refreshes.get(binding.provider);
        if (!refresh) {
          const provider = binding.provider;
          refresh = Promise.race([
            Promise.resolve()
              .then(() => dependencies.refresh(provider))
              .catch(() => undefined),
            timeout,
          ]);
          refreshes.set(provider, refresh);
        }
        const read = await refresh;
        const now = dependencies.now();
        if (usageResumeExpired(createdAt, now)) return expires();
        if (!read || now >= deadline) return defer(now);
        const outlook = classifyUsageLimitResume({
          ...read,
          interruption: binding,
          now,
        });
        switch (outlook.kind) {
          case 'uncheckable':
            return {
              ...basis,
              decision: { kind: 'stop', reason: USAGE_RESUME_UNCHECKABLE },
            };
          case 'recheck':
            return defer(now, outlook.retryAt);
          case 'reset':
            return defer(now, undefined, outlook.runAt);
          case 'clear':
            return { ...basis, decision: { kind: 'dispatch' } };
        }
      }),
    );
  } finally {
    controller.abort();
  }
}
