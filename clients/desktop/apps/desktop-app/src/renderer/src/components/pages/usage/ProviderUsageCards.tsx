import { AntigravityAccountCard, OpenCodeAccountCard } from '@canopy/ui-shared';
import { getCursorSettingsSection } from '@/lib/cursor-settings';
import { getCopilotSettingsSection } from '@/lib/copilot-settings';
import { getOpenCodeSettingsSection } from '@/lib/opencode-settings';
/* eslint-disable react-refresh/only-export-components -- exports the shared
   provider-selection helpers (reused by the Usage panel) alongside the card
   components; splitting them would fragment a single cohesive display module. */
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  AgentUsageOverview,
  AgentProviderType,
  ProviderUsageSummary,
  UsageLimitedSessionItem,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  Button,
  getModelCatalogProviderLabel,
  ProviderUsageAccountRow,
  UsageGroup,
  UsageProviderGroup,
  UsageRowList,
  UsageRow,
  usagePlanLabel,
} from '@canopy/ui-shared';
import {
  UsageLimitedSessionsControl,
  DialogModal,
  TranscriptPagingControls,
  type NonEmptyUsageLimitedWaitingSessions,
  type UsageLimitedWaitingSession,
} from '@canopy/ui-shared/components';
import { OtherAccountSnapshots } from './OtherAccountSnapshots';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import {
  invalidateClaudeAuthStatusCache,
  useClaudeAuthStatus,
} from '@/hooks/useClaudeAuthStatus';
import {
  invalidateCodexAuthStatusCache,
  useCodexAuthStatus,
} from '@/hooks/useCodexAuthStatus';
import {
  useUsageLimitedSessions,
  type UsageLimitedSessionEntry,
} from '@/hooks/useUsageLimitedSessionCount';
import {
  hasBlockingRateLimit,
  selectBlockingResetAtMs,
} from '@/lib/usage-limit/resume-availability';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { navigateToLiveChat } from '@/lib/navigation/live-chat-navigation';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { installTranscriptPage } from '@/stores/chat/transcript-pages';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { buildSubCards } from './usage-sub-cards';
import { UsageErrorNotice, resolveUsageErrorInfo } from './UsageErrorNotice';
import { AccountProxyUsageSection } from './AccountProxyUsageSection';
import { useProviderAccountSource } from '@/stores/accountProxyStore';

type UsageLoginProvider = Extract<AgentProviderType, 'claude' | 'codex'>;
type LoginProviderUsageSummary = ProviderUsageSummary & {
  provider: UsageLoginProvider;
};

export type UsageAccountProvider =
  | UsageLoginProvider
  | 'cursor'
  | 'copilot'
  | 'opencode';
export type AccountProviderUsageSummary =
  | LoginProviderUsageSummary
  | (ProviderUsageSummary & { provider: 'cursor' })
  | (ProviderUsageSummary & { provider: 'copilot' });

interface ProviderUsageCardsProps {
  nowMs: number;
  usage: AgentUsageOverview;
  refreshingProviders: Set<AgentProviderType>;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
}

interface ProviderAccountRowProps {
  provider: LoginProviderUsageSummary;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
}

