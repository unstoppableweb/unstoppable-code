import { createCoreWorktreeRecoveryAdapter } from './core-worktree-recovery-adapter';
import {
  createCoreMemoryChatsAdapter,
  type CoreMemoryChatsHost,
} from './core-memory-chats-adapter';
import { createCoworkFolderAdapter } from './cowork-folder-adapter';
import { createDesktopWorktreeGitAdapter } from './worker-git-worktree-adapter';
import { CoreHelperRuns } from '@canopy/core-runtime/node/agent/helpers';
import { CoreSignInRuns } from '@canopy/core-runtime/node/agent/sign-in';
import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import { setSessionInterfaceToolRegistry } from '../agents/interface-tool-binding';
import {
  CoreChatTurnRuns,
  CoreSubagentRuns,
} from '@canopy/core-runtime/node/agent/turns';
import {
  CoreDeferredToolReloads,
  type DeferredToolReloadHost,
} from '@canopy/core-runtime/node/agent/deferred-tools';
import {
  createWorkerAgentAdapter,
  type WorkerAgentAdapter,
} from './worker-agent-adapter';
import { stopChatTurnExactly } from './chat-turn-stop';
import {
  CoreSummarySchedule,
  type CoreSummaryScheduleHost,
} from '@canopy/core-runtime/node/summary';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, join, sep } from 'node:path';
import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
  WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  type CanopyStreamCursor,
  type OperationRecord,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryHandlerMap,
  type CanopyQueryParams,
  type CanopyQueryResult,
  type CanopyStreamHandlerMap,
  type CanopyStreamItem,
  type CanopyStreamParams,
  type CanopyStreamEnd,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemFileReadResult,
  type WorkerFilesystemLinkResolveMode,
  type WorkerFilesystemLinkResolveResult,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
  type WorkerFilesystemSearchResult,
  type WorkerFilesystemWatchParams,
  type CoreChatTranscriptPageParams,
  type CoreChatTranscriptPageResult,
  type CoreChatTranscriptSearchParams,
  type CoreChatTranscriptSearchResult,
  type CoreChatToolOutputReadParams,
  type CoreChatToolOutputReadResult,
  WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
} from '@canopy/protocol/canopy-core';
import {
  createFilesystemSearchEngine,
  type FilesystemSearchPage,
} from '@canopy/core-runtime/node';
import type { FileIndexingPreferences } from '@canopy/protocol/file-indexing';
import {
  CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS,
  CanopyOperationError,
  canopyUnavailableError,
  createCanopyDispatcher,
  createCanopyRuntime,
  createDirectLocalWorkerTransport,
  createWorkerExecutorReceipts,
  type CanopyDispatcher,
  type CanopyDispatcherStreamHandlerMap,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type RuntimeService,
  type CanopyHandlerContext,
  type CanopyQueryOptions,
  type CanopyStreamFrame,
  type CanopyStreamHandle,
  type CanopyStreamOptions,
} from '@canopy/core-runtime';
import type {
  ChatCancelRequest,
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatStateChangedEvent,
  FileContentReadIdentity,
  FileContentResponse,
  FileIndexEntry,
  FileIndexRequest,
  FileIndexResponse,
  RepoFileIndex,
  FileReferenceResolveResponse,
  FileTreeDirectoryResponse,
  FileTreeRootsResponse,
  SidebarItemsFile,
  WorktreeData,
  WorkspaceConfigFile,
  ChatTranscriptSearchResult,
  ChatToolOutputResponse,
  WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { createCoreChatStateAdapter } from './core-chat-state-adapter';
import {
  createCoreChatTurnAdapter,
  type CoreChatTurnCancelHost,
} from './core-chat-turn-adapter';
import {
  createCoreChatQuestionAdapter,
  type CoreChatQuestionHost,
} from './core-chat-question-adapter';
import { stopSubagentNatively } from '../agent-runs/subagent-native-stop';
import { respondToChatQuestion } from '../chat-questions/respond';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { installQuestionTurnWaits } from '../chat-questions/question-turn-waits';
import { installApprovalTurnWaits } from '../approvals/approval-turn-waits';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { createCoreChatEventsAdapter } from './core-chat-events-adapter';
import { createChatEventReplayLog } from './chat-event-replay-log';
import {
  coalesceFileIndexBuild,
  fileIndexEntriesPerRoot,
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../services/files-service';
import type { FileBrowserRoot } from '../lib/file-browser-roots';
import { validateId } from '../lib/validation';
import { logMainProcessError } from '../lib/main-process-logging';
import { getChatStateCommandPort } from '../ipc/chat-state';
import { createCoreChatCommandAdapter } from './core-chat-command-adapter';
import { assertAutoArchivePatchOnly } from './auto-archive-principal-guard';
import {
  createDesktopChatArchiveEffects,
  withChatArchiveEffects,
  type CoreChatArchiveEffects,
} from './core-chat-archive-effects';
import type { CoreChatSettingsHost } from './core-chat-command-adapter';
import { ChatCommandKeyFingerprints } from './chat-command-key-fingerprints';
import {
  createCoreChatLocateAdapter,
  createDesktopChatLocateHost,
  type CoreChatLocateHost,
} from './core-chat-locate-adapter';
import {
  createCoreChatTransferAdapter,
  type CoreChatTransferHost,
} from './core-chat-transfer-adapter';
import { getChatStateService } from '../services/chat-state-service';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import { createCoreChatMessageAdapter } from './core-chat-message-command-adapter';
import {
  createCoreWorkspaceAdapter,
  createCoreWorkspaceReadSnapshots,
  type CoreWorkspaceReadDetail,
  type CoreWorkspaceReadServices,
} from './core-workspace-adapter';
import type { CoreReadSnapshotLimits } from '@canopy/core-runtime/node/workspace/core-workspace-read-snapshots';
import {
  createCoreLedgerInstructionHandlers,
  createCoreLedgerQueryHandlers,
  getDesktopLedgerService,
} from '../ledger/core-ledger-adapter';
import type { LedgerService } from '../ledger/service';
import { createCoreCostAdapter } from './core-cost-adapter';
import { createCoreUpdateAdapter } from './core-update-adapter';
import type { CoreUpdateHost } from '@canopy/core-runtime/update';
import {
  createCoreSearchAdapter,
  type CoreSearchIndex,
} from './core-search-adapter';
import { createCoreWorkspaceInstructionsAdapter } from './core-workspace-instructions-adapter';
import { createCoreWorkspaceItemsAdapter } from './core-workspace-items-adapter';
import { createDesktopWorkspaceTextItemProviders } from './core-workspace-note-items-host';
import { createCoreInitiatedWorkSourceAdapter } from './core-initiated-work-source-adapter';
import { createCoreExecutionAdapter } from './core-execution-adapter';
import { createCoreTerminalSettingsAdapter } from './core-terminal-settings-adapter';
import {
  createCoreConfigAdapter,
  type CoreConfigHost,
} from './core-config-adapter';
import {
  createCoreMemoryAdapter,
  type CoreMemoryHost,
} from './core-memory-adapter';
import {
  createCoreMemoryMaintenanceAdapter,
  type CoreMemoryMaintenanceHost,
} from './core-memory-maintenance-adapter';
import {
  createCoreArchiveAdapter,
  type CoreArchiveHost,
} from './core-archive-adapter';
import {
  createCoreWatcherAdapter,
  type CoreWatcherHost,
} from './core-watcher-adapter';
import {
  createCoreManagedDelegationAdapter,
  type CoreManagedDelegationHost,
} from './core-managed-delegation-adapter';
import {
  createCoreDeferredToolsAdapter,
  type CoreDeferredToolsHost,
} from './core-deferred-tools-adapter';
import {
  createCoreChatVisualStageAdapter,
  type CoreChatVisualStageHost,
} from './core-chat-visual-stage-adapter';
import { createCoreCatalogAdapter } from './core-catalog-adapter';
import { createWorkerCatalogAdapter } from './worker-catalog-adapter';
import {
  createWorkerVisualAdapter,
  type WorkerVisualHost,
} from './worker-visual-adapter';
import { createDesktopMaterializationResolver } from './catalog-materialization-host';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import {
  DESKTOP_QUERY_DEFINITIONS,
  type DesktopQueryDefinitions,
} from './desktop-query-definitions';
import type { TerminalSettingsStore } from '@canopy/core-runtime/node/terminal';
import {
  CoreCatalogMaterializations,
  type CatalogMaterializationResolver,
  type CoreCatalogHost,
  type WorkerCatalogHost,
  type WorkerCatalogMaterializationReader,
} from '@canopy/core-runtime/node/catalog';
import { createCoreObservabilityAdapter } from './core-observability-adapter';
import type { CoreHookSourceHost } from '@canopy/core-runtime/node/initiated-work/hook-sources';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import type { CoreWorkspaceInstructionsHost } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import type { CoreWorkspaceItemHandlerOptions } from '@canopy/core-runtime/node/workspace/workspace-items';
import {
  createCoreSharedMultiRepoHandlers,
  type SharedMultiRepoHost,
  type SharedMultiRepoCoordinator,
} from '@canopy/core-runtime/node/workspace/org-shared-multi-repo';
import { createCoreWorkspaceRepoRulesAdapter } from './core-workspace-repo-rules-adapter';
import { createCorePipelineDefinitionAdapter } from './core-pipeline-definition-adapter';
import { createCoreScriptDefinitionsAdapter } from './core-script-definitions-adapter';
import { createCoreWorkspaceMetadataAdapter } from './core-workspace-metadata-adapter';
import { createCoreWorkspaceLifecycleAdapter } from './core-workspace-lifecycle-adapter';
import { createCoreWorkspaceGuardedAdapter } from './core-workspace-guarded-adapter';
import { createCoreSourceCompositionAdapter } from './core-source-composition-adapter';
import { createCoreIntegrationAdapter } from './core-integration-adapter';
import { createCorePullRequestAdapter } from './core-pull-request-adapter';
import type {
  CoreIntegrationHost,
  CorePullRequestHost,
} from '@canopy/core-runtime/node/github';
import {
  createWorkerScriptAdapter,
  type WorkerScriptAdapter,
} from './worker-script-adapter';
import {
  createWorkerPipelineAdapter,
  type WorkerPipelineAdapter,
} from './worker-pipeline-adapter';
import { createWorkerCodeGraphAdapter } from './worker-code-graph-adapter';
import type {
  WorkerCodeGraphHandlers,
  WorkerCodeGraphReadHandlers,
} from '@canopy/core-runtime/node/code-graph';
import { createWorkerCodeGraphReadAdapter } from './worker-code-graph-read-adapter';
import {
  createWorkerGitAdapter,
  type DesktopHealthWorktree,
} from './worker-git-adapter';
import { createWorkerGitCommitPushAdapter } from './worker-git-commit-push-adapter';
import { createWorkerGitSyncWriteAdapter } from './worker-git-sync-adapter';
import { createWorkerGitLocalMutationAdapter } from './worker-git-local-mutations-adapter';
import { registerLocalGitMutationDispatcher } from './worker-git-local-mutations-dispatch';
import { createWorkerGitMergeAdapter } from './worker-git-merge-adapter';
import type {
  WorkerGitBranchListHost,
  WorkerGitBranchWriteHost,
  WorkerGitDiffHost,
  WorkerGitExecutableHost,
  WorkerGitRemoteHost,
  WorkerGitSyncWriteHost,
  WorkerGitMergeHost,
  WorkerGitWorktreeHealthHost,
} from '@canopy/core-runtime/node/git';
import type { CoreWorkspaceRepoRulesHost } from '@canopy/core-runtime/node/workspace/workspace-repo-rules';
import type { WorkerPipelineExecution } from '@canopy/protocol/canopy-core';
import {
  CorePipelineRuns,
  type PipelineHostRequestBroker,
  pipelineHostCoreCaller,
  settlePipelineHostRequests,
  type CorePipelineDefinitionHost,
} from '@canopy/core-runtime/node/pipeline';
import type { CoreScriptDefinitionsHost } from '@canopy/core-runtime/node/script/core-script-definitions';
import type { CoreWorkspaceMetadataHost } from '@canopy/core-runtime/node/workspace/metadata-commands';
import type { CoreWorkspaceLifecycleHost } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import type { CoreWorkspaceGuardedHost } from '@canopy/core-runtime/node/workspace/guarded-commands';
import type { CoreSourceCompositionHost } from '@canopy/core-runtime/node/workspace/source-composition-commands';
import {
  createCoreAnnotationAdapter,
  type CoreAnnotationAdapter,
} from './core-annotation-adapter';
import { publishFileAnnotationsUpdated } from './annotation-update-publisher';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from './core-operation-adapter';
import { LocalWorkerExecution } from '@canopy/core-runtime/node/operations';
import { CoreScriptRuns } from '@canopy/core-runtime/node/script/execution';
import {
  HookChatClaims,
  HookQueue,
  InitiatedWorkEngine,
} from '@canopy/core-runtime/node/initiated-work';
import {
  logMainProcessDebug,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import {
  createDesktopDeferredToolReloadHost,
  type DesktopDeferredToolReloadPayload,
} from '../deferred-tools/reload-host';
import { setDeferredToolReloads } from '../deferred-tools/reload-coordinator';
import { emitChatTurnWait } from '../agent-runs/turn-runs';
import { createHookQueuePayloadStore } from '../lib/hook-queue-store';
import type { CostService } from '../cost-index/service';
import type { ObservabilityReadModel } from '@canopy/core-runtime/observability';
import {
  createWorkerFilesystemAdapter,
  WorkerFilesystemAdapterError,
  type WorkerFilesystemServices,
} from './worker-filesystem-adapter';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import type { FilesystemLinkResolved } from '@canopy/core-runtime/node';
import type { FileBrowserRootsResult } from '../lib/file-browser-roots';
import {
  missingFileContent,
  projectLegacyFileContent,
} from '@canopy/desktop-shared/file-content-projection';
import {
  createWorkerFilesystemReadAdapter,
  DEFAULT_FILE_READ_SERVICES,
  LEGACY_FILE_CONTENT_MAX_BYTES,
  resolveLegacyFileReadIdentity,
  type WorkerFilesystemReadServices,
} from './worker-filesystem-read-adapter';
import {
  createWorkerFilesystemSearchAdapter,
  DEFAULT_FILE_SEARCH_SERVICES,
  type WorkerFilesystemSearchServices,
} from './worker-filesystem-search-adapter';
import {
  createWorkerFilesystemWatchAdapter,
  type WorkerFilesystemWatchAdapterOptions,
} from './worker-filesystem-watch-adapter';
import {
  createCoreChatReadAdapter,
  type CoreChatReadServices,
} from './core-chat-read-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { createDesktopSummaryScheduleHost } from './core-summary-schedule-host';
import {
  createCoreSummaryAdapter,
  DESKTOP_SUMMARY_ADAPTER_HOST,
  type CoreSummaryAdapterHost,
} from './core-summary-adapter';
import type {
  DaemonFilesRoute,
  DaemonFilesRouteRequest,
  DaemonFilesSearchWalk,
} from './daemon-files-route';
import type {
  FilesystemEntryDeleteIo,
  FilesystemEntryTransferIo,
  FilesystemFileWriteIo,
} from '@canopy/core-runtime/node';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type {
  FileTreeMutationRequest,
  FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { electronTrashServices } from './electron-trash-services';
import {
  DESKTOP_INSTRUCTION_DEFINITIONS,
  type DesktopInstructionDefinitions,
} from './desktop-instruction-definitions';
import {
  createDesktopEntryMutationHost,
  createFileTreeEntryForLegacyIpc,
  createWorkerFilesystemMutationAdapter,
  deleteFileTreeEntryForLegacyIpc,
  saveTextFileForLegacyIpc,
  transferFileTreeEntryForLegacyIpc,
  type DesktopEntryMutationPlatform,
  type LegacyTextFileSave,
} from './worker-filesystem-mutation-adapter';
import {
  createInterfaceToolProvenance,
  type InterfaceToolProvenanceIngest,
} from './interface-tools/interface-tool-provenance';

/** Deferred: observability loads after the runtime it records. */
const loadInterfaceToolProvenanceIngest =
  async (): Promise<InterfaceToolProvenanceIngest> => {
    const { getExecutionObservabilityIngest } =
      await import('../observability/ingest');
    return {
      noteInterfaceToolCallDelivered: (...args): void =>
        getExecutionObservabilityIngest().noteInterfaceToolCallDelivered(
          ...args,
        ),
      recordInterfaceToolCall: (...args): void =>
        getExecutionObservabilityIngest().recordInterfaceToolCall(...args),
    };
  };

export interface CreateDesktopRuntimeOptions {
  services?: WorkerFilesystemServices;
  runtimeServices?: readonly RuntimeService[];
  getChatStatePort?: () => ChatStateCommandPort | null;
  workspaceServices?: CoreWorkspaceReadServices;
  /** Retention bounds for list continuation; defaults otherwise. */
  workspaceReadSnapshotLimits?: CoreReadSnapshotLimits;
  chatServices?: CoreChatReadServices;
  chatCommandPort?: ChatStateCommandPort;
  /** Bookkeeping after core archives and restores; null disables it; tests may inject one. */
  chatArchiveEffects?: CoreChatArchiveEffects | null;
  /** Host behind `core.chat.update` settings changes; null disables them; tests may inject one. */
  chatSettingsHost?: CoreChatSettingsHost | null;
  /** Work Entry lookup behind `core.chat.locate`; tests may inject one. */
  chatLocateHost?: CoreChatLocateHost;
  /** Session transfer behind core.chat.transfer.*; tests may inject one. */
  chatTransferHost?: CoreChatTransferHost;
  /** Effects behind `core.chat.turn.cancel`; default to the desktop Stop. */
  turnCancelHost?: CoreChatTurnCancelHost;
  /** Effects behind core.chat.question.respond; default to the chat store and the question wait lifecycle. */
  questionHost?: CoreChatQuestionHost;
  adapters?: DesktopDomainAdapter[];
  /**
   * Handler logic for `core.ledger.*`. Defaults to the app's Ledger service,
   * which touches storage only on the first Ledger operation.
   */
  ledgerService?: LedgerService;
  /** Handler logic for `core.cost.*`; tests may inject an isolated service. */
  costService?: CostService;
  /** Index behind `core.search.query`; defaults to the chat search service. */
  searchIndex?: () => Promise<CoreSearchIndex>;
  /** Host facts and generation for the core summary schedule; tests inject one. */
  summaryScheduleHost?: CoreSummaryScheduleHost;
  /** Summary file reads behind `core.summary.*`; tests inject one. */
  summaryAdapterHost?: CoreSummaryAdapterHost;
  /** Store behind `core.terminal.settings.*`; tests may inject one. */
  terminalSettingsStore?: TerminalSettingsStore;
  /** Host behind `core.catalog.*`; tests may inject one. */
  catalogHost?: CoreCatalogHost;
  /** Namespace reads behind `core.config.get`; tests may inject them. */
  configHost?: Partial<CoreConfigHost>;
  /** Local memory behind `core.memory.*`; tests may inject one. */
  memoryHost?: CoreMemoryHost;
  memoryChatsHost?: CoreMemoryChatsHost;
  /** Consolidation, rebuild, snapshots and import behind `core.memory.*`; tests may inject one. */
  memoryMaintenanceHost?: CoreMemoryMaintenanceHost;
  /** Archived containers behind the `core.archive` reads and lock; tests may inject one. */
  archiveHost?: CoreArchiveHost;
  /** Watcher service behind `core.initiatedWork.watcher.*`; tests may inject one. */
  watcherHost?: CoreWatcherHost;
  /** Delegation broker behind `core.managedDelegation.*`; tests may inject one. */
  managedDelegationHost?: CoreManagedDelegationHost;
  /** Catalog and reload lifecycle behind `core.agent.deferredTools.*`; tests may inject one. */
  deferredToolsHost?: CoreDeferredToolsHost;
  /** Staging writer behind `core.chat.visual.stage`; tests may inject one. */
  visualStageHost?: CoreChatVisualStageHost;
  /** Render engine behind `worker.visual.render`; tests may inject one. */
  visualRenderHost?: WorkerVisualHost;
  /** Worker host behind `worker.catalog.*` and the resolver behind materialization; tests may inject them. */
  workerCatalogHost?: WorkerCatalogHost;
  catalogMaterializationResolver?: CatalogMaterializationResolver;
  /** Installer behind `core.update.*`; defaults to this process's updater. */
  updateHost?: CoreUpdateHost;
  /** Read model for `core.observability.*`; tests may inject isolated stores. */
  observabilityReadModel?: ObservabilityReadModel;
  /** Host port for `core.workspace.instructions.*`; defaults to the desktop files. */
  workspaceInstructionsHost?: CoreWorkspaceInstructionsHost;
  /** Hosts and providers for `core.workspace.item.*`; default to the desktop stores. */
  workspaceItems?: Partial<CoreWorkspaceItemHandlerOptions>;
  /** Host port for `core.initiatedWork.source.*`; defaults to the desktop hook files. */
  hookSourceHost?: CoreHookSourceHost<HookAction>;
  /** Host port for `core.workspace.repoRules.*`; defaults to the desktop policy. */
  repoRulesHost?: CoreWorkspaceRepoRulesHost;
  /** Host port for `core.pipeline.definition.*`; defaults to the desktop sources. */
  pipelineDefinitionHost?: CorePipelineDefinitionHost;
  sharedMultiRepoHost?: SharedMultiRepoHost;
  /** Host port for `core.script.definition.*`; defaults to the desktop sources. */
  scriptDefinitionsHost?: CoreScriptDefinitionsHost;
  /** `worker.script.*` over this process's local worker (CAN-4143). */
  workerScriptAdapter?: WorkerScriptAdapter;
  workerAgentAdapter?: WorkerAgentAdapter;
  /** Host port for the W5 `core.workspace.*` metadata commands (W7a). */
  workspaceMetadataHost?: CoreWorkspaceMetadataHost;
  /**
   * Host port for the lifecycle commands: the creates #1, #2 and #21
   * (W7b-3) and archive, restore and workspace delete (W7b-2a).
   */
  workspaceLifecycleHost?: CoreWorkspaceLifecycleHost;
  /** Host port for the guarded W5 commands (W7b-1b and 1c). */
  workspaceGuardedHost?: CoreWorkspaceGuardedHost;
  /** Host port for the keyed source, composition, rename and fork lifecycles (W7b-4). */
  sourceCompositionHost?: CoreSourceCompositionHost;
  /** `worker.pipeline.execution.*`; defaults to the desktop pipeline worker. */
  workerPipelineAdapter?: WorkerPipelineAdapter;
  /** The code-graph build queue controls; default to main's build scheduler. */
  workerCodeGraphAdapter?: WorkerCodeGraphHandlers;
  /** The code-graph reads; default to main's code-graph read service. */
  workerCodeGraphReadAdapter?: WorkerCodeGraphReadHandlers;
  /** Host port for `worker.git.branch.list`; defaults to the desktop checkouts. */
  workerGitHost?: WorkerGitBranchListHost<string>;
  /** Host port for `worker.git.executable.get`; defaults to the desktop detection. */
  workerGitExecutableHost?: WorkerGitExecutableHost;
  /** Host port for `worker.git.remote.get`; defaults to the workspace records. */
  workerGitRemoteHost?: WorkerGitRemoteHost<string>;
  /** Host port for `worker.git.worktree.health.get`; defaults to the desktop checkouts. */
  workerGitWorktreeHealthHost?: WorkerGitWorktreeHealthHost<DesktopHealthWorktree>;
  /** Host port for `worker.git.diff.get`; defaults to the desktop checkouts. */
  workerGitDiffHost?: WorkerGitDiffHost<string>;
  /**
   * Host port for `worker.git.checkout` and `worker.git.branch.create`;
   * defaults to the desktop checkouts.
   */
  workerGitBranchWriteHost?: WorkerGitBranchWriteHost<string>;
  /** Host port for `worker.git.fetch` and `worker.git.pull`; defaults to the desktop checkouts. */
  workerGitSyncWriteHost?: WorkerGitSyncWriteHost<string>;
  /** Host port for `worker.git.merge`; defaults to the desktop checkouts. */
  workerGitMergeHost?: WorkerGitMergeHost<string>;
  /** Host port for `core.integration.*`; defaults to the desktop GitHub connections. */
  integrationHost?: CoreIntegrationHost;
  /** Host port for `core.pullRequest.*`; defaults to the desktop records and GitHub handle. */
  pullRequestHost?: CorePullRequestHost;
  /** Handler logic for `core.annotation.*`; tests may inject an isolated adapter. */
  annotationAdapter?: CoreAnnotationAdapter;
  /**
   * The operation service behind `core.operation.*`; tests may inject one
   * over an isolated ledger. The runtime closes it at shutdown.
   */
  operationAdapter?: CoreOperationAdapter;
  shutdownTimeoutMs?: number;
  /**
   * The opt-in daemon route for file-tree IPC reads. Resolved per routable
   * request; absent keeps every read on the direct reader.
   */
  daemonFilesRoute?: () => DaemonFilesRoute;
  /**
   * Native watch and resolution dependencies for `worker.filesystem.watch`.
   * The stream always runs in process; it is never routed to the daemon.
   */
  filesystemWatch?: Omit<
    WorkerFilesystemWatchAdapterOptions,
    'onAttached' | 'onAttachFailed'
  >;
  /** Roots source for `worker.filesystem.file.read`; tests inject one. */
  fileReadServices?: WorkerFilesystemReadServices;
  /** Roots, preferences and Git for `worker.filesystem.search`. */
  fileSearchServices?: WorkerFilesystemSearchServices;
  /**
   * The `PlatformServices` members `worker.filesystem.entry.*` uses. Defaults
   * to this host's OS and the Electron Trash adapter; a value without
   * `trash` makes every Trash request fail before any effect.
   */
  platform?: DesktopEntryMutationPlatform;
  /** Test seams around `worker.filesystem.entry.delete`'s effect. */
  entryDeleteIo?: FilesystemEntryDeleteIo;
  /** Test seams around `worker.filesystem.entry.copy` and `.move` effects. */
  entryTransferIo?: FilesystemEntryTransferIo;
  /** Test seams around `worker.filesystem.file.write` and `.directory.create`. */
  fileWriteIo?: FilesystemFileWriteIo;
  /** Host behind deferred-tool reloads (CAN-4127); tests may inject it. */
  deferredToolReloadHost?: DeferredToolReloadHost<DesktopDeferredToolReloadPayload>;
}

function defaultEntryMutationPlatform(): DesktopEntryMutationPlatform {
  // Only win32 changes the path rules; any other host keeps POSIX's.
  return { os: hostOperatingSystem() ?? 'linux', trash: electronTrashServices };
}

export interface DesktopDomainAdapter {
  queries?: Partial<CanopyDispatcherHandlerMap<DesktopQueryDefinitions>>;
  instructions?: Partial<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>
  >;
  streams?: Partial<CanopyStreamHandlerMap<CanopyHandlerContext>>;
}

interface RootsProjectionContext {
  kind: 'roots';
  /** Set only by the file-tree IPC handlers; other callers stay direct. */
  route?: DaemonFilesRouteRequest;
  legacyResult?: FileTreeRootsResponse;
}

interface DirectoryProjectionContext {
  kind: 'directory';
  route?: DaemonFilesRouteRequest;
  legacyResult?: FileTreeDirectoryResponse;
}

type FileTreeProjectionContext =
  | RootsProjectionContext
  | DirectoryProjectionContext;

/** One scoped `file:read-content` request's projection state. */
interface FileReadProjectionContext {
  /** Set only by the `file:read-content` IPC handler; other callers stay direct. */
  route?: DaemonFilesRouteRequest;
  roots?: {
    projectId: string;
    worktreeId: string;
    value: Awaited<
      ReturnType<WorkerFilesystemReadServices['getFileBrowserRoots']>
    >;
  };
  read?: Parameters<typeof projectLegacyFileContent>[0];
  /** A markdown base outside every root, as the renderer spelled it. */
  linkHostBase?: string;
  link?: FilesystemLinkResolved;
}

/** A `file-reference:resolve` request, addressed as the renderer sent it. */
export interface DesktopLinkResolveRequest {
  scope: { workspaceId: string; worktreeId: string };
  mode: WorkerFilesystemLinkResolveMode;
  href: string;
  /** Markdown mode: the host path of the file the link is relative to. */
  baseFilePath?: string;
}

type LinkBaseProjection =
  | { kind: 'root'; fileRootId: string; relativePath: string }
  | { kind: 'host'; absolutePath: string };

/**
 * Projects a markdown base path onto the deepest root whose spelling
 * contains it. Lexical on purpose: URL resolution uses the base's spelling,
 * and `<root>/<relativePath>` rebuilds that spelling exactly. A base no root
 * spells, or one that is not a safe root-relative file path (a root itself,
 * a trailing separator, `.` or `..` segments), stays a host path.
 */
function projectLinkBase(
  roots: FileBrowserRootsResult,
  baseFilePath: string,
): LinkBaseProjection {
  let owner: {
    fileRootId: string;
    relativePath: string;
    depth: number;
  } | null = null;
  for (const root of roots.roots) {
    const trimmed = root.absolutePath.replace(/[\\/]+$/, '');
    const prefix = trimmed === '' ? root.absolutePath : trimmed;
    if (!baseFilePath.startsWith(prefix)) continue;
    const rest = baseFilePath.slice(prefix.length);
    // A backslash is a file name character on POSIX, a separator on Windows.
    if (!(sep === '\\' ? /^[\\/]/ : /^\//).test(rest)) continue;
    const relativePath =
      sep === '\\' ? rest.slice(1).replace(/\\/g, '/') : rest.slice(1);
    if (!isSafePortableRelativePath(relativePath)) continue;
    if (owner && owner.depth >= prefix.length) continue;
    owner = { fileRootId: root.repoId, relativePath, depth: prefix.length };
  }
  return owner
    ? {
        kind: 'root',
        fileRootId: owner.fileRootId,
        relativePath: owner.relativePath,
      }
    : { kind: 'host', absolutePath: baseFilePath };
}

/**
 * Link failures the legacy projections answer as `null`: every typed
 * `worker.filesystem.link.*` failure, and a request the operation's schema
 * refuses (an over-long link).
 */
function isUnresolvedLink(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    (error.payload.code?.startsWith('worker.filesystem.link.') === true ||
      (error.payload.code === undefined &&
        error.payload.kind === 'invalid_argument'))
  );
}

/** One root's pages of a `file-index:get` projection. */
interface FileSearchProjectionContext {
  /** Set only by the `file-index:get` IPC handler; other callers stay direct. */
  route?: { request: DaemonFilesRouteRequest; walk: DaemonFilesSearchWalk };
  projectId: string;
  worktreeId: string;
  root: FileBrowserRoot;
  fileIndexing: FileIndexingPreferences;
  page: FilesystemSearchPage | null;
}

/** A scoped `file:read-content` request, addressed as the renderer sent it. */
export interface DesktopFileContentRequest {
  scope: { workspaceId: string; worktreeId: string };
  absolutePath: string;
  /** When set, read as addressed instead of mapping `absolutePath`. */
  file?: FileContentReadIdentity;
}

/** The legacy file-tree projection's view of one watch stream's attachment. */
interface WatchProjectionContext {
  attached(): void;
  failed(error: unknown): void;
}

type FileTreeWatchHandle = CanopyStreamHandle<
  CanopyStreamItem<'worker.filesystem.watch'>,
  CanopyStreamEnd<'worker.filesystem.watch'>
>;

interface WorkspaceProjectionContext {
  sidebar?: SidebarItemsFile;
  sidebarDetail?: CoreWorkspaceReadDetail;
  config?: WorkspaceConfigFile;
  configDetail?: CoreWorkspaceReadDetail;
  worktrees?: WorktreeData[];
  worktreesDetail?: CoreWorkspaceReadDetail;
  worktree?: WorktreeData;
  worktreeDetail?: CoreWorkspaceReadDetail;
}

interface ChatReadProjectionContext {
  requestId?: string;
  toolOutputRead?: Promise<ChatToolOutputResponse>;
  legacyResult?:
    | TranscriptPage
    | ChatTranscriptSearchResult
    | ChatToolOutputResponse;
}

export interface DesktopCanopyDispatcher extends CanopyDispatcher<
  DesktopQueryDefinitions & CanopyRuntimeQueries,
  DesktopInstructionDefinitions,
  typeof CANOPY_STREAM_DEFINITIONS & CanopyRuntimeStreams
> {
  openChatEventsForLegacyIpc(
    params: CanopyStreamParams<'core.chat.events'>,
    options: CanopyStreamOptions<
      CanopyStreamFrame<
        CanopyStreamItem<'core.chat.events'>,
        CanopyStreamEnd<'core.chat.events'>
      >
    >,
  ): Promise<{
    handle: CanopyStreamHandle<
      CanopyStreamItem<'core.chat.events'>,
      CanopyStreamEnd<'core.chat.events'>
    >;
    takeLegacyEvent: (cursor: CanopyStreamCursor) => ChatStateChangedEvent;
  }>;
  /** Resolves the original event for a legacy-push frame, including from `onFrame`. */
  takeChatEventForLegacyIpc(cursor: CanopyStreamCursor): ChatStateChangedEvent;
  closeChatEventsForLegacyIpc(): void;
  /**
   * Opens an in-process `worker.filesystem.watch` stream for the file-tree
   * IPC. `attached` settles once its native handle is attached, or rejects
   * with the original failure when the stream ends first.
   */
  openFileTreeWatchForLegacyIpc(
    params: WorkerFilesystemWatchParams,
    options: CanopyStreamOptions<
      CanopyStreamFrame<
        CanopyStreamItem<'worker.filesystem.watch'>,
        CanopyStreamEnd<'worker.filesystem.watch'>
      >
    >,
  ): Promise<{ handle: FileTreeWatchHandle; attached: Promise<void> }>;
  /**
   * Opens an in-process `gitHead` watch stream for main's branch observer,
   * with the same `attached` contract as the file-tree projection.
   */
  openGitHeadWatchForBranchObserver(
    params: Pick<WorkerFilesystemWatchParams, 'scope' | 'fileRootId'>,
    options: CanopyStreamOptions<
      CanopyStreamFrame<
        CanopyStreamItem<'worker.filesystem.watch'>,
        CanopyStreamEnd<'worker.filesystem.watch'>
      >
    >,
  ): Promise<{ handle: FileTreeWatchHandle; attached: Promise<void> }>;
  /** Closes every in-process watch stream; runs before runtime shutdown. */
  closeFileTreeWatchesForLegacyIpc(): void;
  queryChatStateForLegacyIpc(
    params: CanopyQueryParams<'core.chat.snapshot.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.chat.snapshot.get'>;
    legacyResult: ChatStateSnapshot;
  }>;
  querySummaryForLegacyIpc(
    params: CanopyQueryParams<'core.summary.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.summary.get'>;
    legacyResult: WorktreeSummaryData | null;
  }>;
  isShuttingDown(): boolean;
  /**
   * Dispatch and placement records for work on the builtin local worker
   * (CAN-4132): each worker instruction a core domain sends becomes a child
   * of its parent operation, recorded before it starts.
   */
  readonly localWorker: LocalWorkerExecution;
  /**
   * Script runs (CAN-4143): each a `core.script.run` operation whose
   * `worker.script.execute` dispatch runs on the local worker.
   */
  readonly scriptRuns: CoreScriptRuns;
  /** Helper model calls (CAN-4122): each a core.helper.run operation whose worker.agent.helper.run dispatch runs on the local worker. */
  readonly helperRuns: CoreHelperRuns;
  /** Provider sign-in attempts (CAN-5070): each a core.signIn.run operation whose worker.agent.signIn.run dispatch runs on the local worker. */
  readonly signInRuns: CoreSignInRuns;
  /** Catalog materialization (CAN-4123): the core resolves a chat's selection and the local worker materializes it under an immutable id. */
  readonly catalogMaterializations: CoreCatalogMaterializations;
  /** Worker-local materialized bundles (CAN-4123); CAN-4115 reads them at session start. */
  readonly catalogMaterializationReader: WorkerCatalogMaterializationReader;
  /** App Advisor writes as keyed operations (CAN-4133). */
  readonly appAdvisorActions: AdvisorActionRuns;
  /**
   * In process: the operation once it ends, or a rejection when the signal
   * stops the wait. App Advisor's marketplace refresh waits on it (CAN-6002).
   */
  waitForOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationRecord>;
  /** Worktree summary generations (CAN-4114): each a core.summary.regenerate operation that survives restart. */
  readonly summarySchedule: CoreSummarySchedule;
  /** Deferred-tool reloads (CAN-4127): the core drives search/load reloads and their resume. */
  readonly deferredToolReloads: CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>;
  /** Chat turns (CAN-4115): each a core.chat.turn.run operation whose worker.agent.turn.run dispatch runs on the local worker. */
  readonly chatTurnRuns: CoreChatTurnRuns;
  /** Managed subagent runs (CAN-4115). */
  readonly subagentRuns: CoreSubagentRuns;
  /** Lease-bound interface agent tools (CAN-4131). In memory; leases are opened by the renderer relay host. */
  readonly interfaceTools: InterfaceToolRegistry;
  /**
   * Initiated work (CAN-4144): each hook firing is a `core.initiatedWork.run`
   * operation with its gates, target queue and cancellation.
   */
  readonly initiatedWork: InitiatedWorkEngine;
  readonly hookChatClaims: HookChatClaims;
  /** Queued hook chats and pipelines (CAN-5081). */
  readonly hookQueue: HookQueue;
  /**
   * Pipeline runs (CAN-4140): each run is a core operation whose start and
   * cancel are dispatched to the local worker.
   */
  readonly pipelineRuns: CorePipelineRuns;
  /** The local worker's host step requests, which core settles. */
  readonly pipelineHostRequests: PipelineHostRequestBroker;
  queryWorkspaceListForLegacyIpc(
    params: CanopyQueryParams<'core.workspace.list'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.list'> | null;
    legacyResult: SidebarItemsFile;
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorkspaceGetForLegacyIpc(
    params: CanopyQueryParams<'core.workspace.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.get'> | null;
    legacyResult: WorkspaceConfigFile;
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorktreeListForLegacyIpc(
    params: CanopyQueryParams<'core.worktree.list'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.list'> | null;
    legacyResult: SidebarItemsFile | WorktreeData[];
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorktreeGetForLegacyIpc(
    params: CanopyQueryParams<'core.worktree.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.get'> | null;
    legacyResult: WorktreeData;
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryFileTreeRootsForLegacyIpc(
    params: WorkerFilesystemRootsListParams,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemRootsListResult;
    legacyResult: FileTreeRootsResponse;
  }>;
  queryFileTreeDirectoryForLegacyIpc(
    params: WorkerFilesystemDirectoryListParams,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemDirectoryListResult;
    legacyResult: FileTreeDirectoryResponse;
  }>;
  /**
   * Scoped `file:read-content` over `worker.filesystem.file.read`. A path
   * that does not exist answers `missing` with no canonical result, as the
   * legacy reader did.
   */
  queryFileContentForLegacyIpc(
    request: DesktopFileContentRequest,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemFileReadResult | null;
    legacyResult: FileContentResponse;
  }>;
  /**
   * `file-index:get` over `worker.filesystem.search`: one search per root,
   * paged, inside the shared index coalescer. The response is the legacy
   * index; local paths come from the walk.
   */
  queryFileIndexForLegacyIpc(
    request: FileIndexRequest,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<FileIndexResponse>;
  /**
   * `file-reference:resolve` over `worker.filesystem.link.resolve`. Every
   * link failure answers `null`, as the legacy resolvers did; a roots read
   * failure still throws.
   */
  queryLinkResolveForLegacyIpc(
    request: DesktopLinkResolveRequest,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemLinkResolveResult | null;
    legacyResult: FileReferenceResolveResponse;
  }>;
  queryChatTranscriptPageForLegacyIpc(
    params: CoreChatTranscriptPageParams,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CoreChatTranscriptPageResult;
    legacyResult: TranscriptPage;
  }>;
  queryChatTranscriptSearchForLegacyIpc(
    params: CoreChatTranscriptSearchParams,
    options: CanopyQueryOptions,
    requestId?: string,
  ): Promise<{
    canonicalResult: CoreChatTranscriptSearchResult;
    legacyResult: ChatTranscriptSearchResult;
  }>;
  queryChatToolOutputForLegacyIpc(
    params: CoreChatToolOutputReadParams,
    options: CanopyQueryOptions,
    requestId?: string,
  ): Promise<{
    canonicalResult: CoreChatToolOutputReadResult;
    legacyResult: ChatToolOutputResponse;
  }>;
  /**
   * A `file-tree:mutate` delete over `worker.filesystem.entry.delete`,
   * answered and failing as `mutateFileTree` did.
   */
  deleteFileTreeEntryForLegacyIpc(
    request: Extract<FileTreeMutationRequest, { operation: 'delete' }>,
    options: { caller: CanopyCallerDescriptor },
  ): Promise<FileTreeMutationResponse>;
  /**
   * A `file-tree:mutate` copy or move over `worker.filesystem.entry.copy` or
   * `.move`, answered and failing as `mutateFileTree` did.
   */
  transferFileTreeEntryForLegacyIpc(
    request: Extract<FileTreeMutationRequest, { operation: 'copy' | 'move' }>,
    options: { caller: CanopyCallerDescriptor },
  ): Promise<FileTreeMutationResponse>;
  /**
   * A `file-tree:mutate` create over `worker.filesystem.directory.create` and
   * `.file.write`, answered and failing as `mutateFileTree` did.
   */
  createFileTreeEntryForLegacyIpc(
    request: Extract<
      FileTreeMutationRequest,
      { operation: 'create-file' | 'create-directory' }
    >,
    options: { caller: CanopyCallerDescriptor },
  ): Promise<FileTreeMutationResponse>;
  /**
   * A `file:save-content` text save over `worker.filesystem.file.write`;
   * `unrouted` leaves a save-only root to the caller's direct write.
   */
  saveTextFileForLegacyIpc(
    save: LegacyTextFileSave,
    options: { caller: CanopyCallerDescriptor },
  ): Promise<'written' | 'unrouted'>;
}

let activeDesktopRuntime: DesktopCanopyDispatcher | null = null;

export function getActiveDesktopRuntime(): DesktopCanopyDispatcher {
  if (activeDesktopRuntime?.state !== 'accepting')
    throw new Error('Desktop Canopy runtime is unavailable.');
  return activeDesktopRuntime;
}

export function getActiveDesktopRuntimeIfAccepting(): DesktopCanopyDispatcher | null {
  return activeDesktopRuntime?.state === 'accepting'
    ? activeDesktopRuntime
    : null;
}

/**
 * Once the legacy read was captured, a canonical projection, validation or
 * list-retention failure must not replace it: legacy callers get
 * `canonicalResult: null`. A refused list cursor is never captured.
 */
function recoverLegacyWorkspaceRead(error: unknown, captured: unknown): null {
  if (
    captured !== undefined &&
    error instanceof CanopyOperationError &&
    (error.payload.kind === 'invalid_argument' ||
      error.payload.kind === 'internal' ||
      error.payload.kind === 'resource_exhausted')
  ) {
    return null;
  }
  throw error;
}

/** Rows of one chat id the search index can hold: live, archived, plan. */
const CHAT_SCOPE_LOOKUP_LIMIT = 20;

export function createDesktopRuntime(
  options: CreateDesktopRuntimeOptions = {},
): DesktopCanopyDispatcher {
  const projectionContext = new AsyncLocalStorage<FileTreeProjectionContext>();
  const chatProjectionContext = new AsyncLocalStorage<{
    legacyResult?: ChatStateSnapshot;
  }>();
  const summaryProjectionContext = new AsyncLocalStorage<{
    legacyResult?: WorktreeSummaryData | null;
  }>();
  const chatLocateAdapter = createCoreChatLocateAdapter(
    options.chatLocateHost ?? createDesktopChatLocateHost(),
  );
  const chatEventReplay = createChatEventReplayLog(
    options.getChatStatePort ?? ((): ChatStateCommandPort | null => null),
  );
  const chatStateAdapter = createCoreChatStateAdapter(
    options.getChatStatePort ?? ((): ChatStateCommandPort | null => null),
    {
      captureState: (result): void => {
        const context = chatProjectionContext.getStore();
        if (context) context.legacyResult = result;
      },
    },
    chatEventReplay,
  );
  const workspaceProjectionContext =
    new AsyncLocalStorage<WorkspaceProjectionContext>();
  // List continuation lives and ends with this runtime.
  const workspaceReadSnapshots = createCoreWorkspaceReadSnapshots(
    options.workspaceReadSnapshotLimits,
  );
  const workspaceAdapter = createCoreWorkspaceAdapter(
    options.workspaceServices,
    {
      captureSidebar: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.sidebar = result;
        context.sidebarDetail = detail;
      },
      captureConfig: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.config = result;
        context.configDetail = detail;
      },
      captureWorktrees: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.worktrees = result;
        context.worktreesDetail = detail;
      },
      captureWorktree: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.worktree = result;
        context.worktreeDetail = detail;
      },
    },
    workspaceReadSnapshots,
  );
  const chatReadProjectionContext =
    new AsyncLocalStorage<ChatReadProjectionContext>();
  const chatAdapter = createCoreChatReadAdapter(options.chatServices, {
    requestId: (): string | undefined =>
      chatReadProjectionContext.getStore()?.requestId,
    page: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    search: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    toolOutput: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    toolOutputPending: (read): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.toolOutputRead = read;
    },
  });
  // Frames reach the legacy consumer in emit order, so captures form a FIFO.
  const legacyEvents: Array<{
    event: ChatStateChangedEvent;
    cursor?: CanopyStreamCursor;
  }> = [];
  const chatEventsAdapter = createCoreChatEventsAdapter(
    options.getChatStatePort ?? ((): ChatStateCommandPort | null => null),
    (event, context) => {
      if (context.caller.clientInstanceId !== 'electron-main-chat-push') return;
      const entry: (typeof legacyEvents)[number] = { event };
      legacyEvents.push(entry);
      return (cursor): void => {
        if (cursor) entry.cursor = cursor;
        else {
          const index = legacyEvents.indexOf(entry);
          if (index >= 0) legacyEvents.splice(index, 1);
        }
      };
    },
    chatEventReplay,
  );
  const adapter = createWorkerFilesystemAdapter(
    options.services ?? { listFileTreeRoots, listFileTreeDirectory },
    {
      captureRoots: (result): void => {
        const context = projectionContext.getStore();
        if (context?.kind === 'roots') context.legacyResult = result;
      },
      captureDirectory: (result): void => {
        const context = projectionContext.getStore();
        if (context?.kind === 'directory') context.legacyResult = result;
      },
    },
  );
  const fileReadProjectionContext =
    new AsyncLocalStorage<FileReadProjectionContext>();
  const fileReadServices: WorkerFilesystemReadServices =
    options.fileReadServices ?? DEFAULT_FILE_READ_SERVICES;
  const readAdapter = createWorkerFilesystemReadAdapter({
    services: fileReadServices,
    projection: {
      roots: (projectId, worktreeId) => {
        const roots = fileReadProjectionContext.getStore()?.roots;
        return roots?.projectId === projectId && roots.worktreeId === worktreeId
          ? roots.value
          : null;
      },
      capture: (read): void => {
        const context = fileReadProjectionContext.getStore();
        if (context) context.read = read;
      },
      linkHostBase: () =>
        fileReadProjectionContext.getStore()?.linkHostBase ?? null,
      captureLink: (resolved): void => {
        const context = fileReadProjectionContext.getStore();
        if (context) context.link = resolved;
      },
    },
  });
  const fileSearchProjectionContext =
    new AsyncLocalStorage<FileSearchProjectionContext>();
  const fileSearchServices: WorkerFilesystemSearchServices =
    options.fileSearchServices ?? DEFAULT_FILE_SEARCH_SERVICES;
  // Paused walks behind this dispatcher's `worker.filesystem.search` cursors.
  const searchEngine = createFilesystemSearchEngine();
  const searchAdapter = createWorkerFilesystemSearchAdapter({
    engine: searchEngine,
    services: fileSearchServices,
    projection: {
      root: (projectId, worktreeId, fileRootId) => {
        const context = fileSearchProjectionContext.getStore();
        return context?.projectId === projectId &&
          context.worktreeId === worktreeId &&
          context.root.repoId === fileRootId
          ? { root: context.root, fileIndexing: context.fileIndexing }
          : null;
      },
      capture: (page): void => {
        const context = fileSearchProjectionContext.getStore();
        if (context) context.page = page;
      },
    },
  });
  const watchProjectionContext =
    new AsyncLocalStorage<WatchProjectionContext>();
  const watchAdapter = createWorkerFilesystemWatchAdapter({
    ...options.filesystemWatch,
    onAttached: (): void => watchProjectionContext.getStore()?.attached(),
    onAttachFailed: (_context, error): void =>
      watchProjectionContext.getStore()?.failed(error),
  });
  const entryMutationHost = createDesktopEntryMutationHost(
    options.platform ?? defaultEntryMutationPlatform(),
  );
  const mutationAdapter = createWorkerFilesystemMutationAdapter(
    entryMutationHost,
    options.entryDeleteIo,
    options.entryTransferIo,
    options.fileWriteIo,
  );
  const translateAdapterCall = async <Result>(
    call: () => Result | Promise<Result>,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WorkerFilesystemAdapterError) {
        throw new CanopyOperationError(error.payload, error.runtimeCause);
      }
      throw error;
    }
  };
  const builtInHandlers: Partial<CanopyQueryHandlerMap<CanopyHandlerContext>> =
    {
      ...chatStateAdapter,
      'core.chat.send.receipt': chatAdapter['core.chat.send.receipt'],
      'core.chat.transcript.page': chatAdapter['core.chat.transcript.page'],
      'core.chat.transcript.search': chatAdapter['core.chat.transcript.search'],
      'core.chat.toolOutput.read': chatAdapter['core.chat.toolOutput.read'],
      'core.chat.content.read': chatAdapter['core.chat.content.read'],
      'core.chat.transcript.blocks.page':
        chatAdapter['core.chat.transcript.blocks.page'],
      'core.chat.visual.read': chatAdapter['core.chat.visual.read'],
      'core.chat.locate': chatLocateAdapter['core.chat.locate'],
      'worker.filesystem.roots.list': (params, context) => {
        const direct = (): Promise<WorkerFilesystemRootsListResult> =>
          translateAdapterCall(() =>
            adapter['worker.filesystem.roots.list'](params, context),
          );
        const store = projectionContext.getStore();
        if (
          store?.kind !== 'roots' ||
          !store.route ||
          !options.daemonFilesRoute
        )
          return direct();
        return options.daemonFilesRoute().roots(params, context, store.route, {
          direct,
          capture: (legacy): void => {
            store.legacyResult = legacy;
          },
        });
      },
      'worker.filesystem.directory.list': (params, context) => {
        const direct = (): Promise<WorkerFilesystemDirectoryListResult> =>
          translateAdapterCall(() =>
            adapter['worker.filesystem.directory.list'](params, context),
          );
        const store = projectionContext.getStore();
        if (
          store?.kind !== 'directory' ||
          !store.route ||
          !options.daemonFilesRoute
        )
          return direct();
        return options
          .daemonFilesRoute()
          .directory(params, context, store.route, {
            direct,
            capture: (legacy): void => {
              store.legacyResult = legacy;
            },
          });
      },
      'worker.filesystem.file.read': (params, context) => {
        const direct = async (): Promise<WorkerFilesystemFileReadResult> =>
          readAdapter['worker.filesystem.file.read'](params, context);
        const store = fileReadProjectionContext.getStore();
        if (!store?.route || !options.daemonFilesRoute) return direct();
        return options.daemonFilesRoute().file(params, context, store.route, {
          direct,
          capture: (read): void => {
            store.read = read;
          },
        });
      },
      'worker.filesystem.search': (params, context) => {
        const direct = async (): Promise<WorkerFilesystemSearchResult> =>
          searchAdapter['worker.filesystem.search'](params, context);
        const store = fileSearchProjectionContext.getStore();
        if (!store?.route || !options.daemonFilesRoute) return direct();
        return options
          .daemonFilesRoute()
          .search(params, context, store.route.request, {
            direct,
            walk: store.route.walk,
            capture: (page): void => {
              store.page = page;
            },
          });
      },
      'worker.filesystem.link.resolve': (params, context) => {
        const direct = async (): Promise<WorkerFilesystemLinkResolveResult> =>
          readAdapter['worker.filesystem.link.resolve'](params, context);
        const store = fileReadProjectionContext.getStore();
        if (!store?.route || !options.daemonFilesRoute) return direct();
        return options.daemonFilesRoute().link(params, context, store.route, {
          direct,
          hostBase: store.linkHostBase !== undefined,
          capture: (resolved): void => {
            store.link = resolved;
          },
        });
      },
    };

  const ledgerService = options.ledgerService ?? getDesktopLedgerService();
  const chatCommandKeys = new ChatCommandKeyFingerprints();
  const commandAdapter = createCoreChatCommandAdapter(
    getChatStateCommandPort,
    options.chatSettingsHost === undefined
      ? undefined
      : (): CoreChatSettingsHost | null => options.chatSettingsHost ?? null,
    chatCommandKeys,
  );
  const chatCommandsWithEffects = withChatArchiveEffects(
    commandAdapter,
    getChatStateCommandPort,
    options.chatArchiveEffects === undefined
      ? createDesktopChatArchiveEffects()
      : options.chatArchiveEffects,
  );
  const chatCommandsAdapter = {
    instructions: {
      ...chatCommandsWithEffects.instructions,
      'core.chat.update': (
        params: unknown,
        context: CanopyHandlerContext,
      ): ReturnType<
        (typeof chatCommandsWithEffects.instructions)['core.chat.update']
      > => {
        assertAutoArchivePatchOnly(context.caller, params);
        return chatCommandsWithEffects.instructions['core.chat.update'](params);
      },
    },
  };
  const chatTransferAdapter = createCoreChatTransferAdapter(
    options.chatTransferHost,
  );
  const messageAdapter = createCoreChatMessageAdapter(
    () => options.chatCommandPort ?? getChatStateService(),
    chatCommandKeys,
  );
  const ledgerAdapter: DesktopDomainAdapter = {
    queries: createCoreLedgerQueryHandlers(ledgerService),
    instructions: createCoreLedgerInstructionHandlers(ledgerService),
  };
  const costAdapter = createCoreCostAdapter(
    options.costService ??
      (async (): Promise<CostService> => {
        const serviceModule = await import('../cost-index/service');
        return serviceModule.getDesktopCostService();
      }),
  );
  const summaryAdapter = createCoreSummaryAdapter(
    options.summaryAdapterHost ?? DESKTOP_SUMMARY_ADAPTER_HOST,
    {
      schedule: () => summarySchedule,
      captureLegacy: (summary): void => {
        const context = summaryProjectionContext.getStore();
        if (context) context.legacyResult = summary;
      },
    },
  );
  const coreSearchAdapter = createCoreSearchAdapter(
    options.searchIndex ??
      (async (): Promise<CoreSearchIndex> => {
        const { getChatSearchService } = await import('../chat-search/service');
        const service = getChatSearchService();
        // Not awaited, as the palette catalog does: a query reads the current
        // index while the scan fills it, and indexRevision advances with it.
        service.ensureInitialScan();
        return service;
      }),
  );
  const injectedUpdateHost = options.updateHost;
  const updateAdapter = createCoreUpdateAdapter(
    injectedUpdateHost
      ? (): Promise<CoreUpdateHost> => Promise.resolve(injectedUpdateHost)
      : undefined,
  );
  const workspaceInstructionsAdapter = createCoreWorkspaceInstructionsAdapter(
    options.workspaceInstructionsHost,
  );
  const workspaceItemsAdapter = createCoreWorkspaceItemsAdapter({
    providers: createDesktopWorkspaceTextItemProviders(),
    ...options.workspaceItems,
  });
  const initiatedWorkSourceAdapter = createCoreInitiatedWorkSourceAdapter(
    options.hookSourceHost,
  );
  const executionAdapter = createCoreExecutionAdapter();
  const terminalSettingsAdapter = createCoreTerminalSettingsAdapter(
    options.terminalSettingsStore,
  );
  const configAdapter = createCoreConfigAdapter(options.configHost);
  const memoryStoreAdapter = createCoreMemoryAdapter(options.memoryHost);
  const memoryChatsAdapter = createCoreMemoryChatsAdapter(
    options.memoryChatsHost,
  );
  const memoryAdapter: DesktopDomainAdapter = {
    ...memoryStoreAdapter,
    queries: { ...memoryStoreAdapter.queries, ...memoryChatsAdapter.queries },
  };
  const memoryMaintenanceAdapter = createCoreMemoryMaintenanceAdapter(
    options.memoryMaintenanceHost,
  );
  const archiveAdapter = createCoreArchiveAdapter(options.archiveHost);
  const worktreeRecoveryAdapter = createCoreWorktreeRecoveryAdapter();
  const watcherAdapter = createCoreWatcherAdapter(options.watcherHost);
  const managedDelegationAdapter = createCoreManagedDelegationAdapter(
    options.managedDelegationHost,
  );
  const deferredToolsAdapter = createCoreDeferredToolsAdapter(
    options.deferredToolsHost,
  );
  const visualStageAdapter = createCoreChatVisualStageAdapter(
    options.visualStageHost,
  );
  const visualRenderAdapter = createWorkerVisualAdapter(
    options.visualRenderHost,
  );
  const observabilityReadModel = options.observabilityReadModel;
  const observabilityAdapter = createCoreObservabilityAdapter(
    observabilityReadModel
      ? (): Promise<ObservabilityReadModel> =>
          Promise.resolve(observabilityReadModel)
      : undefined,
  );
  const sharedMultiRepoAdapter = createCoreSharedMultiRepoHandlers(
    options.sharedMultiRepoHost ?? {
      load: async (): Promise<SharedMultiRepoCoordinator> =>
        (
          await import('./core-shared-multi-repo-host')
        ).desktopSharedMultiRepoHost.load(),
    },
  );
  const repoRulesAdapter = createCoreWorkspaceRepoRulesAdapter(
    options.repoRulesHost,
  );
  const pipelineDefinitionAdapter = createCorePipelineDefinitionAdapter(
    options.pipelineDefinitionHost,
  );
  const workerPipelineAdapter =
    options.workerPipelineAdapter ?? createWorkerPipelineAdapter();
  const pipelineHostRequests = workerPipelineAdapter.hostRequests;
  const workerCodeGraphAdapter =
    options.workerCodeGraphAdapter ?? createWorkerCodeGraphAdapter();
  const workerCodeGraphReadAdapter =
    options.workerCodeGraphReadAdapter ?? createWorkerCodeGraphReadAdapter();
  const scriptDefinitionsAdapter = createCoreScriptDefinitionsAdapter(
    options.scriptDefinitionsHost,
  );
  const workerScriptAdapter =
    options.workerScriptAdapter ?? createWorkerScriptAdapter();
  const chatTurnRunsRef: { current: CoreChatTurnRuns | null } = {
    current: null,
  };
  const workerAgentAdapter =
    options.workerAgentAdapter ??
    createWorkerAgentAdapter({
      sinkFor: (id) => chatTurnRunsRef.current?.sinkFor(id) ?? null,
    });
  const workerCatalogAdapter = createWorkerCatalogAdapter(
    options.workerCatalogHost,
  );
  const workerScriptHandlers: DesktopDomainAdapter = {
    queries: workerScriptAdapter.queries,
    instructions: workerScriptAdapter.instructions,
  };
  const workspaceMetadataAdapter = createCoreWorkspaceMetadataAdapter(
    options.workspaceMetadataHost,
  );
  const workspaceLifecycleAdapter = createCoreWorkspaceLifecycleAdapter(
    options.workspaceLifecycleHost,
  );
  const workspaceGuardedAdapter = createCoreWorkspaceGuardedAdapter(
    options.workspaceGuardedHost,
  );
  // A wire lifecycle's Git effect dispatches on this runtime, once built.
  const lifecycleEffects: { dispatcher?: DesktopCanopyDispatcher } = {};
  const sourceCompositionAdapter = createCoreSourceCompositionAdapter(
    options.sourceCompositionHost,
    () => {
      if (!lifecycleEffects.dispatcher)
        throw new Error('Desktop Canopy runtime is unavailable.');
      return lifecycleEffects.dispatcher;
    },
  );
  const workerGitAdapter = createWorkerGitAdapter(
    options.workerGitHost,
    options.workerGitExecutableHost,
    options.workerGitRemoteHost,
    options.workerGitWorktreeHealthHost,
    options.workerGitDiffHost,
    options.workerGitBranchWriteHost,
  );
  const workerGitLocalMutationAdapter: DesktopDomainAdapter = {
    instructions: {
      ...createWorkerGitLocalMutationAdapter(),
      ...createDesktopWorktreeGitAdapter(),
    },
  };
  const workerGitMergeAdapter: DesktopDomainAdapter = {
    instructions: createWorkerGitMergeAdapter(options.workerGitMergeHost),
  };
  const workerGitSyncAdapter: DesktopDomainAdapter = {
    instructions: {
      ...createWorkerGitSyncWriteAdapter(options.workerGitSyncWriteHost),
      ...createWorkerGitCommitPushAdapter(),
    },
  };
  const integrationAdapter = createCoreIntegrationAdapter(
    options.integrationHost,
  );
  const pullRequestAdapter = createCorePullRequestAdapter(
    options.pullRequestHost,
  );
  const annotationAdapter =
    options.annotationAdapter ??
    createCoreAnnotationAdapter({ publish: publishFileAnnotationsUpdated });
  const operationAdapter =
    options.operationAdapter ?? createCoreOperationAdapter();
  let catalogDispatcher: DesktopCanopyDispatcher | null = null;
  const catalogAdapter = createCoreCatalogAdapter({
    operations: operationAdapter.service,
    host: options.catalogHost,
    dispatchWorkspacePluginsUpdate: (params, caller) =>
      catalogDispatcher
        ? catalogDispatcher.instruction(
            'core.workspace.plugins.update',
            params,
            {
              caller,
              metadata: { idempotencyKey: params._meta.idempotencyKey },
            },
          )
        : Promise.reject(canopyUnavailableError()),
  });
  const operationQueriesAndInstructions: DesktopDomainAdapter = {
    queries: operationAdapter.queries,
    instructions: operationAdapter.instructions,
  };
  const defaultChatScopesForChat = async (
    chatId: string,
  ): Promise<ChatCancelRequest[]> => {
    const scopes = new Map(
      getChatTurnOwnership()
        .scopesForChat(chatId)
        .map((scope) => [`${scope.projectId}/${scope.worktreeId}`, scope]),
    );
    try {
      const { getChatSearchService } = await import('../chat-search/service');
      // The index lists every live and archived chat by id, one query.
      for (const row of getChatSearchService().getCatalog(
        CHAT_SCOPE_LOOKUP_LIMIT,
        [chatId],
      ))
        scopes.set(`${row.projectId}/${row.worktreeId}`, {
          projectId: row.projectId,
          worktreeId: row.worktreeId,
          chatId,
        });
    } catch (error) {
      // Without the index an untracked chat is unknown, not missing.
      if (scopes.size === 0)
        throw new CanopyOperationError(
          {
            kind: 'unavailable',
            message: 'The chat lookup is unavailable.',
            retry: { kind: 'same_request', delayMs: 1_000 },
          },
          error,
        );
      logMainProcessError('Chat search scope lookup failed', error);
    }
    return [...scopes.values()];
  };
  const defaultChatState = (
    scope: ChatCancelRequest,
  ): Promise<ChatStateSnapshot> =>
    (options.chatCommandPort ?? getChatStateService()).getState(scope);
  const turnAdapter: DesktopDomainAdapter = {
    instructions: createCoreChatTurnAdapter(
      options.turnCancelHost ?? {
        scopesForChat: defaultChatScopesForChat,
        getState: defaultChatState,
        stop: stopChatTurnExactly,
      },
    ),
  };
  const questionAdapter: DesktopDomainAdapter = {
    instructions: createCoreChatQuestionAdapter(
      options.questionHost ?? {
        scopesForChat: defaultChatScopesForChat,
        getState: defaultChatState,
        liveScope: (questionId) => {
          const live = getDesktopChatWaits().scopeOf(questionId);
          return live
            ? {
                projectId: live.workspaceId,
                worktreeId: live.worktreeId,
                chatId: live.chatId,
              }
            : null;
        },
        respond: (request) =>
          respondToChatQuestion({
            ...request,
            port: options.chatCommandPort ?? getChatStateService(),
          }),
      },
    ),
  };
  const adapters: DesktopDomainAdapter[] = [
    chatCommandsAdapter,
    turnAdapter,
    questionAdapter,
    messageAdapter,
    chatTransferAdapter,
    ledgerAdapter,
    costAdapter,
    {
      queries: updateAdapter.queries,
      instructions: updateAdapter.instructions,
    },
    summaryAdapter,
    coreSearchAdapter,
    terminalSettingsAdapter,
    configAdapter,
    memoryAdapter,
    memoryMaintenanceAdapter,
    archiveAdapter,
    worktreeRecoveryAdapter,
    watcherAdapter,
    managedDelegationAdapter,
    deferredToolsAdapter,
    visualStageAdapter,
    visualRenderAdapter,
    catalogAdapter,
    workspaceInstructionsAdapter,
    workspaceItemsAdapter,
    initiatedWorkSourceAdapter,
    { queries: executionAdapter.queries },
    { queries: observabilityAdapter.queries },
    repoRulesAdapter,
    pipelineDefinitionAdapter,
    sharedMultiRepoAdapter,
    scriptDefinitionsAdapter,
    workerScriptHandlers,
    workerAgentAdapter,
    workerCatalogAdapter,
    workerGitAdapter,
    workerGitSyncAdapter,
    workerGitMergeAdapter,
    workerGitLocalMutationAdapter,
    integrationAdapter,
    pullRequestAdapter,
    workerPipelineAdapter,
    workerCodeGraphAdapter,
    workerCodeGraphReadAdapter,
    annotationAdapter,
    operationQueriesAndInstructions,
    ...(options.adapters ?? []),
  ];
  const coworkFolderAdapter = createCoworkFolderAdapter();
  const queries: Partial<CanopyDispatcherHandlerMap<DesktopQueryDefinitions>> =
    {
      ...builtInHandlers,
      ...workspaceAdapter,
      'core.workspace.cowork.folder.check':
        coworkFolderAdapter['core.workspace.cowork.folder.check'],
    };
  const instructions: Partial<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>
  > = {
    'core.workspace.cowork.send.rollback':
      coworkFolderAdapter['core.workspace.cowork.send.rollback'],
  };
  const streams: Partial<
    CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>
  > = {
    ...chatEventsAdapter.handlers,
    ...watchAdapter.handlers,
    ...operationAdapter.streams,
    ...executionAdapter.streams,
    ...observabilityAdapter.streams,
    ...updateAdapter.streams,
  };
  for (const entry of adapters) {
    for (const name of Object.keys(entry.queries ?? {}))
      if (Object.prototype.hasOwnProperty.call(queries, name))
        throw new Error(`Duplicate Canopy query handler: ${name}`);
    for (const name of Object.keys(entry.instructions ?? {}))
      if (Object.prototype.hasOwnProperty.call(instructions, name))
        throw new Error(`Duplicate Canopy instruction handler: ${name}`);
    for (const name of Object.keys(entry.streams ?? {}))
      if (Object.prototype.hasOwnProperty.call(streams, name))
        throw new Error(`Duplicate Canopy stream handler: ${name}`);
    Object.assign(queries, entry.queries);
    Object.assign(instructions, entry.instructions);
    Object.assign(streams, entry.streams);
  }

  // Worker-plane instructions run on this dispatcher; their receipts let
  // the local worker execution resolve an unknown reply (CAN-4132). Only the
  // composed registry's worker instructions are wrapped: the git branch
  // writes (CAN-4108), the entry instructions (CAN-5502) and the git fetch
  // and pull (CAN-5517), which the transport carries. Create/save are now
  // composed (CAN-5518), but stay outside this transport until CAN-4730.
  const instructionDefinitions: CanopyInstructionDefinitionMap = {
    ...CANOPY_INSTRUCTION_DEFINITIONS,
    ...WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
    ...WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS,
    ...WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
    ...WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  };
  const workerInstructions: CanopyInstructionDefinitionMap = Object.fromEntries(
    Object.entries(instructionDefinitions).filter(
      ([name, definition]) =>
        definition.plane === 'worker' &&
        name !== 'worker.filesystem.file.write' &&
        name !== 'worker.filesystem.directory.create',
    ),
  );
  const workerReceipts = createWorkerExecutorReceipts(workerInstructions);
  const workerHandlers = workerReceipts.wrap(
    Object.fromEntries(
      Object.entries({ ...instructions, ...mutationAdapter }).flatMap(
        ([name, handler]) =>
          Object.prototype.hasOwnProperty.call(workerInstructions, name)
            ? [[name, handler]]
            : [],
      ),
    ),
  );
  const owned = (
    name: string,
    ...maps: Array<object | undefined>
  ): { name: string; operations: string[] } => ({
    name,
    operations: maps.flatMap((map) => Object.keys(map ?? {})),
  });
  const ownedAdapter = (
    name: string,
    entry: DesktopDomainAdapter,
  ): { name: string; operations: string[] } =>
    owned(name, entry.queries, entry.instructions, entry.streams);
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS;
  // The vault SQLite connection is daemon-exclusive, including in-process hosts.
  if (
    [
      CANOPY_QUERY_DEFINITIONS,
      DESKTOP_INSTRUCTION_DEFINITIONS,
      CANOPY_STREAM_DEFINITIONS,
    ].some((definitions) =>
      Object.keys(definitions).some((name) => name.startsWith('core.vault.')),
    )
  )
    throw new Error(
      'The in-process desktop runtime must not register core.vault.',
    );
  const runtime = createCanopyRuntime({
    profile: 'core+worker',
    // Trusted-host placeholders until the daemon descriptor lands (C5).
    identity: {
      runtimeId: LOCAL_DESKTOP_AUTHORITY_ID,
      hostId: LOCAL_DESKTOP_AUTHORITY_ID,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    },
    definitions: {
      queries: DESKTOP_QUERY_DEFINITIONS,
      instructions: DESKTOP_INSTRUCTION_DEFINITIONS,
      streams: CANOPY_STREAM_DEFINITIONS,
    },
    owners: [
      owned('core.chat.state', chatStateAdapter),
      {
        name: 'core.chat.read',
        operations: [
          'core.chat.send.receipt',
          'core.chat.transcript.page',
          'core.chat.transcript.search',
          'core.chat.toolOutput.read',
          'core.chat.content.read',
          'core.chat.transcript.blocks.page',
          'core.chat.visual.read',
          'core.chat.locate',
        ],
      },
      owned(
        'worker.filesystem',
        adapter,
        readAdapter,
        searchAdapter,
        watchAdapter.handlers,
        mutationAdapter,
      ),
      owned('core.workspace', workspaceAdapter, coworkFolderAdapter),
      owned('core.chat.events', chatEventsAdapter.handlers),
      ownedAdapter('core.chat.turn', turnAdapter),
      ownedAdapter('core.chat.question', questionAdapter),
      ownedAdapter('core.chat.commands', chatCommandsAdapter),
      ownedAdapter('core.chat.messages', messageAdapter),
      ownedAdapter('core.chat.transfer', chatTransferAdapter),
      ownedAdapter('core.ledger', ledgerAdapter),
      ownedAdapter('core.cost', costAdapter),
      owned(
        'core.update',
        updateAdapter.queries,
        updateAdapter.instructions,
        updateAdapter.streams,
      ),
      ownedAdapter('core.summary', summaryAdapter),
      ownedAdapter('core.search', coreSearchAdapter),
      ownedAdapter('core.terminal.settings', terminalSettingsAdapter),
      ownedAdapter('core.config', configAdapter),
      ownedAdapter('core.memory', memoryAdapter),
      ownedAdapter('core.memory.maintenance', memoryMaintenanceAdapter),
      ownedAdapter('core.archive', archiveAdapter),
      ownedAdapter('core.worktree.recovery', worktreeRecoveryAdapter),
      ownedAdapter('core.initiatedWork.watcher', watcherAdapter),
      ownedAdapter('core.managedDelegation', managedDelegationAdapter),
      ownedAdapter('core.agent.deferredTools', deferredToolsAdapter),
      ownedAdapter('core.chat.visual.stage', visualStageAdapter),
      ownedAdapter('worker.visual', visualRenderAdapter),
      ownedAdapter('core.catalog', catalogAdapter),
      ownedAdapter('worker.catalog', workerCatalogAdapter),
      ownedAdapter('core.workspace.instructions', workspaceInstructionsAdapter),
      ownedAdapter('core.workspace.item', workspaceItemsAdapter),
      ownedAdapter('core.initiatedWork.source', initiatedWorkSourceAdapter),
      owned(
        'core.execution',
        executionAdapter.queries,
        executionAdapter.streams,
      ),
      owned(
        'core.observability',
        observabilityAdapter.queries,
        observabilityAdapter.streams,
      ),
      ownedAdapter('core.workspace.repoRules', repoRulesAdapter),
      ownedAdapter('core.pipeline', pipelineDefinitionAdapter),
      ownedAdapter('core.workspace.sharedMultiRepo', sharedMultiRepoAdapter),
      ownedAdapter('core.script.definition', scriptDefinitionsAdapter),
      ownedAdapter('worker.script', workerScriptHandlers),
      ownedAdapter('worker.agent', workerAgentAdapter),
      owned('core.workspace.metadata', workspaceMetadataAdapter.instructions),
      owned('core.workspace.lifecycle', workspaceLifecycleAdapter.instructions),
      owned('core.workspace.guarded', workspaceGuardedAdapter.instructions),
      owned(
        'core.workspace.lifecycle.sourceComposition',
        sourceCompositionAdapter.instructions,
      ),
      owned(
        'worker.git',
        workerGitAdapter.queries,
        workerGitAdapter.instructions,
        workerGitSyncAdapter.instructions,
        workerGitMergeAdapter.instructions,
        workerGitLocalMutationAdapter.instructions,
      ),
      ownedAdapter('core.integration', integrationAdapter),
      ownedAdapter('core.pullRequest', pullRequestAdapter),
      ownedAdapter('worker.pipeline', workerPipelineAdapter),
      owned(
        'worker.codeGraph',
        workerCodeGraphAdapter.queries,
        workerCodeGraphAdapter.instructions,
        workerCodeGraphReadAdapter.queries,
        workerCodeGraphReadAdapter.instructions,
      ),
      ownedAdapter('core.annotation', annotationAdapter),
      owned(
        'core.operation',
        operationAdapter.queries,
        operationAdapter.instructions,
        operationAdapter.streams,
      ),
      ...(options.adapters ?? []).map((entry, index) =>
        ownedAdapter(`desktop.adapter.${index}`, entry),
      ),
    ],
    // Writer ownership stays with the existing desktop services for now.
    services: options.runtimeServices ?? [],
    // Phase 3 outlasts the dispatcher's own drain-then-abort window.
    phaseDeadlineMs: shutdownTimeoutMs + 250,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          queries: { ...queries, ...input.runtimeHandlers.queries },
          // The filesystem write and entry instructions are keyed with no
          // retained outcome by decision (Mike, q-14 D3, 2026-10-31) until
          // CAN-4733, so a reused key re-executes: file.write and
          // directory.create bypass the receipts, and the entry receipts never
          // replay. The explorer and text save mint one per call; relay and
          // preload rewrite same-key retries to `never`.
          instructions: {
            ...instructions,
            ...mutationAdapter,
            ...workspaceMetadataAdapter.instructions,
            ...workspaceLifecycleAdapter.instructions,
            ...workspaceGuardedAdapter.instructions,
            ...sourceCompositionAdapter.instructions,
            ...workerHandlers,
          },
          streams: { ...streams, ...input.runtimeHandlers.streams },
        },
        shutdownTimeoutMs,
      }),
  });
  // Startup failure is reported through runtime health.
  void runtime.start().catch(() => undefined);
  const dispatcher = runtime.dispatcher;
  const localWorker = new LocalWorkerExecution({
    operations: operationAdapter.service,
    transport: createDirectLocalWorkerTransport({
      dispatcher,
      instructions: workerInstructions,
      caller: {
        principalId: 'core',
        clientInstanceId: 'desktop-core',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: Array.from(
          new Set(
            Object.values(workerInstructions).flatMap(
              ({ requiredGrants }) => requiredGrants,
            ),
          ),
        ),
      },
      receipts: workerReceipts,
    }),
  });
  const scriptRuns = new CoreScriptRuns({
    operations: operationAdapter.service,
    localWorker,
    observe: (executionId, observer): Promise<() => void> =>
      workerScriptAdapter.observe(executionId, observer),
  });
  const helperRuns = new CoreHelperRuns({
    operations: operationAdapter.service,
    localWorker,
  });
  const signInRuns = new CoreSignInRuns({
    operations: operationAdapter.service,
    localWorker,
  });
  const catalogMaterializations = new CoreCatalogMaterializations({
    operations: operationAdapter.service,
    localWorker,
    resolver:
      options.catalogMaterializationResolver ??
      createDesktopMaterializationResolver(),
    secrets: getDesktopExecutionSecrets(),
  });
  const appAdvisorActions = new AdvisorActionRuns({
    operations: operationAdapter.service,
    onError: (error, context): void =>
      logMainProcessWarn(`[app-advisor-actions] ${context} failed`, error),
  });
  const summarySchedule = new CoreSummarySchedule({
    operations: operationAdapter.service,
    ownerId: LOCAL_DESKTOP_AUTHORITY_ID,
  });
  summarySchedule.registerHost(
    options.summaryScheduleHost ?? createDesktopSummaryScheduleHost(),
  );
  const chatTurnRuns = new CoreChatTurnRuns({
    operations: operationAdapter.service,
    localWorker,
    onError: (error, context): void =>
      logMainProcessWarn(`[chat-turn-runs] ${context} failed`, error),
  });
  chatTurnRunsRef.current = chatTurnRuns;
  installQuestionTurnWaits(getDesktopChatWaits());
  installApprovalTurnWaits(getDesktopChatWaits());
  const subagentRuns = new CoreSubagentRuns({
    operations: operationAdapter.service,
    localWorker,
    onError: (error, context): void =>
      logMainProcessWarn(`[subagent-runs] ${context} failed`, error),
    stopNative: stopSubagentNatively,
  });
  // CAN-5828: the turn's audit entry records which lease answered.
  const provenance = createInterfaceToolProvenance({
    load: loadInterfaceToolProvenanceIngest,
    onError: (error, context): void =>
      logMainProcessWarn(`[interface-tools] ${context} failed`, error),
  });
  const interfaceTools = new InterfaceToolRegistry({
    onError: (error, context): void =>
      logMainProcessWarn(`[interface-tools] ${context} failed`, error),
    onDelivered: (event): void => {
      logMainProcessDebug('[interface-tools] delivered', event);
      provenance.onDelivered(event);
    },
    onSettled: (event): void => provenance.onSettled(event),
  });
  setSessionInterfaceToolRegistry(interfaceTools);
  const deferredToolReloads =
    new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
      operations: operationAdapter.service,
      host:
        options.deferredToolReloadHost ?? createDesktopDeferredToolReloadHost(),
      display: null,
      materializations: catalogMaterializations,
      waits: {
        opened: (scope, waitId): void => {
          emitChatTurnWait(scope, {
            kind: 'wait_opened',
            waitId,
            waitKind: 'deferred_tools',
          });
        },
        resolved: (scope, waitId, resolution): void => {
          emitChatTurnWait(scope, {
            kind: 'wait_resolved',
            waitId,
            resolution,
          });
        },
      },
      onError: (error, context): void =>
        logMainProcessWarn(`[deferred-tools] ${context} failed`, error),
    });
  const initiatedWork = new InitiatedWorkEngine({
    operations: operationAdapter.service,
    // Hook runs a restart interrupted resume through the hook source
    // (CAN-4145); it registers once the poller starts.
    recoverableOrigins: ['hook'],
    onError: (error, context): void => {
      logMainProcessWarn(`[initiated-work] ${context} failed`, error);
    },
  });
  const hookChatClaims = new HookChatClaims({
    operations: operationAdapter.service,
  });
  const hookQueue = new HookQueue({
    operations: operationAdapter.service,
    payloads: createHookQueuePayloadStore(),
    onError: (error, context): void => {
      logMainProcessWarn(`[hook-queue] ${context} failed`, error);
    },
  });
  const pipelineRuns = new CorePipelineRuns({
    operations: operationAdapter.service,
    localWorker,
    worker: {
      get: (executionId): Promise<WorkerPipelineExecution | null> =>
        workerPipelineAdapter.loaded()?.get(executionId) ??
        Promise.resolve(null),
      observe: (executionId, observer): (() => void) | null =>
        workerPipelineAdapter.loaded()?.observe(executionId, observer) ?? null,
    },
  });
  // Core settles the local worker's host step requests; the desktop host
  // loads on the first request.
  const stopSettlingHostRequests = settlePipelineHostRequests({
    dispatcher,
    caller: pipelineHostCoreCaller(LOCAL_DESKTOP_AUTHORITY_ID),
    apply: async (request, signal) =>
      (
        await import('../pipelines/pipeline-host-requests')
      ).applyPipelineHostRequest(request, signal),
    onError: (error) => logMainProcessError('Pipeline host step failed', error),
  }).catch((error: unknown) => {
    logMainProcessError('Pipeline host requests are unavailable', error);
    return null;
  });
  const takeChatEventForLegacyIpc = (
    cursor: CanopyStreamCursor,
  ): ChatStateChangedEvent => {
    const entry = legacyEvents[0];
    // An entry without a cursor is the emit in progress (synchronous delivery).
    if (
      !entry ||
      (entry.cursor &&
        (entry.cursor.daemonEpoch !== cursor.daemonEpoch ||
          entry.cursor.sequence !== cursor.sequence))
    )
      throw new Error('Chat event projection was not captured.');
    legacyEvents.shift();
    return entry.event;
  };
  const openChatEventsForLegacyIpc: DesktopCanopyDispatcher['openChatEventsForLegacyIpc'] =
    async (params, streamOptions) => ({
      handle: await dispatcher.openStream(
        'core.chat.events',
        params,
        streamOptions,
      ),
      takeLegacyEvent: takeChatEventForLegacyIpc,
    });
  const legacyWatchHandles = new Set<FileTreeWatchHandle>();
  const openFileTreeWatchForLegacyIpc: DesktopCanopyDispatcher['openFileTreeWatchForLegacyIpc'] =
    async (params, streamOptions) => {
      let settle: { resolve(): void; reject(error: unknown): void } | null =
        null;
      const attached = new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
      // A projection that closes before attaching never awaits this promise.
      attached.catch(() => undefined);
      const finish = (error?: unknown): void => {
        const current = settle;
        settle = null;
        if (!current) return;
        if (error === undefined) current.resolve();
        else current.reject(error);
      };
      // The end frame can arrive before openStream resolves.
      const opened: { handle?: FileTreeWatchHandle; ended: boolean } = {
        ended: false,
      };
      const onFrame = streamOptions.onFrame;
      const context: WatchProjectionContext = {
        attached: () => finish(),
        failed: (error) => finish(error),
      };
      const handle = await watchProjectionContext.run(context, () =>
        dispatcher.openStream('worker.filesystem.watch', params, {
          ...streamOptions,
          onFrame: (frame): void => {
            if (frame.kind === 'end') {
              opened.ended = true;
              if (opened.handle) legacyWatchHandles.delete(opened.handle);
              finish(
                new CanopyOperationError(
                  frame.error ?? {
                    kind: 'cancelled',
                    message: 'The filesystem watch ended before attaching.',
                    retry: { kind: 'never' },
                  },
                ),
              );
            }
            onFrame?.(frame);
          },
        }),
      );
      opened.handle = handle;
      if (!opened.ended) legacyWatchHandles.add(handle);
      return { handle, attached };
    };
  const closeFileTreeWatchesForLegacyIpc = (): void => {
    for (const handle of Array.from(legacyWatchHandles)) handle.close();
    legacyWatchHandles.clear();
  };
  const queryChatStateForLegacyIpc = async (
    params: CanopyQueryParams<'core.chat.snapshot.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.chat.snapshot.get'>;
    legacyResult: ChatStateSnapshot;
  }> => {
    const context: { legacyResult?: ChatStateSnapshot } = {};
    const canonicalResult = await chatProjectionContext.run(context, () =>
      dispatcher.query('core.chat.snapshot.get', params, queryOptions),
    );
    if (!context.legacyResult)
      throw new Error('Chat state projection was not captured.');
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const querySummaryForLegacyIpc = async (
    params: CanopyQueryParams<'core.summary.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.summary.get'>;
    legacyResult: WorktreeSummaryData | null;
  }> => {
    const context: { legacyResult?: WorktreeSummaryData | null } = {};
    const canonicalResult = await summaryProjectionContext.run(context, () =>
      dispatcher.query('core.summary.get', params, queryOptions),
    );
    if (context.legacyResult === undefined)
      throw new Error('Summary projection was not captured.');
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryFileTreeRootsForLegacyIpc = async (
    params: WorkerFilesystemRootsListParams,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemRootsListResult;
    legacyResult: FileTreeRootsResponse;
  }> => {
    const context: RootsProjectionContext = {
      kind: 'roots',
      ...(route && { route }),
    };
    const canonicalResult = await projectionContext.run(context, () =>
      dispatcher.query('worker.filesystem.roots.list', params, queryOptions),
    );
    if (context.legacyResult === undefined) {
      throw new Error('Filesystem roots projection was not captured.');
    }
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryFileTreeDirectoryForLegacyIpc = async (
    params: WorkerFilesystemDirectoryListParams,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemDirectoryListResult;
    legacyResult: FileTreeDirectoryResponse;
  }> => {
    const context: DirectoryProjectionContext = {
      kind: 'directory',
      ...(route && { route }),
    };
    const canonicalResult = await projectionContext.run(context, () =>
      dispatcher.query(
        'worker.filesystem.directory.list',
        params,
        queryOptions,
      ),
    );
    if (context.legacyResult === undefined) {
      throw new Error('Filesystem directory projection was not captured.');
    }
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryFileContentForLegacyIpc = async (
    request: DesktopFileContentRequest,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemFileReadResult | null;
    legacyResult: FileContentResponse;
  }> => {
    const { workspaceId: projectId, worktreeId } = request.scope;
    const missing = (): {
      canonicalResult: null;
      legacyResult: FileContentResponse;
    } => ({
      canonicalResult: null,
      legacyResult: missingFileContent(basename(request.absolutePath)),
    });
    const roots = await fileReadServices.getFileBrowserRoots(
      projectId,
      worktreeId,
    );
    const identity =
      request.file ??
      (await resolveLegacyFileReadIdentity(roots, request.absolutePath));
    if (identity === null) return missing();
    const context: FileReadProjectionContext = {
      roots: { projectId, worktreeId, value: roots },
      ...(route && { route }),
    };
    let canonicalResult: WorkerFilesystemFileReadResult;
    try {
      canonicalResult = await fileReadProjectionContext.run(context, () =>
        dispatcher.query(
          'worker.filesystem.file.read',
          {
            scope: request.scope,
            fileRootId: identity.fileRootId,
            relativePath: identity.relativePath,
            maxBytes: LEGACY_FILE_CONTENT_MAX_BYTES,
          },
          queryOptions,
        ),
      );
    } catch (error) {
      if (
        error instanceof CanopyOperationError &&
        error.payload.code === 'worker.filesystem.file.notFound'
      )
        return missing();
      throw error;
    }
    if (!context.read)
      throw new Error('File read projection was not captured.');
    return {
      canonicalResult,
      legacyResult: projectLegacyFileContent(context.read),
    };
  };
  /**
   * One root of `file-index:get`: pages at the largest limit until the walk
   * ends or the root's share of its purpose's entry cap is reached, then
   * releases the rest of the walk.
   */
  const indexRootForLegacyIpc = async (
    request: FileIndexRequest,
    root: FileBrowserRoot,
    fileIndexing: FileIndexingPreferences,
    cap: number,
    queryOptions: CanopyQueryOptions,
    route: FileSearchProjectionContext['route'],
  ): Promise<RepoFileIndex> => {
    const explorer = request.purpose === 'file-explorer';
    const context: FileSearchProjectionContext = {
      ...(route && { route }),
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      root,
      fileIndexing,
      page: null,
    };
    const files: FileIndexEntry[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const result = await fileSearchProjectionContext.run(context, () =>
        dispatcher.query(
          'worker.filesystem.search',
          {
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
            },
            fileRootId: root.repoId,
            query: '',
            mode: 'name',
            purpose: explorer ? 'file-explorer' : 'mentions',
            limit: Math.min(
              WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
              cap - files.length,
            ),
            ...(cursor !== undefined && { cursor }),
          },
          queryOptions,
        ),
      );
      const page = context.page;
      context.page = null;
      if (page?.files.length !== result.matches.length)
        throw new Error('File search projection was not captured.');
      result.matches.forEach((match, index) => {
        const walked = page.files[index];
        if (walked?.relativePath !== match.path)
          throw new Error('File search projection does not match its page.');
        files.push({
          relativePath: match.path,
          filename: match.name,
          absolutePath: walked.absolutePath,
          isIgnored: match.isIgnored,
        });
      });
      truncated = result.truncated;
      if (result.nextCursor === null) break;
      if (files.length >= cap) {
        // A daemon cursor is not this engine's; its walk idles out there.
        if (route?.walk.backend !== 'daemon')
          searchEngine.release(result.nextCursor);
        break;
      }
      cursor = result.nextCursor;
    }
    return {
      repoId: root.repoId,
      repoName: root.repoName,
      absolutePath: root.absolutePath,
      rootKind: root.rootKind,
      files,
      truncated,
    };
  };
  const indexForLegacyIpc = async (
    request: FileIndexRequest,
    queryOptions: CanopyQueryOptions,
    route: FileSearchProjectionContext['route'],
  ): Promise<FileIndexResponse> => {
    const [{ roots }, fileIndexing] = await Promise.all([
      fileSearchServices.getFileBrowserRoots(
        request.projectId,
        request.worktreeId,
      ),
      fileSearchServices.readFileIndexingPreferences(),
    ]);
    const cap = fileIndexEntriesPerRoot(request.purpose, roots.length);
    return {
      repos: await Promise.all(
        roots.map((root) =>
          indexRootForLegacyIpc(
            request,
            root,
            fileIndexing,
            cap,
            queryOptions,
            route,
          ),
        ),
      ),
    };
  };
  const queryFileIndexForLegacyIpc = async (
    request: FileIndexRequest,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<FileIndexResponse> => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    // Decided once per index, before its first page: every root and cursor
    // stays on this backend, in the walk's own coalescing lane.
    const scope = {
      workspaceId: request.projectId,
      worktreeId: request.worktreeId,
    };
    const walk =
      route && options.daemonFilesRoute
        ? {
            request: route,
            walk: options
              .daemonFilesRoute()
              .searchWalk(scope, queryOptions.caller, route),
          }
        : undefined;
    const build = (): Promise<FileIndexResponse> =>
      indexForLegacyIpc(request, queryOptions, walk).catch((error: unknown) => {
        // Retained direct callers can join this walk, so it fails with the
        // walk's own error, as their direct walk would.
        throw error instanceof CanopyOperationError &&
          error.runtimeCause instanceof Error
          ? error.runtimeCause
          : error;
      });
    return coalesceFileIndexBuild(
      request,
      undefined,
      build,
      walk?.walk.lane ?? undefined,
    );
  };
  const queryLinkResolveForLegacyIpc = async (
    request: DesktopLinkResolveRequest,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemLinkResolveResult | null;
    legacyResult: FileReferenceResolveResponse;
  }> => {
    const { workspaceId: projectId, worktreeId } = request.scope;
    const roots = await fileReadServices.getFileBrowserRoots(
      projectId,
      worktreeId,
    );
    const base =
      request.mode === 'markdown' && request.baseFilePath !== undefined
        ? projectLinkBase(roots, request.baseFilePath)
        : null;
    const context: FileReadProjectionContext = {
      roots: { projectId, worktreeId, value: roots },
      ...(route && { route }),
      ...(base?.kind === 'host' && { linkHostBase: base.absolutePath }),
    };
    let canonicalResult: WorkerFilesystemLinkResolveResult;
    try {
      canonicalResult = await fileReadProjectionContext.run(context, () =>
        dispatcher.query(
          'worker.filesystem.link.resolve',
          {
            scope: request.scope,
            mode: request.mode,
            href: request.href,
            ...(base?.kind === 'root' && {
              base: {
                fileRootId: base.fileRootId,
                relativePath: base.relativePath,
              },
            }),
          },
          queryOptions,
        ),
      );
    } catch (error) {
      if (isUnresolvedLink(error))
        return { canonicalResult: null, legacyResult: null };
      throw error;
    }
    const resolved = context.link;
    if (!resolved)
      throw new Error('Link resolution projection was not captured.');
    return {
      canonicalResult,
      legacyResult: {
        // Authorized by real paths, addressed through the root's spelling.
        absolutePath: join(
          resolved.rootAbsolutePath,
          ...canonicalResult.relativePath.split('/'),
        ),
        filename: canonicalResult.name,
        kind: canonicalResult.kind,
      },
    };
  };
  const queryWorkspaceListForLegacyIpc = async (
    params: CanopyQueryParams<'core.workspace.list'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.list'> | null;
    legacyResult: SidebarItemsFile;
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.workspace.list', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.sidebar),
      );
    if (!context.sidebar)
      throw new Error('Workspace list projection was not captured.');
    return {
      canonicalResult,
      legacyResult: context.sidebar,
      ...(context.sidebarDetail
        ? { legacyAuthority: context.sidebarDetail }
        : {}),
    };
  };
  const queryWorkspaceGetForLegacyIpc = async (
    params: CanopyQueryParams<'core.workspace.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.get'> | null;
    legacyResult: WorkspaceConfigFile;
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.workspace.get', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.config),
      );
    if (!context.config)
      throw new Error('Workspace projection was not captured.');
    return {
      canonicalResult,
      legacyResult: context.config,
      ...(context.configDetail
        ? { legacyAuthority: context.configDetail }
        : {}),
    };
  };
  const queryWorktreeListForLegacyIpc = async (
    params: CanopyQueryParams<'core.worktree.list'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.list'> | null;
    legacyResult: SidebarItemsFile | WorktreeData[];
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.worktree.list', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.worktrees ?? context.sidebar),
      );
    const legacyResult = context.worktrees ?? context.sidebar;
    if (!legacyResult)
      throw new Error('Worktree list projection was not captured.');
    const legacyAuthority = context.worktrees
      ? context.worktreesDetail
      : context.sidebarDetail;
    return {
      canonicalResult,
      legacyResult,
      ...(legacyAuthority ? { legacyAuthority } : {}),
    };
  };
  const queryWorktreeGetForLegacyIpc = async (
    params: CanopyQueryParams<'core.worktree.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.get'> | null;
    legacyResult: WorktreeData;
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.worktree.get', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.worktree),
      );
    if (!context.worktree)
      throw new Error('Worktree projection was not captured.');
    return {
      canonicalResult,
      legacyResult: context.worktree,
      ...(context.worktreeDetail
        ? { legacyAuthority: context.worktreeDetail }
        : {}),
    };
  };
  let shuttingDown = false;
  // The kernel admits queries until its final phase; legacy IPC stops at shutdown.
  const refuseOnceShuttingDown =
    <Args extends unknown[], Result>(
      read: (...args: Args) => Promise<Result>,
    ): ((...args: Args) => Promise<Result>) =>
    (...args) =>
      shuttingDown ? Promise.reject(canopyUnavailableError()) : read(...args);
  const desktopDispatcher: DesktopCanopyDispatcher = Object.assign(dispatcher, {
    isShuttingDown: (): boolean => shuttingDown,
    localWorker,
    scriptRuns,
    helperRuns,
    signInRuns,
    catalogMaterializations,
    catalogMaterializationReader: workerCatalogAdapter.reader,
    appAdvisorActions,
    waitForOperation: (operationId: string, signal?: AbortSignal) =>
      operationAdapter.service.waitForTerminal(operationId, signal),
    summarySchedule,
    deferredToolReloads,
    chatTurnRuns,
    subagentRuns,
    interfaceTools,
    initiatedWork,
    hookChatClaims,
    hookQueue,
    pipelineRuns,
    pipelineHostRequests,
    queryWorkspaceListForLegacyIpc: refuseOnceShuttingDown(
      queryWorkspaceListForLegacyIpc,
    ),
    queryWorkspaceGetForLegacyIpc: refuseOnceShuttingDown(
      queryWorkspaceGetForLegacyIpc,
    ),
    shutdown: async (): Promise<void> => {
      shuttingDown = true;
      releaseLocalGitMutationDispatcher();
      deferredToolReloads.close();
      setDeferredToolReloads(null);
      if (activeDesktopRuntime === desktopDispatcher)
        activeDesktopRuntime = null;
      chatEventsAdapter.closeLegacy();
      chatEventReplay.dispose();
      legacyEvents.length = 0;
      workspaceReadSnapshots.close();
      setSessionInterfaceToolRegistry(null);
      interfaceTools.close();
      // An open stream is an active call that shutdown would wait out.
      closeFileTreeWatchesForLegacyIpc();
      (await stopSettlingHostRequests)?.();
      await runtime.shutdown('desktop');
      // Unfinished work stays recorded; the next launch reconciles it.
      operationAdapter.close();
    },
    queryChatStateForLegacyIpc: refuseOnceShuttingDown(
      queryChatStateForLegacyIpc,
    ),
    querySummaryForLegacyIpc: refuseOnceShuttingDown(querySummaryForLegacyIpc),
    queryWorktreeListForLegacyIpc: refuseOnceShuttingDown(
      queryWorktreeListForLegacyIpc,
    ),
    queryWorktreeGetForLegacyIpc: refuseOnceShuttingDown(
      queryWorktreeGetForLegacyIpc,
    ),
    openChatEventsForLegacyIpc: refuseOnceShuttingDown(
      openChatEventsForLegacyIpc,
    ),
    takeChatEventForLegacyIpc,
    closeChatEventsForLegacyIpc: (): void => {
      chatEventsAdapter.closeLegacy();
      legacyEvents.length = 0;
    },
    openFileTreeWatchForLegacyIpc: refuseOnceShuttingDown(
      openFileTreeWatchForLegacyIpc,
    ),
    openGitHeadWatchForBranchObserver: refuseOnceShuttingDown(
      (
        params: Pick<WorkerFilesystemWatchParams, 'scope' | 'fileRootId'>,
        streamOptions: Parameters<
          DesktopCanopyDispatcher['openGitHeadWatchForBranchObserver']
        >[1],
      ) =>
        openFileTreeWatchForLegacyIpc(
          { ...params, subject: 'gitHead' },
          streamOptions,
        ),
    ),
    closeFileTreeWatchesForLegacyIpc,
    queryFileTreeRootsForLegacyIpc: refuseOnceShuttingDown(
      queryFileTreeRootsForLegacyIpc,
    ),
    queryFileTreeDirectoryForLegacyIpc: refuseOnceShuttingDown(
      queryFileTreeDirectoryForLegacyIpc,
    ),
    queryFileContentForLegacyIpc: refuseOnceShuttingDown(
      queryFileContentForLegacyIpc,
    ),
    queryFileIndexForLegacyIpc: refuseOnceShuttingDown(
      queryFileIndexForLegacyIpc,
    ),
    queryLinkResolveForLegacyIpc: refuseOnceShuttingDown(
      queryLinkResolveForLegacyIpc,
    ),
    deleteFileTreeEntryForLegacyIpc: refuseOnceShuttingDown(
      (
        request: Extract<FileTreeMutationRequest, { operation: 'delete' }>,
        deleteOptions: { caller: CanopyCallerDescriptor },
      ) =>
        deleteFileTreeEntryForLegacyIpc(
          (params, instructionOptions) =>
            dispatcher.instruction(
              'worker.filesystem.entry.delete',
              params,
              instructionOptions,
            ),
          entryMutationHost,
          request,
          deleteOptions,
        ),
    ),
    transferFileTreeEntryForLegacyIpc: refuseOnceShuttingDown(
      (
        request: Extract<
          FileTreeMutationRequest,
          { operation: 'copy' | 'move' }
        >,
        transferOptions: { caller: CanopyCallerDescriptor },
      ) =>
        transferFileTreeEntryForLegacyIpc(
          {
            copy: (params, instructionOptions) =>
              dispatcher.instruction(
                'worker.filesystem.entry.copy',
                params,
                instructionOptions,
              ),
            move: (params, instructionOptions) =>
              dispatcher.instruction(
                'worker.filesystem.entry.move',
                params,
                instructionOptions,
              ),
          },
          entryMutationHost,
          request,
          transferOptions,
        ),
    ),
    createFileTreeEntryForLegacyIpc: refuseOnceShuttingDown(
      (
        request: Extract<
          FileTreeMutationRequest,
          { operation: 'create-file' | 'create-directory' }
        >,
        createOptions: { caller: CanopyCallerDescriptor },
      ) =>
        createFileTreeEntryForLegacyIpc(
          {
            file: (params, instructionOptions) =>
              dispatcher.instruction(
                'worker.filesystem.file.write',
                params,
                instructionOptions,
              ),
            directory: (params, instructionOptions) =>
              dispatcher.instruction(
                'worker.filesystem.directory.create',
                params,
                instructionOptions,
              ),
          },
          entryMutationHost,
          request,
          createOptions,
        ),
    ),
    saveTextFileForLegacyIpc: refuseOnceShuttingDown(
      (
        save: LegacyTextFileSave,
        saveOptions: { caller: CanopyCallerDescriptor },
      ) =>
        saveTextFileForLegacyIpc(
          (params, instructionOptions) =>
            dispatcher.instruction(
              'worker.filesystem.file.write',
              params,
              instructionOptions,
            ),
          entryMutationHost,
          save,
          saveOptions,
        ),
    ),
    queryChatTranscriptPageForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatTranscriptPageParams,
        queryOptions: CanopyQueryOptions,
      ): Promise<{
        canonicalResult: CoreChatTranscriptPageResult;
        legacyResult: TranscriptPage;
      }> => {
        const context: ChatReadProjectionContext = {};
        const canonicalResult = await chatReadProjectionContext.run(
          context,
          () =>
            dispatcher.query('core.chat.transcript.page', params, queryOptions),
        );
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('messages' in legacyResult))
          throw new Error('Chat transcript page projection was not captured.');
        return { canonicalResult, legacyResult };
      },
    ),
    queryChatTranscriptSearchForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatTranscriptSearchParams,
        queryOptions: CanopyQueryOptions,
        requestId?: string,
      ): Promise<{
        canonicalResult: CoreChatTranscriptSearchResult;
        legacyResult: ChatTranscriptSearchResult;
      }> => {
        const context: ChatReadProjectionContext = { requestId };
        const canonicalResult = await chatReadProjectionContext.run(
          context,
          () =>
            dispatcher.query(
              'core.chat.transcript.search',
              params,
              queryOptions,
            ),
        );
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('matches' in legacyResult))
          throw new Error(
            'Chat transcript search projection was not captured.',
          );
        return { canonicalResult, legacyResult };
      },
    ),
    queryChatToolOutputForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatToolOutputReadParams,
        queryOptions: CanopyQueryOptions,
        requestId?: string,
      ): Promise<{
        canonicalResult: CoreChatToolOutputReadResult;
        legacyResult: ChatToolOutputResponse;
      }> => {
        const context: ChatReadProjectionContext = { requestId };
        let canonicalResult: CoreChatToolOutputReadResult;
        try {
          canonicalResult = await chatReadProjectionContext.run(context, () =>
            dispatcher.query('core.chat.toolOutput.read', params, queryOptions),
          );
        } catch (error) {
          if (context.toolOutputRead) {
            const legacyResult = await context.toolOutputRead;
            return { canonicalResult: legacyResult, legacyResult };
          }
          throw error;
        }
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('text' in legacyResult))
          throw new Error('Chat tool output projection was not captured.');
        return { canonicalResult, legacyResult };
      },
    ),
  });
  setDeferredToolReloads(deferredToolReloads);
  catalogDispatcher = desktopDispatcher;
  lifecycleEffects.dispatcher = desktopDispatcher;
  activeDesktopRuntime = desktopDispatcher;
  const releaseLocalGitMutationDispatcher =
    registerLocalGitMutationDispatcher(desktopDispatcher);
  return desktopDispatcher;
}
