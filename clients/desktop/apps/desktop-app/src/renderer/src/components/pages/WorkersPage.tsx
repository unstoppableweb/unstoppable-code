import {
  WorkerCardSurface,
  WorkerTerminalSurface,
} from '@canopy/ui-shared/components';
import { StatusIllustration } from '@canopy/ui-shared/components';
import { Badge, type BadgeTone } from '@canopy/ui-shared/primitives/Badge';
import { StatusGlyph } from '@canopy/ui-shared/primitives/StatusGlyph';
import { Stack, Button, Heading, Surface } from '@canopy/ui-shared/components';
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import type {
  AgentAuditLinkTarget,
  WorkerCardData,
  WorkerStatus,
} from '@canopy/desktop-shared/types';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import { ClaudeLogo } from '@canopy/ui-shared/icons';
import { ExternalIcon as AppCatalogExternalIcon } from '@canopy/ui-shared/icons/AppIcons';
import { DialogModal } from '@/components/shared/DialogModal';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { TERMINAL_BG_COLOR } from '@canopy/ui-app/terminal';
import { formatRelativeTime } from '@/lib/format';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  createWorkersStoreE2eControls,
  isWorkerUnsettled,
  type WorkersStoreE2eControls,
  useWorkersStore,
} from '@/stores/workersStore';
import { brandText } from '@/lib/brand';

const HIGHLIGHT_DURATION_MS = 2_500;
const ALREADY_COMPLETED_NOTICE_MS = 4_000;

declare global {
  interface Window {
    __CANOPY_E2E_WORKERS__?: WorkersStoreE2eControls;
  }
}

