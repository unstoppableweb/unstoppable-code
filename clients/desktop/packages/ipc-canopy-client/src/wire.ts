/**
 * The parts of desktop IPC request and reply shapes this adapter reads or
 * writes. Each is a structural subset of the desktop type named beside it
 * (`@canopy/desktop-shared/types`), which this browser-safe package cannot
 * import; the golden test checks these stay assignable. Replies are decoded
 * at the transport boundary (`./decoders`) before any field is read.
 */
import type { CodexSpeed } from '@canopy/protocol/automations';
import type { ThinkingLevel } from '@canopy/protocol/thinking';

/** `SidebarItem`: one entry of `projects:load` (`ProjectsFile.items`). */
export interface WireSidebarItem {
  readonly id: string;
  readonly type: string;
  readonly repoPath?: string;
  readonly worktrees?: readonly WireWorktreeRef[];
  readonly [field: string]: unknown;
}

export interface WireWorktreeRef {
  readonly id: string;
  readonly createdAt?: string;
  /** Hook keys paused for this worktree (`WorktreeData.pausedHookKeys`). */
  readonly pausedHookKeys?: readonly string[];
}

/** `ProjectsFile`. */
export interface WireProjectsFile {
  readonly items: readonly WireSidebarItem[];
}

/** `FileTreeRoot`. */
export interface WireFileTreeRoot {
  readonly repoId: string;
  readonly repoName: string;
  readonly absolutePath: string;
}

/** `FileTreeRootsResponse`. */
export interface WireFileTreeRoots {
  readonly roots: readonly WireFileTreeRoot[];
}

/** `FileTreeDirectoryResponse`. */
export interface WireFileTreeDirectory {
  readonly entries: readonly {
    readonly name: string;
    readonly relativePath: string;
    readonly kind: 'file' | 'directory';
  }[];
}

/** `FileIndexResponse`. */
export interface WireFileIndex {
  readonly repos: readonly {
    readonly repoId: string;
    readonly truncated?: boolean;
    readonly files: readonly { readonly relativePath: string }[];
  }[];
}

/** `ReadFileContentResponse`. */
export interface WireFileContent {
  readonly kind: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly truncated: boolean;
  readonly canonical?: {
    readonly fileRootId: string;
    readonly sizeBytes: number;
    readonly version: string;
    readonly truncated: boolean;
    readonly modifiedAt: string;
  };
}

/** `SaveFileContentResponse`. */
export interface WireFileSaved {
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

/** `ResolveFileReferenceResponse` (nullable). */
export interface WireFileReference {
  readonly canonical?: {
    readonly kind: string;
    readonly fileRootId?: string;
    readonly relativePath?: string;
  };
}

/** `ActivityFileDiffResponse`. */
export interface WireFileDiff {
  readonly oldValue: string;
  readonly newValue: string;
  readonly filePath: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

/** `TrackedPlanSource`. */
export type WireTrackedPlanSource =
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | 'cursor'
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'pipeline'
  | 'imported'
  | 'detected';

/** `TrackedPlanReviewStatus`. */
export type WireTrackedPlanReviewStatus = 'pending' | 'approved' | 'dismissed';

/** `TrackedPlanData`. */
export interface WireTrackedPlan {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly source: string;
  readonly title: string;
  readonly content: string;
  readonly reviewStatus: string;
  readonly updatedAt: string;
  readonly latestRevisionNumber: number;
  readonly approvedAt?: string;
  readonly dismissedAt?: string;
  readonly hidden?: boolean;
  readonly revisions: readonly {
    readonly revisionNumber: number;
    readonly content: string;
    readonly source: string;
    readonly reviewStatus: string;
    readonly approvedAt?: string;
    readonly dismissedAt?: string;
  }[];
}

/** `UpdateTrackedPlanRequest`. */
export interface WireUpdateTrackedPlanRequest {
  projectId: string;
  worktreeId: string;
  planId: string;
  content?: string;
  title?: string;
  source?: WireTrackedPlanSource;
  reviewStatus?: WireTrackedPlanReviewStatus;
  linkedExecutionId?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
}

/** `ScriptRunRequest`. */
export type WireScriptRunRequest =
  | {
      target: 'project';
      scriptName: string;
      projectId: string;
      worktreeId: string;
    }
  | {
      target: 'workspace-root';
      scriptName: string;
      workspaceId: string;
      worktreeId: string;
    }
  | {
      target: 'workspace-repo';
      scriptName: string;
      workspaceId: string;
      worktreeId: string;
      repoId: string;
    };

/** `HookRunRequest`. */
export type WireHookRunRequest =
  | {
      target: 'project';
      triggerName: string;
      projectId: string;
      worktreeId: string;
    }
  | {
      target: 'workspace-root';
      triggerName: string;
      workspaceId: string;
      worktreeId: string;
    }
  | {
      target: 'workspace-repo';
      triggerName: string;
      workspaceId: string;
      worktreeId: string;
      repoId: string;
    };

/** `AgentModelConfig` (the fields a Portal pipeline run carries). */
export interface WireAgentModelConfig {
  thinkingLevel?: ThinkingLevel;
  speed?: CodexSpeed;
  fastMode?: boolean;
}

/** `ChatCommandResult`. */
export interface WireChatCommandResult {
  readonly outcome: string;
  readonly reason?: string;
  readonly commandId?: string;
  readonly revision?: number;
  readonly entityId?: string;
  readonly messageId?: string;
}

/** `ChatCancelResult`. */
export interface WireChatCancelResult {
  readonly resumableTurn?: { readonly userMessageId: string };
  readonly outcome?: 'stop_requested' | 'turn_not_active';
}

/** `ChatStateSnapshot` fields a tab close and the Orchestrator read (`chat:get-state`). */
export interface WireChatState {
  readonly tabsFile: {
    readonly activeTabId?: string;
    readonly tabs: readonly {
      readonly id: string;
      readonly kind?: string;
      readonly title?: string;
      readonly customTitle?: string;
      readonly createdAt?: string;
      readonly archivedAt?: string;
      readonly model?: string;
      readonly providerType?: string;
      readonly executionHarness?: string;
      readonly messages?: readonly unknown[];
      readonly transcript?: {
        readonly messageCount?: number;
        readonly committedMessageCount?: number;
      };
      readonly pendingPlanExit?: unknown;
    }[];
  };
  readonly runtimeByChatId?: Readonly<
    Record<
      string,
      {
        readonly status?: string;
        readonly queuedMessageIds?: readonly string[];
      }
    >
  >;
}

/** One `ModelRegistrySnapshot` provider row (`model-registry:get`). */
export interface WireModelRegistryEntry {
  readonly id: string;
}

/** `ModelRegistrySnapshot` fields a model's provider is read from. */
export interface WireModelRegistry {
  readonly claude?: readonly WireModelRegistryEntry[];
  readonly codex?: readonly WireModelRegistryEntry[];
  readonly ollama?: readonly WireModelRegistryEntry[];
  readonly cursor?: readonly WireModelRegistryEntry[];
  readonly copilot?: readonly WireModelRegistryEntry[];
  readonly antigravity?: readonly WireModelRegistryEntry[];
  readonly opencode?: readonly WireModelRegistryEntry[];
  /** Custom Agents run on their base model's provider. */
  readonly agents?: readonly {
    readonly id: string;
    readonly baseModel: string;
  }[];
  readonly aliases?: Readonly<Record<string, string>>;
}

/** `CoworkWorkEntryCreateResponse` (`work-entries:create`). */
export interface WireCreatedWorkEntry {
  readonly entry: { readonly id: string };
}

/** `CoworkWorkEntryMeta` fields the Orchestrator reads (`work-entries:list`). */
export interface WireWorkEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly lastMessageAt?: string;
  readonly providerType?: string;
  readonly hasActiveChat?: boolean;
  readonly unreadChats?: readonly { readonly chatId: string }[];
}

/** `CoworkWorkEntryListResponse`. */
export interface WireWorkEntryList {
  readonly entries: readonly WireWorkEntry[];
}

/** `ChatSendMessageResult` fields a send reads (`chat:send-message`). */
export interface WireChatSendResult {
  readonly disposition?: string;
  readonly refusedAuthDependencies?: unknown;
}

/** `editor:resolve-invocable` (`EditorResolveInvocableResult`). */
export interface WireResolvedInvocable {
  readonly insertText: string;
  readonly invocationKey: string;
  readonly enable?: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly tabId: string;
    readonly pluginSelections: Readonly<Record<string, unknown>>;
    readonly expectedPluginSelections: Readonly<Record<string, unknown>>;
  };
}

