/**
 * The portable `CanopyClient` over desktop IPC channels.
 *
 * Extracted from the desktop renderer adapter, which called the preload's
 * typed `window.api.*` methods. Every operation now names the channel and
 * arguments the preload method sent (`@canopy/protocol/remote-control`
 * `REMOTE_IPC_CHANNELS`), so the same adapter runs over the desktop preload,
 * a browser direct-control session or a hosted session. Renderer stores and
 * helpers became {@link IpcCanopyClientPorts}.
 *
 * Each query, command and domain event dispatches through an exhaustive,
 * typed handler table, which keeps the generic methods sound without casts.
 * `REMOTE_QUERY_CHANNELS` / `REMOTE_COMMAND_CHANNELS` / `REMOTE_EVENT_CHANNELS`
 * record every channel each handler may use, including its conditional
 * branches; the golden test holds the two together.
 *
 * Operations without a faithful channel mapping reject with
 * `UnsupportedOperationError` (see the parity map in
 * `docs/planning/2026-11-07-web-remote-control-direct/parity-map.md`).
 */
import {
  OrganizationOperationFailure,
  FileSaveConflictError,
  type CanopyCapabilities,
  type CanopyClient,
  type ChatTabSettings,
  type CommandMap,
  type CommandName,
  type DomainEventMap,
  type DomainEventName,
  type QueryMap,
  type QueryName,
  type ShellCommandName,
  type ShellQueryName,
  type SubscriptionFilter,
  type Unsubscribe,
} from '@canopy/app-core';
import type { MarketplaceSourcesClient } from '@canopy/app-core/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { TranscriptReadClient } from '@canopy/app-core';
import {
  extractIpcErrorMessage,
  extractIpcErrorName,
} from '@canopy/protocol/app-errors/ipc-rejection';
import {
  CORE_SHARED_MULTI_REPO_INSTRUCTIONS,
  CORE_SHARED_MULTI_REPO_QUERIES,
} from '@canopy/protocol/canopy-core';
import {
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/protocol/chat-targets';
import type { FeedbackReportClient } from '@canopy/protocol/feedback-report';
import type {
  PreparedSharedMultiRepo,
  SharedMultiRepoCreationStatus,
} from '@canopy/protocol/org-projects';
import {
  normalizeOnboardingTipDismissals,
  type OnboardingTipDismissals,
} from '@canopy/protocol/onboarding-tips';
import {
  OrganizationInviteResultSchema,
  OrganizationInviteStatusSchema,
  OrganizationOperationRefusalSchema,
  PersonalOrganizationPromotionOutcomeSchema,
  PersonalProjectListSchema,
  PersonalProjectOperationSchema,
} from '@canopy/protocol/organizations';
import type {
  PortalAppAdvisorSettings,
  PortalDirectoryListing,
  PortalFileIndex,
  PortalFileMutationResult,
  PortalFilePreview,
  PortalFileReadPayload,
  PortalFileRoot,
} from '@canopy/protocol/portal';
import {
  REMOTE_IPC_CHANNELS as C,
  type RemoteIpcChannel,
} from '@canopy/protocol/remote-control/channels';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import {
  isScriptActionsAddReceipt,
  isScriptActionsContext,
  isScriptActionsSnapshot,
  type ScriptActionsAddReceipt,
} from '@canopy/protocol/script-actions';
import {
  parseSuggestionsState,
  type SuggestionsState,
} from '@canopy/protocol/suggestions';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  createChannelClient,
  UnsupportedOperationError,
  type ChannelClient,
  type Decoder,
} from './channel-client';
import { readChatHistory } from './chat-history';
import { createChatEventSource, subscribeChatMessages } from './chat-messages';
import { createWorktreeActivityHandlers } from './worktree-activity';
import {
  anyPayload,
  anyReply,
  arrayReply,
  isNullableString,
  isOrgProjectCatalogSnapshot,
  isOrgProjectSetupProgress,
  isRecord,
  isString,
  isWorkspaceContextBroadcast,
  isWorkspaceContextState,
  nullableRecordReply,
  recordReply,
  recordWith,
  recordWithArray,
  reply,
  type CatalogSnapshot,
} from './decoders';
import { readFileDiff } from './file-diff';
import type { IpcCanopyClientPorts } from './ports';
import {
  isActivitySectionId,
  joinRootPath,
  languageForPath,
  rootRelativeSegments,
  toAgentModelConfig,
  toHookRunRequest,
  toRequestedPortalPlanDetail,
  toScriptRunRequest,
  toUpdateTrackedPlanRequest,
  versionFrom,
} from './projections';
import { createShellCommandHandlers } from './shell-commands';
import { createTerminalHandlers } from './terminal';
import type {
  WireAddedWorkspace,
  WireChatCommandResult,
  WireCommitAndPushResponse,
  WireCreatedWorktree,
  WireFileContent,
  WireFileIndex,
  WireFileReference,
  WireFileSaved,
  WireFileTreeDirectory,
  WireFileTreeRoot,
  WireFileTreeRoots,
  WireIpcResult,
  WirePipelineData,
  WirePipelineInfo,
  WirePreferences,
  WireSettingsPatchResult,
  WireProjectsFile,
  WireSidebarItem,
  WireTrackedPlan,
  WireTurnFeedbackRated,
  WireWorktreeRepoEntry,
} from './wire';

type QueryHandlers = {
  [K in QueryName]: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};
type CommandHandlers = {
  [K in CommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};
type TerminalHandlers = ReturnType<typeof createTerminalHandlers>;
type SubscribeHandlers = {
  [K in DomainEventName]: (
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
};

const isProjectsFile = reply<WireProjectsFile>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.type === 'string',
    ),
);
const isFileTreeRoots = recordWithArray<WireFileTreeRoots>('roots');
const isFileTreeDirectory = recordWithArray<WireFileTreeDirectory>('entries');
const isFileIndex = recordWithArray<WireFileIndex>('repos');
const isFileContent = reply<WireFileContent>(
  (value) =>
    isRecord(value) &&
    typeof value.kind === 'string' &&
    (value.kind !== 'text' || typeof value.content === 'string'),
);
const isFileSaved = recordWith<WireFileSaved>('sizeBytes', 'modifiedAtMs');
const isPreferences = recordReply<WirePreferences>();
const isAppAdvisorSettings = reply<PortalAppAdvisorSettings | null>(
  (value) =>
    value === null ||
    (isRecord(value) &&
      typeof value.model === 'string' &&
      typeof value.instructions === 'string' &&
      Array.isArray(value.availableModels)),
);
const isSettingsPatchResult = recordWith<WireSettingsPatchResult>('ok');
const isChatCommandResult = recordWith<WireChatCommandResult>('outcome');
const isCreatedWorktree = recordWith<WireCreatedWorktree>('id');
const isCommitAndPush = reply<WireCommitAndPushResponse>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.failedRepos) &&
    Array.isArray(value.agentResolutionRepos),
);
function isIpcResult<T>(): Decoder<WireIpcResult<T>> {
  return recordWith<WireIpcResult<T>>('success');
}

/** The preload's `organizationReply` and the renderer's typed refusal, merged. */
function organizationReply<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  const refused = OrganizationOperationRefusalSchema.safeParse(value);
  if (refused.success) {
    throw new OrganizationOperationFailure(
      refused.data.error,
      refused.data.code,
      refused.data.status,
    );
  }
  return schema.parse(value);
}

/**
 * Shared review UI renders these messages and matches "Scan again", so
 * Electron's `Error invoking remote method …` wrapper must not reach it.
 */
async function unwrapIpcError<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw new Error(extractIpcErrorMessage(error));
  }
}

const noopUnsubscribe: Unsubscribe = (): void => {
  // Nothing to tear down: the default connection status never changes.
};

/** Script action replies carry `{ ok, value }` or a typed `{ ok: false, error }`. */
async function invokeScriptActions<T>(
  channels: ChannelClient,
  channel: RemoteIpcChannel,
  request: unknown,
  guard: (value: unknown) => value is T,
): Promise<T> {
  const raw = await channels.invoke(channel, anyReply<unknown>(), request);
  if (
    isRecord(raw) &&
    raw.ok === false &&
    isRecord(raw.error) &&
    typeof raw.error.code === 'string' &&
    typeof raw.error.message === 'string'
  ) {
    throw Object.assign(new Error(raw.error.message), {
      code: raw.error.code,
    });
  }
  if (!isRecord(raw) || raw.ok !== true || !guard(raw.value)) {
    throw new Error('Invalid script action response.');
  }
  return raw.value;
}