function formatWorkerStatus(status: WorkerStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'starting':
      return 'Starting';
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

function workerStatusBadgeTone(status: WorkerStatus): BadgeTone {
  switch (status) {
    case 'queued':
      return 'neutral';
    case 'starting':
      return 'info';
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

/**
 * Navigate to the "Inspect" target for a worker card. Mirrors the audit-trail
 * link handling so workers and audit entries resolve `AgentAuditLinkTarget` the
 * same way.
 */
async function openLinkTarget(linkTarget: AgentAuditLinkTarget): Promise<void> {
  if (linkTarget.kind === 'worktree-chat') {
    if (linkTarget.projectId && linkTarget.worktreeId) {
      const chatStore = useChatStore.getState();
      useNavigationStore.getState().navigate('main');
      chatStore.selectWorktree(linkTarget.projectId, linkTarget.worktreeId);
      const tabsLoaded = await chatStore.ensureSelectedWorktreeTabsLoaded();
      if (tabsLoaded && linkTarget.chatId) {
        chatStore.switchTab(linkTarget.chatId);
      }
    }
    return;
  }

  if (linkTarget.kind === 'standalone-chat') {
    const projectId = linkTarget.worktreeId;
    if (!projectId) {
      return;
    }
    await useStandaloneChatStore.getState().switchChatProject(projectId);
    if (linkTarget.chatId) {
      // selectChat resolves which Work Entry owns the chat and selects it.
      await useStandaloneChatStore.getState().selectChat(linkTarget.chatId);
    }
    useNavigationStore.getState().navigate('chat');
    return;
  }

  if (linkTarget.kind === 'app-advisor') {
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
    // The worker's run (possibly a child run, which opens as its own panel)
    // opens in its recorded owner's layout. The worker's own scope is not
    // passed as a hint: Cowork workers record the legacy workspace-id shape.
    await openPipelineExecutionFromUi({
      executionId: linkTarget.pipelineExecutionId,
    });
  }
}

interface IdentifierLabelProps {
  label: string;
  value: string;
}

function IdentifierLabel({ label, value }: IdentifierLabelProps): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 text-2xs fg-secondary">
      <span className="font-mono opacity-70">{label}</span>
      <span className="font-mono fg-primary/80">{value}</span>
    </span>
  );
}

interface WorkerCardProps {
  worker: WorkerCardData;
  highlighted: boolean;
  onCancel: (workerId: string) => void;
  onRetry: (workerId: string) => void;
  onExpand?: (workerId: string) => void;
  /**
   * Compact variant for queued workers: no terminal pane (the PTY does not
   * exist until launch) and no Retry (the worker has not run yet). Only Inspect
   * and Cancel are offered.
   */
  compact?: boolean;
  terminalPlaceholder?: boolean;
  terminalClassName?: string;
  modalLayout?: boolean;
  testIdSuffix?: string;
}

function WorkerCard({
  worker,
  highlighted,
  onCancel,
  onRetry,
  onExpand,
  compact = false,
  terminalPlaceholder = false,
  terminalClassName = 'h-48',
  modalLayout = false,
  testIdSuffix = '',
}: WorkerCardProps): JSX.Element {
  const unsettled = isWorkerUnsettled(worker.status);
  const testId = (base: string): string =>
    testIdSuffix ? `${base}-${testIdSuffix}` : base;

  return (
    <WorkerCardSurface
      data-testid={testId(`worker-card-${worker.workerId}`)}
      data-worker-status={worker.status}
      modal={modalLayout}
      highlighted={highlighted}
    >
      <div
        className={`flex min-h-0 flex-col gap-3 ${modalLayout ? 'flex-1' : ''}`}
      >
        <div>
          {!modalLayout && (
            <div className="flex items-start justify-between gap-3 px-4 pt-4">
              <Stack gap="tight" className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaudeLogo width={14} height={14} className="shrink-0" />
                  <span className="truncate text-s font-semibold fg-primary">
                    {worker.label}
                  </span>
                  <Badge
                    tone={workerStatusBadgeTone(worker.status)}
                    data-testid={testId(`worker-status-${worker.workerId}`)}
                  >
                    {formatWorkerStatus(worker.status)}
                  </Badge>
                </div>
                <p className="text-xs fg-secondary">
                  <span className="font-mono">{worker.kind}</span>
                  {' · '}
                  {formatRelativeTime(new Date(worker.startedAt).toISOString())}
                </p>
              </Stack>
              <div className="flex items-center gap-2">
                {worker.status === 'queued' && (
                  <span
                    className="inline-flex items-center gap-1 text-2xs fg-secondary"
                    data-testid={testId(
                      `worker-queued-indicator-${worker.workerId}`,
                    )}
                  >
                    <StatusGlyph state="queued" size={12} />
                    Waiting for a slot
                  </span>
                )}
                {!compact && onExpand && (
                  <Button
                    variant="ghost"
                    size="compact"
                    iconOnly
                    onClick={() => onExpand(worker.workerId)}
                    aria-label="Enlarge worker terminal"
                    data-testid={testId(`worker-expand-${worker.workerId}`)}
                  >
                    <AppCatalogExternalIcon size={14} />
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 px-4 pt-2">
            {worker.projectId && (
              <IdentifierLabel label="project" value={worker.projectId} />
            )}
            {worker.worktreeId && (
              <IdentifierLabel
                label={WORKTREE_UNIT_LABEL.toLowerCase()}
                value={worker.worktreeId}
              />
            )}
            {worker.chatId && (
              <IdentifierLabel label="Chat" value={worker.chatId} />
            )}
            {worker.pipelineExecutionId && (
              <IdentifierLabel
                label="workflow"
                value={worker.pipelineExecutionId}
              />
            )}
            {worker.stepId && (
              <IdentifierLabel label="step" value={worker.stepId} />
            )}
          </div>
        </div>
        {compact ? (
          <div />
        ) : (
          <WorkerTerminalSurface
            // The host paints the terminal's own canvas color, so no strip of
            // page surface shows beside a partially filled xterm row. There is
            // no theme role for it: the terminal is this dark in both modes,
            // and `bg-inverse` would turn the host white in dark mode.
            // The block class keeps the worker's prompt and output out of
            // session replay.
            layout={terminalClassName}
            style={{ backgroundColor: TERMINAL_BG_COLOR }}
            data-testid={testId(`worker-terminal-${worker.workerId}`)}
          >
            {terminalPlaceholder ? null : worker.terminalId ? (
              <TerminalPane
                terminalId={worker.terminalId}
                // Display-only viewer: never wire input (no `onData → writeTerminal`),
                // so a worker that blocked on a prompt can never hang invisibly here.
                live={false}
                // The PTY is live, though — report the fitted size so the agent
                // renders for the actual card width instead of the spawn size.
                reportResize
                // The worker PTY is created and managed by the main-process worker
                // session service; the renderer only attaches to replay + stream its
                // output, so there is nothing to restore on mount.
                restoreOnMount={false}
                readOnlyMessage={null}
                addToChatSelectionHelper={false}
                pasteDroppedFiles={false}
                focused={false}
                onFocus={(): void => {}}
              />
            ) : (
              // No PTY yet (a `starting` worker before its terminal spawns).
              // Render a placeholder rather than attaching to an empty id.
              <div className="flex flex-1 items-center justify-center text-xs fg-secondary">
                Starting…
              </div>
            )}
          </WorkerTerminalSurface>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <Button
          size="compact"
          onClick={() => {
            void openLinkTarget(worker.linkTarget);
          }}
          data-testid={testId(`worker-inspect-${worker.workerId}`)}
        >
          <AppCatalogExternalIcon size="sm" />
          Inspect
        </Button>
        {unsettled && (
          <div className="flex items-center gap-2">
            {!compact && (
              <Button
                size="compact"
                onClick={() => onRetry(worker.workerId)}
                data-testid={testId(`worker-retry-${worker.workerId}`)}
              >
                Try again
              </Button>
            )}
            <Button
              variant="ghost-destructive"
              size="compact"
              onClick={() => onCancel(worker.workerId)}
              data-testid={testId(`worker-cancel-${worker.workerId}`)}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </WorkerCardSurface>
  );
}

interface WorkerModalProps {
  worker: WorkerCardData;
  onClose: () => void;
  onCancel: (workerId: string) => void;
  onRetry: (workerId: string) => void;
}

function WorkerModal({
  worker,
  onClose,
  onCancel,
  onRetry,
}: WorkerModalProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={worker.label}
      subtitle={`${worker.kind} · ${formatWorkerStatus(worker.status)} · ${formatRelativeTime(
        new Date(worker.startedAt).toISOString(),
      )}`}
      titleId={`worker-terminal-modal-title-${worker.workerId}`}
      maxWidth="4xl"
      maxHeight="86vh"
      height="86vh"
      scrollableBody={false}
      dataTestId={`worker-modal-${worker.workerId}`}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkerCard
          worker={worker}
          highlighted={false}
          onCancel={onCancel}
          onRetry={onRetry}
          terminalClassName="flex-1"
          modalLayout
          testIdSuffix="modal"
        />
      </div>
    </DialogModal>
  );
}

export function WorkersPage(): JSX.Element {
  const workers = useWorkersStore((s) => s.workers);
  const cancel = useWorkersStore((s) => s.cancel);
  const retry = useWorkersStore((s) => s.retry);
  const initialize = useWorkersStore((s) => s.initialize);
  const pendingWorkerHighlight = useNavigationStore(
    (s) => s.pendingWorkerHighlight,
  );
  const consumeWorkerHighlight = useNavigationStore(
    (s) => s.consumeWorkerHighlight,
  );

  const [highlightedWorkerId, setHighlightedWorkerId] = useState<string | null>(
    null,
  );
  const [alreadyCompletedNotice, setAlreadyCompletedNotice] = useState(false);
  const [expandedWorkerId, setExpandedWorkerId] = useState<string | null>(null);

  useEffect(() => {
    void initialize().catch(() => undefined);
  }, [initialize]);

  useEffect(() => {
    if (!__CANOPY_E2E__) {
      return undefined;
    }

    const controls = createWorkersStoreE2eControls();
    window.__CANOPY_E2E_WORKERS__ = controls;

    return (): void => {
      if (window.__CANOPY_E2E_WORKERS__ === controls) {
        delete window.__CANOPY_E2E_WORKERS__;
      }
    };
  }, []);

  // Apply the transient highlight requested by a "View worker" deep link. If
  // the target card is present we ring it briefly; if the worker has already
  // exited (card removed), surface a short "Worker already completed" notice
  // instead. Either way the pending field is consumed so it does not re-fire.
  useEffect(() => {
    if (!pendingWorkerHighlight) {
      return;
    }
    const targetId = pendingWorkerHighlight;
    const exists = workers.has(targetId);
    consumeWorkerHighlight();

    if (exists) {
      setAlreadyCompletedNotice(false);
      setHighlightedWorkerId(targetId);
      const timer = setTimeout(() => {
        setHighlightedWorkerId((current) =>
          current === targetId ? null : current,
        );
      }, HIGHLIGHT_DURATION_MS);
      return (): void => clearTimeout(timer);
    }

    setHighlightedWorkerId(null);
    setAlreadyCompletedNotice(true);
    const timer = setTimeout(() => {
      setAlreadyCompletedNotice(false);
    }, ALREADY_COMPLETED_NOTICE_MS);
    return (): void => clearTimeout(timer);
  }, [pendingWorkerHighlight, workers, consumeWorkerHighlight]);

  const handleCancel = useCallback(
    (workerId: string): void => {
      void cancel(workerId).catch(() => undefined);
    },
    [cancel],
  );

  const handleRetry = useCallback(
    (workerId: string): void => {
      void retry(workerId).catch(() => undefined);
    },
    [retry],
  );

  const handleExpand = useCallback((workerId: string): void => {
    setExpandedWorkerId(workerId);
  }, []);

  const handleCloseExpandedWorker = useCallback((): void => {
    setExpandedWorkerId(null);
  }, []);

  const openClaudeSettings = useCallback((): void => {
    useNavigationStore.getState().openSettings('claude');
  }, []);

  const workerList = useMemo(() => Array.from(workers.values()), [workers]);
  const queuedWorkers = useMemo(
    () => workerList.filter((worker) => worker.status === 'queued'),
    [workerList],
  );
  const activeWorkers = useMemo(
    () => workerList.filter((worker) => worker.status !== 'queued'),
    [workerList],
  );
  const expandedWorker = expandedWorkerId
    ? (workers.get(expandedWorkerId) ?? null)
    : null;

  useEffect(() => {
    if (expandedWorkerId && !workers.has(expandedWorkerId)) {
      setExpandedWorkerId(null);
    }
  }, [expandedWorkerId, workers]);

  return (
    <section
      className="page-scroll-gutter flex h-full flex-col overflow-y-auto"
      data-testid="page-workers"
    >
      <PageTitlebar />
      <PageContent bottomInset="tight" className="shrink-0">
        <Stack gap="item">
          <PageHeader
            title="Claude workers"
            description="Live, read-only view of background and workflow tasks running as managed Claude Code terminal sessions."
          />
          {alreadyCompletedNotice && (
            <Surface
              variant="card"
              size="small"
              className="self-start inline-block"
            >
              <p
                className="inline-flex px-3 py-1.5 text-s fg-secondary"
                role="status"
                data-testid="worker-already-completed-notice"
              >
                Worker already completed.
              </p>
            </Surface>
          )}
        </Stack>
      </PageContent>

      <div className="min-h-0 flex-1 overflow-auto">
        <PageContent>
          {workerList.length === 0 ? (
            <Surface
              variant="dashed"
              className="mx-auto max-w-lg"
              data-testid="workers-empty-state"
            >
              <div className="flex flex-col gap-4 px-6 py-12 text-center">
                <StatusIllustration variant="workers" tone="neutral">
                  <ClaudeLogo width={18} height={18} />
                </StatusIllustration>
                <Stack gap="tight">
                  <Heading level={2} variant="title">
                    No active workers
                  </Heading>
                  <p className="text-s fg-secondary">
                    When {brandText.appName} runs background helpers or workflow
                    steps in Terminal mode, each appears here as a read-only
                    terminal you can watch, inspect, or cancel.
                  </p>
                </Stack>
                <Button
                  className="self-center"
                  onClick={openClaudeSettings}
                  data-testid="workers-empty-open-settings"
                >
                  Open Claude settings
                </Button>
              </div>
            </Surface>
          ) : (
            <Stack gap="page">
              {queuedWorkers.length > 0 && (
                <section
                  className="flex flex-col gap-3"
                  data-testid="workers-queued-section"
                >
                  <div className="flex items-baseline gap-2">
                    <Heading level={2} variant="title">
                      Queued
                    </Heading>
                    <span className="text-xs fg-secondary">
                      {queuedWorkers.length} waiting for an available slot
                    </span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {queuedWorkers.map((worker) => (
                      <WorkerCard
                        key={worker.workerId}
                        worker={worker}
                        highlighted={highlightedWorkerId === worker.workerId}
                        onCancel={handleCancel}
                        onRetry={handleRetry}
                        compact
                      />
                    ))}
                  </div>
                </section>
              )}
              {activeWorkers.length > 0 && (
                <section
                  className="flex flex-col gap-3"
                  data-testid="workers-active-section"
                >
                  {queuedWorkers.length > 0 && (
                    <div className="flex items-baseline gap-2">
                      <Heading level={2} variant="title">
                        Active
                      </Heading>
                      <span className="text-xs fg-secondary">
                        {activeWorkers.length} running
                      </span>
                    </div>
                  )}
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {activeWorkers.map((worker) => (
                      <WorkerCard
                        key={worker.workerId}
                        worker={worker}
                        highlighted={highlightedWorkerId === worker.workerId}
                        onCancel={handleCancel}
                        onRetry={handleRetry}
                        onExpand={handleExpand}
                        terminalPlaceholder={
                          expandedWorkerId === worker.workerId
                        }
                      />
                    ))}
                  </div>
                </section>
              )}
            </Stack>
          )}
        </PageContent>
      </div>
      {expandedWorker && (
        <WorkerModal
          worker={expandedWorker}
          onClose={handleCloseExpandedWorker}
          onCancel={handleCancel}
          onRetry={handleRetry}
        />
      )}
    </section>
  );
}
