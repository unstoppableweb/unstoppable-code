import { isCopilotModel } from '@canopy/execution-engine/lib/copilot-models';
import { isCostWorkScope } from '@canopy/desktop-shared/lib/cost-scope';
import { CopilotAccountUsage } from './CopilotAccountUsage';
import { isCursorModel } from '@canopy/execution-engine/lib/cursor-models';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import {
  CodexContextWindowControl,
  UsageIndicator as SharedUsageIndicator,
  createOpenCodeUsageResponse,
  type UsageIndicatorContextBreakdown,
} from '@canopy/ui-shared/components';
import {
  CODEX_LONG_CONTEXT_THRESHOLD,
  type CodexContextWindowSetting,
} from '@canopy/execution-engine/lib/codex-context-window';
import { useCodexContextWindowControl } from './useCodexContextWindowControl';
import { useCostChatSummaryStore } from '@canopy/ui-app/cost';
import { UsageCostPreviewRow } from '@canopy/ui-shared/components/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import {
  getModelDisplayName,
  getProviderForModel,
  type AgentProviderType,
  type ChatContextUsageRequest,
  type ChatTabUsage,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import { accountProxyHarnessForChat } from '@canopy/desktop-shared/lib/account-proxy';
import { useNavigationStore } from '@/stores/navigationStore';
import { useAiCreditsOnlyBilling } from '@/hooks/useAiCreditsOnlyBilling';
import { useChatAccountSource } from '@/stores/accountProxyStore';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import { openSessionBreakdownPanel } from '@/lib/cost/open-cost-panels';
import { CursorAccountUsage } from './CursorAccountUsage';
import { PlanAccountUsage, type PlanAccountProvider } from './PlanAccountUsage';
import { ProxyAccountUsage } from './ProxyAccountUsage';
import { useWeeklyLimitUsedPercent } from './useWeeklyLimitUsedPercent';
import { createSeededTabUsage } from '@/lib/chatUsageNormalization';
import {
  useComposerAiCreditsBalance,
  type ComposerAiCreditsTarget,
} from '@/hooks/useComposerAiCreditsBalance';
import { useWorkModelLibraryAccess } from '@/hooks/useModelLibraryAccess';
import { chatAiCreditsScope } from '@/lib/aiCreditsScope';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';

interface UsageIndicatorProps {
  usage: ChatTabUsage | undefined;
  isCodex: boolean;
  /** Selected harness, independent of the model's shared identity. */
  isCursor?: boolean;
  executionHarness?: ModelHarness;
  /**
   * The tab's current model. Lets the meter size itself to the model's
   * context window while `usage` is still undefined (a chat whose session has
   * not produced a turn yet), instead of rendering a dead ring.
   */
  model?: string;
  /**
   * The chat's execution provider, as main creates its session; defaults to
   * the model's provider. Only Claude Code and Codex chats can run through the
   * account proxy.
   */
  providerType?: AgentProviderType;
  /** Whether the tab routes through AI Credits; picks the gateway window. */
  aiCreditsRouted?: boolean;
  /**
   * The user picked their own subscription for this chat, which keeps the
   * global AI Credits mode from outranking the account proxy.
   */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether the account proxy serves the chat's live session, as main
   * reported it; undefined before the session exists.
   */
  accountProxyRouted?: boolean;
  /**
   * The chat whose live session can report what fills its context window.
   * Asked as the popover opens; Claude sessions answer by category.
   */
  contextTarget?: ChatContextUsageRequest;
  /** Lines the popover up with the composer box's right edge. */
  alignRef?: RefObject<HTMLElement | null>;
  /**
   * The chat whose personal AI Credits balance the meter may show, including
   * a chat outside any project. Absent, no balance shows.
   */
  creditTarget?: ComposerAiCreditsTarget;
  /**
   * Whether the selected model bills the chat's next turn to AI Credits. The
   * balance shows only then, never for a chat billed to the user's own
   * provider subscription.
   */
  aiCreditsBilled?: boolean;
  /** True while the chat's turn runs; its end re-reads a charged balance. */
  turnActive?: boolean;
  /** The Codex chat's own context window choice; absent uses the default. */
  contextWindowSetting?: CodexContextWindowSetting;
}

const NO_CREDIT_TARGET: ComposerAiCreditsTarget = {};

/**
 * Desktop wrapper over the shared composer usage meter: resolves the model's
 * configured context window through desktop-shared (CAN-2799) and hands the
 * seeded usage to the shared popover.
 */