const isScriptActionsReceiptOrNull = (
  value: unknown,
): value is ScriptActionsAddReceipt | null =>
  value === null || isScriptActionsAddReceipt(value);

class PortableIpcCanopyClient implements CanopyClient {
  readonly capabilities: CanopyCapabilities;
  readonly transcripts?: TranscriptReadClient;
  readonly feedback?: FeedbackReportClient;
  readonly marketplaceSources?: MarketplaceSourcesClient;
  readonly settings?: AccountOrganizationSettingsClient;
  readonly sharedMultiRepo: NonNullable<CanopyClient['sharedMultiRepo']>;

  private readonly channels: ChannelClient;
  private readonly ports: IpcCanopyClientPorts;
  private readonly now: () => string;
  private readonly randomId: () => string;
  private readonly subscribeChatEvents: ReturnType<
    typeof createChatEventSource
  >;

  /**
   * Write-through cache of the last settings persisted per chat. The
   * `chat.getTabSettings` query carries only `chatId`, so the persisted
   * `ChatTabsFile` cannot be located from it; same-session reads come from
   * here and otherwise answer `null` ("nothing persisted yet").
   */
  private readonly sessionTabSettings = new Map<string, ChatTabSettings>();

  /**
   * Only during synchronous change delivery: store reloads consume the
   * host's already refreshed snapshot, while explicit refreshes still fetch.
   */
  private readonly orgProjectBroadcasts = new Map<string, CatalogSnapshot>();

  private readonly queryHandlers: QueryHandlers;
  private readonly commandHandlers: CommandHandlers;
  private readonly subscribeHandlers: SubscribeHandlers;

