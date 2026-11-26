import { CodeBlock } from '@canopy/ui-shared/components';
import { type BadgeTone } from '@canopy/ui-shared/primitives/Badge';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import type {
  AgentAuditEntry,
  AgentAuditEventType,
  AgentAuditLinkTarget,
  AgentAuditHistoryRequest,
  AgentAuditStatus,
  AgentAuditTranscriptResponse,
  AgentTranscriptInjectedPrompt,
} from '@canopy/desktop-shared/types';
import {
  AGENT_AUDIT_EVENT_TYPES,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  CHAT_LABEL,
  CHAT_UNIT_LABEL,
  ORCHESTRATOR_LABEL,
  WORKTREE_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import {
  entriesToCsv,
  formatAuditCostLabel,
  formatRequestedSpeed,
} from './auditTrailCost';
import {
  AUDIT_TRAIL_PROVIDERS,
  auditEntryWorkspaceId,
  auditTrailProviderSelection,
  type AuditTrailProvider,
} from '@/lib/auditTrailFilters';
import { ModelProviderIcon } from '@canopy/ui-shared/components';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { TranscriptViewer } from '@/components/chat/TranscriptViewer';
import { DialogModal } from '@/components/shared/DialogModal';
import { SearchBar } from '@/components/shared/search/SearchBar';
import { LoadingSpinner } from '@/components/shared/loading';
import {
  Stack,
  EmptyState,
  ErrorState,
  Heading,
  StatusLabel,
  Surface,
} from '@canopy/ui-shared/components';
import { useContentSearch } from '@/hooks/useContentSearch';
import { createDomSearchExecutor } from '@/lib/dom-search-highlight';
import { formatElapsed, getElapsedMs } from '@/lib/pipelineTiming';
import type { SearchExecutor } from '@/components/shared/search/search-types';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
} from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useObservabilityEntriesInterest } from '@/lib/chat-interest';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { brandText } from '@/lib/brand';
import { requestPipelineAssistantOpen } from '@/lib/pipelineAssistantEvents';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { switchContextForWorkspace } from '@/lib/contextScope';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import {
  Button,
  DelayedLoadingPlaceholder,
  LoadingIndicator,
  PageHeader,
  PageSearchControls,
  PageSearchField,
  PageSearchFilters,
  PageSearchRow,
  pageFilter,
  Badge,
  SegmentedControl,
  Skeleton,
} from '@canopy/ui-shared/components';
import { SAMPLE_AUDIT_ENTRIES } from './auditTrailSamples';
import {
  Download as AppCatalogDownload,
  ExternalIcon as AppCatalogExternalIcon,
} from '@canopy/ui-shared/icons/AppIcons';

function formatMetric(entry: AgentAuditEntry): string {
  const totalTokens = entry.tokens.input + entry.tokens.output;
  return `${totalTokens.toLocaleString()} tokens`;
}

/** The Status filter's values, in order. */
const AUDIT_TRAIL_STATUSES: readonly AgentAuditStatus[] = [
  'running',
  'success',
  'failure',
  'cancelled',
  'interrupted',
];

function formatStatus(status: AgentAuditStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'success':
      return 'Success';
    case 'failure':
      return 'Failure';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
  }
}

function statusBadgeTone(status: AgentAuditStatus): BadgeTone {
  switch (status) {
    case 'running':
      return 'info';
    case 'success':
      return 'success';
    case 'failure':
      return 'danger';
    case 'cancelled':
      return 'warning';
    case 'interrupted':
      return 'warning';
  }
}

function displayLabelForEntry(entry: AgentAuditEntry): string {
  switch (entry.eventType) {
    case 'worktree_chat':
      return `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL.toLowerCase()}`;
    case 'standalone_chat':
      return `${CHAT_LABEL} ${CHAT_UNIT_LABEL.toLowerCase()}`;
    case 'chat_summary':
      return `${CHAT_UNIT_LABEL} summary`;
    // Entries recorded before the rename stored "App Advisor" as their label.
    case 'app_advisor':
      return ORCHESTRATOR_LABEL;
    default:
      return entry.label;
  }
}

/**
 * Opens an audited worktree chat: switches to its live tab when one still
 * exists, otherwise hands off to the worktree tab bar's read-only archive
 * transcript viewer.
 *
 * The distinction is load-bearing. Archived chats are removed from the active
 * tab list, and `switchTab` sets `activeTabId` unconditionally and persists it,
 * so calling it with an archived id both fails to open the chat and leaves the
 * worktree pointing at a tab that no longer exists. Archive-origin handoff
 * summaries hit exactly this path, since the archive flow intentionally leaves
 * its source chat archived. Mirrors `ForkedFromLink`'s navigation.
 */