function ProviderAccountRow({
  provider,
  refreshProviderUsageDetails,
}: ProviderAccountRowProps): JSX.Element {
  const [loginOpen, setLoginOpen] = useState(false);
  const claudeStatus = useClaudeAuthStatus(0);
  const codexStatus = useCodexAuthStatus(0);
  const authStatus =
    provider.provider === 'claude' ? claudeStatus : codexStatus;

  // Use the provider snapshot while the live probe is loading, then let the
  // fresher probe win so an out-of-band logout cannot leave stale account UI.
  const snapshotAuthenticated = provider.authState === 'authenticated';
  const authenticated =
    authStatus === null ? snapshotAuthenticated : authStatus.authenticated;
  const snapshotAccountLabel = provider.accountLabel ?? provider.accountEmail;
  const liveAccountLabel = authStatus?.accountLabel ?? authStatus?.accountEmail;
  const accountLabel = authenticated
    ? (liveAccountLabel ?? snapshotAccountLabel ?? null)
    : null;
  const statusLabel = authenticated
    ? 'Signed in'
    : authStatus === null && provider.authState !== 'unauthenticated'
      ? 'Checking account…'
      : 'Sign in to see usage';

  const handleCloseLoginModal = useCallback((): void => {
    setLoginOpen(false);
    if (provider.provider === 'claude') {
      invalidateClaudeAuthStatusCache();
    } else {
      invalidateCodexAuthStatusCache();
    }
    void refreshProviderUsageDetails(provider.provider);
  }, [provider.provider, refreshProviderUsageDetails]);

  return (
    <>
      <ProviderUsageAccountRow
        accountLabel={accountLabel}
        statusLabel={statusLabel}
        testId={`usage-provider-${provider.provider}-account`}
      >
        <Button
          variant="secondary"
          size="compact"
          onClick={(): void => setLoginOpen(true)}
          disabled={authStatus === null && provider.authState === 'unknown'}
          data-testid={`usage-provider-${provider.provider}-connect`}
        >
          {authenticated ? 'Change account' : 'Sign in'}
        </Button>
      </ProviderUsageAccountRow>
      {loginOpen && (
        <AuthLoginModal
          provider={provider.provider}
          onClose={handleCloseLoginModal}
        />
      )}
    </>
  );
}

interface ManagedAccountRowProps {
  provider: ProviderUsageSummary & { provider: 'cursor' | 'copilot' };
}

/** Managed harness accounts use their existing connection settings. */
function ManagedAccountRow({ provider }: ManagedAccountRowProps): JSX.Element {
  const openSettings = useNavigationStore((state) => state.openSettings);
  const accountLabel =
    provider.authState === 'authenticated'
      ? (provider.accountLabel ?? provider.accountEmail ?? null)
      : null;
  const statusLabel =
    provider.authState === 'authenticated'
      ? 'Signed in'
      : provider.authState === 'unauthenticated'
        ? 'Sign in to see usage'
        : 'Checking account…';

  const label = getModelCatalogProviderLabel(provider.provider);
  return (
    <ProviderUsageAccountRow
      accountLabel={accountLabel}
      statusLabel={statusLabel}
      testId={`usage-provider-${provider.provider}-account`}
    >
      <Button
        variant="secondary"
        size="compact"
        onClick={(): void =>
          openSettings(
            provider.provider === 'copilot'
              ? getCopilotSettingsSection()
              : getCursorSettingsSection(),
          )
        }
        data-testid={`usage-provider-${provider.provider}-manage`}
      >
        Manage {label}
      </Button>
    </ProviderUsageAccountRow>
  );
}

function waitingSessionId(session: UsageLimitedSessionItem): string {
  return session.kind === 'chat'
    ? `chat-${session.projectId}-${session.worktreeId}-${session.chatId}`
    : `pipeline-${session.executionId}`;
}

function toWaitingSession({
  session,
  workspaceName,
}: UsageLimitedSessionEntry): UsageLimitedWaitingSession {
  const worktreeName = session.worktreeName?.trim();
  const subtitle = [workspaceName.trim(), worktreeName]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return {
    id: waitingSessionId(session),
    kind: session.kind,
    title: session.kind === 'chat' ? session.chatTitle : session.pipelineName,
    ...(subtitle ? { subtitle } : {}),
  };
}