export function UsageIndicator({
  usage,
  isCodex,
  isCursor,
  executionHarness,
  model,
  providerType,
  aiCreditsRouted = false,
  subscriptionBillingOverride,
  accountProxyRouted,
  contextTarget,
  alignRef,
  creditTarget,
  aiCreditsBilled = false,
  turnActive = false,
  contextWindowSetting,
}: UsageIndicatorProps): JSX.Element {
  useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const navigate = useNavigationStore((state) => state.navigate);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const creditBalance = useComposerAiCreditsBalance({
    target: creditTarget ?? NO_CREDIT_TARGET,
    aiCreditsRouted: aiCreditsRouted && creditTarget !== undefined,
    aiCreditsBilled: aiCreditsBilled && creditTarget !== undefined,
    turnActive,
  });
  // The balance shows only for Personal work billed to AI Credits, so its
  // label reads the same work owner's access, and only while it shows.
  const creditTargetProjectId = creditTarget?.projectId;
  const creditTargetWorktreeId = creditTarget?.worktreeId;
  const creditTargetChatId = creditTarget?.chatId;
  const creditScope = useMemo(
    () =>
      chatAiCreditsScope(
        creditTargetProjectId,
        creditTargetWorktreeId,
        creditTargetChatId,
      ),
    [creditTargetProjectId, creditTargetWorktreeId, creditTargetChatId],
  );
  const creditLibraryAccess = useWorkModelLibraryAccess(
    creditScope,
    creditBalance.credits !== null || creditBalance.pending,
  );
  const onManageCredits = useCallback(
    (): void => navigate('usage'),
    [navigate],
  );
  const usageModel = usage?.model || model;
  const modelLabel = usageModel ? getModelDisplayName(usageModel) : undefined;
  const isCopilot = isCopilotModel(usageModel ?? '');
  const selectedModel = model ?? usageModel;
  const opencode =
    (executionHarness ??
      providerType ??
      (selectedModel ? getProviderForModel(selectedModel) : undefined)) ===
    'opencode';
  const cursor = !isCopilot && (isCursor ?? isCursorModel(usageModel ?? ''));
  // Only a Claude session reports what fills its window; Codex, Cursor and
  // Copilot report totals.
  const { breakdown: claudeBreakdown, onOpenChange: onContextOpenChange } =
    useContextBreakdown(
      isCodex || cursor || isCopilot || opencode ? undefined : contextTarget,
    );
  // Codex reports totals; its autocompact buffer and the context window
  // control come from the window and the model's catalog bounds.
  const codexChat = isCodex && !cursor && !isCopilot && !opencode;
  const codexContextWindow = useCodexContextWindowControl({
    chat: codexChat ? contextTarget : undefined,
    setting: contextWindowSetting,
    usedTokens: usage?.contextTokens ?? 0,
    reportedWindowTokens: usage?.contextWindow ?? 0,
  });
  const contextBreakdown = claudeBreakdown ?? codexContextWindow.breakdown;
  // A reserved chat scope, such as the Pipeline Assistant's, keeps no cost
  // and has no panel grid to show a breakdown in.
  const costTarget =
    contextTarget !== undefined &&
    isCostWorkScope(contextTarget.projectId, contextTarget.worktreeId)
      ? contextTarget
      : undefined;
  // An account that bills every turn to AI Credits sees no USD for a chat
  // billed that way: AI Credits is its only money figure (CAN-5028).
  const creditsOnly = useAiCreditsOnlyBilling();
  const costHidden = creditsOnly && aiCreditsBilled;
  const costScope: CostScopeRef = {
    kind: 'entry',
    projectId: costTarget?.projectId ?? '',
    worktreeId: costTarget?.worktreeId ?? '',
  };
  const costSummaryStore = useCostChatSummaryStore(
    desktopCostClient,
    costScope,
    costTarget?.chatId ?? '',
    {
      enabled: costTarget !== undefined && popoverOpen && !costHidden,
    },
  );
  const costPreview = costSummaryStore((state) =>
    state.problem === null ? state.value?.totals : undefined,
  );
  const proxyAccounts = costSummaryStore((state) =>
    state.problem === null ? state.value?.proxyAccounts : undefined,
  );
  const onOpenChange = useCallback(
    (open: boolean): void => {
      setPopoverOpen(open);
      onContextOpenChange(open);
    },
    [onContextOpenChange],
  );
  const onSeeDetails = useCallback((): void => {
    const openUsagePage = (): void => navigate('usage');
    if (costTarget === undefined) {
      openUsagePage();
      return;
    }
    // The link always lands somewhere: a breakdown no group took gives way
    // to the Usage page.
    void openSessionBreakdownPanel(
      { projectId: costTarget.projectId, worktreeId: costTarget.worktreeId },
      costTarget.chatId,
    ).then((result) => {
      if (result.status !== 'placed' && result.status !== 'revealed') {
        openUsagePage();
      }
    }, openUsagePage);
  }, [costTarget, navigate]);
  // Plan limits only describe a chat that runs on a Claude or Codex plan; an
  // AI Credits route bills elsewhere. When the account proxy serves the chat,
  // its accounts' limits bound it, not the user's own sign-in.
  const planProvider = resolvePlanAccountProvider(
    usageModel,
    cursor || opencode,
    aiCreditsRouted,
  );
  // The proxy routes by the chat's execution harness, as main decides it; the
  // shared resolver owns which harnesses and models it can take.
  const chatProviderType =
    providerType ?? (usageModel ? getProviderForModel(usageModel) : undefined);
  const proxyHarness = accountProxyHarnessForChat({
    providerType: chatProviderType,
    model: usageModel,
  });
  const accountSource = useChatAccountSource({
    providerType: chatProviderType,
    model: usageModel,
    sessionAccountProxyRouted: accountProxyRouted,
    chatChoseAiCredits: aiCreditsRouted,
    subscriptionBillingOverride,
  });
  // The ring shows the weekly limit of the plan this chat runs on; a chat the
  // account proxy routes is bound by its accounts, and one billed to AI
  // Credits by its wallet, not the user's sign-in.
  const weeklyUsedPercent = useWeeklyLimitUsedPercent(
    accountSource === 'account-proxy' || aiCreditsBilled
      ? undefined
      : planProvider,
    usageModel,
    turnActive,
  );
  // Copilot reports cumulative token buckets, but no dollar cost or current
  // context occupancy. Keep its totals visible without inventing those figures.
  const displayUsage = isCopilot
    ? {
        ...usage,
        contextTokens: 0,
        contextWindow: 0,
        totalCostUsd: undefined,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
        numTurns: usage?.numTurns ?? 0,
        model: usageModel ?? '',
      }
    : usage;

  return (
    <SharedUsageIndicator
      usage={displayUsage}
      accountUsage={
        isCopilot ? (
          <CopilotAccountUsage />
        ) : proxyHarness && accountSource === 'account-proxy' ? (
          <ProxyAccountUsage
            accounts={proxyAccounts ?? []}
            harness={proxyHarness}
            {...(contextTarget ? { chat: contextTarget } : {})}
          />
        ) : cursor ? (
          <CursorAccountUsage />
        ) : planProvider ? (
          <PlanAccountUsage provider={planProvider} />
        ) : undefined
      }
      hideCost={costHidden}
      {...(!opencode && !costHidden ? { onSeeDetails } : {})}
      {...(contextBreakdown ? { contextBreakdown } : {})}
      {...(codexContextWindow.control
        ? {
            contextWindowControl: (
              <CodexContextWindowControl
                state={codexContextWindow.control.state}
                onSelect={codexContextWindow.control.onSelect}
              />
            ),
          }
        : {})}
      {...(codexChat
        ? { longContextThresholdTokens: CODEX_LONG_CONTEXT_THRESHOLD }
        : {})}
      {...(contextTarget !== undefined &&
      costPreview !== undefined &&
      !costHidden
        ? { costPreview: <UsageCostPreviewRow preview={costPreview} /> }
        : {})}
      onOpenChange={onOpenChange}
      {...(creditBalance.credits !== null || creditBalance.pending
        ? {
            creditBalance: {
              credits: creditBalance.credits,
              onManage: onManageCredits,
              ...(creditLibraryAccess !== undefined
                ? { libraryAccess: creditLibraryAccess }
                : {}),
            },
          }
        : {})}
      capsule
      {...(weeklyUsedPercent !== undefined
        ? { weeklyLimit: { usedPercent: weeklyUsedPercent } }
        : {})}
      {...(alignRef ? { alignRef } : {})}
      responseUsage={
        opencode
          ? createOpenCodeUsageResponse(usage?.opencodeReportedUsage)
          : cursor
            ? {
                message: usage?.cursorReportedUsage
                  ? 'Latest reported response. Input includes cached tokens.'
                  : 'Cursor has not reported token usage.',
                note: 'Response cost and context limit are unavailable.',
                usage: usage?.cursorReportedUsage,
              }
            : undefined
      }
      isCodex={isCodex}
      // An id with no display name stays unnamed rather than showing raw.
      modelLabel={modelLabel === usageModel ? '' : (modelLabel ?? '')}
      seedUsage={createSeededTabUsage(model, aiCreditsRouted, executionHarness)}
    />
  );
}