function openWorktreeChatOrArchive(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const chatStore = useChatStore.getState();
  const tabs = chatStore.worktreeChats[`${projectId}/${worktreeId}`]?.tabs;
  if (tabs?.some((tab) => tab.id === chatId)) {
    chatStore.switchTab(chatId, { projectId, worktreeId });
    return;
  }
  // A frame's delay lets the freshly selected worktree's tab bar mount its
  // listener before the request fires.
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
        detail: { projectId, worktreeId, chatId },
      }),
    );
  });
}

/**
 * Inspect a worktree-chat entry: select its worktree on the main page, open
 * its plan's Plan panel beside the entry's chat when it links a plan, then
 * open that chat.
 */
async function openWorktreeChatLink(
  linkTarget: AgentAuditLinkTarget,
): Promise<void> {
  const { projectId, worktreeId, planId, chatId } = linkTarget;
  if (!projectId || !worktreeId) return;
  const chatStore = useChatStore.getState();
  useNavigationStore.getState().navigate('main');
  chatStore.selectWorktree(projectId, worktreeId);
  const tabsLoaded = await chatStore.ensureSelectedWorktreeTabsLoaded();
  if (planId) {
    // The worktree is already on screen, so the opener only places the panel.
    await openTrackedPlan(
      { projectId, worktreeId, planId },
      { navigate: false, ...(chatId ? { origin: { chatTabId: chatId } } : {}) },
    );
  }
  if (tabsLoaded && chatId) {
    openWorktreeChatOrArchive(projectId, worktreeId, chatId);
  }
}

/**
 * Display label for every audit event type. Exhaustive by construction, so a
 * new `AgentAuditEventType` is a compile error here and its filter option is
 * generated automatically. Previously the parser was compile-safe but the
 * `<option>` list was hand-maintained, so a new type could be recorded and
 * displayed while remaining impossible to filter for — the drift that hid
 * `automation_if_command_generation`.
 */
const EVENT_TYPE_FILTER_LABELS: Record<AgentAuditEventType, string> = {
  worktree_chat: `${WORKTREE_LABEL} ${CHAT_UNIT_LABEL.toLowerCase()}`,
  standalone_chat: `${CHAT_LABEL} ${CHAT_UNIT_LABEL.toLowerCase()}`,
  app_advisor: ORCHESTRATOR_LABEL,
  pipeline_editor: 'Workflow editor',
  pipeline_agent_turn: 'Workflow agent',
  pipeline_advisor: 'Workflow Advisor',
  pr_generation: 'PR generation',
  pr_split_planning: 'PR split planning',
  commit_message_generation: 'Commit message',
  branch_naming: 'Branch naming',
  cron_generation: 'Cron generation',
  automation_if_command_generation: 'Automation condition',
  worktree_summary: `${WORKTREE_UNIT_LABEL} summary`,
  chat_summary: `${CHAT_UNIT_LABEL} summary`,
  chat_handoff_summary: `${CHAT_UNIT_LABEL} handoff summary`,
  archive_summary: 'Archive summary',
  worktree_plan_chat: `${WORKTREE_LABEL} plan ${CHAT_LABEL}`,
  worktree_plan_diagram: `${WORKTREE_LABEL} plan diagram`,
  code_review_annotations: 'Review annotations',
  code_review_diagram: 'Review diagram',
  local_memory_consolidation: 'Memory consolidation',
  local_memory_chat_profile: 'Chat history profile',
  skill_suggestion_scan: 'Skill suggestion scan',
  managed_delegation: 'Delegation',
};

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatInjectedPromptCondition(
  condition: AgentTranscriptInjectedPrompt['applicationCondition'],
): string {
  switch (condition) {
    case 'claude_system_prompt_append_each_turn':
      return 'Applied on each Claude turn';
    case 'codex_first_turn_without_session_id':
      return 'Applied on the first Codex turn without a resumed session';
    case 'helper_task_system_prompt':
      return 'Applied as helper task system instructions';
    case 'pipeline_step_system_prompt':
      return 'Applied as workflow step system instructions';
    case 'plan_mode_enabled':
      return 'Applied when Codex plan mode is enabled';
    case 'deferred_tools_reload_continuation':
      return 'Applied after deferred tools were enabled';
    case 'org_memory_enabled_for_turn':
      return 'Applied when organization memory is enabled for the turn';
    case 'local_memory_enabled_for_turn':
      return 'Applied when local memory is enabled for the turn';
    case 'local_memory_withheld_for_turn':
      return 'Local memory withheld for this internal sample';
  }
}

interface IdentifierRowProps {
  label: string;
  value?: string;
  testId?: string;
  monospace?: boolean;
}