/** The retired review host has no live destination; its exact chat is still readable. */
function RetainedReviewChatDialog({
  session,
  onClose,
}: {
  session: Extract<UsageLimitedSessionItem, { kind: 'chat' }>;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<PersistedChatTab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    const scope = {
      projectId: session.projectId,
      worktreeId: session.worktreeId,
    };
    void Promise.all([
      window.api.chat.getState(scope),
      window.api.chat.getTranscriptPage({ ...scope, chatId: session.chatId }),
    ])
      .then(([state, page]) => {
        if (cancelled) return;
        const found = state.tabsFile.tabs.find(
          (candidate) => candidate.id === session.chatId,
        );
        if (found) setTab(installTranscriptPage(found, page, false));
        else setError("Couldn't open the chat. Close this view and try again.");
      })
      .catch(() => {
        if (!cancelled)
          setError("Couldn't open the chat. Close this view and try again.");
      });
    return (): void => {
      cancelled = true;
      alive.current = false;
    };
  }, [session.projectId, session.worktreeId, session.chatId]);

  async function loadEarlier(): Promise<void> {
    const before = tab?.transcriptWindow?.before;
    if (!tab || before === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await window.api.chat.getTranscriptPage({
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        chatId: session.chatId,
        before,
        transcriptRevision: tab.transcriptWindow?.transcriptRevision,
      });
      if (alive.current) setTab(installTranscriptPage(tab, page, true));
    } catch {
      if (alive.current) setError("Couldn't load earlier messages. Try again.");
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }

  return (
    <DialogModal
      inset="flush"
      title="Interrupted review chat"
      subtitle="Viewing this chat doesn't resume it."
      onClose={onClose}
      trapFocus
      maxWidth="4xl"
      height="85vh"
      dataTestId="usage-retained-review-chat"
    >
      {tab ? (
        <WorkspaceAccessContext.Provider
          value={{
            mode: 'read-only',
            reason: 'retained-chat',
            containerType: 'CODE_WORKTREE',
            runAllowed: false,
          }}
        >
          <ChatMessageList
            messages={tab.messages}
            queuedMessages={[]}
            chatId={tab.id}
            agentUsage={tab.agentUsage}
            turnDiffs={tab.turnDiffs}
            targetOverride={{
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              chatId: tab.id,
            }}
            hideBranchActions
            onClearQueuedMessage={(): void => undefined}
            pagingControls={
              <TranscriptPagingControls
                loading={loading}
                error={error}
                hasEarlier={tab.transcriptWindow?.before !== undefined}
                onLoadEarlier={(): void => {
                  void loadEarlier();
                }}
                onReload={(): void => {
                  void loadEarlier();
                }}
              />
            }
          />
        </WorkspaceAccessContext.Provider>
      ) : (
        <p className="p-4 text-s fg-secondary">
          {error ?? 'Loading transcript…'}
        </p>
      )}
    </DialogModal>
  );
}

/** Navigate to a waiting session. Only navigates: never resumes or schedules. */
function openUsageLimitedSession({
  session,
  workspaceId,
}: UsageLimitedSessionEntry): void {
  if (session.kind === 'chat') {
    void navigateToLiveChat({
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      chatId: session.chatId,
      workspaceId,
    });
    return;
  }
  void openPipelineExecutionFromUi({
    executionId: session.executionId,
    ...(session.projectId && session.worktreeId
      ? {
          owner: {
            projectId: session.projectId,
            worktreeId: session.worktreeId,
          },
        }
      : {}),
  });
}

/**
 * Sessions (chats and pipelines) waiting on this provider's usage limit.
 * Shown only while a rate-limit window is confirmed still at 100% (a window
 * whose reset time has passed is stale, not blocking): it says how many are
 * waiting, the expected reset when every blocking window reports one, and
 * navigates to each session. Once nothing blocks, the surface's one
 * interrupted-sessions notice offers the resume instead. The account-proxy
 * group passes the native `rateLimits`, so eligibility matches the native
 * group rather than the proxy's display windows.
 */