function resolvePlanAccountProvider(
  model: string | undefined,
  cursor: boolean,
  aiCreditsRouted: boolean,
): PlanAccountProvider | undefined {
  if (cursor || aiCreditsRouted || !model) return undefined;
  const provider = getProviderForModel(model);
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

/**
 * Fetches the live session's context breakdown each time the popover opens,
 * so it reflects the latest turn. A chat without a live session (or one on a
 * harness that reports totals only) keeps the plain meter.
 */
function useContextBreakdown(target: ChatContextUsageRequest | undefined): {
  breakdown: UsageIndicatorContextBreakdown | null;
  onOpenChange: (open: boolean) => void;
} {
  const [breakdown, setBreakdown] =
    useState<UsageIndicatorContextBreakdown | null>(null);
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  // A different chat's categories never carry over.
  useEffect(() => {
    setBreakdown(null);
  }, [projectId, worktreeId, chatId]);
  const onOpenChange = useCallback(
    (open: boolean): void => {
      if (!open || !projectId || !worktreeId || !chatId) return;
      void window.api.chat
        .getContextUsage({ projectId, worktreeId, chatId })
        .then((next) => {
          setBreakdown(
            next
              ? { categories: next.categories, maxTokens: next.maxTokens }
              : null,
          );
        })
        .catch(() => setBreakdown(null));
    },
    [projectId, worktreeId, chatId],
  );
  return { breakdown, onOpenChange };
}