/** An `app-advisor:tool-request` push (`AppAdvisorRendererToolRequest`). */
export interface WireAppAdvisorToolRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly chatId?: string;
  readonly question?: Readonly<Record<string, unknown>>;
  readonly originChatTabId?: string;
  readonly payload?: unknown;
}

/** An `app-advisor:tool-request-cancelled` push. */
export interface WireAppAdvisorToolCancellation {
  readonly requestId: string;
  readonly originChatId?: string;
}

/** `app-advisor:watcher-delete` reply. */
export interface WireWatcherDeleteResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** `script:read-run-log` reply (`ScriptRunLogResponse`). */
export interface WireScriptRunLog {
  readonly lines: readonly string[];
}

/** `hook:change-pause` reply (`HookPauseChangeResponse`). */
export interface WireHookPauseResult {
  readonly ok: boolean;
  readonly pausedHookKeys?: readonly string[];
  readonly error?: string;
}

/** `app-advisor:settings-patch` reply (`AppAdvisorSettingsPatchResponse`). */
export interface WireSettingsPatchResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** `IPCResult<T>` from the pipeline channels. */
export interface WireIpcResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

/** `PipelineInfo`. */
export interface WirePipelineInfo {
  readonly id: string;
  readonly filePath?: string;
}

/** `PipelineData`. */
export interface WirePipelineData {
  readonly content: string;
}

/** The created worktree from `worktree:create` / `workspace:create-worktree`. */
export interface WireCreatedWorktree {
  readonly id: string;
  readonly branchName: string;
  readonly needsRepair?: boolean;
}

/** `WorktreeRepoEntry`. */
export interface WireWorktreeRepoEntry {
  readonly repoId: string;
  readonly repoName: string;
}

/** `CommitAndPushResponse`. */
export interface WireCommitAndPushResponse {
  readonly failedRepos: readonly {
    readonly repoName: string;
    readonly error: string;
  }[];
  readonly agentResolutionRepos: readonly {
    readonly repoName: string;
    readonly kind: string;
  }[];
}

/** `TurnFeedbackRateResponse`. */
export interface WireTurnFeedbackRated {
  readonly feedbackId?: string;
}

/**
 * `{ id, scriptActionsOperationId? }` of the workspace
 * `workspace:add-from-remote` created; the operation is the post-add script
 * scan, as the Portal reply carries it.
 */
export interface WireAddedWorkspace {
  readonly id: string;
  readonly scriptActionsOperationId?: string;
}

/** `Preferences` fields the adapter reads. */
export interface WirePreferences {
  readonly __error?: unknown;
  readonly onboardingTipsDismissed?: unknown;
  readonly suggestions?: unknown;
  readonly [field: string]: unknown;
}