function UsageLimitedSessionsSection({
  provider,
  nowMs,
  boxed = false,
}: {
  provider: LoginProviderUsageSummary;
  nowMs: number;
  /** In its own row box, for a group whose rows the host does not supply. */
  boxed?: boolean;
}): JSX.Element | null {
  const { sessions, status } = useUsageLimitedSessions(
    provider.provider,
    nowMs,
  );
  const [retainedReview, setRetainedReview] = useState<Extract<
    UsageLimitedSessionItem,
    { kind: 'chat' }
  > | null>(null);
  const [first, ...rest] = sessions;
  const resetAtMs = selectBlockingResetAtMs(provider.rateLimits, nowMs);
  const entriesById = new Map(
    sessions.map((entry) => [waitingSessionId(entry.session), entry]),
  );
  const waiting: NonEmptyUsageLimitedWaitingSessions | null =
    first === undefined
      ? null
      : [toWaitingSession(first), ...rest.map(toWaitingSession)];
  const row =
    (waiting !== null || status === 'idle') &&
    hasBlockingRateLimit(provider.rateLimits, nowMs) ? (
      <UsageLimitedSessionsControl
        testIdPrefix={`usage-provider-${provider.provider}`}
        state={
          waiting === null
            ? { kind: 'loading' }
            : {
                kind: 'waiting',
                sessions: waiting,
                resetLabel:
                  resetAtMs === null
                    ? null
                    : formatUsageLimitTimeLabel(resetAtMs),
                onOpenSession: (session): void => {
                  const target = entriesById.get(session.id);
                  if (!target) return;
                  if (
                    target.session.kind === 'chat' &&
                    target.session.projectId === CODE_REVIEW_CHAT_PROJECT_ID
                  ) {
                    setRetainedReview(target.session);
                  } else {
                    openUsageLimitedSession(target);
                  }
                },
              }
        }
      />
    ) : null;
  return (
    <>
      {row && (boxed ? <UsageRowList>{row}</UsageRowList> : row)}
      {retainedReview && (
        <RetainedReviewChatDialog
          key={waitingSessionId(retainedReview)}
          session={retainedReview}
          onClose={(): void => setRetainedReview(null)}
        />
      )}
    </>
  );
}

function isAccountProviderUsageSummary(
  provider: ProviderUsageSummary,
): provider is AccountProviderUsageSummary {
  return (
    provider.provider === 'claude' ||
    provider.provider === 'codex' ||
    provider.provider === 'cursor' ||
    provider.provider === 'copilot'
  );
}

/** Account-usage summaries in wire order, respecting the Cursor rollout. */
export function selectAccountProviderUsageSummaries(
  usage: AgentUsageOverview,
  cursorEnabled = true,
  copilotEnabled = true,
): AccountProviderUsageSummary[] {
  return usage.providers
    .filter(isAccountProviderUsageSummary)
    .filter((provider) => cursorEnabled || provider.provider !== 'cursor')
    .filter((provider) => copilotEnabled || provider.provider !== 'copilot');
}

interface ProviderUsageCardProps {
  provider: AccountProviderUsageSummary;
  nowMs: number;
  /** Retained snapshots for OTHER accounts of this provider. */
  snapshots: AgentUsageOverview['accountSnapshots'];
  refreshingProviders: Set<AgentProviderType>;
  refreshProviderUsage: (provider: AgentProviderType) => Promise<void>;
  refreshProviderUsageDetails: (
    provider: AgentProviderType,
  ) => Promise<AgentUsageOverview>;
}

/**
 * One provider's usage group: its name and plan as the heading, a row per
 * limit window, then the account as the last row, with retained snapshots
 * of other accounts and any error under it. Shared by the standalone Usage
 * page (via {@link ProviderUsageCards}) and the Usage panel, so both
 * surfaces render identical content. The surface owns refresh.
 */
export function ProviderUsageCard({
  provider,
  nowMs,
  snapshots,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
}: ProviderUsageCardProps): JSX.Element {
  const proxyHarness =
    provider.provider === 'claude' || provider.provider === 'codex'
      ? provider.provider
      : undefined;
  const proxied = useProviderAccountSource(proxyHarness) === 'account-proxy';
  const providerLabel = getModelCatalogProviderLabel(provider.provider);

  if (
    proxied &&
    (provider.provider === 'claude' || provider.provider === 'codex')
  ) {
    return (
      <UsageGroup
        title={providerLabel}
        provider={provider.provider}
        plan="Account proxy"
        testId={`usage-provider-card-${provider.provider}`}
        childrenGap="inline"
      >
        <AccountProxyUsageSection harness={provider.provider} nowMs={nowMs} />
        <UsageLimitedSessionsSection provider={provider} nowMs={nowMs} boxed />
      </UsageGroup>
    );
  }

  return (
    <ProviderUsageDetails
      provider={provider}
      providerLabel={providerLabel}
      nowMs={nowMs}
      snapshots={snapshots}
      refreshingProviders={refreshingProviders}
      refreshProviderUsage={refreshProviderUsage}
      refreshProviderUsageDetails={refreshProviderUsageDetails}
    />
  );
}