function IdentifierRow({
  label,
  value,
  testId,
  monospace = true,
}: IdentifierRowProps): JSX.Element {
  if (!value) {
    return <></>;
  }

  return (
    <Stack gap="tight" data-testid={testId}>
      <p className="text-2xs fg-secondary">{label}</p>
      <p
        className={`text-xs fg-primary ${monospace ? 'break-all font-mono' : 'break-words'}`}
      >
        {value}
      </p>
    </Stack>
  );
}

/**
 * The speed a turn requested. Audit entries hold only request evidence, so
 * the row never claims the requested speed was served.
 */
function RequestedSpeedRow({ entry }: { entry: AgentAuditEntry }): JSX.Element {
  const speed = formatRequestedSpeed(entry);
  return (
    <IdentifierRow
      label="Speed"
      value={speed ? `${speed.requested} · ${speed.actual}` : undefined}
      testId="audit-transcript-requested-speed"
      monospace={false}
    />
  );
}

interface AuditDurationProps {
  entry: AgentAuditEntry;
  className?: string;
}

/**
 * Renders an audit entry's elapsed duration, always computed from the
 * start/stop timestamps rather than the persisted `durationMs`. For running
 * entries it ticks once per second by falling back to "now"; finished entries
 * (success/failure/cancelled/interrupted) render a static `startedAt` →
 * `completedAt` value. Reuses the shared pipeline timing helpers so audit
 * durations match the formatting used elsewhere in the activity UI.
 */
function AuditDuration({ entry, className }: AuditDurationProps): JSX.Element {
  const isRunning = entry.status === 'running' && !entry.completedAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    setNow(Date.now());
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [isRunning]);

  const elapsedMs = getElapsedMs({
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    nowMs: now,
    fallbackToNow: isRunning,
  });

  return (
    <span
      className={className}
      data-testid={`audit-duration-${entry.id}`}
      title="Duration"
    >
      {entry.startedAt ? formatElapsed(elapsedMs) : '—'}
    </span>
  );
}

interface AuditEntryCardProps {
  entry: AgentAuditEntry;
  onOpenTranscript: () => void;
  onInspect: () => void;
}

/** One audit entry: its run, status, timing, counts, and actions. */
function AuditEntryCard({
  entry,
  onOpenTranscript,
  onInspect,
}: AuditEntryCardProps): JSX.Element {
  const costLabel = formatAuditCostLabel(entry);
  return (
    <Surface variant="group" data-testid={`audit-entry-${entry.id}`}>
      <div className="flex flex-col px-4 py-4 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Stack gap="tight">
            <div className="flex flex-wrap items-center gap-2">
              <ModelProviderIcon provider={entry.provider} size="sm" />
              <span className="text-s font-semibold fg-primary">
                {displayLabelForEntry(entry)}
              </span>
              <Badge>{entry.provider}</Badge>
              {entry.chatMode === 'terminal' && (
                <Badge data-testid={`audit-chat-mode-badge-${entry.id}`}>
                  Terminal
                </Badge>
              )}
              <Badge tone={statusBadgeTone(entry.status)}>
                {formatStatus(entry.status)}
              </Badge>
              {entry.aiCreditsRouted && !entry.modelGatewayRouted && (
                <Badge
                  data-testid={`audit-ai-credits-badge-${entry.id}`}
                  title="This run's LLM traffic was routed through your AI Credits."
                >
                  AI Credits
                </Badge>
              )}
            </div>
            <p className="text-xs fg-secondary">
              {new Date(entry.startedAt).toLocaleString()}
              {entry.model ? ` · ${entry.model}` : ''}
              {entry.repoLabel ? ` · ${entry.repoLabel}` : ''}
            </p>
          </Stack>
          <div className="flex items-center gap-3">
            {entry.hasTranscript && (
              <Button
                size="compact"
                onClick={onOpenTranscript}
                data-testid={`audit-transcript-button-${entry.id}`}
              >
                Transcript
              </Button>
            )}
            {entry.linkTarget && (
              <Button
                size="compact"
                onClick={onInspect}
                data-testid={`audit-inspect-button-${entry.id}`}
              >
                <AppCatalogExternalIcon size="sm" />
                Inspect
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 text-xs fg-secondary">
          <div className="flex flex-wrap gap-4">
            <AuditDuration entry={entry} />
            <span>{entry.messageCount} messages</span>
            <span>{entry.toolUseCount} tool uses</span>
            <span>{entry.subAgentCount} sub-agents</span>
            {costLabel !== null ? (
              <span data-testid={`audit-cost-${entry.id}`}>{costLabel}</span>
            ) : null}
          </div>
          <span data-testid={`audit-tokens-${entry.id}`}>
            {formatMetric(entry)}
          </span>
        </div>

        {entry.error && (
          <p>
            <StatusLabel size="s">{entry.error}</StatusLabel>
          </p>
        )}
      </div>
    </Surface>
  );
}

const noop = (): void => undefined;

/**
 * Entries that have not arrived: `AuditEntryCard` itself, rendered from
 * plain samples inside the measured `Skeleton`, so the bars sit where the
 * entries will.
 */
function AuditEntryListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading audit entries"
      testId="audit-trail-loading"
    >
      <Stack gap="item">
        {SAMPLE_AUDIT_ENTRIES.map((entry) => (
          <AuditEntryCard
            key={entry.id}
            entry={entry}
            onOpenTranscript={noop}
            onInspect={noop}
          />
        ))}
      </Stack>
    </Skeleton>
  );
}