  constructor(transport: RemoteIpcTransport, ports: IpcCanopyClientPorts) {
    this.ports = ports;
    this.capabilities = ports.capabilities;
    this.channels = createChannelClient(transport, {
      ...(ports.authorizedChannels !== undefined
        ? { authorizedChannels: ports.authorizedChannels }
        : {}),
    });
    this.now = ports.now ?? ((): string => new Date().toISOString());
    this.randomId = ports.randomId ?? ((): string => crypto.randomUUID());
    this.subscribeChatEvents = createChatEventSource(this.channels, {
      ...(ports.requestChatEventOutputReset !== undefined
        ? { requestOutputReset: ports.requestChatEventOutputReset }
        : {}),
      ...(ports.chatEventsDecoded === true ? { decoded: true } : {}),
    });
    if (ports.transcripts) this.transcripts = ports.transcripts;
    if (ports.feedback) this.feedback = ports.feedback;
    if (ports.marketplaceSources) {
      this.marketplaceSources = ports.marketplaceSources;
    }
    if (ports.settings) this.settings = ports.settings;
    const channels = this.channels;
    this.sharedMultiRepo = {
      prepare: async (params): Promise<PreparedSharedMultiRepo> =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.prepare'
        ].result.parse(
          await channels.invoke(
            C.orgProjectsSharedMultiRepoPrepare,
            anyReply<unknown>(),
            params,
          ),
        ),
      create: async (params): Promise<SharedMultiRepoCreationStatus> =>
        CORE_SHARED_MULTI_REPO_INSTRUCTIONS[
          'core.workspace.sharedMultiRepo.create'
        ].result.parse(
          await channels.invoke(
            C.orgProjectsSharedMultiRepoCreate,
            anyReply<unknown>(),
            params,
          ),
        ),
      resume: async (creationKey): Promise<SharedMultiRepoCreationStatus> =>
        CORE_SHARED_MULTI_REPO_INSTRUCTIONS[
          'core.workspace.sharedMultiRepo.create'
        ].result.parse(
          await channels.invoke(
            C.orgProjectsSharedMultiRepoCreate,
            anyReply<unknown>(),
            { creationKey },
          ),
        ),
      getCreation: async (
        creationKey,
      ): Promise<SharedMultiRepoCreationStatus | null> =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.getCreation'
        ].result.parse(
          await channels.invoke(
            C.orgProjectsSharedMultiRepoGetCreation,
            anyReply<unknown>(),
            { creationKey },
          ),
        ),
      listCreations: async (): Promise<
        readonly SharedMultiRepoCreationStatus[]
      > =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.listCreations'
        ].result.parse(
          await channels.invoke(
            C.orgProjectsSharedMultiRepoListCreations,
            anyReply<unknown>(),
            { limit: 50 },
          ),
        ),
      catalog: (organizationId): Promise<CatalogSnapshot> =>
        channels.invoke(C.orgProjectsRefresh, isOrgProjectCatalogSnapshot, {
          context: { kind: 'organization', organizationId },
        }),
      cancelSetup: async (_organizationId, projectId): Promise<void> => {
        await channels.invokeVoid(C.orgProjectsSetupCancel, { projectId });
      },
    };
    const terminal = createTerminalHandlers(channels, {
      now: this.now,
      ...(ports.observeTerminalOutput !== undefined
        ? { observeOutput: ports.observeTerminalOutput }
        : {}),
    });
    const appAdvisorSurface =
      ports.appAdvisorTransport === undefined
        ? null
        : createChannelClient(ports.appAdvisorTransport, {
            ...(ports.authorizedChannels !== undefined
              ? { authorizedChannels: ports.authorizedChannels }
              : {}),
          });
    const activity = createWorktreeActivityHandlers(channels, this.now);
    const shell = createShellCommandHandlers({
      channels,
      appAdvisorSurface,
      randomId: this.randomId,
      now: this.now,
      activityChanged: activity.changed,
      ...(ports.uploadFile !== undefined
        ? { uploadFile: ports.uploadFile }
        : {}),
    });
    this.queryHandlers = {
      ...this.createQueryHandlers(terminal),
      ...shell.queries,
      'appAdvisor.chats': shell.orchestrator.query,
      'worktree.activity': activity.query,
    };
    this.commandHandlers = {
      ...this.createCommandHandlers(terminal),
      ...shell.commands,
      'chat.attachments.upload': shell.uploadAttachment,
    };
    this.subscribeHandlers = {
      ...this.createSubscribeHandlers(terminal),
      'appAdvisor.changed': (handler, filter): Unsubscribe =>
        shell.orchestrator.subscribe(handler, filter),
      'worktree.activityChanged': (handler, filter): Unsubscribe =>
        activity.subscribe(handler, filter),
    };
  }

  openExternalUrl(url: string): void {
    this.ports.openExternalUrl(url);
  }

  private log(message: string, error: unknown): void {
    this.ports.logError?.(message, { error });
  }

  private loadProjects(): Promise<WireProjectsFile> {
    return this.channels.invoke(C.projectsLoad, isProjectsFile);
  }

  private async loadWorkspace(workspaceId: string): Promise<WireSidebarItem> {
    const file = await this.loadProjects();
    const item = file.items.find((candidate) => candidate.id === workspaceId);
    if (!item) {
      throw new Error(`Project ${workspaceId} not found.`);
    }
    return item;
  }

  private invalidateSessionSnapshot(): Promise<void> {
    return this.channels.invokeVoid(C.desktopSessionSnapshotInvalidate);
  }

  /**
   * Resolve the file root a payload targets: a host-local override first
   * (renderer-owned, read-only roots), then the host's catalog roots.
   */
  private async resolveFileRoot(
    projectId: string,
    worktreeId: string,
    rootId: string | undefined,
  ): Promise<{ root: WireFileTreeRoot; catalog: boolean }> {
    if (!rootId) {
      throw new Error('Either repoId or fileRootLocalId must be set.');
    }
    const override = this.ports.resolveLocalFileRoot?.(rootId);
    if (override) return { root: override, catalog: false };
    const { roots } = await this.channels.invoke(
      C.fileTreeRoots,
      isFileTreeRoots,
      { projectId, worktreeId },
    );
    const root = roots.find((candidate) => candidate.repoId === rootId);
    if (!root) {
      throw new Error(`Unknown file root "${rootId}" for this worktree.`);
    }
    return { root, catalog: true };
  }

  private async loadPreferences(): Promise<WirePreferences> {
    const preferences = await this.channels.invoke(
      C.preferencesLoad,
      isPreferences,
      undefined,
    );
    if (preferences.__error) {
      throw new Error('Preferences could not be loaded.');
    }
    return preferences;
  }

  /**
   * Stored tip dismissals. A failed preferences load rejects, so shared tips
   * stay hidden instead of reappearing; so does a host built before tips.
   */
  private async loadOnboardingTipDismissals(): Promise<OnboardingTipDismissals> {
    const preferences = await this.loadPreferences();
    if (!('onboardingTipsDismissed' in preferences)) {
      throw new Error('This host does not store onboarding tip dismissals.');
    }
    return normalizeOnboardingTipDismissals(
      preferences.onboardingTipsDismissed,
    );
  }

  /** The master switch, dismissals and corner cap (CAN-4343). */
  private async loadSuggestionsState(): Promise<SuggestionsState> {
    const preferences = await this.loadPreferences();
    const state = parseSuggestionsState(preferences.suggestions);
    if (state === null) {
      throw new Error('This host does not store suggestion preferences.');
    }
    return state;
  }

  /** `file:read-content`, projected into the canonical preview. */
  private async readFilePreview(
    args: PortalFileReadPayload,
  ): Promise<PortalFilePreview> {
    const { root, catalog } = await this.resolveFileRoot(
      args.projectId,
      args.worktreeId,
      args.fileRootLocalId ?? args.repoId,
    );
    const absolutePath = joinRootPath(root.absolutePath, args.relativePath);
    const segments = rootRelativeSegments(args.relativePath, root.absolutePath);
    const response = await this.channels.invoke(
      C.fileReadContent,
      isFileContent,
      {
        // Kept for hosts that predate `file` (remote control); newer read `file`.
        absolutePath,
        workspaceTarget: {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
        },
        ...(catalog &&
          segments.length > 0 && {
            file: { fileRootId: root.repoId, relativePath: segments.join('/') },
          }),
      },
    );
    if (response.kind === 'missing') {
      throw new Error(`File not found: ${args.relativePath}`);
    }
    if (response.kind === 'image' || response.kind === 'unsupported') {
      throw new Error('Binary files cannot be read.');
    }
    const canonical = response.canonical;
    if (canonical) {
      return {
        workspaceLocalId: args.projectId,
        worktreeLocalId: args.worktreeId,
        fileRootLocalId: canonical.fileRootId,
        path: args.relativePath,
        content: response.content,
        language: languageForPath(args.relativePath),
        size: canonical.sizeBytes,
        version: canonical.version,
        truncated: canonical.truncated,
        modifiedAt: canonical.modifiedAt,
      };
    }
    // A host without the canonical read: host-local roots, the sealed viewer,
    // or a remote-control host from before CAN-4099.
    return {
      workspaceLocalId: args.projectId,
      worktreeLocalId: args.worktreeId,
      fileRootLocalId: root.repoId,
      path: args.relativePath,
      content: response.content,
      language: languageForPath(args.relativePath),
      size: response.sizeBytes,
      version: versionFrom(response.sizeBytes, response.modifiedAtMs),
      truncated: response.truncated,
      modifiedAt: new Date(response.modifiedAtMs).toISOString(),
    };
  }

  private async listFileRoots(args: {
    projectId: string;
    worktreeId: string;
  }): Promise<PortalFileRoot[]> {
    const { roots } = await this.channels.invoke(
      C.fileTreeRoots,
      isFileTreeRoots,
      { projectId: args.projectId, worktreeId: args.worktreeId },
    );
    return roots.map((root) => ({
      workspaceLocalId: args.projectId,
      worktreeLocalId: args.worktreeId,
      fileRootLocalId: root.repoId,
      label: root.repoName,
      absolutePath: root.absolutePath,
    }));
  }

  private async listDirectory(args: {
    projectId: string;
    worktreeId: string;
    repoId: string;
    relativeDir: string;
  }): Promise<PortalDirectoryListing> {
    const { entries } = await this.channels.invoke(
      C.fileTreeDirectory,
      isFileTreeDirectory,
      {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        repoId: args.repoId,
        relativeDir: args.relativeDir,
      },
    );
    return {
      workspaceLocalId: args.projectId,
      worktreeLocalId: args.worktreeId,
      fileRootLocalId: args.repoId,
      path: args.relativeDir,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.relativePath,
        type: entry.kind,
      })),
    };
  }

  /** `file-tree:mutate` with the store's re-read result shape. */
  private async mutateFile(
    args: {
      projectId: string;
      worktreeId: string;
      fileRootLocalId: string;
      relativePath: string;
    },
    mutation: (repoId: string) => Record<string, unknown>,
    result: (repoId: string) => PortalFileMutationResult,
  ): Promise<PortalFileMutationResult> {
    try {
      const { root } = await this.resolveFileRoot(
        args.projectId,
        args.worktreeId,
        args.fileRootLocalId,
      );
      await this.channels.invokeVoid(C.fileTreeMutate, {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        ...mutation(root.repoId),
      });
      return result(root.repoId);
    } catch (error) {
      throw new Error(extractIpcErrorMessage(error));
    }
  }

  /**
   * The `(projectId, worktreeId)` a chat-tab-settings persist routes to.
   * Standalone (cowork) chats key their tabs file per Work Entry.
   */
  private chatTabsRouting(
    args: CommandMap['chat.persistTabSettings']['args'],
  ): {
    projectId: string;
    worktreeId: string;
  } {
    const projectId = args.workspaceLocalId;
    if (!projectId) {
      throw new Error(
        'chat.persistTabSettings requires workspaceLocalId to route to the chat tabs file on desktop.',
      );
    }
    let worktreeId = args.worktreeLocalId;
    if (args.scope === 'standalone' && !worktreeId) {
      // Callers should carry a Work Entry id; without one, fall back to the
      // active entry for this workspace, then to the LEGACY-only home id.
      const active = this.ports.standaloneChatActiveWork?.();
      worktreeId =
        active?.chatProjectId === projectId && active.workEntryId !== null
          ? active.workEntryId
          : COWORK_HOME_WORKTREE_ID;
    }
    if (!worktreeId) {
      throw new Error(
        'chat.persistTabSettings requires worktreeLocalId for worktree-scoped chats on desktop.',
      );
    }
    return { projectId, worktreeId };
  }

  /** `chat:command`, requiring an applied (or already applied) outcome. */
  private async chatCommand(
    request: Record<string, unknown>,
    refusal: string,
  ): Promise<void> {
    const result = await this.channels.invoke(
      C.chatCommand,
      isChatCommandResult,
      request,
    );
    if (result.outcome !== 'applied' && result.outcome !== 'already_applied') {
      throw new Error(result.reason ?? refusal);
    }
  }

  private createQueryHandlers(
    terminal: TerminalHandlers,
  ): Omit<
    QueryHandlers,
    ShellQueryName | 'appAdvisor.chats' | 'worktree.activity'
  > {
    const channels = this.channels;
    return {
      'delegation.lifetimeStatus': (args) =>
        channels.invoke(
          C.managedDelegationLifetimeStatus,
          recordReply<QueryMap['delegation.lifetimeStatus']['result']>(),
          args,
        ),
      // Script action replies keep typed error codes, so no unwrapIpcError.
      'scriptActions.list': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsList,
          args,
          isScriptActionsSnapshot,
        ),
      'scriptActions.receipt': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsReceipt,
          args,
          isScriptActionsReceiptOrNull,
        ),
      'repoRules.scan': (args) =>
        unwrapIpcError(
          channels.invoke(
            C.repoRulesScan,
            recordReply<QueryMap['repoRules.scan']['result']>(),
            args,
          ),
        ),
      'repoRules.status': (args) =>
        unwrapIpcError(
          channels.invoke(
            C.repoRulesStatus,
            recordReply<QueryMap['repoRules.status']['result']>(),
            args,
          ),
        ),
      'repoRules.preview': (args) =>
        unwrapIpcError(
          channels.invoke(
            C.repoRulesPreview,
            recordReply<QueryMap['repoRules.preview']['result']>(),
            args,
          ),
        ),
      'editorSetup.presence': (args) =>
        unwrapIpcError(
          channels.invoke(
            C.editorSetupPresence,
            recordReply<QueryMap['editorSetup.presence']['result']>(),
            args,
          ),
        ),
      'organization.inviteStatus': async (args) =>
        organizationReply(
          OrganizationInviteStatusSchema,
          await channels.invoke(
            C.personalOrganizationUpgradeInviteStatus,
            anyReply<unknown>(),
            args,
          ),
        ),
      ...terminal.queries,
      // Organization projects (CAN-2955): the host-owned catalog per context.
      'orgProjects.catalog': (args) => {
        const broadcast = this.orgProjectBroadcasts.get(
          serializeWorkspaceContext(args.context),
        );
        if (broadcast) return Promise.resolve(broadcast);
        return args.refresh === true
          ? channels.invoke(C.orgProjectsRefresh, isOrgProjectCatalogSnapshot, {
              context: args.context,
              force: true,
              ...(args.repositories === true ? { repositories: true } : {}),
            })
          : channels.invoke(C.orgProjectsList, isOrgProjectCatalogSnapshot, {
              context: args.context,
            });
      },
      'workspaceContext.get': () =>
        channels.invoke(C.workspaceContextGet, isWorkspaceContextState),
      'personalOrganization.projects': async () =>
        PersonalProjectListSchema.parse(
          await channels.invoke(
            C.personalOrganizationUpgradeList,
            anyReply<unknown>(),
          ),
        ),
      'personalOrganization.operationStatus': async (args) =>
        PersonalProjectOperationSchema.nullable().parse(
          await channels.invoke(
            C.personalOrganizationUpgradeStatus,
            anyReply<unknown>(),
            { operationId: args.operationId },
          ),
        ),
      'referencePreview.linearScope': () =>
        channels.invoke(
          C.referencePreviewLinearScope,
          anyReply<QueryMap['referencePreview.linearScope']['result']>(),
        ),
      'referencePreview.linearIssue': (args) =>
        channels.invoke(
          C.referencePreviewLinearIssue,
          anyReply<QueryMap['referencePreview.linearIssue']['result']>(),
          args,
        ),
      'referencePreview.linearTeams': () =>
        channels.invoke(
          C.referencePreviewLinearTeams,
          anyReply<QueryMap['referencePreview.linearTeams']['result']>(),
        ),
      'referencePreview.githubScope': () =>
        channels.invoke(
          C.referencePreviewGitHubScope,
          anyReply<QueryMap['referencePreview.githubScope']['result']>(),
        ),
      'referencePreview.githubOrigin': (args) =>
        channels.invoke(
          C.referencePreviewGitHubOrigin,
          anyReply<QueryMap['referencePreview.githubOrigin']['result']>(),
          args,
        ),
      'referencePreview.github': (args) =>
        channels.invoke(
          C.referencePreviewGitHub,
          anyReply<QueryMap['referencePreview.github']['result']>(),
          args,
        ),
      'session.snapshot': (args) =>
        channels.invoke(
          C.desktopSessionSnapshot,
          recordReply<QueryMap['session.snapshot']['result']>(),
          args,
        ),
      'file.read': (args) =>
        this.ports.scopedFiles?.(args.worktreeId)?.['file.read'](args) ??
        this.readFilePreview(args),
      // A projection over `worker.filesystem.link.resolve` in transcript mode
      // (CAN-5038). An older host answers `null`.
      'file.resolveLink': async (args) => {
        const scoped = this.ports.scopedFiles?.(args.worktreeId);
        if (scoped) return scoped['file.resolveLink'](args);
        const resolved = await channels.invoke(
          C.fileReferenceResolve,
          nullableRecordReply<WireFileReference>(),
          {
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            baseFilePath: '',
            href: args.href,
            mode: 'transcript',
          },
        );
        const canonical = resolved?.canonical;
        return canonical?.kind === 'file' &&
          typeof canonical.fileRootId === 'string' &&
          typeof canonical.relativePath === 'string'
          ? {
              fileRootLocalId: canonical.fileRootId,
              relativePath: canonical.relativePath,
            }
          : null;
      },
      'diff.read': (args) => readFileDiff(channels, args),
      'file.roots': (args) =>
        this.ports.scopedFiles?.(args.worktreeId)?.['file.roots'](args) ??
        this.listFileRoots({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
        }),
      'file.index': async (args): Promise<PortalFileIndex> => {
        try {
          const index = await channels.invoke(C.fileIndexGet, isFileIndex, {
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            purpose: 'file-explorer',
          });
          const repo = index.repos.find(
            (candidate): boolean => candidate.repoId === args.fileRootLocalId,
          );
          const needle = (args.q ?? '').toLowerCase();
          const matched = (repo?.files ?? []).filter((file): boolean =>
            file.relativePath.toLowerCase().includes(needle),
          );
          const limit = Math.max(0, Math.min(args.limit ?? 25_000, 25_000));
          return {
            fileRootLocalId: args.fileRootLocalId,
            paths: matched
              .slice(0, limit)
              .map((file): string => file.relativePath),
            truncated: repo?.truncated === true || matched.length > limit,
          };
        } catch (error) {
          throw new Error(extractIpcErrorMessage(error));
        }
      },
      'file.directory': (args) =>
        this.listDirectory({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          repoId: args.repoId,
          relativeDir: args.relativeDir,
        }),
      'chat.history': (args) =>
        readChatHistory(channels, args, this.ports.toolFamilyFor),
      'plan.get': async (args) => {
        const plan = await channels.invoke(
          C.trackedPlansGet,
          nullableRecordReply<WireTrackedPlan>(),
          {
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            planId: args.planId,
          },
        );
        const detail = plan
          ? toRequestedPortalPlanDetail(plan, args.revisionNumber)
          : null;
        if (!detail) {
          throw new Error('Plan not found.');
        }
        return detail;
      },
      'chat.getTabSettings': (args) =>
        Promise.resolve(this.sessionTabSettings.get(args.chatId) ?? null),
      'workspace.claudeMd.get': (args) =>
        channels.invoke(C.workspaceLoadClaudeMd, isNullableString, {
          workspaceId: args.workspaceId,
        }),
      'workspace.scripts.get': (args) =>
        channels.invoke(
          C.workspaceReadScripts,
          anyReply<QueryMap['workspace.scripts.get']['result']>(),
          { workspaceId: args.workspaceId },
        ),
      // The settings Portal's Orchestrator settings get serves; the desktop
      // edits them in its own modal.
      'appAdvisor.settings.get': () =>
        channels.invoke(C.appAdvisorSettingsView, isAppAdvisorSettings),
      // Turn-level ratings (CAN-1521). The host merges server rows with
      // pending outbox entries and resolves.
      'turnFeedback.list': (args) =>
        channels.invoke(
          C.turnFeedbackList,
          anyReply<QueryMap['turnFeedback.list']['result']>(),
          { clientChatId: args.clientChatId },
        ),
      // Rejects when there is no real value, so the row shows a locked state.
      'account.installUpdateEmails.get': () =>
        channels.invoke(
          C.settingsLoadInstallUpdateEmailPreference,
          anyReply<QueryMap['account.installUpdateEmails.get']['result']>(),
        ),
      'onboardingTips.get': async () => ({
        dismissed: await this.loadOnboardingTipDismissals(),
      }),
      'claudeMods.get': (args) =>
        channels.invoke(
          C.claudeModsGet,
          recordReply<QueryMap['claudeMods.get']['result']>(),
          args,
        ),
      'suggestions.get': () => this.loadSuggestionsState(),
    };
  }

  private createCommandHandlers(
    terminal: TerminalHandlers,
  ): Omit<CommandHandlers, ShellCommandName | 'chat.attachments.upload'> {
    const channels = this.channels;
    return {
      'delegation.extendLifetimeLimit': (args) =>
        channels.invoke(
          C.managedDelegationExtendLifetimeLimit,
          recordReply<CommandMap['delegation.extendLifetimeLimit']['result']>(),
          args,
        ),
      'providerUsage.refresh': async ({ provider }) => {
        await channels.invokeVoid(C.observabilityRefreshUsage, provider);
      },
      'repoRules.apply': (args) =>
        unwrapIpcError(
          channels.invoke(
            C.repoRulesApply,
            recordReply<CommandMap['repoRules.apply']['result']>(),
            args,
          ),
        ),
      'scriptActions.rescan': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsRescan,
          args,
          isScriptActionsSnapshot,
        ),
      'scriptActions.review': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsReview,
          args,
          isScriptActionsSnapshot,
        ),
      'scriptActions.setShortcut': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsSetShortcut,
          args,
          isScriptActionsSnapshot,
        ),
      'scriptActions.setPinned': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsSetPinned,
          args,
          isScriptActionsSnapshot,
        ),
      'scriptActions.enableShellAliasScan': (args) =>
        invokeScriptActions(
          channels,
          C.scriptActionsEnableShellAliasScan,
          args,
          isScriptActionsSnapshot,
        ),
      'sidebar.itemGroups.create': (args) =>
        channels.invoke(
          C.sidebarItemGroupsCreate,
          anyReply<CommandMap['sidebar.itemGroups.create']['result']>(),
          args,
        ),
      'sidebar.itemGroups.update': (args) =>
        channels.invoke(
          C.sidebarItemGroupsUpdate,
          anyReply<CommandMap['sidebar.itemGroups.update']['result']>(),
          args,
        ),
      'sidebar.itemGroups.ungroup': (args) =>
        channels.invoke(
          C.sidebarItemGroupsUngroup,
          anyReply<CommandMap['sidebar.itemGroups.ungroup']['result']>(),
          args,
        ),
      'sidebar.itemGroups.moveItem': (args) =>
        channels.invoke(
          C.sidebarItemGroupsMoveItem,
          anyReply<CommandMap['sidebar.itemGroups.moveItem']['result']>(),
          args,
        ),
      'sidebar.itemGroups.moveGroup': (args) =>
        channels.invoke(
          C.sidebarItemGroupsMoveGroup,
          anyReply<CommandMap['sidebar.itemGroups.moveGroup']['result']>(),
          args,
        ),
      ...terminal.commands,
      'orgProjects.setPreference': async (args) => {
        // The preference belongs to the context the row was listed in: the
        // context this window is looking at.
        await channels.invoke(
          C.orgProjectsSetPreference,
          isOrgProjectCatalogSnapshot,
          {
            context: this.ports.workspaceContext?.() ?? { kind: 'personal' },
            projectId: args.projectId,
            preference: args.preference,
          },
        );
      },
      'orgProjects.setupStart': async ({ projectId, destinationRoot }) => {
        const result = await channels.invoke(
          C.orgProjectsSetupStart,
          anyReply<unknown>(),
          { projectId, destinationRoot },
        );
        if (!isOrgProjectSetupProgress(result)) {
          throw new Error('Malformed organization project setup reply');
        }
        return result;
      },
      'orgProjects.setupCancel': (args) =>
        channels.invoke(
          C.orgProjectsSetupCancel,
          anyReply<CommandMap['orgProjects.setupCancel']['result']>(),
          args,
        ),
      'personalOrganization.upgrade': async (args) =>
        organizationReply(
          PersonalOrganizationPromotionOutcomeSchema,
          await channels.invoke(
            C.personalOrganizationUpgradePromote,
            anyReply<unknown>(),
            args,
          ),
        ),
      'personalOrganization.convertProjects': async (args) =>
        PersonalProjectOperationSchema.parse(
          await channels.invoke(
            C.personalOrganizationUpgradeConvert,
            anyReply<unknown>(),
            args,
          ),
        ),
      'organization.invite': async (args) =>
        organizationReply(
          OrganizationInviteResultSchema,
          await channels.invoke(
            C.personalOrganizationUpgradeInvite,
            anyReply<unknown>(),
            { organizationId: args.organizationId, invite: args.invite },
          ),
        ),
      'workspaceContext.set': (args) =>
        channels.invoke(C.workspaceContextSet, isWorkspaceContextState, {
          context: args.context,
          expectedRevision: args.expectedRevision,
        }),
      // The local desktop has no relayed portal session to end.
      'session.end': () => Promise.resolve(),
      // One scoped, revisioned command; the adapter never merges snapshots.
      'chat.persistTabSettings': async (args) => {
        const { projectId, worktreeId } = this.chatTabsRouting(args);
        const result = await channels.invoke(
          C.chatCommand,
          isChatCommandResult,
          {
            schemaVersion: 1,
            commandId: `renderer-chat-settings-${args.chatId}-${this.randomId()}`,
            projectId,
            worktreeId,
            command: {
              type: 'chat.patch_tab_settings',
              tabId: args.chatId,
              patch: {
                planMode: args.settings.planMode,
                proposalMode: args.settings.proposalMode,
                modelConfig: {
                  thinkingLevel: args.settings.thinkingLevel,
                },
                pendingPlanExit: args.settings.pendingPlanExit ?? null,
              },
            },
          },
        );
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied'
        ) {
          throw new Error(
            result.reason ??
              `chat.persistTabSettings was not applied (${result.outcome}).`,
          );
        }
        this.sessionTabSettings.set(args.chatId, args.settings);
      },
      'chat.queue.cancel': async (args) => {
        await channels.invokeVoid(C.chatQueueCancel, args);
      },
      'chat.queue.edit': async (args) => {
        await channels.invokeVoid(C.chatQueueEdit, args);
      },
      'chat.queue.force': async (args) => {
        await channels.invokeVoid(C.chatQueueForce, args);
      },
      'chat.queue.steer': (args) =>
        this.chatCommand(
          {
            schemaVersion: 1,
            commandId: this.randomId(),
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            command: {
              type: 'chat.steer_queued_message',
              chatId: args.chatId,
              queuedMessageId: args.entryId,
            },
          },
          'Steering could not be confirmed',
        ),
      'chat.inputDelivery': (args) =>
        this.chatCommand(
          {
            schemaVersion: 1,
            commandId: this.randomId(),
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            command: {
              type: 'chat.input_delivery_action',
              chatId: args.chatId,
              rowId: args.rowId,
              rowRevision: args.rowRevision,
              action: args.action,
              ...(args.text !== undefined ? { text: args.text } : {}),
            },
          },
          'The message action could not be confirmed',
        ),
      'chat.queue.set_edit_lock': async (args) => {
        await channels.invokeVoid(C.chatQueueSetEditLock, args);
      },
      'file.create': (args) =>
        this.mutateFile(
          args,
          (repoId) => ({
            operation: 'create-file',
            target: { repoId, relativePath: args.relativePath },
          }),
          (repoId) => ({
            fileRootLocalId: repoId,
            path: args.relativePath,
            kind: 'create',
          }),
        ),
      'file.mkdir': (args) =>
        this.mutateFile(
          args,
          (repoId) => ({
            operation: 'create-directory',
            target: { repoId, relativePath: args.relativePath },
          }),
          (repoId) => ({
            fileRootLocalId: repoId,
            path: args.relativePath,
            kind: 'mkdir',
          }),
        ),
      'file.rename': (args) =>
        this.mutateFile(
          args,
          (repoId) => ({
            operation: 'move',
            source: { repoId, relativePath: args.relativePath },
            target: { repoId, relativePath: args.toRelativePath },
            conflict: 'error',
          }),
          (repoId) => ({
            fileRootLocalId: repoId,
            path: args.toRelativePath,
            kind: 'rename',
            fromPath: args.relativePath,
          }),
        ),
      'file.delete': (args) =>
        this.mutateFile(
          args,
          (repoId) => ({
            operation: 'delete',
            target: { repoId, relativePath: args.relativePath },
            useTrash: true,
          }),
          (repoId) => ({
            fileRootLocalId: repoId,
            path: args.relativePath,
            kind: 'delete',
          }),
        ),
      // Write through `file:save-content` (which owns containment and
      // conflict checks) and shape the stat into the re-read preview.
      'file.save': async (args) => {
        const { root } = await this.resolveFileRoot(
          args.projectId,
          args.worktreeId,
          args.fileRootLocalId ?? args.repoId,
        );
        const absolutePath = joinRootPath(root.absolutePath, args.relativePath);
        let response: WireFileSaved;
        try {
          response = await channels.invoke(C.fileSaveContent, isFileSaved, {
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            absolutePath,
            content: args.content,
            ...(args.expectedModifiedAtMs !== undefined
              ? { expectedModifiedAtMs: args.expectedModifiedAtMs }
              : {}),
          });
        } catch (error) {
          // Restore the typed stale-version refusal so the store can
          // recover; keep transport details out of every other error.
          if (extractIpcErrorName(error) === 'FileSaveConflictError') {
            throw new FileSaveConflictError(extractIpcErrorMessage(error));
          }
          throw new Error(extractIpcErrorMessage(error));
        }
        return {
          workspaceLocalId: args.projectId,
          worktreeLocalId: args.worktreeId,
          fileRootLocalId: root.repoId,
          path: args.relativePath,
          content: args.content,
          language: languageForPath(args.relativePath),
          size: response.sizeBytes,
          version: versionFrom(response.sizeBytes, response.modifiedAtMs),
          truncated: false,
          modifiedAt: new Date(response.modifiedAtMs).toISOString(),
        };
      },
      // The same load → update → save round trip the desktop projects store
      // uses; unknown section ids are dropped, never persisted.
      'activity.setSectionOrder': async (args) => {
        const order = args.order.filter(isActivitySectionId);
        const file = await this.loadProjects();
        const items = file.items.map((item) =>
          item.id === args.workspaceLocalId && item.type !== 'cowork'
            ? { ...item, activitySectionOrder: order }
            : item,
        );
        await channels.invokeVoid(C.projectsSave, items, undefined);
      },
      'activity.stopBackgroundTask': (args) =>
        channels.invoke(
          C.activityStopBgProcess,
          anyReply<CommandMap['activity.stopBackgroundTask']['result']>(),
          {
            projectId: args.projectId,
            worktreeId: args.worktreeId,
            chatId: args.chatId,
            taskId: args.taskId,
          },
        ),
      'workspace.create': async (args) => {
        const destinationDir = await channels.invoke(
          C.repoDefaultCloneDir,
          isString,
        );
        const workspace = await channels.invoke(
          C.workspaceAddFromRemote,
          recordWith<WireAddedWorkspace>('id'),
          { remoteUrl: args.remoteUrl, destinationDir },
        );
        await this.invalidateSessionSnapshot();
        // The guard checked only `id`; read the optional field as wire data.
        const operationId: unknown = workspace.scriptActionsOperationId;
        return {
          status: 'completed',
          workspaceId: workspace.id,
          ...(typeof operationId === 'string' && operationId !== ''
            ? { scriptActionsOperationId: operationId }
            : {}),
        };
      },
      'workspace.update': async (args) => {
        await channels.invokeVoid(C.workspaceUpdateMetadata, {
          workspaceId: args.workspaceId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.color !== undefined ? { color: args.color } : {}),
        });
        await this.invalidateSessionSnapshot();
      },
      'workspace.delete': async (args) => {
        const item = await this.loadWorkspace(args.workspaceId);
        // CAN-5337: the interrupted deletion the person confirmed superseding.
        const superseded =
          args.supersedeInterruptedDeletion !== undefined
            ? {
                supersedeInterruptedDeletion: args.supersedeInterruptedDeletion,
              }
            : {};
        if (item.type === 'single-repo') {
          await channels.invokeVoid(C.projectDelete, {
            projectId: args.workspaceId,
            ...superseded,
          });
        } else {
          // Multi-repo and cowork workspaces share the workspace deletion path.
          await channels.invokeVoid(C.workspaceDelete, {
            workspaceId: args.workspaceId,
            ...superseded,
          });
        }
        await this.invalidateSessionSnapshot();
      },
      'lifecycleJournal.inspect': () =>
        channels.invoke(
          C.lifecycleJournalInspect,
          anyReply<CommandMap['lifecycleJournal.inspect']['result']>(),
        ),
      'lifecycleJournal.quarantine': (args) =>
        channels.invoke(
          C.lifecycleJournalQuarantine,
          anyReply<CommandMap['lifecycleJournal.quarantine']['result']>(),
          args,
        ),
      'worktree.discard.describe': (args) =>
        channels.invoke(
          C.worktreeDiscardDescribe,
          anyReply<CommandMap['worktree.discard.describe']['result']>(),
          {
            projectId: args.workspaceId,
            worktreeId: args.worktreeId,
            ...(args.retainedArchives === true
              ? { retainedArchives: true }
              : {}),
          },
        ),
      'worktree.discard': (args) =>
        channels.invoke(
          C.worktreeDiscard,
          anyReply<CommandMap['worktree.discard']['result']>(),
          {
            projectId: args.workspaceId,
            worktreeId: args.worktreeId,
            confirmation: args.confirmation,
            ...(args.retainedArchives === true
              ? { retainedArchives: true }
              : {}),
          },
        ),
      'workspace.delete.discard.describe': (args) =>
        channels.invoke(
          C.workspaceDeleteDiscardDescribe,
          anyReply<CommandMap['workspace.delete.discard.describe']['result']>(),
          {
            workspaceId: args.workspaceId,
            ...(args.retainedArchives === true
              ? { retainedArchives: true }
              : {}),
          },
        ),
      'workspace.reorder': async (args) => {
        await channels.invokeVoid(C.workspaceReorder, args);
        await this.invalidateSessionSnapshot();
      },
      'worktree.create': async (args) => {
        const item = await this.loadWorkspace(args.workspaceId);
        if (item.type === 'cowork') {
          throw new Error('Cannot create a worktree in a cowork project.');
        }
        const existingWorktreeIds =
          args.existingWorktreeIds ??
          (item.worktrees ?? []).map((worktree) => worktree.id);
        const base = args.baseWorktreeId
          ? { baseWorktreeId: args.baseWorktreeId }
          : {};
        const created =
          item.type === 'multi-repo'
            ? await channels.invoke(
                C.workspaceCreateWorktree,
                isCreatedWorktree,
                {
                  workspaceId: args.workspaceId,
                  existingWorktreeIds,
                  ...base,
                },
              )
            : await channels.invoke(C.worktreeCreate, isCreatedWorktree, {
                projectId: args.workspaceId,
                repoPath: item.repoPath,
                existingWorktreeIds,
                ...base,
              });
        if (created.needsRepair === true) {
          throw new Error('The new worktree requires project repair.');
        }
        const fork = this.ports.forkWorktreeState;
        if (args.forkOpenTabs && args.baseWorktreeId && fork) {
          try {
            await fork({
              projectId: args.workspaceId,
              sourceWorktreeId: args.baseWorktreeId,
              destinationWorktreeId: created.id,
            });
          } catch (error: unknown) {
            // Creation already committed. Report it completed so a retry
            // cannot create a duplicate; the destination keeps its normal
            // empty-tab fallback.
            this.log(
              'Failed to carry open tabs to portal-created branched worktree',
              error,
            );
          }
        }
        await this.invalidateSessionSnapshot();
        return {
          status: 'completed',
          worktreeId: created.id,
          branchName: created.branchName,
        };
      },
      'worktree.update': async (args) => {
        let changed = false;
        try {
          if (args.label !== undefined) {
            await channels.invokeVoid(C.worktreeSetLabel, {
              projectId: args.workspaceId,
              worktreeId: args.worktreeId,
              ...(args.label !== null ? { label: args.label } : {}),
            });
            changed = true;
          }
          if (args.hidden !== undefined) {
            await channels.invokeVoid(C.worktreeSetHidden, {
              projectId: args.workspaceId,
              worktreeId: args.worktreeId,
              hidden: args.hidden,
            });
            changed = true;
          }
        } finally {
          if (changed) {
            await this.invalidateSessionSnapshot().catch(() => undefined);
          }
        }
      },
      'worktree.archive': async (args) => {
        const item = await this.loadWorkspace(args.workspaceId);
        if (item.type === 'cowork') {
          throw new Error('Cannot archive a worktree in a cowork project.');
        }
        const worktrees = item.worktrees ?? [];
        const target = worktrees.find(
          (worktree) => worktree.id === args.worktreeId,
        );
        if (!target) {
          throw new Error('Worktree to archive was not found.');
        }
        const remainingWorktreeOrder = worktrees
          .filter((worktree) => worktree.id !== args.worktreeId)
          .map((worktree) => worktree.id);
        const requestOrder = {
          remainingWorktreeOrder,
          expectedRemainingWorktreeOrder: remainingWorktreeOrder,
          ...(target.createdAt ? { expectedCreatedAt: target.createdAt } : {}),
        };
        if (item.type === 'multi-repo') {
          await channels.invokeVoid(C.workspaceArchiveWorktree, {
            workspaceId: args.workspaceId,
            worktreeId: args.worktreeId,
            ...requestOrder,
          });
        } else {
          await channels.invokeVoid(C.worktreeArchive, {
            projectId: args.workspaceId,
            worktreeId: args.worktreeId,
            repoPath: item.repoPath,
            ...requestOrder,
          });
        }
        await this.invalidateSessionSnapshot();
      },
      'worktree.reorder': async (args) => {
        await channels.invokeVoid(C.worktreeReorder, args);
        await this.invalidateSessionSnapshot();
      },
      'workspace.claudeMd.save': async (args) => {
        await channels.invokeVoid(C.workspaceSaveClaudeMd, args);
        await this.invalidateSessionSnapshot();
      },
      'workspace.scripts.save': async (args) => {
        await channels.invokeVoid(C.workspaceMergeScripts, args);
        await this.invalidateSessionSnapshot();
      },
      // Saved as Portal's Orchestrator settings save applies the patch; an
      // invalid patch is refused by the computer before anything is written.
      'appAdvisor.settings.save': async (args) => {
        const saved = await channels.invoke(
          C.appAdvisorSettingsPatch,
          isSettingsPatchResult,
          args,
        );
        if (!saved.ok) {
          throw new Error(saved.error ?? 'The settings were not saved.');
        }
      },
      // Scripts and hooks map onto the run/stop channels. The invoke settles
      // when the run completes; status still streams on the script and hook
      // event channels.
      'script.run': async (args) => {
        await channels.invokeVoid(C.scriptRun, toScriptRunRequest(args));
      },
      'script.cancel': async (args) => {
        await channels.invokeVoid(C.scriptStop, {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          scriptKey: args.scriptKey,
        });
      },
      'hook.run': async (args) => {
        await channels.invokeVoid(C.hookRun, toHookRunRequest(args));
      },
      'hook.cancel': async (args) => {
        await channels.invokeVoid(C.hookStop, {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          hookKey: args.hookKey,
        });
      },
      // Mirror of the main-process portal `runPipeline` flow: resolve the
      // worktree cwd, discover the project pipeline by id, load it, execute.
      'pipeline.run': async (args) => {
        const { projectId, worktreeId } = args;
        if (!projectId || !worktreeId) {
          throw new Error(
            'pipeline.run requires projectId and worktreeId on desktop.',
          );
        }
        if (args.cwd) {
          // The host resolves a relative cwd with containment checks; this
          // adapter cannot, so explicit overrides are refused.
          throw new UnsupportedOperationError(
            'pipeline.run',
            'pipeline.run with an explicit cwd is not supported by the desktop adapter.',
          );
        }
        const cwd = await channels.invoke(C.worktreeGetPath, isString, {
          projectId,
          worktreeId,
        });
        const discovered = await channels.invoke(
          C.pipelinesDiscoverProject,
          isIpcResult<WirePipelineInfo[]>(),
          cwd,
        );
        if (!discovered.success || !discovered.data) {
          throw new Error(discovered.error ?? 'Unable to discover pipelines.');
        }
        const info = discovered.data.find(
          (pipeline) => pipeline.id === args.pipelineId,
        );
        if (!info?.filePath) {
          throw new Error('Pipeline not found.');
        }
        const detail = await channels.invoke(
          C.pipelinesGet,
          isIpcResult<WirePipelineData>(),
          { id: info.id, cwd, filePath: info.filePath },
        );
        if (!detail.success || !detail.data) {
          throw new Error(detail.error ?? 'Unable to load pipeline.');
        }
        const modelConfig = toAgentModelConfig(args);
        const result = await channels.invoke(
          C.pipelinesExecute,
          isIpcResult<unknown>(),
          detail.data.content,
          {
            cwd,
            pipelineId: args.pipelineId,
            pipelineFilePath: info.filePath,
            repoPath: cwd,
            projectId,
            worktreeId,
            ...(args.planId ? { planId: args.planId } : {}),
            ...(args.inputs && Object.keys(args.inputs).length > 0
              ? { inputs: args.inputs }
              : {}),
            ...(modelConfig ? { modelConfig } : {}),
            // The run location (CAN-6187): main starts a targeted run
            // elsewhere or refuses it, never runs it here.
            ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
          },
        );
        if (!result.success) {
          throw new Error(
            result.error ?? 'Pipeline execution failed to start.',
          );
        }
      },
      'pipeline.cancel': async (args) => {
        const result = await channels.invoke(
          C.pipelinesCancelExecution,
          isIpcResult<unknown>(),
          args.executionId,
        );
        if (!result.success) {
          throw new Error(
            result.error ?? 'Unable to cancel pipeline execution.',
          );
        }
      },
      // PR git actions: commit_and_push, push and pull map onto the GitHub
      // channels; create and update_base_branch have no faithful channel.
      'pr.action': async (args) => {
        const projectId = args.workspaceLocalId;
        const worktreeId = args.worktreeLocalId;
        switch (args.action) {
          case 'commit_and_push': {
            const repos = await channels.invoke(
              C.worktreeListRepoEntries,
              arrayReply<WireWorktreeRepoEntry[]>(),
              { projectId, worktreeId },
            );
            const allowed = args.repoIds?.length ? new Set(args.repoIds) : null;
            const selected = allowed
              ? repos.filter((repo) => allowed.has(repo.repoId))
              : repos;
            const response = await channels.invoke(
              C.githubCommitAndPush,
              isCommitAndPush,
              {
                projectId,
                worktreeId,
                // Pin the caller's message to every targeted repo so the host
                // uses it verbatim instead of generating one per repo.
                messages: selected.map((repo) => ({
                  repoId: repo.repoId,
                  repoName: repo.repoName,
                  message: args.commitMessage,
                })),
                ...(args.repoIds?.length ? { repoIds: args.repoIds } : {}),
              },
            );
            // Per-repo failures arrive in the reply; the Portal service is
            // fail-fast, so a partial failure rejects here too.
            const failed = response.failedRepos.map(
              (repo) => `${repo.repoName}: ${repo.error}`,
            );
            const pendingAgents = response.agentResolutionRepos.map(
              (repo) => `${repo.repoName} (${repo.kind})`,
            );
            if (failed.length > 0 || pendingAgents.length > 0) {
              const parts: string[] = [];
              if (failed.length > 0) {
                parts.push(`failed repos — ${failed.join('; ')}`);
              }
              if (pendingAgents.length > 0) {
                parts.push(
                  `repos pending agent conflict resolution — ${pendingAgents.join('; ')}`,
                );
              }
              throw new Error(
                `commit_and_push did not complete for all repos: ${parts.join(' | ')}`,
              );
            }
            return;
          }
          case 'push': {
            if (args.repoIds?.length) {
              // `PushOnlyRequest` has no repo scoping; refusing beats
              // silently pushing every repo in the worktree.
              throw new UnsupportedOperationError(
                'pr.action',
                'pr.action push with repo scoping is not supported by the desktop adapter.',
              );
            }
            await channels.invokeVoid(C.githubPushOnly, {
              projectId,
              worktreeId,
            });
            return;
          }
          case 'pull': {
            if (args.repoIds?.length) {
              throw new UnsupportedOperationError(
                'pr.action',
                'pr.action pull with repo scoping is not supported by the desktop adapter.',
              );
            }
            await channels.invokeVoid(C.githubPull, { projectId, worktreeId });
            return;
          }
          case 'create':
            // The host's createPr generates its own title and body and does
            // not accept the explicit ones the Portal contract requires.
            throw new UnsupportedOperationError(
              'pr.action',
              'pr.action create is not yet bridged on desktop; the desktop createPr IPC does not accept an explicit title/body.',
            );
          case 'update_base_branch':
            // Needs a PR number the payload lacks and no channel resolves.
            throw new UnsupportedOperationError(
              'pr.action',
              'pr.action update_base_branch is not yet bridged on desktop; resolving the PR number requires a PR-status query IPC.',
            );
          default:
            // Worktree PR actions (get_actions, create_auto, merge), cloud
            // commit and cancel: no desktop channel honors these payloads.
            // The renderer adapter used to resolve them without effect.
            throw new UnsupportedOperationError(
              'pr.action',
              `pr.action ${args.action} is not available over this connection.`,
            );
        }
      },
      'pr.create': () =>
        Promise.reject(
          new UnsupportedOperationError(
            'pr.create',
            'pr.create is not yet bridged on desktop; the desktop createPr IPC does not accept an explicit title/body.',
          ),
        ),
      'pr.refresh': async (args) => {
        await channels.invokeVoid(C.githubRequestRefresh, {
          projectId: args.workspaceLocalId,
          worktreeId: args.worktreeLocalId,
        });
      },
      'plan.update': async (args) => {
        const updated = await channels.invoke(
          C.trackedPlansUpdate,
          anyReply<unknown>(),
          toUpdateTrackedPlanRequest(args),
        );
        if (!updated) {
          throw new Error('Plan not found.');
        }
      },
      'sourceRepository.star': () =>
        channels.invoke(
          C.settingsStarSourceRepository,
          anyReply<CommandMap['sourceRepository.star']['result']>(),
        ),
      // Turn-level thumbs (CAN-1521). Both host handlers resolve: an
      // unreachable cloud queues the rating in the local outbox.
      'turnFeedback.rate': async (args) => {
        const response = await channels.invoke(
          C.turnFeedbackRate,
          recordReply<WireTurnFeedbackRated>(),
          {
            clientUserMessageId: args.clientUserMessageId,
            // Required, never defaulted: the host rejects an empty id, so a
            // substitute would silently discard the rating.
            clientChatId: args.clientChatId,
            rating: args.rating,
            ...(args.provider ? { provider: args.provider } : {}),
            ...(args.model ? { model: args.model } : {}),
            ...(args.eventType ? { eventType: args.eventType } : {}),
            ...(args.chatMode ? { chatMode: args.chatMode } : {}),
          },
        );
        return response.feedbackId ? { feedbackId: response.feedbackId } : {};
      },
      'turnFeedback.clear': async (args) => {
        await channels.invokeVoid(C.turnFeedbackClear, {
          clientUserMessageId: args.clientUserMessageId,
          ...(args.feedbackId ? { feedbackId: args.feedbackId } : {}),
        });
      },
      'turnFeedback.detail': async (args) => {
        await channels.invokeVoid(C.turnFeedbackDetail, {
          clientUserMessageId: args.clientUserMessageId,
          ...(args.feedbackId ? { feedbackId: args.feedbackId } : {}),
          ...(args.reason ? { reason: args.reason } : {}),
          ...(args.comment ? { comment: args.comment } : {}),
        });
      },
      'account.installUpdateEmails.set': (args) =>
        channels.invoke(
          C.settingsSaveInstallUpdateEmailPreference,
          anyReply<CommandMap['account.installUpdateEmails.set']['result']>(),
          { enabled: args.enabled },
        ),
      // The host applies the update to the latest stored record inside its
      // serialized preferences write, so a dismissal is never dropped.
      'onboardingTips.update': (update) =>
        channels.invoke(
          C.preferencesUpdateOnboardingTips,
          anyReply<CommandMap['onboardingTips.update']['result']>(),
          update,
        ),
      'claudeMods.update': (args) =>
        channels.invoke(
          C.claudeModsUpdate,
          anyReply<CommandMap['claudeMods.update']['result']>(),
          args,
        ),
      // The host stamps the time inside the serialized preferences write.
      'suggestions.update': (update) =>
        channels.invoke(
          C.preferencesUpdateSuggestions,
          anyReply<CommandMap['suggestions.update']['result']>(),
          update,
        ),
    };
  }

  private createSubscribeHandlers(
    terminal: TerminalHandlers,
  ): Omit<
    SubscribeHandlers,
    'appAdvisor.changed' | 'worktree.activityChanged'
  > {
    const channels = this.channels;
    return {
      ...terminal.subscriptions,
      'delegation.lifetimeChanged': (handler, filter) =>
        channels.listen(
          C.managedDelegationLifetimeChanged,
          recordReply<
            Omit<DomainEventMap['delegation.lifetimeChanged'], 'occurredAt'>
          >(),
          (event) => {
            if (
              (filter?.projectId !== undefined &&
                filter.projectId !== event.projectId) ||
              (filter?.worktreeId !== undefined &&
                filter.worktreeId !== event.worktreeId)
            ) {
              return;
            }
            handler({ ...event, occurredAt: this.now() });
          },
        ),
      'workspace-context.changed': (handler) =>
        channels.listen(
          C.workspaceContextChanged,
          isWorkspaceContextBroadcast,
          (broadcast) => {
            const { reason, ...state } = broadcast;
            handler({ occurredAt: this.now(), state, reason });
          },
        ),
      'org-projects.changed': (handler) =>
        channels.listen(
          C.orgProjectsChanged,
          isOrgProjectCatalogSnapshot,
          (snapshot) => {
            const context = parseWorkspaceContext(snapshot.context);
            if (!context) return;
            this.orgProjectBroadcasts.set(snapshot.context, snapshot);
            try {
              handler({
                occurredAt: snapshot.fetchedAt,
                context,
                reason: 'catalog',
              });
            } finally {
              this.orgProjectBroadcasts.delete(snapshot.context);
            }
          },
        ),
      'org-projects.setup-progress': (handler) =>
        channels.listen(
          C.orgProjectsSetupProgress,
          isOrgProjectSetupProgress,
          (progress) => handler({ progress, occurredAt: progress.updatedAt }),
        ),
      'scriptActions.changed': (handler, filter) =>
        channels.listen(
          C.scriptActionsChanged,
          isScriptActionsContext,
          (context) => {
            if (
              (filter?.projectId !== undefined &&
                filter.projectId !== context.projectId) ||
              (filter?.worktreeId !== undefined &&
                filter.worktreeId !== context.worktreeId)
            )
              return;
            handler({ ...context, occurredAt: this.now() });
          },
        ),
      // The local desktop's link is always active: emit once and hand back a
      // no-op unsubscribe. Remote transports supply their own status.
      'connection.status': (handler) => {
        if (this.ports.subscribeConnectionStatus) {
          return this.ports.subscribeConnectionStatus(handler);
        }
        handler({ status: 'active', occurredAt: this.now() });
        return noopUnsubscribe;
      },
      'session.snapshot-stale': (handler) =>
        channels.listen(C.desktopSessionSnapshotStale, anyPayload, () => {
          handler({ occurredAt: this.now() });
        }),
      'chat.message': (handler, filter) =>
        subscribeChatMessages(
          {
            subscribeChatEvents: this.subscribeChatEvents,
            isCoworkChatTarget:
              this.ports.isCoworkChatTarget ??
              ((projectId): boolean =>
                projectId === STANDALONE_CHAT_PROJECT_ID),
            ...(this.ports.toolFamilyFor !== undefined
              ? { toolFamilyFor: this.ports.toolFamilyFor }
              : {}),
            now: this.now,
          },
          handler,
          filter,
        ),
    };
  }

  query<K extends QueryName>(
    name: K,
    args: QueryMap[K]['args'],
  ): Promise<QueryMap[K]['result']> {
    return this.queryHandlers[name](args);
  }

  command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']> {
    return this.commandHandlers[name](args);
  }

  subscribe<K extends DomainEventName>(
    name: K,
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe {
    return this.subscribeHandlers[name](handler, filter);
  }
}

/**
 * A `CanopyClient` over `transport`, with host services from `ports`. The
 * transport must not replay an invoke after a disconnect (see
 * `RemoteIpcTransport`); this adapter never retries a call either.
 */
export function createIpcCanopyClient(
  transport: RemoteIpcTransport,
  ports: IpcCanopyClientPorts,
): CanopyClient {
  return new PortableIpcCanopyClient(transport, ports);
}