/** The user's own sign-in on this device: its limits, account, and errors. */
function ProviderUsageDetails({
  provider,
  providerLabel,
  nowMs,
  snapshots,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
}: ProviderUsageCardProps & { providerLabel: string }): JSX.Element {
  const subCards = buildSubCards(provider.provider, provider.rateLimits);
  const errorInfo = resolveUsageErrorInfo(provider.errorInfo, provider.error);
  return (
    <UsageProviderGroup
      title={providerLabel}
      provider={provider.provider}
      plan={
        provider.authState === 'authenticated'
          ? usagePlanLabel(providerLabel, provider.subscriptionLabel)
          : null
      }
      planTestId={`usage-provider-${provider.provider}-plan-chip`}
      testId={`usage-provider-card-${provider.provider}`}
      windows={subCards}
      nowMs={nowMs}
      rows={
        <>
          {/* The error notice below already explains why no live data is
              available, so this row only renders for the error-free case. */}
          {subCards.length === 0 && !errorInfo ? (
            <UsageRow
              title="Limits"
              detail="No live remaining-limit data is available for this provider in the current session."
            />
          ) : null}
          {provider.provider === 'claude' || provider.provider === 'codex' ? (
            <UsageLimitedSessionsSection provider={provider} nowMs={nowMs} />
          ) : null}
          {provider.provider === 'cursor' || provider.provider === 'copilot' ? (
            <ManagedAccountRow provider={provider} />
          ) : (
            <ProviderAccountRow
              provider={provider}
              refreshProviderUsageDetails={refreshProviderUsageDetails}
            />
          )}
        </>
      }
      footer={
        <>
          <OtherAccountSnapshots
            provider={provider.provider}
            activeEmail={provider.accountEmail}
            activeSubscriptionLabel={provider.subscriptionLabel}
            snapshots={snapshots ?? []}
            nowMs={nowMs}
          />
          {errorInfo && (
            <UsageErrorNotice
              label={providerLabel}
              testIdPrefix={`usage-provider-${provider.provider}`}
              info={errorInfo}
              onRetry={(): void => {
                void refreshProviderUsage(provider.provider);
              }}
              retrying={refreshingProviders.has(provider.provider)}
              showingRetainedUsage={subCards.length > 0}
              frameless
            />
          )}
        </>
      }
    />
  );
}

export function ProviderUsageCards({
  nowMs,
  usage,
  refreshingProviders,
  refreshProviderUsage,
  refreshProviderUsageDetails,
}: ProviderUsageCardsProps): JSX.Element {
  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const providers = selectAccountProviderUsageSummaries(
    usage,
    cursorEnabled,
    copilotEnabled,
  );

  return (
    <>
      {providers.map((provider) => (
        <ProviderUsageCard
          key={provider.provider}
          provider={provider}
          nowMs={nowMs}
          snapshots={usage.accountSnapshots ?? []}
          refreshingProviders={refreshingProviders}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
        />
      ))}
      <OpenCodeUsageSection usage={usage} />
      <AntigravityUsageSection usage={usage} />
    </>
  );
}

/** Host gate around the shared Antigravity plan group. */
export function AntigravityUsageSection({
  usage,
}: {
  usage: AgentUsageOverview;
}): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  if (!enabled || !usage.antigravityAccount) return null;
  return <AntigravityAccountCard snapshot={usage.antigravityAccount} />;
}

/** Host gate around the shared OpenCode account group. */
export function OpenCodeUsageSection({
  usage,
}: {
  usage: AgentUsageOverview;
}): JSX.Element | null {
  const openSettings = useNavigationStore((state) => state.openSettings);
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  if (!enabled || !usage.openCodeAccounts) return null;
  return (
    <OpenCodeAccountCard
      snapshot={usage.openCodeAccounts}
      onManageProviders={(): void => openSettings(getOpenCodeSettingsSection())}
    />
  );
}