interface DurationRowProps {
  label: string;
  entry: AgentAuditEntry;
}

function DurationRow({ label, entry }: DurationRowProps): JSX.Element {
  return (
    <Stack gap="tight">
      <p className="text-2xs fg-secondary">{label}</p>
      <AuditDuration entry={entry} className="font-mono text-xs fg-primary" />
    </Stack>
  );
}

export function AuditTrailPage(): JSX.Element {
  useObservabilityEntriesInterest();
  const initialize = useObservabilityStore((s) => s.initialize);
  const refreshHistory = useObservabilityStore((s) => s.refreshHistory);
  const loadMoreHistory = useObservabilityStore((s) => s.loadMoreHistory);
  const loadTranscript = useObservabilityStore((s) => s.loadTranscript);
  const historyEntries = useObservabilityStore((s) => s.historyEntries);
  const loadingHistory = useObservabilityStore((s) => s.loadingHistory);
  const nextCursor = useObservabilityStore((s) => s.nextCursor);
  const activeHistoryRequest = useObservabilityStore(
    (s) => s.activeHistoryRequest,
  );

  const [search, setSearch] = useState('');
  const [provider, setProvider] =
    useState<AgentAuditHistoryRequest['provider']>('all');
  const [status, setStatus] = useState<'all' | AgentAuditStatus>('all');
  const [eventType, setEventType] = useState<'all' | AgentAuditEventType>(
    'all',
  );
  const [contextFilter, setContextFilter] = useState<'context' | 'all'>(
    'context',
  );
  const [exporting, setExporting] = useState(false);
  const [transcriptEntry, setTranscriptEntry] =
    useState<AgentAuditEntry | null>(null);
  const [transcriptResponse, setTranscriptResponse] =
    useState<AgentAuditTranscriptResponse | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptViewMode, setTranscriptViewMode] = useState<'rich' | 'raw'>(
    'rich',
  );
  const transcriptRequestIdRef = useRef(0);
  const { context: scopingContext, isInContext } = useContextScopedWorkspaces();
  const visibleHistoryEntries = useMemo(
    () =>
      contextFilter === 'all'
        ? historyEntries
        : historyEntries.filter((entry) => {
            const workspaceId = auditEntryWorkspaceId(entry);
            return workspaceId === undefined || isInContext(workspaceId);
          }),
    [contextFilter, historyEntries, isInContext],
  );
  const transcriptDisplayEntry =
    transcriptEntry === null
      ? null
      : (historyEntries.find((entry) => entry.id === transcriptEntry.id) ??
        transcriptEntry);

  useWorkspaceContextReset((): void => {
    transcriptRequestIdRef.current += 1;
    setTranscriptEntry(null);
    setTranscriptResponse(null);
    setTranscriptError(null);
    setLoadingTranscript(false);
  });

  // Transcript content search
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const transcriptSearchInputRef = useRef<HTMLInputElement>(null);
  const transcriptSearchExecutor = useMemo(
    (): SearchExecutor =>
      createDomSearchExecutor(
        () => transcriptContentRef.current,
        () =>
          transcriptContentRef.current?.closest('[data-transcript-scroll]') ??
          transcriptContentRef.current,
      ),
    [],
  );
  const transcriptSearchExecutorRef = useRef<SearchExecutor>(
    transcriptSearchExecutor,
  );
  transcriptSearchExecutorRef.current = transcriptSearchExecutor;
  const transcriptSearch = useContentSearch(transcriptSearchExecutorRef);

  // Cmd+F focuses transcript search input when modal is open
  useEffect(() => {
    if (!transcriptEntry) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        transcriptSearchInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void =>
      document.removeEventListener('keydown', handleKeyDown, true);
  }, [transcriptEntry]);

  const filterRequest: AgentAuditHistoryRequest = {
    search,
    provider,
    status,
    eventType,
  };
  const historyRequestIsCurrent =
    activeHistoryRequest !== null &&
    activeHistoryRequest.search === filterRequest.search &&
    activeHistoryRequest.provider === filterRequest.provider &&
    activeHistoryRequest.status === filterRequest.status &&
    activeHistoryRequest.eventType === filterRequest.eventType;

  useEffect(() => {
    void initialize().then(() => {
      void refreshHistory(filterRequest);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType, initialize, provider, refreshHistory, search, status]);

  // History is paginated globally, so a selected context can have no entries
  // in the first page even though matching entries exist later. Continue
  // loading until one visible page is filled or the global history is
  // exhausted. The active-request guard prevents a filter change from using a
  // cursor that belongs to the previous request while refreshHistory starts.
  useEffect(() => {
    if (
      contextFilter !== 'context' ||
      !historyRequestIsCurrent ||
      loadingHistory ||
      !nextCursor ||
      visibleHistoryEntries.length >= 50
    ) {
      return;
    }
    void loadMoreHistory(filterRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contextFilter,
    eventType,
    historyRequestIsCurrent,
    loadingHistory,
    loadMoreHistory,
    nextCursor,
    provider,
    search,
    status,
    visibleHistoryEntries.length,
  ]);

  // Infinite scroll via IntersectionObserver
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(loadMoreHistory);
  loadMoreRef.current = loadMoreHistory;
  const filterRequestRef = useRef(filterRequest);
  filterRequestRef.current = filterRequest;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const target = observerEntries[0];
        if (target?.isIntersecting) {
          void loadMoreRef.current(filterRequestRef.current);
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const handleExport = useCallback(async (): Promise<void> => {
    setExporting(true);
    try {
      const allEntries: AgentAuditEntry[] = [];
      let cursor: string | undefined;

      for (;;) {
        const response = await window.api.observability.loadHistory({
          limit: 200,
          ...filterRequest,
          cursor,
        });
        allEntries.push(...response.entries);
        cursor = response.nextCursor;
        if (!cursor) {
          break;
        }
      }

      const exportEntries =
        contextFilter === 'all'
          ? allEntries
          : allEntries.filter((entry) => {
              const workspaceId = auditEntryWorkspaceId(entry);
              return workspaceId === undefined || isInContext(workspaceId);
            });
      const csv = entriesToCsv(exportEntries);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadCsv(csv, `canopy-audit-${timestamp}.csv`);
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, provider, status, eventType, contextFilter, isInContext]);

  const openEntry = async (entry: AgentAuditEntry): Promise<void> => {
    const workspaceId = auditEntryWorkspaceId(entry);
    if (
      workspaceId !== undefined &&
      !(await switchContextForWorkspace(workspaceId))
    ) {
      return;
    }
    const linkTarget = entry.linkTarget;
    if (!linkTarget) {
      return;
    }

    if (linkTarget.kind === 'worktree-chat') {
      await openWorktreeChatLink(linkTarget);
      return;
    }

    if (linkTarget.kind === 'standalone-chat') {
      // `projectId` carries the cowork workspace id on entries persisted
      // after the cowork rekeying. Entries persisted before that rekeying
      // only have `worktreeId` set to the legacy chat-project id; that
      // fallback is best-effort and degrades to a no-op switch if the id no
      // longer resolves to a chat project.
      const workspaceId = linkTarget.projectId ?? linkTarget.worktreeId;
      if (!workspaceId) {
        return;
      }
      await useStandaloneChatStore.getState().switchChatProject(workspaceId);
      if (linkTarget.chatId) {
        // selectChat resolves which Work Entry owns the chat and selects it.
        await useStandaloneChatStore.getState().selectChat(linkTarget.chatId);
      }
      useNavigationStore.getState().navigate('chat');
      return;
    }

    if (linkTarget.kind === 'pipeline-editor') {
      // The pipeline-editor chat lives in the drawer on the Pipelines page,
      // keyed by the pipeline-editor sentinel target. Navigate there and
      // best-effort focus the originating chat tab once its tabs are loaded.
      const chatStore = useChatStore.getState();
      useNavigationStore.getState().navigate('workflows-library');
      requestPipelineAssistantOpen();
      void window.api
        .savePreferences({ pipelineChatPanelVisible: true })
        .catch(() => {
          // The immediate renderer event still opens the drawer for this
          // session when the Pipelines page is already mounted.
        });
      if (linkTarget.chatId) {
        try {
          await chatStore.loadTabsForTarget(
            PIPELINE_EDITOR_PROJECT_ID,
            PIPELINE_EDITOR_WORKTREE_ID,
          );
          chatStore.switchTab(linkTarget.chatId, {
            projectId: PIPELINE_EDITOR_PROJECT_ID,
            worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          });
        } catch {
          // Stay on Pipelines; the drawer will fall back to its persisted tab
          // if the sentinel chat target cannot be hydrated.
        }
      }
      return;
    }

    if (linkTarget.kind === 'app-advisor') {
      // Open / focus the standalone App Advisor window and forward the
      // chatId so the App Advisor renderer's `select_chat` command
      // subscription can select the requested tab once it finishes
      // loading. Audit-trail links never originate from inside the App
      // Advisor surface itself, so a fire-and-forget IPC is sufficient
      // here; window-state sync arrives via the broadcast subscription
      // mounted in `App.tsx`.
      void window.api.appAdvisor.openWindow({
        focus: true,
        ...(linkTarget.chatId ? { chatId: linkTarget.chatId } : {}),
      });
      return;
    }

    if (
      linkTarget.kind === 'pipeline-execution' &&
      linkTarget.pipelineExecutionId
    ) {
      // The run (possibly a child run, which opens as its own panel) opens in
      // its recorded owner's layout. The entry's scope is not passed as a
      // hint: Cowork entries record the legacy workspace-id shape.
      await openPipelineExecutionFromUi({
        executionId: linkTarget.pipelineExecutionId,
      });
    }
  };

  const handleOpenTranscript = useCallback(
    async (entry: AgentAuditEntry): Promise<void> => {
      const requestId = transcriptRequestIdRef.current + 1;
      transcriptRequestIdRef.current = requestId;
      setTranscriptEntry(entry);
      setTranscriptResponse(null);
      setTranscriptError(null);
      setTranscriptViewMode('rich');
      setLoadingTranscript(true);
      try {
        const response = await loadTranscript(entry);
        if (transcriptRequestIdRef.current !== requestId) {
          return;
        }
        setTranscriptResponse(response);
      } catch (error) {
        if (transcriptRequestIdRef.current !== requestId) {
          return;
        }
        setTranscriptError(
          error instanceof Error ? error.message : 'Failed to load transcript.',
        );
      } finally {
        if (transcriptRequestIdRef.current === requestId) {
          setLoadingTranscript(false);
        }
      }
    },
    [loadTranscript],
  );

  return (
    <section
      className="page-scroll-gutter flex h-full flex-col overflow-y-auto"
      data-testid="page-audit"
    >
      <PageTitlebar />
      <PageContent bottomInset="tight" className="shrink-0">
        <Stack gap="group">
          <PageHeader
            title="Audit trail"
            description="Chronological summaries of chat turns, helper tasks, and workflow agent steps."
            actions={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  void handleExport();
                }}
                disabled={exporting}
              >
                <AppCatalogDownload width="14" height="14" aria-hidden="true" />
                {exporting ? 'Exporting…' : 'Export CSV'}
              </Button>
            }
          />

          <PageSearchRow testId="audit-trail-search-row">
            <PageSearchField
              value={search}
              onValueChange={setSearch}
              placeholder="Search the audit trail"
              aria-label="Search the audit trail"
              data-testid="audit-trail-search"
              clearTestId="audit-trail-search-clear"
            />
            <PageSearchControls>
              <PageSearchFilters
                filters={[
                  ...(scopingContext !== undefined
                    ? [
                        pageFilter<'context'>({
                          key: 'context',
                          title: 'Scope',
                          anyLabel: 'All contexts',
                          options: [
                            { value: 'context', label: 'Selected context' },
                          ],
                          selected:
                            contextFilter === 'context' ? ['context'] : [],
                          onToggle: (): void => setContextFilter('context'),
                          onClear: (): void => setContextFilter('all'),
                          testId: 'audit-trail-context-filter',
                        }),
                      ]
                    : []),
                  pageFilter<AuditTrailProvider>({
                    key: 'provider',
                    title: 'Provider',
                    anyLabel: 'All providers',
                    options: AUDIT_TRAIL_PROVIDERS.map((value) => ({
                      value,
                      label: getModelCatalogProviderLabel(value),
                    })),
                    selected: auditTrailProviderSelection(provider),
                    onToggle: (value): void =>
                      setProvider(provider === value ? 'all' : value),
                    onClear: (): void => setProvider('all'),
                    testId: 'audit-trail-provider-filter',
                  }),
                  pageFilter<AgentAuditStatus>({
                    key: 'status',
                    title: 'Status',
                    anyLabel: 'All statuses',
                    options: AUDIT_TRAIL_STATUSES.map((value) => ({
                      value,
                      label: formatStatus(value),
                    })),
                    selected: status === 'all' ? [] : [status],
                    onToggle: (value): void =>
                      setStatus(status === value ? 'all' : value),
                    onClear: (): void => setStatus('all'),
                    testId: 'audit-trail-status-filter',
                  }),
                  pageFilter<AgentAuditEventType>({
                    key: 'event',
                    title: 'Event',
                    anyLabel: 'All events',
                    options: AGENT_AUDIT_EVENT_TYPES.map((value) => ({
                      value,
                      label: EVENT_TYPE_FILTER_LABELS[value],
                    })),
                    selected: eventType === 'all' ? [] : [eventType],
                    onToggle: (value): void =>
                      setEventType(eventType === value ? 'all' : value),
                    onClear: (): void => setEventType('all'),
                    testId: 'audit-trail-event-type-filter',
                  }),
                ]}
                onClearAll={(): void => {
                  setContextFilter('all');
                  setProvider('all');
                  setStatus('all');
                  setEventType('all');
                }}
                testId="audit-trail-filter"
              />
            </PageSearchControls>
          </PageSearchRow>
        </Stack>
      </PageContent>

      <div className="min-h-0 flex-1 overflow-auto">
        <PageContent>
          <Stack gap="item" data-testid="audit-entry-list">
            {visibleHistoryEntries.length === 0 && loadingHistory ? (
              <DelayedLoadingPlaceholder slowNote="Still loading audit entries…">
                <AuditEntryListSkeleton />
              </DelayedLoadingPlaceholder>
            ) : null}
            {visibleHistoryEntries.map((entry) => (
              <AuditEntryCard
                key={entry.id}
                entry={entry}
                onOpenTranscript={() => {
                  void handleOpenTranscript(entry);
                }}
                onInspect={() => {
                  void openEntry(entry);
                }}
              />
            ))}

            {visibleHistoryEntries.length === 0 && !loadingHistory && (
              <EmptyState title="No audit entries yet." />
            )}

            {/* More entries on their way below the loaded ones, as the
                list scrolls: a busy load-more keeps its verb. */}
            {loadingHistory && visibleHistoryEntries.length > 0 && (
              <div className="flex justify-center py-4 text-s fg-secondary">
                <LoadingIndicator />
              </div>
            )}

            {nextCursor && !loadingHistory && (
              <div ref={sentinelRef} className="h-1" aria-hidden="true" />
            )}
          </Stack>
        </PageContent>
      </div>
      {transcriptDisplayEntry && (
        <DialogModal
          inset="flush"
          onClose={() => {
            transcriptRequestIdRef.current += 1;
            transcriptSearch.close();
            setTranscriptEntry(null);
            setTranscriptResponse(null);
            setTranscriptError(null);
            setLoadingTranscript(false);
          }}
          title="Transcript"
          subtitle={`${displayLabelForEntry(transcriptDisplayEntry)} · ${new Date(transcriptDisplayEntry.startedAt).toLocaleString()}`}
          maxWidth="4xl"
          height="80vh"
        >
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-testid="audit-transcript-modal"
          >
            <Surface variant="section" boundary="bottom">
              <div className="flex flex-wrap items-center gap-3 px-6 py-3">
                <div className="text-s fg-secondary">
                  {transcriptResponse?.type === 'success' &&
                  transcriptResponse.truncation.truncated
                    ? `Transcript truncated at ${transcriptResponse.truncation.maxBytes.toLocaleString()} bytes.`
                    : 'View the captured raw sidecar or the reconstructed rich transcript.'}
                </div>
                <SearchBar
                  query={transcriptSearch.query}
                  onQueryChange={transcriptSearch.setQuery}
                  currentIndex={transcriptSearch.currentIndex}
                  totalCount={transcriptSearch.totalCount}
                  onNext={transcriptSearch.goToNext}
                  onPrevious={transcriptSearch.goToPrevious}
                  inputRef={transcriptSearchInputRef}
                  className="ml-auto"
                />
                <SegmentedControl<'rich' | 'raw'>
                  label="Transcript view"
                  value={transcriptViewMode}
                  width="content"
                  options={[
                    {
                      value: 'rich',
                      label: 'Rich',
                      dataTestId: 'audit-transcript-mode-rich',
                    },
                    {
                      value: 'raw',
                      label: 'Raw',
                      dataTestId: 'audit-transcript-mode-raw',
                    },
                  ]}
                  onChange={setTranscriptViewMode}
                />
              </div>
            </Surface>

            <div
              className="min-h-0 flex-1 overflow-auto"
              data-transcript-scroll
            >
              <Surface variant="section" boundary="bottom">
                <div className="grid gap-3 px-6 py-4 md:grid-cols-3">
                  <DurationRow
                    label="Duration"
                    entry={transcriptDisplayEntry}
                  />
                  <IdentifierRow
                    label="Project ID"
                    value={transcriptDisplayEntry.projectId}
                  />
                  <IdentifierRow
                    label={`${WORKTREE_UNIT_LABEL} ID`}
                    value={transcriptDisplayEntry.worktreeId}
                  />
                  <IdentifierRow
                    label={`${CHAT_UNIT_LABEL} ID`}
                    value={transcriptDisplayEntry.chatId}
                  />
                  <IdentifierRow
                    label="Session ID"
                    value={transcriptDisplayEntry.sdkSessionId}
                  />
                  <IdentifierRow
                    label="Repo ID"
                    value={transcriptDisplayEntry.repoId}
                  />
                  <IdentifierRow
                    label="Repo label"
                    value={transcriptDisplayEntry.repoLabel}
                  />
                  <RequestedSpeedRow entry={transcriptDisplayEntry} />
                  <IdentifierRow
                    label="Cost"
                    value={
                      formatAuditCostLabel(transcriptDisplayEntry) ?? undefined
                    }
                    testId="audit-transcript-cost"
                    monospace={
                      transcriptDisplayEntry.observedCost?.status !==
                        'unpriced' &&
                      transcriptDisplayEntry.observedCost?.status !==
                        'partially_priced'
                    }
                  />
                </div>
              </Surface>

              {transcriptResponse?.type === 'success' &&
                transcriptResponse.injectedPrompts.length > 0 && (
                  <Surface
                    variant="section"
                    boundary="bottom"
                    data-testid="audit-transcript-injected-prompts"
                  >
                    <div className="flex flex-col px-6 py-4 gap-3">
                      <div>
                        <Heading level={3} variant="title">
                          Injected prompts
                        </Heading>
                        <p className="text-xs fg-secondary">
                          Prompts {brandText.appName} injected outside the
                          user's original text.
                        </p>
                      </div>
                      {transcriptResponse.injectedPrompts.map(
                        (prompt, index) => (
                          <Surface
                            key={`${prompt.kind}-${String(index)}`}
                            variant="group"
                            gap="item"
                            padding="compact"
                          >
                            <Stack gap="tight">
                              <p className="text-xs font-medium fg-primary">
                                {prompt.kind === 'system_prompt_append'
                                  ? 'System prompt'
                                  : prompt.kind === 'org_memory'
                                    ? 'Organization memory'
                                    : prompt.kind === 'local_memory'
                                      ? 'Local memory'
                                      : 'Plan mode developer instructions'}
                              </p>
                              <p className="text-xs fg-secondary">
                                {prompt.provider} ·{' '}
                                {formatInjectedPromptCondition(
                                  prompt.applicationCondition,
                                )}
                              </p>
                            </Stack>
                            <CodeBlock
                              variant="document"
                              size="xs"
                              wrap="words"
                              tone="primary"
                              replay="block"
                            >
                              {prompt.text}
                            </CodeBlock>
                          </Surface>
                        ),
                      )}
                    </div>
                  </Surface>
                )}

              <div ref={transcriptContentRef} className="px-6 py-4">
                {loadingTranscript ? (
                  <div
                    className="flex min-h-60 items-center justify-center gap-3 text-s fg-secondary"
                    data-testid="audit-transcript-loading"
                  >
                    <LoadingSpinner tone="secondary" />
                    Loading transcript…
                  </div>
                ) : transcriptError ? (
                  <div className="flex min-h-60 items-center justify-center">
                    <ErrorState
                      space="panel"
                      message={transcriptError}
                      testId="audit-transcript-error"
                    />
                  </div>
                ) : transcriptResponse?.type !== 'success' ? (
                  <div
                    className="flex min-h-60 items-center justify-center text-s fg-secondary"
                    data-testid="audit-transcript-not-available"
                  >
                    Transcript not available.
                  </div>
                ) : transcriptViewMode === 'raw' ? (
                  <CodeBlock
                    variant="audit-transcript"
                    wrap="none"
                    data-testid="audit-transcript-raw"
                  >
                    {transcriptResponse.lines.join('\n')}
                  </CodeBlock>
                ) : (
                  <Surface variant="group">
                    <div className="px-3 py-2">
                      <TranscriptViewer
                        transcriptKey={`audit:${transcriptDisplayEntry.id}`}
                        lines={transcriptResponse.lines}
                        providerHint={transcriptResponse.providerHint}
                        closeOpenTurnAtEnd={
                          transcriptDisplayEntry.status !== 'running'
                        }
                        emptyMessage="No transcript available."
                        dataTestId="audit-transcript-rich"
                      />
                    </div>
                  </Surface>
                )}
              </div>
            </div>
          </div>
        </DialogModal>
      )}
    </section>
  );
}
