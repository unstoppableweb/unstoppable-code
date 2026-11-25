/**
 * Golden: the portable CanopyClient adapter (`@canopy/ipc-canopy-client`).
 *
 * Every `QueryMap`, `CommandMap` and `DomainEventMap` operation runs over a
 * fake `RemoteIpcTransport`. The scenario tables are mapped types over those
 * maps, so a new operation fails to compile until it has scenarios, and the
 * runtime check keeps them equal to the protocol's per-operation channel
 * manifest. Each scenario pins the channels and arguments sent and the result
 * or error returned; conditional branches have one scenario each. Every
 * observed channel must be in the operation's manifest entry, and every
 * manifest channel must be observed, so the manifest that controller
 * allowlists derive from cannot drift from the adapter.
 */
import type {
  CanopyCapabilities,
  ChatTabSettings,
  CommandMap,
  CommandName,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  ShellCommandName,
  ShellQueryName,
} from '@canopy/app-core';
import {
  FileSaveConflictError,
  OrganizationOperationFailure,
} from '@canopy/app-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { INSTALLED_ITEM_CHANNELS } from '@canopy/desktop-shared/types/installed-items';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { IpcAppErrorRejection } from '@canopy/protocol/app-errors/ipc-rejection';
import {
  REMOTE_COMMAND_CHANNELS,
  REMOTE_EVENT_CHANNELS,
  REMOTE_IPC_CHANNELS,
  REMOTE_MEMBER_CHANNELS,
  REMOTE_QUERY_CHANNELS,
  deriveRemoteIpcChannels,
  remoteOperationChannelUse,
  type RemoteIpcChannel,
  type RemoteIpcChannelKey,
  type RemoteOperationChannels,
} from '@canopy/protocol/remote-control/channels';
import type { RemoteControlPrActionPayload } from '@canopy/protocol/remote-control/shell';
import {
  channelUnavailableMessage,
  CHANNEL_UNAVAILABLE_CODE,
  RemoteChannelUnavailableError,
  type RemoteIpcTransport,
} from '@canopy/protocol/remote-control';
import { SCRIPT_ACTIONS_CHANNELS } from '@canopy/protocol/script-actions';
import {
  ChatHistoryCursorError,
  RemoteIpcChannelUnauthorizedError,
  RemoteHostOutdatedError,
  RemoteIpcMalformedReplyError,
  UnsupportedOperationError,
  capabilityLimitForChannels,
  createIpcCanopyClient,
  intersectCanopyCapabilities,
  type IpcCanopyClientPorts,
} from '../index';
import { isRecord } from '../decoders';

const C = REMOTE_IPC_CHANNELS;

// ---------------------------------------------------------------------------
// Channel constants: one value with the desktop catalogs, at type and runtime.
// ---------------------------------------------------------------------------

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type DesktopCatalogKey = Exclude<
  RemoteIpcChannelKey,
  | `pipelines${string}`
  | `scriptActions${string}`
  | keyof typeof MARKETPLACE_KEYS
>;
type CatalogEquality = {
  [K in DesktopCatalogKey]: Equal<
    (typeof REMOTE_IPC_CHANNELS)[K],
    (typeof IPC_CHANNELS)[K]
  >;
};
const catalogTypesMatch: CatalogEquality[DesktopCatalogKey] = true;
const pipelineTypesMatch: Equal<
  typeof REMOTE_IPC_CHANNELS.pipelinesExecute,
  typeof PIPELINE_CHANNELS.EXECUTE
> = true;
const queryKeysMatch: Equal<keyof typeof REMOTE_QUERY_CHANNELS, QueryName> =
  true;
const commandKeysMatch: Equal<
  keyof typeof REMOTE_COMMAND_CHANNELS,
  CommandName
> = true;
const eventKeysMatch: Equal<
  keyof typeof REMOTE_EVENT_CHANNELS,
  DomainEventName
> = true;

// Installed-item and plugin install channels live in their own desktop
// catalogs (CAN-7442).
const MARKETPLACE_KEYS = {
  installedItemsListStatus: INSTALLED_ITEM_CHANNELS.LIST_STATUS,
  installedItemsSetStatus: INSTALLED_ITEM_CHANNELS.SET_STATUS,
  installedItemsUninstall: INSTALLED_ITEM_CHANNELS.UNINSTALL,
  installedItemsChanged: INSTALLED_ITEM_CHANNELS.CHANGED,
  pluginsInstallPlugin: PLUGINS_CHANNELS.INSTALL_PLUGIN,
  pluginsInstallBuiltInPlugin: PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
} as const;
const marketplaceTypesMatch: {
  [K in keyof typeof MARKETPLACE_KEYS]: Equal<
    (typeof REMOTE_IPC_CHANNELS)[K],
    (typeof MARKETPLACE_KEYS)[K]
  >;
}[keyof typeof MARKETPLACE_KEYS] = true;

const PIPELINE_KEYS = {
  pipelinesDiscoverProject: PIPELINE_CHANNELS.DISCOVER_PROJECT,
  pipelinesGet: PIPELINE_CHANNELS.GET,
  pipelinesExecute: PIPELINE_CHANNELS.EXECUTE,
  pipelinesExecutionEvent: PIPELINE_CHANNELS.EXECUTION_EVENT,
  pipelinesCancelExecution: PIPELINE_CHANNELS.CANCEL_EXECUTION,
  pipelinesCuratedImport: PIPELINE_CHANNELS.CURATED_IMPORT,
  pipelinesGetForWorktree: PIPELINE_CHANNELS.GET_FOR_WORKTREE,
  pipelinesGetWorktreeExecution: PIPELINE_CHANNELS.GET_WORKTREE_EXECUTION,
  pipelinesListWorktreeExecutions: PIPELINE_CHANNELS.LIST_WORKTREE_EXECUTIONS,
  pipelinesReadStepLog: PIPELINE_CHANNELS.READ_STEP_LOG,
  pipelinesRerunExecution: PIPELINE_CHANNELS.RERUN_EXECUTION,
  pipelinesResume: PIPELINE_CHANNELS.RESUME,
  pipelinesRetryExecution: PIPELINE_CHANNELS.RETRY_EXECUTION,
} as const;

// ---------------------------------------------------------------------------
// Fake transport and fixtures.
// ---------------------------------------------------------------------------

type Reply = (...args: unknown[]) => unknown;
type Replies = Partial<Record<string, Reply>>;

interface Call {
  readonly channel: string;
  readonly args: readonly unknown[];
}

interface FakeTransport {
  readonly transport: RemoteIpcTransport;
  readonly calls: Call[];
  readonly listened: string[];
  emit(channel: string, ...payload: unknown[]): void;
  listenerCount(channel: string): number;
}

const NOW = '2026-11-08T00:00:00.000Z';
const WORKTREE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const CATALOG = {
  context: 'personal',
  revision: 'r1',
  fetchedAt: NOW,
  stale: false,
  error: null,
  projects: [],
};
const CONTEXT_STATE = {
  context: { kind: 'personal' },
  revision: 3,
  organizations: [],
};
const SETUP_PROGRESS = {
  projectId: 'org-project-1',
  instanceId: null,
  state: 'materializing',
  message: null,
  percent: 40,
  updatedAt: NOW,
};
const PLAN = {
  id: 'plan-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  source: 'claude',
  title: 'Plan',
  content: 'v2 body',
  reviewStatus: 'pending',
  updatedAt: NOW,
  latestRevisionNumber: 2,
  revisions: [
    {
      revisionNumber: 1,
      content: 'v1 body',
      source: 'claude',
      reviewStatus: 'approved',
      approvedAt: NOW,
    },
    {
      revisionNumber: 2,
      content: 'v2 body',
      source: 'claude',
      reviewStatus: 'pending',
    },
  ],
};
const PROJECTS = {
  items: [
    {
      id: 'single',
      type: 'single-repo',
      repoPath: '/repos/single',
      worktrees: [
        { id: 'wt-a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'wt-b' },
      ],
    },
    {
      id: 'multi',
      type: 'multi-repo',
      worktrees: [{ id: 'wt-a' }, { id: 'wt-b' }],
    },
    { id: 'cowork', type: 'cowork' },
  ],
};
const TRANSCRIPT_PAGE = {
  messages: [
    {
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Hello' }],
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'Hi there' }],
    },
  ],
  before: 40,
  totalMessages: 42,
  transcriptRevision: 7,
};

/** A host clone job, as `clone-jobs:list` answers it (CAN-7433). */
const HOST_CLONE_JOB = {
  id: 'job-1',
  repoName: 'canopy',
  remoteUrl: '',
  destinationPath: '/Users/someone/code/canopy',
  status: 'running',
  phase: 'receiving',
  phasePercent: 40,
  percent: 30,
  processedCount: 4,
  totalCount: 10,
  received: '1.00 MiB',
  throughput: '1.00 MiB/s',
  startedAt: 1,
  background: true,
  cancellable: true,
  workspaceId: null,
  workspaceName: 'canopy',
  error: null,
};
const PORTABLE_CLONE_JOB = {
  id: 'job-1',
  repoName: 'canopy',
  workspaceName: 'canopy',
  status: 'running',
  error: null,
  background: true,
  cancellable: true,
};
/** A quota projection, as `provider-usage:*` answers it (CAN-7433). */
const PROVIDER_USAGE = {
  updatedAt: NOW,
  providers: [
    { provider: 'claude', authState: 'authenticated', windows: [] },
    { provider: 'codex', authState: 'unknown', windows: [] },
  ],
};

const DEFAULT_REPLIES: Replies = {
  [C.homeListBranchTargets]: () => ({
    supported: true,
    branches: [],
    defaultBranch: null,
  }),
  [C.projectsLoad]: () => PROJECTS,
  [C.fileTreeRoots]: () => ({
    roots: [{ repoId: 'repo-1', repoName: 'Repo', absolutePath: '/root/' }],
  }),
  [C.fileTreeDirectory]: () => ({
    entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
  }),
  [C.fileIndexGet]: () => ({
    repos: [
      {
        repoId: 'repo-1',
        files: [{ relativePath: 'src/App.ts' }, { relativePath: 'README.md' }],
      },
    ],
  }),
  [C.fileReadContent]: () => ({
    kind: 'text',
    content: 'body',
    sizeBytes: 4,
    modifiedAtMs: 1_000,
    truncated: false,
    canonical: {
      fileRootId: 'repo-1',
      sizeBytes: 4,
      version: 'v1',
      truncated: false,
      modifiedAt: NOW,
    },
  }),
  [C.fileSaveContent]: () => ({ sizeBytes: 9, modifiedAtMs: 2_000 }),
  [C.fileReferenceResolve]: () => ({
    canonical: {
      kind: 'file',
      fileRootId: 'repo-1',
      relativePath: 'src/App.ts',
    },
  }),
  [C.activityFileDiff]: () => ({
    oldValue: 'one\ntwo\n',
    newValue: 'one\nthree\n',
    filePath: 'src/App.ts',
    source: 'uncommitted',
    truncated: false,
    binary: false,
  }),
  [C.chatGetTranscriptPage]: () => TRANSCRIPT_PAGE,
  [C.chatCommand]: () => ({ commandId: 'c', revision: 1, outcome: 'applied' }),
  [C.trackedPlansGet]: () => PLAN,
  [C.trackedPlansUpdate]: () => PLAN,
  [C.workspaceContextGet]: () => CONTEXT_STATE,
  [C.workspaceContextSet]: () => CONTEXT_STATE,
  [C.orgProjectsList]: () => CATALOG,
  [C.orgProjectsRefresh]: () => CATALOG,
  [C.orgProjectsSetPreference]: () => CATALOG,
  [C.orgProjectsSetupStart]: () => SETUP_PROGRESS,
  [C.personalOrganizationUpgradeList]: () => ({ projects: [] }),
  [C.personalOrganizationUpgradeStatus]: () => null,
  [C.personalOrganizationUpgradeInviteStatus]: () => ({ status: 'not-found' }),
  [C.terminalList]: () => [
    { id: 't1', ...WORKTREE },
    { id: 't2', projectId: 'project-1', worktreeId: 'other' },
  ],
  [C.terminalLoadWorktreeState]: () => ({ state: null }),
  [C.terminalSpawn]: () => ({ id: 't3', ...WORKTREE }),
  [C.pipelinesDiscoverProject]: () => ({
    success: true,
    data: [{ id: 'pipeline-1', filePath: '/wt/.canopy/p.yml' }],
  }),
  [C.pipelinesGet]: () => ({ success: true, data: { content: 'name: p' } }),
  [C.pipelinesExecute]: () => ({ success: true }),
  [C.pipelinesCancelExecution]: () => ({ success: true }),
  [C.worktreeGetPath]: () => '/wt',
  [C.repoDefaultCloneDir]: () => '/clones',
  [C.workspaceAddFromRemote]: () => ({ id: 'new-workspace' }),
  [C.worktreeCreate]: () => ({ id: 'wt-new', branchName: 'branch-new' }),
  [C.workspaceCreateWorktree]: () => ({
    id: 'wt-new',
    branchName: 'branch-new',
  }),
  [C.worktreeListRepoEntries]: () => [
    { repoId: 'repo-1', repoName: 'One' },
    { repoId: 'repo-2', repoName: 'Two' },
  ],
  [C.githubCommitAndPush]: () => ({
    failedRepos: [],
    agentResolutionRepos: [],
  }),
  [C.preferencesLoad]: () => ({
    onboardingTipsDismissed: {},
    suggestions: { enabled: true, dismissed: {} },
  }),
  [C.preferencesLoadOnboardingTips]: () => ({ dismissed: {} }),
  [C.preferencesLoadSuggestions]: () => ({ enabled: true, dismissed: {} }),
  [C.turnFeedbackRate]: () => ({ feedbackId: 'feedback-1' }),
  [C.desktopSessionSnapshot]: () => ({ workspaces: [] }),
  [C.managedDelegationLifetimeStatus]: () => ({ kind: 'unsupported' }),
  [C.managedDelegationExtendLifetimeLimit]: () => ({ ok: true }),
  [C.repoRulesScan]: () => ({ rules: [] }),
  [C.repoRulesStatus]: () => ({ status: 'none' }),
  [C.repoRulesCheck]: () => ({ blocked: [] }),
  [C.repoRulesPreview]: () => ({ files: [] }),
  [C.repoRulesApply]: () => ({ applied: true }),
  [C.editorSetupPresence]: () => ({ present: false }),
  [C.claudeModsGet]: () => ({ enabled: true }),
  [C.workspaceLoadClaudeMd]: () => '# Instructions',
  [C.scriptActionsList]: () => ({ ok: true, value: null }),
  [C.scriptActionsReceipt]: () => ({ ok: true, value: null }),
  [C.cloneJobsList]: () => [HOST_CLONE_JOB],
  [C.providerUsageLoad]: () => PROVIDER_USAGE,
  [C.providerUsageRefresh]: () => PROVIDER_USAGE,
  [C.orgProjectsFindRepositoryOwner]: () => ({ kind: 'none' }),
};

function fakeTransport(replies: Replies = {}): FakeTransport {
  const calls: Call[] = [];
  const listened: string[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const transport: RemoteIpcTransport = {
    invoke: (channel, ...args) => {
      calls.push({ channel, args });
      const reply = replies[channel] ?? DEFAULT_REPLIES[channel];
      try {
        return Promise.resolve(reply ? reply(...args) : undefined);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    send: (channel, ...args) => {
      calls.push({ channel, args });
    },
    on: (channel, listener) => {
      listened.push(channel);
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return (): void => {
        set.delete(listener);
      };
    },
  };
  return {
    transport,
    calls,
    listened,
    emit: (channel, ...payload): void => {
      for (const listener of Array.from(listeners.get(channel) ?? [])) {
        listener(...payload);
      }
    },
    listenerCount: (channel): number => listeners.get(channel)?.size ?? 0,
  };
}

const PENDING_ARCHIVE_RECOVERY = [
  {
    operationId: '12345678-1234-4234-8234-123456789abc',
    confirmation: 'a'.repeat(64),
  },
];

const VISUAL_SHA = 'a'.repeat(64);
const VISUAL_READ = {
  ...WORKTREE,
  chatId: 'chat-1',
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-4000-8000-000000000000',
    artifactId: `sha256-v1-${VISUAL_SHA}`,
    byteLength: 4,
    sha256: VISUAL_SHA,
    mediaType: 'text/html',
    title: 'Visual',
    maxHeight: 400,
  },
  offset: 0,
  limit: 4,
} as const;
const VISUAL_RANGE = {
  data: 'PHA+',
  offset: 0,
  length: 3,
  byteLength: 4,
  sha256: VISUAL_SHA,
};

const CAPABILITIES: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  worktreeRecovery: true,
  worktreeRecoveryResolution: true,
  worktreeRecoveryReads: true,
};

interface Harness {
  readonly fake: FakeTransport;
  readonly client: ReturnType<typeof createIpcCanopyClient>;
  readonly forks: unknown[];
  readonly logged: string[];
  /** Files the upload port stored, as [fileName, byte length]. */
  readonly uploads: (readonly [string, number])[];
  /** Answers the secret request port took. */
  readonly secretAnswers: unknown[];
}

function harness(
  replies: Replies = {},
  ports: Partial<IpcCanopyClientPorts> = {},
): Harness {
  const fake = fakeTransport(replies);
  const forks: unknown[] = [];
  const logged: string[] = [];
  const uploads: (readonly [string, number])[] = [];
  const secretAnswers: unknown[] = [];
  const client = createIpcCanopyClient(fake.transport, {
    capabilities: CAPABILITIES,
    // The App Advisor surface shares the fake, so its calls and listeners
    // are attributed like any other.
    appAdvisorTransport: fake.transport,
    uploadFile: (fileName, bytes) => {
      uploads.push([fileName, bytes.byteLength]);
      return Promise.resolve(`/uploads/${fileName}`);
    },
    settleSecretRequest: (params) => {
      secretAnswers.push(params);
      return Promise.resolve({ accepted: true });
    },
    openExternalUrl: () => undefined,
    now: () => NOW,
    randomId: () => 'random-id',
    workspaceContext: () => ({ kind: 'personal' }),
    forkWorktreeState: (request) => {
      forks.push(request);
      return Promise.resolve();
    },
    logError: (message) => {
      logged.push(message);
    },
    resolveLocalFileRoot: (rootId) =>
      rootId === 'archive'
        ? { repoId: 'archive', repoName: 'Archive', absolutePath: '/archive' }
        : undefined,
    ...ports,
  });
  return { fake, client, forks, logged, uploads, secretAnswers };
}

/** An opaque argument the adapter must pass through unchanged. */
function opaque<T>(label: string): T {
  const value: unknown = { opaque: label };
  return value as T;
}

// ---------------------------------------------------------------------------
// Scenario tables: mapped over QueryMap, CommandMap and DomainEventMap.
// ---------------------------------------------------------------------------

interface Scenario<Args, Result> {
  readonly name: string;
  readonly args: Args;
  readonly replies?: Replies;
  readonly ports?: Partial<IpcCanopyClientPorts>;
  /** Channels and arguments, in order. Omit to check channels only. */
  readonly calls?: readonly Call[];
  /** Channels only, in order. */
  readonly channels?: readonly string[];
  readonly result?: (value: Result, context: Harness) => void;
  readonly rejects?: RegExp | (abstract new (...args: never[]) => Error);
  /**
   * Earlier work in the same client (an upload, a question that arrived).
   * Its calls and listeners are not attributed to the operation.
   */
  readonly before?: (context: Harness) => Promise<void>;
}

type QueryScenarios = {
  [K in QueryName]: readonly Scenario<
    QueryMap[K]['args'],
    QueryMap[K]['result']
  >[];
};
type CommandScenarios = {
  [K in CommandName]: readonly Scenario<
    CommandMap[K]['args'],
    CommandMap[K]['result']
  >[];
};

const call = (channel: string, ...args: unknown[]): Call => ({ channel, args });

function passthroughQuery<K extends QueryName>(
  channel: string,
  label: string,
): readonly Scenario<QueryMap[K]['args'], QueryMap[K]['result']>[] {
  const args = opaque<QueryMap[K]['args']>(label);
  return [
    { name: 'passes arguments through', args, calls: [call(channel, args)] },
  ];
}

function passthroughCommand<K extends CommandName>(
  channel: string,
  label: string,
): readonly Scenario<CommandMap[K]['args'], CommandMap[K]['result']>[] {
  const args = opaque<CommandMap[K]['args']>(label);
  return [
    { name: 'passes arguments through', args, calls: [call(channel, args)] },
  ];
}

const NO_ARGS: Record<string, never> = {};

// Installed items and plugin installs (CAN-7442).
const PLUGIN_TARGET = {
  kind: 'plugin',
  marketplaceId: 'acme',
  pluginName: 'lint',
} as const;
const INSTALLED_SNAPSHOT = {
  items: [
    {
      target: PLUGIN_TARGET,
      status: 'active',
      removable: true,
      uninstallTarget: PLUGIN_TARGET,
      notices: [],
    },
  ],
};
const MUTATION_RESULT = {
  success: true,
  requestedStatus: 'disabled',
  snapshot: INSTALLED_SNAPSHOT,
  removed: [],
  errors: [],
};
const INSTALLED_PLUGIN = {
  name: 'lint',
  marketplaceId: 'acme',
  version: '1.0.0',
  providerSupport: { claude: 'native', codex: 'none' },
};
const CURATED_PLUGIN = {
  name: 'notes',
  marketplaceId: 'curated/cloud',
  curated: true,
};
const SOURCE_MISMATCH =
  'Remote control can only install this plugin from the source this computer has for it. Refresh its marketplace on this computer, then try again.';
const hostRefusesChannel =
  (channel: string): Reply =>
  () => {
    throw new RemoteChannelUnavailableError(channel);
  };

/**
 * A narrow tips or suggestions read (CAN-7434): the narrow channel only; an
 * older host's refusal of that channel falls back to `preferences:load` for a
 * client served the full preferences, and nothing else falls back.
 */
function narrowPreferenceScenarios<
  K extends 'onboardingTips.get' | 'suggestions.get',
>(
  channel: RemoteIpcChannel,
  cases: {
    readonly reply: unknown;
    readonly expected: QueryMap[K]['result'];
    readonly olderHostExpected: QueryMap[K]['result'];
    readonly olderHostFailures: readonly {
      readonly name: string;
      readonly reply: unknown;
      readonly rejects: RegExp;
    }[];
  },
): readonly Scenario<QueryMap[K]['args'], QueryMap[K]['result']>[] {
  const args: QueryMap[K]['args'] = NO_ARGS;
  // What a desktop remote window sees: Electron's wrapper keeps the text only.
  const wrappedRefusal = (): never => {
    throw new Error(
      `Error invoking remote method '${channel}': Error: ${channelUnavailableMessage(channel)}`,
    );
  };
  const olderHost = [call(channel), call(C.preferencesLoad, undefined)];
  return [
    {
      name: 'reads only the narrow channel',
      args,
      replies: { [channel]: () => cases.reply },
      calls: [call(channel)],
      result: (value) => expect(value).toEqual(cases.expected),
    },
    {
      name: 'falls back to preferences:load when an older host refuses the channel (Electron-wrapped)',
      args,
      replies: { [channel]: wrappedRefusal },
      calls: olderHost,
      result: (value) => expect(value).toEqual(cases.olderHostExpected),
    },
    {
      name: 'falls back to preferences:load when an older host refuses the channel (with its code)',
      args,
      replies: {
        [channel]: () => {
          throw new RemoteChannelUnavailableError(channel);
        },
      },
      calls: olderHost,
      result: (value) => expect(value).toEqual(cases.olderHostExpected),
    },
    ...cases.olderHostFailures.map(
      (failure): Scenario<QueryMap[K]['args'], QueryMap[K]['result']> => ({
        name: `older host: ${failure.name}`,
        args,
        replies: {
          [channel]: wrappedRefusal,
          [C.preferencesLoad]: () => failure.reply,
        },
        calls: olderHost,
        rejects: failure.rejects,
      }),
    ),
    {
      name: "does not fall back on a current host's refusal",
      args,
      replies: {
        [channel]: () => {
          throw Object.assign(
            new Error(
              'The settings are unavailable because preferences could not be loaded.',
            ),
            { code: 'core.config.invalidState' },
          );
        },
      },
      calls: [call(channel)],
      rejects: /preferences could not be loaded/,
    },
    {
      name: 'does not fall back on a refusal naming another channel',
      args,
      replies: {
        [channel]: () => {
          throw new Error(channelUnavailableMessage(C.preferencesLoad));
        },
      },
      calls: [call(channel)],
      rejects: /not available while controlling another computer/,
    },
    {
      name: 'never falls back for a client not served the full preferences',
      args,
      replies: {
        [channel]: () => {
          throw Object.assign(new Error(channelUnavailableMessage(channel)), {
            code: CHANNEL_UNAVAILABLE_CODE,
          });
        },
      },
      ports: {
        capabilities: { ...CAPABILITIES, settingsScope: 'api-keys-only' },
      },
      calls: [call(channel)],
      rejects: /not available while controlling another computer/,
    },
    {
      name: 'rejects a malformed narrow reply without falling back',
      args,
      replies: { [channel]: () => ({ dismissed: 'nope', enabled: 'nope' }) },
      calls: [call(channel)],
      rejects: RemoteIpcMalformedReplyError,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shell commands (CAN-5985): Portal command payloads plus a navigation target.
// ---------------------------------------------------------------------------

const SHELL_TARGET = {
  workspaceLocalId: 'project-1',
  worktreeLocalId: 'worktree-1',
};
const CHAT = { ...WORKTREE, chatId: 'chat-1' };
const COWORK_CHAT = {
  localId: 'chat-s',
  projectLocalId: 'cowork',
  workEntryId: 'entry-1',
};
const STANDALONE_SNAPSHOT = { standaloneChats: [COWORK_CHAT] };
const COWORK_TARGET = { projectId: 'cowork', worktreeId: 'entry-1' };
/** The web row's archive request for {@link COWORK_CHAT}. */
const STANDALONE_ARCHIVE = {
  chatId: 'chat-s',
  projectLocalId: 'cowork',
  workEntryId: 'entry-1',
};
/** The snapshot lists live chats only: an archived chat is absent from it. */
const ARCHIVED_SNAPSHOT = { standaloneChats: [] };
/** The project's archived list with {@link COWORK_CHAT}'s Work Entry locked. */
const LOCKED_ARCHIVE_LIST = {
  items: [{ id: 'entry-1', title: 'Chat', state: 'archived' }],
  nextOffset: null,
};
const EMPTY_ARCHIVE_LIST = { items: [], nextOffset: null };
/** Each snapshot read answers the next value; the last one repeats. */
function snapshotsInTurn(...snapshots: readonly unknown[]): Reply {
  let read = 0;
  return () => snapshots[Math.min(read++, snapshots.length - 1)];
}
/** The standalone target a Cowork composer sends for its `/` menu. */
const STANDALONE_INVOCABLE_TARGET = {
  kind: 'standalone',
  projectLocalId: COWORK_CHAT.projectLocalId,
  chatId: COWORK_CHAT.localId,
} as const;
const MODEL_REGISTRY = {
  claude: [{ id: 'opus' }],
  codex: [{ id: 'gpt' }],
  ollama: [],
  agents: [{ id: 'agent-x', baseModel: 'opus' }],
  aliases: { latest: 'gpt' },
};
const SELECTIONS = { collectionIds: [], skillRefs: [], pluginRefs: [] };
/** Portal's first-message withdrawal, which carries a field the type omits. */
const WITHDRAW_FIRST_MESSAGE = { ...CHAT, withdrawFirstMessage: true };

/**
 * The withdrawal the web shell sends: only its chat, with the worktree in the
 * navigation target (the payload type names fields it does not carry).
 */
function shellWithdrawal(
  mode?: 'dismiss',
): CommandMap['chat.cancel']['args']['payload'] {
  const value: unknown = {
    chatId: 'chat-1',
    withdrawFirstMessage: true,
    ...(mode === undefined ? {} : { firstMessageWithdrawalMode: mode }),
  };
  return value as CommandMap['chat.cancel']['args']['payload'];
}
const REFUSED = {
  commandId: 'c',
  revision: 1,
  outcome: 'rejected',
  reason: 'The chat is busy.',
};
/** The Orchestrator's Work Entries and one entry's tabs (`app-advisor`). */
const ADVISOR_TARGET = { projectId: 'app-advisor', worktreeId: 'entry-a' };
const WORK_ENTRIES = {
  entries: [
    {
      id: 'entry-a',
      title: 'Plan the trip',
      createdAt: NOW,
      lastMessageAt: NOW,
      unreadChats: [{ chatId: 'adv-2' }],
    },
  ],
};
const ADVISOR_STATE = {
  tabsFile: {
    activeTabId: 'adv-1',
    tabs: [
      {
        id: 'adv-1',
        title: 'First',
        createdAt: NOW,
        model: 'opus',
        providerType: 'claude',
        transcript: { messageCount: 2 },
      },
      { id: 'adv-2', title: 'Second', createdAt: NOW },
      { id: 'file-1', kind: 'file', title: 'notes.md' },
    ],
  },
  runtimeByChatId: { 'adv-1': { status: 'streaming' } },
};
const ADVISOR_REPLIES: Replies = {
  [C.workEntriesList]: () => WORK_ENTRIES,
  [C.chatGetState]: () => ADVISOR_STATE,
};
const ADVISOR_QUESTION = {
  question: 'Which city?',
  options: ['Paris', 'Rome'],
};
/** An uploaded attachment the composer sends by its minted reference. */
const UPLOADED_ATTACHMENT = {
  attachmentId: 'direct-upload-1',
  filename: 'notes.txt',
  mediaType: 'text/plain',
  size: 5,
  contentSha256: 'a'.repeat(64),
  storageKind: 'blob' as const,
  source: 'direct-upload',
};
/** One worktree's panel entities, as `worktree:activity-entities` serves them. */
const ACTIVITY_ENTITIES = {
  entities: [
    {
      entityType: 'plan',
      localId: 'plan-1',
      parentLocalId: 'project-1:worktree-1',
      payload: { title: 'Plan' },
    },
    {
      entityType: 'hook_run',
      localId: 'run-1',
      payload: { status: 'running' },
    },
  ],
};
/** The Orchestrator settings view (`app-advisor:settings-view`). */
const ADVISOR_SETTINGS = {
  model: 'opus',
  thinkingLevel: 'medium',
  pluginSelections: SELECTIONS,
  instructions: '',
  archiveRetentionDays: null,
  autoArchiveDays: null,
  availableModels: [],
};
const RESOLVED_INVOCABLE = {
  insertText: '/review ',
  invocationKey: 'plugin:review',
};

/** Uploads `notes.txt` through this client, minting `direct-upload-1`. */
async function uploadNotes(context: Harness): Promise<void> {
  await context.client.command('chat.attachments.upload', {
    workspaceLocalId: 'project-1',
    chatId: 'chat-1',
    fileName: 'notes.txt',
    mediaType: 'text/plain',
    bytes: new Uint8Array([104, 101, 108, 108, 111]),
    contentSha256: 'a'.repeat(64),
  });
}

/** Subscribes to the Orchestrator and delivers question `req-1` for `adv-1`. */
function holdQuestion(context: Harness): Promise<void> {
  context.client.subscribe('appAdvisor.changed', () => undefined);
  context.fake.emit(C.appAdvisorToolRequest, {
    requestId: 'req-1',
    kind: 'ask_user_question',
    chatId: 'adv-1',
    question: ADVISOR_QUESTION,
  });
  return Promise.resolve();
}

/** The `chat:command` envelope a shell command sends. */
function chatEnvelope(
  target: { readonly projectId: string; readonly worktreeId: string },
  command: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Call {
  return call(C.chatCommand, {
    schemaVersion: 1,
    commandId: 'random-id',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    ...extra,
    command,
  });
}

function expectAccepted(
  value: { readonly ok?: boolean; readonly error?: string },
  result?: Record<string, unknown>,
): void {
  expect(value.ok).toBe(true);
  expect(value.error).toBeUndefined();
  if (result !== undefined) {
    expect(Reflect.get(value, 'result')).toEqual(
      expect.objectContaining(result),
    );
  }
}

function expectRefused(
  value: { readonly ok?: boolean; readonly error?: string },
  error: RegExp,
): void {
  expect(value.ok).toBe(false);
  expect(value.error).toMatch(error);
}

type ShellQueryScenarios = Pick<QueryScenarios, ShellQueryName>;
type ShellCommandScenarios = Pick<CommandScenarios, ShellCommandName>;

const SHELL_QUERY_SCENARIOS: ShellQueryScenarios = {
  'editor.fileMentions': [
    {
      name: 'searches the file index under each root',
      args: { payload: { ...WORKTREE, query: 'app' }, target: SHELL_TARGET },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileIndexGet, { ...WORKTREE, purpose: 'mentions' }),
      ],
      result: (value) =>
        expectAccepted(value, {
          files: [
            {
              referenceId: 'direct-ref-1',
              repoId: 'repo-1',
              repoName: 'Repo',
              relativePath: 'src/App.ts',
              filename: 'App.ts',
              kind: 'file',
            },
          ],
        }),
    },
    {
      name: 'mints one selected folder from its root',
      args: {
        payload: {
          ...WORKTREE,
          selector: {
            repoId: 'repo-1',
            relativePath: 'docs',
            kind: 'directory',
          },
        },
        target: SHELL_TARGET,
      },
      calls: [call(C.fileTreeRoots, WORKTREE)],
      result: (value) =>
        expectAccepted(value, {
          files: [expect.objectContaining({ kind: 'directory' })],
        }),
    },
    {
      name: 'refuses to rebind references it did not mint',
      args: {
        payload: {
          ...WORKTREE,
          rebind: {
            sourceProjectId: 'p',
            sourceWorktreeId: 'w',
            fileReferences: [{ displayPath: 'a', referenceId: 'portal-ref' }],
          },
        },
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'editor.slashCommands': [
    {
      name: "reads the worktree's discovered commands",
      args: {
        payload: { ...WORKTREE, providerType: 'claude' },
        target: SHELL_TARGET,
      },
      replies: {
        [C.editorListSlashCommands]: () => ({
          commands: [{ name: 'review', description: 'Review' }],
        }),
      },
      calls: [
        call(C.editorListSlashCommands, {
          ...WORKTREE,
          providerType: 'claude',
        }),
      ],
      result: (value) =>
        expectAccepted(value, {
          commands: [{ name: 'review', description: 'Review' }],
        }),
    },
  ],
  'editor.invocables': [
    {
      name: "reads the chat's menu rows",
      args: {
        payload: { target: { kind: 'worktree', ...CHAT } },
        target: SHELL_TARGET,
      },
      replies: {
        [C.editorListInvocables]: () => ({
          commands: [{ name: 'review', section: 'discovered' }],
          stale: false,
          rebuilding: false,
        }),
      },
      calls: [
        call(C.editorListInvocables, { target: { kind: 'worktree', ...CHAT } }),
      ],
      result: (value) => {
        expectAccepted(value, {
          commands: [{ name: 'review', section: 'discovered' }],
          stale: false,
        });
        // An older host's reply has no Mod forecast, and gains none.
        expect(Reflect.get(value, 'result')).not.toHaveProperty('skippedMods');
      },
    },
    {
      name: "passes the chat's skipped-Mod forecast through unchanged (CAN-7436)",
      args: {
        payload: { target: { kind: 'worktree', ...CHAT } },
        target: SHELL_TARGET,
      },
      replies: {
        [C.editorListInvocables]: () => ({
          commands: [],
          stale: false,
          rebuilding: false,
          skippedMods: [{ pluginId: 'mod@market', reason: 'not-admitted' }],
        }),
      },
      calls: [
        call(C.editorListInvocables, { target: { kind: 'worktree', ...CHAT } }),
      ],
      result: (value) =>
        expectAccepted(value, {
          commands: [],
          skippedMods: [{ pluginId: 'mod@market', reason: 'not-admitted' }],
        }),
    },
    {
      name: "reads a Cowork chat's menu rows through its standalone target",
      args: {
        payload: { target: STANDALONE_INVOCABLE_TARGET },
        target: { workspaceLocalId: COWORK_CHAT.projectLocalId },
      },
      replies: {
        [C.editorListInvocables]: () => ({
          commands: [{ name: 'review', section: 'available' }],
          stale: false,
          rebuilding: false,
        }),
      },
      calls: [
        call(C.editorListInvocables, { target: STANDALONE_INVOCABLE_TARGET }),
      ],
      result: (value) =>
        expectAccepted(value, {
          commands: [{ name: 'review', section: 'available' }],
        }),
    },
  ],
  'editor.pluginCatalog': [
    {
      name: "reads the computer's plugin picker catalog",
      args: { payload: { ...WORKTREE }, target: SHELL_TARGET },
      replies: {
        [C.pluginCatalogList]: () => ({
          collections: [],
          skills: [],
          plugins: [],
          mcpServers: [],
        }),
      },
      calls: [call(C.pluginCatalogList, { projectId: 'project-1' })],
      result: (value) => expectAccepted(value, { skills: [], mcpServers: [] }),
    },
  ],
  'pipeline.get': [
    {
      name: "reads one pipeline's detail for the worktree",
      args: {
        payload: { pipelineId: 'pipeline-1', ...WORKTREE },
        target: SHELL_TARGET,
      },
      replies: {
        [C.pipelinesGetForWorktree]: () => ({ definition: { name: 'p' } }),
      },
      calls: [
        call(C.pipelinesGetForWorktree, {
          pipelineId: 'pipeline-1',
          ...WORKTREE,
        }),
      ],
      result: (value) => expectAccepted(value, { definition: { name: 'p' } }),
    },
  ],
  'pipeline.executions': [
    {
      name: "lists the worktree's runs, bounded by the limit",
      args: { payload: { ...WORKTREE, limit: 1 }, target: SHELL_TARGET },
      replies: {
        [C.pipelinesListWorktreeExecutions]: () => ({
          runs: [{ localId: 'run-1' }, { localId: 'run-2' }],
        }),
      },
      calls: [call(C.pipelinesListWorktreeExecutions, WORKTREE)],
      result: (value) =>
        expectAccepted(value, {
          runs: [{ localId: 'run-1' }],
          truncated: true,
        }),
    },
    {
      name: 'refuses without a worktree to read',
      args: { payload: {} },
      calls: [],
      result: (value) => expectRefused(value, /worktree/),
    },
  ],
  'pipeline.execution': [
    {
      name: "reads one run held to the shell's worktree",
      args: { payload: { executionId: 'run-1' }, target: SHELL_TARGET },
      replies: {
        [C.pipelinesGetWorktreeExecution]: () => ({ localId: 'run-1' }),
      },
      calls: [
        call(C.pipelinesGetWorktreeExecution, {
          ...WORKTREE,
          executionId: 'run-1',
        }),
      ],
      result: (value) => expectAccepted(value, { localId: 'run-1' }),
    },
    {
      name: 'reports a run the computer no longer has',
      args: { payload: { executionId: 'gone' }, target: SHELL_TARGET },
      replies: { [C.pipelinesGetWorktreeExecution]: () => null },
      channels: [C.pipelinesGetWorktreeExecution],
      result: (value) => expectRefused(value, /no longer available/),
    },
    {
      name: 'is refused without a worktree target',
      args: { payload: { executionId: 'run-1' } },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'workEntries.archived': [
    {
      name: "reads a cowork project's archive overview as Portal's result",
      args: {
        payload: { projectLocalId: 'cowork-1', offset: 0 },
        target: { workspaceLocalId: 'cowork-1' },
      },
      replies: {
        [C.workEntriesListArchived]: () => ({
          items: [
            {
              id: 'entry-1',
              title: 'Old task',
              state: 'archived',
              archivedAt: '2026-11-01T00:00:00.000Z',
            },
          ],
          nextOffset: null,
        }),
      },
      calls: [
        call(C.workEntriesListArchived, {
          projectLocalId: 'cowork-1',
          offset: 0,
        }),
      ],
      result: (value) =>
        expectAccepted(value, {
          items: [
            {
              id: 'entry-1',
              title: 'Old task',
              state: 'archived',
              archivedAt: '2026-11-01T00:00:00.000Z',
            },
          ],
          nextOffset: null,
        }),
    },
    {
      name: 'rejects a reply without items',
      args: { payload: { projectLocalId: 'cowork-1' } },
      replies: { [C.workEntriesListArchived]: () => ({ nextOffset: null }) },
      channels: [C.workEntriesListArchived],
      rejects: Error,
    },
  ],
};

const SHELL_COMMAND_SCENARIOS: ShellCommandScenarios = {
  'chat.send': [
    {
      name: 'sends to an existing chat with its composer settings',
      args: {
        payload: {
          ...CHAT,
          userMessageId: 'user-1',
          text: 'Hello',
          planMode: true,
          thinkingLevel: 'high',
          inputMode: 'typed',
          model: 'ignored-for-worktree-sends',
        },
        target: SHELL_TARGET,
      },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          text: 'Hello',
          modelConfig: { thinkingLevel: 'high' },
          planMode: true,
          inputMode: 'typed',
        }),
      ],
      result: (value) => {
        expectAccepted(value, { userMessageId: 'user-1', outcome: 'applied' });
        expect(value.chatId).toBe('chat-1');
      },
    },
    {
      name: 'creates the chat before a send without one',
      args: { payload: { ...WORKTREE, text: 'Hi' } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.create_tab',
          tabId: 'random-id',
        }),
        chatEnvelope(WORKTREE, {
          type: 'chat.send_message',
          chatId: 'random-id',
          userMessageId: 'random-id',
          text: 'Hi',
        }),
      ],
      result: (value) => expect(value.chatId).toBe('random-id'),
    },
    {
      name: 'reports a refusal as a receipt',
      args: { payload: { ...CHAT, text: 'Hi' } },
      replies: { [C.chatCommand]: () => REFUSED },
      channels: [C.chatCommand],
      result: (value) => expectRefused(value, /busy/),
    },
    {
      name: 'sends attachments it uploaded as their computer paths',
      before: uploadNotes,
      args: {
        payload: {
          ...CHAT,
          userMessageId: 'user-1',
          text: 'See file',
          cloudAttachments: [UPLOADED_ATTACHMENT],
        },
      },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          text: 'See file',
          attachmentPaths: ['/uploads/notes.txt'],
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'refuses attachments another client uploaded before the transport',
      args: {
        payload: {
          ...CHAT,
          text: 'Hi',
          cloudAttachments: [opaque('upload')],
        },
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'refuses a file reference it did not mint',
      args: {
        payload: {
          ...CHAT,
          text: 'Hi',
          fileReferences: [{ displayPath: 'a', referenceId: 'portal-ref' }],
        },
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'chat.cancel': [
    {
      name: 'stops the chat turn over chat:cancel',
      args: { payload: CHAT, target: SHELL_TARGET },
      replies: { [C.chatCancel]: () => ({}) },
      calls: [call(C.chatCancel, CHAT)],
      result: (value) => expectAccepted(value),
    },
    {
      name: "stops the first message's turn on the computer",
      args: { payload: shellWithdrawal(), target: SHELL_TARGET },
      replies: { [C.chatCancel]: () => ({}) },
      calls: [call(C.chatCancel, CHAT)],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'has nothing to take back when dismissing a message never sent',
      args: { payload: shellWithdrawal('dismiss'), target: SHELL_TARGET },
      calls: [],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'refuses a withdrawal without its worktree',
      args: { payload: WITHDRAW_FIRST_MESSAGE },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'chat.cancelTurn': [
    {
      name: 'stops exactly the named turn over chat:cancel',
      args: { payload: { ...CHAT, turnId: 'user-1' } },
      replies: { [C.chatCancel]: () => ({ outcome: 'turn_not_active' }) },
      calls: [call(C.chatCancel, { ...CHAT, expectedUserMessageId: 'user-1' })],
      result: (value) => expectAccepted(value, { outcome: 'turn_not_active' }),
    },
    {
      name: 'rejects a host without exact-turn stops',
      args: { payload: { ...CHAT, turnId: 'user-1' } },
      replies: { [C.chatCancel]: () => ({}) },
      channels: [C.chatCancel],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'chat.createTab': [
    {
      name: 'creates an empty tab',
      args: { payload: CHAT, target: SHELL_TARGET },
      calls: [
        chatEnvelope(WORKTREE, { type: 'chat.create_tab', tabId: 'chat-1' }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: "reads an initial model's provider from the registry",
      args: {
        payload: { ...CHAT, model: 'opus', pluginSelections: SELECTIONS },
      },
      replies: { [C.modelRegistryGet]: () => MODEL_REGISTRY },
      calls: [
        call(C.modelRegistryGet),
        chatEnvelope(WORKTREE, {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          model: 'opus',
          providerType: 'claude',
          pluginSelections: SELECTIONS,
        }),
      ],
    },
    {
      name: 'refuses a model the computer does not know',
      args: { payload: { ...CHAT, model: 'missing' } },
      replies: { [C.modelRegistryGet]: () => MODEL_REGISTRY },
      calls: [call(C.modelRegistryGet)],
      result: (value) => expectRefused(value, /isn't available/),
    },
  ],
  'chat.closeTab': [
    {
      name: 'archives a chat with messages at the read revision',
      args: { payload: CHAT, target: SHELL_TARGET },
      replies: {
        [C.chatGetState]: () => ({
          revision: 4,
          tabsFile: {
            tabs: [
              { id: 'chat-1', transcript: { messageCount: 3 } },
              { id: 'chat-2' },
            ],
          },
          runtimeByChatId: {},
        }),
      },
      calls: [
        call(C.chatGetState, WORKTREE),
        chatEnvelope(
          WORKTREE,
          { type: 'chat.close_tab', tabId: 'chat-1', mode: 'archive' },
          { expectedRevision: 4 },
        ),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'discards an empty last tab and replaces it',
      args: { payload: CHAT },
      replies: {
        [C.chatGetState]: () => ({
          tabsFile: { tabs: [{ id: 'chat-1', messages: [] }] },
        }),
      },
      calls: [
        call(C.chatGetState, WORKTREE),
        chatEnvelope(WORKTREE, {
          type: 'chat.close_tab',
          tabId: 'chat-1',
          mode: 'discard_empty',
          replacementTabId: 'random-id',
        }),
      ],
    },
    {
      name: 'refuses while the chat is working',
      args: { payload: CHAT },
      replies: {
        [C.chatGetState]: () => ({
          tabsFile: { tabs: [{ id: 'chat-1' }] },
          runtimeByChatId: { 'chat-1': { status: 'streaming' } },
        }),
      },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) => expectRefused(value, /active/),
    },
    {
      name: 'treats an unknown tab as closed',
      args: { payload: { ...WORKTREE, chatId: 'gone' } },
      replies: { [C.chatGetState]: () => ({ tabsFile: { tabs: [] } }) },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) => expectAccepted(value),
    },
  ],
  'chat.setModel': [
    {
      name: 'sets a model with its registry provider',
      args: { payload: { ...CHAT, model: 'gpt', executionHarness: 'codex' } },
      replies: { [C.modelRegistryGet]: () => MODEL_REGISTRY },
      calls: [
        call(C.modelRegistryGet),
        chatEnvelope(WORKTREE, {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'gpt',
          providerType: 'codex',
          executionHarness: 'codex',
        }),
      ],
    },
    {
      name: 'resolves an Agent through its base model',
      args: { payload: { ...CHAT, model: 'agent-x' } },
      replies: { [C.modelRegistryGet]: () => MODEL_REGISTRY },
      calls: [
        call(C.modelRegistryGet),
        chatEnvelope(WORKTREE, {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'agent-x',
          providerType: 'claude',
        }),
      ],
    },
    {
      name: 'retains a bare inheriting Agent and reads its destination provider with Portal off',
      args: { payload: { ...CHAT, model: 'agent_model_review' } },
      replies: {
        [C.modelRegistryGet]: () => ({
          ...MODEL_REGISTRY,
          agents: [{ id: 'agent_model_review', baseModel: 'default' }],
        }),
        [C.desktopSessionSnapshot]: () => ({
          availableModels: [
            { id: 'agent_model_review', provider: 'codex', available: true },
          ],
        }),
      },
      calls: [
        call(C.modelRegistryGet),
        call(C.desktopSessionSnapshot, { workspaceLocalId: 'project-1' }),
        chatEnvelope(WORKTREE, {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'agent_model_review',
          providerType: 'codex',
        }),
      ],
    },
    {
      name: 'resolves an Agent override on a gateway-only model without changing its route',
      args: { payload: { ...CHAT, model: 'agent_model_review@gateway-only' } },
      replies: {
        [C.modelRegistryGet]: () => ({
          ...MODEL_REGISTRY,
          agents: [{ id: 'agent_model_review', baseModel: 'default' }],
          aiGatewayModels: [
            { id: 'gateway-only', recommendedHarness: 'claude' },
          ],
        }),
      },
      calls: [
        call(C.modelRegistryGet),
        chatEnvelope(WORKTREE, {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'agent_model_review@gateway-only',
          providerType: 'claude',
        }),
      ],
    },
    {
      name: 'switches to Auto without a registry read',
      args: { payload: { ...CHAT, selectionMode: 'auto' } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelSelectionMode: 'auto' },
        }),
      ],
    },
  ],
  'chat.setThinkingLevel': [
    {
      name: 'patches the thinking level',
      args: { payload: { ...CHAT, thinkingLevel: 'high' } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { thinkingLevel: 'high' } },
        }),
      ],
    },
    {
      name: "refuses the cloud chats' default sentinel",
      args: { payload: { ...CHAT, thinkingLevel: 'default' } },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'chat.setPlanMode': [
    {
      name: 'patches plan mode',
      args: { payload: { ...CHAT, planMode: true } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { planMode: true },
        }),
      ],
    },
  ],
  'chat.setFastMode': [
    {
      name: 'patches fast mode',
      args: { payload: { ...CHAT, fastMode: false } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { fastMode: false } },
        }),
      ],
    },
  ],
  'chat.setPluginSelections': [
    {
      name: 'patches selections and the deferred tool policy',
      args: {
        payload: {
          ...CHAT,
          selections: SELECTIONS,
          deferredToolsAllowed: false,
        },
      },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { pluginSelections: SELECTIONS, deferredToolsAllowed: false },
        }),
      ],
    },
  ],
  'chat.answerQuestion': [
    {
      name: 'answers a question, approvals included',
      args: {
        payload: {
          ...CHAT,
          requestId: 'question-1',
          answers: [{ question: 'Allow?', selectedOptions: ['Allow'] }],
        },
      },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.answer_question',
          chatId: 'chat-1',
          questionId: 'question-1',
          answers: [{ question: 'Allow?', selectedOptions: ['Allow'] }],
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'reports a stale question as refused',
      args: { payload: { ...CHAT, requestId: 'question-1', answers: [] } },
      replies: {
        [C.chatCommand]: () => ({
          commandId: 'c',
          revision: 1,
          outcome: 'not_found',
        }),
      },
      channels: [C.chatCommand],
      result: (value) => expectRefused(value, /no longer available/),
    },
  ],
  'chat.dismissQuestion': [
    {
      name: 'dismisses a question',
      args: { payload: { ...CHAT, requestId: 'question-1' } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.dismiss_question',
          chatId: 'chat-1',
          questionId: 'question-1',
        }),
      ],
    },
  ],
  'chat.markRead': [
    {
      name: 'marks a worktree chat read',
      args: {
        payload: { scope: 'worktree', ...CHAT, lastMessageId: 'm1' },
      },
      calls: [
        chatEnvelope(WORKTREE, { type: 'chat.mark_read', chatId: 'chat-1' }),
      ],
    },
    {
      name: 'routes a standalone chat to its Work Entry',
      args: {
        payload: {
          scope: 'standalone',
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          lastMessageId: null,
        },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.mark_read',
          chatId: 'chat-s',
        }),
      ],
    },
    {
      name: 'refuses a standalone chat the computer no longer has',
      args: {
        payload: {
          scope: 'standalone',
          projectLocalId: 'cowork',
          chatId: 'gone',
          lastMessageId: null,
        },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [call(C.desktopSessionSnapshot, {})],
      result: (value) => expectRefused(value, /no longer available/),
    },
  ],
  'chat.setUnread': [
    {
      name: 'marks a worktree chat unread by hand',
      args: { payload: { scope: 'worktree', ...CHAT, unread: true } },
      calls: [
        chatEnvelope(WORKTREE, {
          type: 'chat.mark_unread',
          chatId: 'chat-1',
          manual: true,
        }),
      ],
    },
    {
      name: 'marks a standalone chat read',
      args: {
        payload: {
          scope: 'standalone',
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          unread: false,
        },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.mark_read',
          chatId: 'chat-s',
        }),
      ],
    },
  ],
  'standaloneChat.send': [
    {
      name: "sends in an existing chat's Work Entry",
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          message: 'Hi',
          modelConfig: { fastMode: true },
        },
        target: { standaloneChatLocalId: 'chat-s' },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.send_message',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          text: 'Hi',
          modelConfig: { fastMode: true },
        }),
      ],
      result: (value) => expect(value.chatId).toBe('chat-s'),
    },
    {
      name: 'creates a new chat on its first send',
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-new',
          message: 'Hi',
          sidebarItemGroupId: 'group-1',
        },
      },
      replies: {
        [C.desktopSessionSnapshot]: () => ({ standaloneChats: [] }),
        [C.workEntriesCreate]: () => ({ entry: { id: 'entry-2' } }),
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.workEntriesCreate, {
          projectId: 'cowork',
          sidebarItemGroupId: 'group-1',
        }),
        chatEnvelope(
          { projectId: 'cowork', worktreeId: 'entry-2' },
          { type: 'chat.create_tab', tabId: 'chat-new' },
        ),
        call(C.desktopSessionSnapshotInvalidate),
        chatEnvelope(
          { projectId: 'cowork', worktreeId: 'entry-2' },
          {
            type: 'chat.send_message',
            chatId: 'chat-new',
            userMessageId: 'random-id',
            text: 'Hi',
          },
        ),
      ],
    },
    {
      name: 'sends a picked model with its provider',
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          message: 'Hi',
          model: 'latest',
        },
      },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.modelRegistryGet]: () => MODEL_REGISTRY,
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.modelRegistryGet),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.send_message',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          text: 'Hi',
          model: 'latest',
          providerType: 'codex',
        }),
      ],
    },
    {
      name: 'sends attachments it uploaded as their computer paths',
      before: uploadNotes,
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          message: 'See file',
          cloudAttachments: [UPLOADED_ATTACHMENT],
        },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.send_message',
          chatId: 'chat-s',
          userMessageId: 'user-1',
          text: 'See file',
          attachmentPaths: ['/uploads/notes.txt'],
        }),
      ],
    },
    {
      name: 'refuses attachments another client uploaded before the transport',
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          message: 'Hi',
          cloudAttachments: [opaque('upload')],
        },
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'standaloneChat.create': [
    {
      name: "creates the chat's Work Entry and tab",
      args: {
        payload: { projectLocalId: 'cowork', chatId: 'chat-new' },
        target: { standaloneChatLocalId: 'chat-new' },
      },
      replies: {
        [C.desktopSessionSnapshot]: () => ({ standaloneChats: [] }),
        [C.workEntriesCreate]: () => ({ entry: { id: 'entry-2' } }),
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.workEntriesCreate, { projectId: 'cowork' }),
        chatEnvelope(
          { projectId: 'cowork', worktreeId: 'entry-2' },
          { type: 'chat.create_tab', tabId: 'chat-new' },
        ),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (value) =>
        expectAccepted(value, {
          chatId: 'chat-new',
          projectLocalId: 'cowork',
          projectId: 'cowork',
          worktreeId: 'entry-2',
          workEntryId: 'entry-2',
        }),
    },
    {
      name: 'answers an existing chat without creating it again',
      args: { payload: { projectLocalId: 'cowork', chatId: 'chat-s' } },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [call(C.desktopSessionSnapshot, {})],
      result: (value) => expectAccepted(value, { worktreeId: 'entry-1' }),
    },
  ],
  'standaloneChat.cancel': [
    {
      name: 'stops the chat in its Work Entry',
      args: { payload: { projectLocalId: 'cowork', chatId: 'chat-s' } },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.chatCancel]: () => ({}),
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.chatCancel, { ...COWORK_TARGET, chatId: 'chat-s' }),
      ],
    },
  ],
  'standaloneChat.archive': [
    {
      name: 'archives the Work Entry locked and refreshes the snapshot',
      args: { payload: STANDALONE_ARCHIVE },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.workEntriesDelete]: () => ({ browserCleanupPending: false }),
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.workEntriesDelete, {
          projectId: 'cowork',
          entryId: 'entry-1',
          lockAfterArchive: true,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (value) =>
        expectAccepted(value, {
          ok: true,
          chatId: 'chat-s',
          projectLocalId: 'cowork',
          workEntryId: 'entry-1',
        }),
    },
    {
      name: 'answers an archived chat as already archived without a write',
      args: { payload: STANDALONE_ARCHIVE },
      replies: {
        [C.desktopSessionSnapshot]: () => ARCHIVED_SNAPSHOT,
        [C.workEntriesListArchived]: () => LOCKED_ARCHIVE_LIST,
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.workEntriesListArchived, { projectLocalId: 'cowork' }),
      ],
      result: (value) =>
        expectAccepted(value, {
          workEntryId: 'entry-1',
          alreadyArchived: true,
        }),
    },
    {
      name: 'refuses a chat whose row names another Work Entry',
      args: { payload: { ...STANDALONE_ARCHIVE, workEntryId: 'entry-2' } },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [call(C.desktopSessionSnapshot, {})],
      result: (value) => expectRefused(value, /no longer available/),
    },
    {
      name: 'refuses an absent chat with no locked archive',
      args: { payload: { ...STANDALONE_ARCHIVE, chatId: 'gone' } },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.workEntriesListArchived]: () => EMPTY_ARCHIVE_LIST,
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.workEntriesListArchived, { projectLocalId: 'cowork' }),
      ],
      result: (value) => expectRefused(value, /no longer available/),
    },
    {
      name: 'refuses with the host message when the archive fails',
      args: { payload: STANDALONE_ARCHIVE },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.workEntriesDelete]: () => {
          throw new Error(
            "Error invoking remote method 'work-entries:delete': Error: The Work Entry changed before deletion.",
          );
        },
      },
      channels: [
        C.desktopSessionSnapshot,
        C.workEntriesDelete,
        C.desktopSessionSnapshot,
      ],
      result: (value) =>
        expectRefused(value, /^The Work Entry changed before deletion\.$/),
    },
    {
      name: 'answers an entry archived meanwhile on the computer as already archived',
      args: { payload: STANDALONE_ARCHIVE },
      replies: {
        [C.desktopSessionSnapshot]: snapshotsInTurn(
          STANDALONE_SNAPSHOT,
          ARCHIVED_SNAPSHOT,
        ),
        [C.workEntriesListArchived]: () => LOCKED_ARCHIVE_LIST,
        [C.workEntriesDelete]: () => {
          throw new Error('Unknown work entry entry-1');
        },
      },
      channels: [
        C.desktopSessionSnapshot,
        C.workEntriesDelete,
        C.desktopSessionSnapshot,
        C.workEntriesListArchived,
      ],
      result: (value) =>
        expectAccepted(value, {
          workEntryId: 'entry-1',
          alreadyArchived: true,
        }),
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { payload: STANDALONE_ARCHIVE },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.workEntriesDelete]: () => {
          throw new RemoteChannelUnavailableError(C.workEntriesDelete);
        },
      },
      channels: [C.desktopSessionSnapshot, C.workEntriesDelete],
      result: (value) => expectRefused(value, /Update the desktop app/),
    },
  ],
  'standaloneChat.setModel': [
    {
      name: 'sets the model with its provider',
      args: {
        payload: { projectLocalId: 'cowork', chatId: 'chat-s', model: 'opus' },
      },
      replies: {
        [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT,
        [C.modelRegistryGet]: () => MODEL_REGISTRY,
      },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        call(C.modelRegistryGet),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.set_model',
          tabId: 'chat-s',
          model: 'opus',
          providerType: 'claude',
        }),
      ],
    },
  ],
  'standaloneChat.setPluginSelections': [
    {
      name: 'patches the selections',
      args: {
        payload: {
          projectLocalId: 'cowork',
          chatId: 'chat-s',
          selections: SELECTIONS,
        },
      },
      replies: { [C.desktopSessionSnapshot]: () => STANDALONE_SNAPSHOT },
      calls: [
        call(C.desktopSessionSnapshot, {}),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-s',
          patch: { pluginSelections: SELECTIONS },
        }),
      ],
    },
  ],
  'appAdvisor.send': [
    {
      name: "sends in the chat's named Work Entry",
      args: {
        payload: {
          workEntryId: 'entry-a',
          chatId: 'adv-1',
          userMessageId: 'user-1',
          text: 'Plan it',
          inputMode: 'typed',
        },
      },
      replies: { [C.chatSendMessage]: () => ({}) },
      calls: [
        call(C.chatSendMessage, {
          ...ADVISOR_TARGET,
          chatId: 'adv-1',
          userMessageId: 'user-1',
          text: 'Plan it',
          inputMode: 'typed',
        }),
      ],
      result: (value) => {
        expectAccepted(value, { userMessageId: 'user-1' });
        expect(value.chatId).toBe('adv-1');
      },
    },
    {
      name: "finds a chat's Work Entry when the caller did not name it",
      args: { payload: { chatId: 'adv-2', userMessageId: 'u', text: 'Hi' } },
      replies: { ...ADVISOR_REPLIES, [C.chatSendMessage]: () => ({}) },
      calls: [
        call(C.workEntriesList, { projectId: 'app-advisor' }),
        call(C.chatGetState, ADVISOR_TARGET),
        call(C.chatSendMessage, {
          ...ADVISOR_TARGET,
          chatId: 'adv-2',
          userMessageId: 'u',
          text: 'Hi',
        }),
      ],
    },
    {
      name: 'creates a Work Entry and its tab for a first send',
      args: { payload: { text: 'Start', model: 'opus' } },
      replies: {
        [C.modelRegistryGet]: () => MODEL_REGISTRY,
        [C.workEntriesCreate]: () => ({ entry: { id: 'entry-new' } }),
        [C.chatSendMessage]: () => ({}),
      },
      calls: [
        call(C.modelRegistryGet),
        call(C.workEntriesCreate, { projectId: 'app-advisor' }),
        chatEnvelope(
          { projectId: 'app-advisor', worktreeId: 'entry-new' },
          { type: 'chat.create_tab', tabId: 'random-id' },
        ),
        call(C.chatSendMessage, {
          projectId: 'app-advisor',
          worktreeId: 'entry-new',
          chatId: 'random-id',
          userMessageId: 'random-id',
          text: 'Start',
          model: 'opus',
          providerType: 'claude',
        }),
      ],
      result: (value) => expect(value.chatId).toBe('random-id'),
    },
    {
      name: 'reports a provider sign-in the computer needs',
      args: {
        payload: { workEntryId: 'entry-a', chatId: 'adv-1', text: 'Hi' },
      },
      replies: {
        [C.chatSendMessage]: () => ({ refusedAuthDependencies: {} }),
      },
      channels: [C.chatSendMessage],
      result: (value) => expectRefused(value, /Sign in/),
    },
    {
      name: 'refuses a chat the computer does not have',
      args: { payload: { chatId: 'missing', text: 'Hi' } },
      replies: ADVISOR_REPLIES,
      channels: [C.workEntriesList, C.chatGetState],
      result: (value) => expectRefused(value, /no longer available/),
    },
  ],
  'appAdvisor.cancel': [
    {
      name: 'stops the chat in its Work Entry',
      args: { payload: { chatId: 'adv-1' } },
      replies: { ...ADVISOR_REPLIES, [C.chatCancel]: () => ({}) },
      calls: [
        call(C.workEntriesList, { projectId: 'app-advisor' }),
        call(C.chatGetState, ADVISOR_TARGET),
        call(C.chatCancel, { ...ADVISOR_TARGET, chatId: 'adv-1' }),
      ],
      result: (value) => expectAccepted(value),
    },
  ],
  'appAdvisor.setModel': [
    {
      name: 'sets the model with its provider',
      args: { payload: { chatId: 'adv-1', model: 'latest' } },
      replies: {
        ...ADVISOR_REPLIES,
        [C.modelRegistryGet]: () => MODEL_REGISTRY,
      },
      calls: [
        call(C.workEntriesList, { projectId: 'app-advisor' }),
        call(C.chatGetState, ADVISOR_TARGET),
        call(C.modelRegistryGet),
        chatEnvelope(ADVISOR_TARGET, {
          type: 'chat.set_model',
          tabId: 'adv-1',
          model: 'latest',
          providerType: 'codex',
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'reads a bare inheriting Agent provider from the App Advisor destination',
      args: { payload: { chatId: 'adv-1', model: 'agent_model_review' } },
      replies: {
        ...ADVISOR_REPLIES,
        [C.modelRegistryGet]: () => ({
          ...MODEL_REGISTRY,
          agents: [{ id: 'agent_model_review', baseModel: 'default' }],
        }),
        [C.desktopSessionSnapshot]: () => ({
          availableModels: [
            { id: 'agent_model_review', provider: 'codex', available: true },
          ],
        }),
      },
      calls: [
        call(C.workEntriesList, { projectId: 'app-advisor' }),
        call(C.chatGetState, ADVISOR_TARGET),
        call(C.modelRegistryGet),
        call(C.desktopSessionSnapshot, { workspaceLocalId: 'app-advisor' }),
        chatEnvelope(ADVISOR_TARGET, {
          type: 'chat.set_model',
          tabId: 'adv-1',
          model: 'agent_model_review',
          providerType: 'codex',
        }),
      ],
      result: (value) => expectAccepted(value),
    },
  ],
  'appAdvisor.createTab': [
    {
      name: 'adds a tab to the named Work Entry',
      args: { payload: { chatId: 'adv-3', workEntryId: 'entry-a' } },
      calls: [
        chatEnvelope(ADVISOR_TARGET, {
          type: 'chat.create_tab',
          tabId: 'adv-3',
        }),
      ],
      result: (value) => expectAccepted(value, { workEntryId: 'entry-a' }),
    },
    {
      name: 'creates a Work Entry for a new nav row',
      args: { payload: { chatId: 'adv-4', sidebarItemGroupId: 'group-1' } },
      replies: {
        [C.workEntriesCreate]: () => ({ entry: { id: 'entry-new' } }),
      },
      calls: [
        call(C.workEntriesCreate, {
          projectId: 'app-advisor',
          sidebarItemGroupId: 'group-1',
        }),
        chatEnvelope(
          { projectId: 'app-advisor', worktreeId: 'entry-new' },
          { type: 'chat.create_tab', tabId: 'adv-4' },
        ),
      ],
    },
  ],
  'appAdvisor.answerQuestion': [
    {
      name: 'answers a held question on the App Advisor surface',
      before: holdQuestion,
      args: {
        payload: {
          chatId: 'adv-1',
          requestId: 'req-1',
          answers: [
            {
              questionId: 'q1',
              question: 'Which city?',
              selectedOptions: [],
              freeformText: 'Lisbon',
            },
          ],
        },
      },
      calls: [
        call(C.appAdvisorToolResponse, {
          requestId: 'req-1',
          originChatId: 'adv-1',
          ok: true,
          answer: {
            questionId: 'q1',
            question: 'Which city?',
            selectedOptions: [],
            freeformText: 'Lisbon',
          },
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'refuses a question this client is not holding',
      args: {
        payload: {
          chatId: 'adv-1',
          requestId: 'req-1',
          answers: [{ question: 'Which city?', selectedOptions: ['Rome'] }],
        },
      },
      calls: [],
      result: (value) => expectRefused(value, /no longer waiting/),
    },
  ],
  'appAdvisor.dismissQuestion': [
    {
      name: 'dismisses a held question on the App Advisor surface',
      before: holdQuestion,
      args: { payload: { chatId: 'adv-1', requestId: 'req-1' } },
      calls: [
        call(C.appAdvisorToolResponse, {
          requestId: 'req-1',
          originChatId: 'adv-1',
          ok: false,
          error: { code: 'cancelled', message: 'User dismissed the question.' },
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'refuses a question this client is not holding',
      args: { payload: { chatId: 'adv-1', requestId: 'req-1' } },
      calls: [],
      result: (value) => expectRefused(value, /no longer waiting/),
    },
  ],
  'editor.resolveInvocable': [
    {
      name: 'returns the insert text when the chat already runs the item',
      args: {
        payload: { target: { kind: 'worktree', ...CHAT }, entryId: 'e1' },
      },
      replies: { [C.editorResolveInvocable]: () => RESOLVED_INVOCABLE },
      calls: [
        call(C.editorResolveInvocable, {
          target: { kind: 'worktree', ...CHAT },
          entryId: 'e1',
        }),
      ],
      result: (value) => expectAccepted(value, RESOLVED_INVOCABLE),
    },
    {
      name: 'commits the enabling selections against the ones resolved from',
      args: {
        payload: {
          target: { kind: 'worktree', ...CHAT },
          entryId: 'e1',
          providerType: 'claude',
        },
      },
      replies: {
        [C.editorResolveInvocable]: () => ({
          ...RESOLVED_INVOCABLE,
          enable: {
            ...WORKTREE,
            tabId: 'chat-1',
            pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
            expectedPluginSelections: SELECTIONS,
          },
        }),
      },
      calls: [
        call(C.editorResolveInvocable, {
          target: { kind: 'worktree', ...CHAT },
          entryId: 'e1',
          providerType: 'claude',
        }),
        chatEnvelope(WORKTREE, {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
          },
          expectedPluginSelections: SELECTIONS,
        }),
      ],
      result: (value) =>
        expectAccepted(value, {
          ...RESOLVED_INVOCABLE,
          pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
        }),
    },
    {
      name: 'reports selections that changed meanwhile',
      args: {
        payload: { target: { kind: 'worktree', ...CHAT }, entryId: 'e1' },
      },
      replies: {
        [C.editorResolveInvocable]: () => ({
          ...RESOLVED_INVOCABLE,
          enable: {
            ...WORKTREE,
            tabId: 'chat-1',
            pluginSelections: SELECTIONS,
            expectedPluginSelections: SELECTIONS,
          },
        }),
        [C.chatCommand]: () => ({ commandId: 'c', outcome: 'conflict' }),
      },
      channels: [C.editorResolveInvocable, C.chatCommand],
      result: (value) => expectRefused(value, /not applied/),
    },
    {
      name: "commits a Cowork row's enabling selections in its Work Entry",
      args: {
        payload: { target: STANDALONE_INVOCABLE_TARGET, entryId: 'e1' },
        target: { workspaceLocalId: COWORK_CHAT.projectLocalId },
      },
      replies: {
        [C.editorResolveInvocable]: () => ({
          ...RESOLVED_INVOCABLE,
          enable: {
            ...COWORK_TARGET,
            tabId: COWORK_CHAT.localId,
            pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
            expectedPluginSelections: SELECTIONS,
          },
        }),
      },
      calls: [
        call(C.editorResolveInvocable, {
          target: STANDALONE_INVOCABLE_TARGET,
          entryId: 'e1',
        }),
        chatEnvelope(COWORK_TARGET, {
          type: 'chat.patch_tab_settings',
          tabId: COWORK_CHAT.localId,
          patch: {
            pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
          },
          expectedPluginSelections: SELECTIONS,
        }),
      ],
      result: (value) =>
        expectAccepted(value, {
          ...RESOLVED_INVOCABLE,
          pluginSelections: { ...SELECTIONS, pluginRefs: ['review'] },
        }),
    },
  ],
  'pipeline.resume': [
    {
      name: 'resumes the run with its pause responses',
      args: {
        payload: { executionId: 'run-1', pauseResponses: [opaque('answer')] },
      },
      replies: { [C.pipelinesResume]: () => ({ success: true }) },
      calls: [
        call(C.pipelinesResume, 'run-1', {
          pauseResponses: [{ opaque: 'answer' }],
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: "reports the computer's refusal",
      args: { payload: { executionId: 'run-1' } },
      replies: {
        [C.pipelinesResume]: () => ({ success: false, error: 'Not paused.' }),
      },
      calls: [call(C.pipelinesResume, 'run-1', {})],
      result: (value) => expectRefused(value, /Not paused/),
    },
  ],
  'pipeline.retry': [
    {
      name: 'retries the run',
      args: { payload: { executionId: 'run-1' } },
      replies: { [C.pipelinesRetryExecution]: () => ({ success: true }) },
      calls: [call(C.pipelinesRetryExecution, 'run-1')],
      result: (value) => expectAccepted(value),
    },
  ],
  'pipeline.rerun': [
    {
      name: 'reruns the run',
      args: { payload: { executionId: 'run-1' } },
      replies: { [C.pipelinesRerunExecution]: () => ({ success: true }) },
      calls: [call(C.pipelinesRerunExecution, 'run-1')],
      result: (value) => expectAccepted(value),
    },
  ],
  'pipeline.requestLog': [
    {
      name: "returns one step's log in the receipt",
      args: {
        payload: { executionId: 'run-1', jobId: 'job', stepId: 'step' },
        target: SHELL_TARGET,
      },
      replies: {
        [C.pipelinesReadStepLog]: () => ({ success: true, data: ['line'] }),
      },
      calls: [
        call(
          C.pipelinesReadStepLog,
          { executionId: 'run-1', jobId: 'job', stepId: 'step' },
          { format: 'lines' },
        ),
      ],
      result: (value) => expectAccepted(value, { log: ['line'] }),
    },
  ],
  'pipeline.installCurated': [
    {
      name: 'imports the curated pipeline the computer verifies',
      args: { payload: { key: 'review', expectedContentHash: 'f'.repeat(64) } },
      replies: {
        [C.pipelinesCuratedImport]: () => ({
          success: true,
          data: { id: 'pipeline-9' },
        }),
      },
      calls: [
        call(C.pipelinesCuratedImport, {
          key: 'review',
          expectedContentHash: 'f'.repeat(64),
        }),
      ],
      result: (value) => expectAccepted(value, { pipelineId: 'pipeline-9' }),
    },
  ],
  'script.requestLog': [
    {
      name: "returns the run's log tail and re-reads the worktree's rows",
      args: { payload: { scriptKey: 'project:dev' }, target: SHELL_TARGET },
      replies: { [C.scriptReadRunLog]: () => ({ lines: ['ready'] }) },
      calls: [
        call(C.scriptReadRunLog, { ...WORKTREE, scriptKey: 'project:dev' }),
      ],
      result: (value) => expectAccepted(value, { lines: ['ready'] }),
    },
    {
      name: 'refuses without a worktree',
      args: { payload: { scriptKey: 'project:dev' } },
      calls: [],
      result: (value) => expectRefused(value, /Open this worktree again/),
    },
  ],
  'hook.pause': [
    {
      name: 'pauses one hook on the latest worktree row',
      args: { payload: { ...WORKTREE, hookKey: 'pre-push' } },
      replies: {
        [C.hookChangePause]: () => ({
          ok: true,
          pausedHookKeys: ['lint', 'pre-push'],
        }),
      },
      calls: [
        call(C.hookChangePause, {
          ...WORKTREE,
          kind: 'pause',
          hookKey: 'pre-push',
        }),
      ],
      result: (value) =>
        expectAccepted(value, { pausedHookKeys: ['lint', 'pre-push'] }),
    },
    {
      name: 'pauses every hook the worktree lists',
      args: { payload: { ...WORKTREE, all: true } },
      replies: {
        [C.hookChangePause]: () => ({
          ok: true,
          pausedHookKeys: ['lint', 'pre-push'],
        }),
      },
      calls: [
        call(C.hookChangePause, { ...WORKTREE, kind: 'pause', all: true }),
      ],
      result: (value) =>
        expectAccepted(value, { pausedHookKeys: ['lint', 'pre-push'] }),
    },
    {
      name: 'reports a hook the computer does not list',
      args: { payload: { ...WORKTREE, hookKey: 'gone' } },
      replies: {
        [C.hookChangePause]: () => ({
          ok: false,
          code: 'not_found',
          error: 'Hook gone was not found.',
        }),
      },
      channels: [C.hookChangePause],
      result: (value) => expectRefused(value, /not found/),
    },
  ],
  'hook.resume': [
    {
      name: 'resumes one hook on the latest worktree row',
      args: { payload: { ...WORKTREE, hookKey: 'lint' } },
      replies: {
        [C.hookChangePause]: () => ({ ok: true, pausedHookKeys: ['x'] }),
      },
      calls: [
        call(C.hookChangePause, {
          ...WORKTREE,
          kind: 'resume',
          hookKey: 'lint',
        }),
      ],
      result: (value) => expectAccepted(value, { pausedHookKeys: ['x'] }),
    },
    {
      name: 'resumes every hook',
      args: { payload: { ...WORKTREE, all: true } },
      replies: {
        [C.hookChangePause]: () => ({ ok: true, pausedHookKeys: [] }),
      },
      calls: [
        call(C.hookChangePause, { ...WORKTREE, kind: 'resume', all: true }),
      ],
      result: (value) => expectAccepted(value, { pausedHookKeys: [] }),
    },
    {
      name: 'refuses a request naming both one hook and every hook',
      args: { payload: { ...WORKTREE, hookKey: 'lint', all: true } },
      calls: [],
      result: (value) => expectRefused(value, /exactly one/),
    },
  ],
  'plan.delete': [
    {
      name: 'deletes the tracked plan',
      args: { payload: { ...WORKTREE, planId: 'plan-1' } },
      calls: [call(C.trackedPlansDelete, { ...WORKTREE, planId: 'plan-1' })],
      result: (value) => expectAccepted(value),
    },
  ],
  'summary.refresh': [
    {
      name: "starts the worktree summary's regeneration",
      args: { payload: { ...WORKTREE } },
      calls: [call(C.worktreeSummaryRefresh, WORKTREE)],
      result: (value) => expectAccepted(value),
    },
  ],
  'watcher.delete': [
    {
      name: 'deletes the watcher',
      args: { payload: { watcherId: 'w-1', notifySubscriber: false } },
      replies: { [C.appAdvisorWatcherDelete]: () => ({ ok: true }) },
      calls: [
        call(C.appAdvisorWatcherDelete, {
          watcherId: 'w-1',
          notifySubscriber: false,
        }),
      ],
      result: (value) => expectAccepted(value),
    },
    {
      name: 'reports a watcher that is firing or gone',
      args: { payload: { watcherId: 'w-1', notifySubscriber: true } },
      replies: {
        [C.appAdvisorWatcherDelete]: () => ({
          ok: false,
          error: 'Watcher not found or currently firing.',
        }),
      },
      channels: [C.appAdvisorWatcherDelete],
      result: (value) => expectRefused(value, /currently firing/),
    },
  ],
};

// ---------------------------------------------------------------------------
// Chat recovery (CAN-7435): plan-exit approval and failed-turn retry.
// ---------------------------------------------------------------------------

const PLAN_APPROVAL = {
  requestId: 'request-1',
  planId: 'plan-1',
  revisionNumber: 2,
};
const PENDING_PLAN_TAB = {
  id: 'chat-1',
  planMode: true,
  pendingPlanExit: { source: 'claude' },
  pendingPlanExitRequestId: 'request-1',
  trackedPlanId: 'plan-1',
  trackedPlanSource: 'claude',
  trackedPlanReviewStatus: 'pending',
  latestRevisionNumber: 2,
};
const planExitState =
  (tab: Record<string, unknown>): Reply =>
  () => ({
    revision: 1,
    tabsFile: { tabs: [tab] },
    runtimeByChatId: {},
  });
const PLAN_DECISION = chatEnvelope(WORKTREE, {
  type: 'chat.patch_tab_settings',
  tabId: 'chat-1',
  patch: {
    pendingPlanExit: null,
    pendingPlanExitRequestId: null,
    planMode: false,
    proposalMode: 'optional',
    trackedPlanReviewStatus: 'approved',
    hasOutstandingProposal: false,
  },
  expectedPendingPlanExitRequestId: 'request-1',
});
const PLAN_REVIEW_SYNC = call(C.trackedPlansUpdate, {
  ...WORKTREE,
  planId: 'plan-1',
  chatId: 'chat-1',
  initiationSource: 'user',
  reviewStatus: 'approved',
  approvedAt: NOW,
  dismissedAt: null,
});
const APPROVED_PLAN = { ...PLAN, reviewStatus: 'approved' };
const RETRY_ARGS = {
  ...CHAT,
  turnUserMessageId: 'user-1',
  noticeText: 'The provider is overloaded.',
};
const RETRY_USER_MESSAGE = {
  id: 'user-1',
  role: 'user',
  timestamp: NOW,
  blocks: [{ type: 'text', text: 'Fix the bug' }],
  attachmentPaths: ['/tmp/a.png'],
};
const RETRY_NOTICE = {
  id: 'notice-1',
  role: 'system',
  timestamp: NOW,
  blocks: [{ type: 'text', text: 'The provider is overloaded.' }],
};
const IDLE_CHAT_STATE: Reply = () => ({
  revision: 1,
  tabsFile: { tabs: [{ id: 'chat-1' }] },
  runtimeByChatId: { 'chat-1': { status: 'idle' } },
});
const transcriptPage =
  (messages: readonly unknown[], before?: number): Reply =>
  () => ({
    messages,
    transcriptRevision: 7,
    ...(before === undefined ? {} : { before }),
  });

const QUERY_SCENARIOS: QueryScenarios = {
  ...SHELL_QUERY_SCENARIOS,
  'chat.checkFailedTurnRetry': [
    {
      name: 'offers a re-send when the agent never ran',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([
          RETRY_USER_MESSAGE,
          RETRY_NOTICE,
        ]),
      },
      calls: [
        call(C.chatGetState, WORKTREE),
        call(C.chatGetTranscriptPage, CHAT),
      ],
      result: (value) =>
        expect(value).toEqual({ available: true, resendsUserMessage: true }),
    },
    {
      name: 'is unavailable while the chat is busy, without reading the transcript',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: () => ({
          tabsFile: { tabs: [{ id: 'chat-1' }] },
          runtimeByChatId: { 'chat-1': { status: 'streaming' } },
        }),
      },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) =>
        expect(value).toEqual({ available: false, reason: 'busy' }),
    },
    {
      name: 'is unavailable when the notice is not the last persisted message',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([RETRY_USER_MESSAGE]),
      },
      channels: [C.chatGetState, C.chatGetTranscriptPage],
      result: (value) =>
        expect(value).toEqual({ available: false, reason: 'not_current' }),
    },
    {
      name: 'fails closed past the paging bound',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([RETRY_NOTICE], 50),
      },
      result: (value, context) => {
        expect(value).toEqual({ available: false, reason: 'out_of_range' });
        expect(
          context.fake.calls.filter(
            (entry) => entry.channel === C.chatGetTranscriptPage,
          ),
        ).toHaveLength(8);
      },
    },
  ],
  'worktree.activity': [
    {
      name: "reads the worktree's panel entities",
      args: WORKTREE,
      replies: { [C.worktreeActivityEntities]: () => ACTIVITY_ENTITIES },
      calls: [call(C.worktreeActivityEntities, WORKTREE)],
      result: (value) =>
        expect(value.entities).toEqual(ACTIVITY_ENTITIES.entities),
    },
    {
      name: 'rejects an entity outside the panels',
      args: WORKTREE,
      replies: {
        [C.worktreeActivityEntities]: () => ({
          entities: [{ entityType: 'workspace', localId: 'project-1' }],
        }),
      },
      channels: [C.worktreeActivityEntities],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'appAdvisor.chats': [
    {
      name: "lists every Orchestrator Work Entry's chat tabs",
      args: {},
      replies: ADVISOR_REPLIES,
      calls: [
        call(C.workEntriesList, { projectId: 'app-advisor' }),
        call(C.chatGetState, ADVISOR_TARGET),
      ],
      result: (value) =>
        expect(value.chats).toEqual([
          expect.objectContaining({
            chatId: 'adv-1',
            title: 'First',
            workEntryId: 'entry-a',
            workEntryTitle: 'Plan the trip',
            workEntryOrder: 0,
            order: 0,
            active: true,
            turnActive: true,
            hasUnread: false,
            messageCount: 2,
            model: 'opus',
          }),
          expect.objectContaining({
            chatId: 'adv-2',
            order: 1,
            active: false,
            turnActive: false,
            hasUnread: true,
          }),
        ]),
    },
  ],
  'catalog.invocables.list': [
    {
      name: 'is refused: a computer lists its own slash rows',
      args: { workspaceLocalId: 'project-1', params: { chatId: 'chat-1' } },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'worktree.baseBranches': passthroughQuery<'worktree.baseBranches'>(
    C.homeListBranchTargets,
    'base branches',
  ),
  'delegation.lifetimeStatus': passthroughQuery<'delegation.lifetimeStatus'>(
    C.managedDelegationLifetimeStatus,
    'lifetime',
  ),
  'repoRules.scan': passthroughQuery<'repoRules.scan'>(C.repoRulesScan, 'scan'),
  'repoRules.status': passthroughQuery<'repoRules.status'>(
    C.repoRulesStatus,
    'status',
  ),
  'repoRules.check': passthroughQuery<'repoRules.check'>(
    C.repoRulesCheck,
    'check',
  ),
  'repoRules.preview': [
    ...passthroughQuery<'repoRules.preview'>(C.repoRulesPreview, 'preview'),
    {
      name: 'strips the Electron invoke wrapper from failures',
      args: opaque('preview'),
      replies: {
        [C.repoRulesPreview]: () => {
          throw new Error(
            "Error invoking remote method 'repo-rules:preview': Error: Scan again",
          );
        },
      },
      rejects: /^Scan again$/,
    },
  ],
  'editorSetup.presence': passthroughQuery<'editorSetup.presence'>(
    C.editorSetupPresence,
    'presence',
  ),
  'organization.inviteStatus': [
    {
      name: 'parses the invite status',
      args: { organizationId: 'org', email: 'a@example.com' },
      calls: [
        call(C.personalOrganizationUpgradeInviteStatus, {
          organizationId: 'org',
          email: 'a@example.com',
        }),
      ],
      result: (value) => expect(value).toEqual({ status: 'not-found' }),
    },
    {
      name: 'restores a typed organization refusal',
      args: { organizationId: 'org', email: 'a@example.com' },
      replies: {
        [C.personalOrganizationUpgradeInviteStatus]: () => ({
          error: 'No access',
          code: 'forbidden',
          status: 403,
        }),
      },
      rejects: OrganizationOperationFailure,
    },
  ],
  'terminal.list': [
    {
      name: 'filters sessions to the requested worktree',
      args: WORKTREE,
      calls: [call(C.terminalList)],
      result: (value) =>
        expect(value.map((session) => session.id)).toEqual(['t1']),
    },
  ],
  'terminal.worktreeState.get': passthroughQuery<'terminal.worktreeState.get'>(
    C.terminalLoadWorktreeState,
    'terminal-state',
  ),
  'file.index': [
    {
      name: 'filters the explorer index for one root',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', q: 'app', limit: 10 },
      calls: [call(C.fileIndexGet, { ...WORKTREE, purpose: 'file-explorer' })],
      result: (value) =>
        expect(value).toEqual({
          fileRootLocalId: 'repo-1',
          paths: ['src/App.ts'],
          truncated: false,
        }),
    },
  ],
  'file.resolveLink': [
    {
      name: 'resolves a transcript link',
      args: { ...WORKTREE, href: 'src/App.ts' },
      calls: [
        call(C.fileReferenceResolve, {
          ...WORKTREE,
          baseFilePath: '',
          href: 'src/App.ts',
          mode: 'transcript',
        }),
      ],
      result: (value) =>
        expect(value).toEqual({
          fileRootLocalId: 'repo-1',
          relativePath: 'src/App.ts',
        }),
    },
    {
      name: 'answers null for an older host',
      args: { ...WORKTREE, href: 'x' },
      replies: { [C.fileReferenceResolve]: () => null },
      result: (value) => expect(value).toBeNull(),
    },
  ],
  'session.snapshot': passthroughQuery<'session.snapshot'>(
    C.desktopSessionSnapshot,
    'snapshot',
  ),
  'file.read': [
    {
      name: 'preserves a literal POSIX backslash in both file locators',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'literal\\name.ts',
      },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileReadContent, {
          absolutePath: '/root/literal\\name.ts',
          workspaceTarget: WORKTREE,
          file: { fileRootId: 'repo-1', relativePath: 'literal\\name.ts' },
        }),
      ],
      result: (value) =>
        expect(value).toMatchObject({
          path: 'literal\\name.ts',
          content: 'body',
        }),
    },
    {
      name: 'retains Windows separators in both file locators',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'src\\App.ts',
      },
      replies: {
        [C.fileTreeRoots]: () => ({
          roots: [
            { repoId: 'repo-1', repoName: 'Repo', absolutePath: 'C:\\repo' },
          ],
        }),
      },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileReadContent, {
          absolutePath: 'C:\\repo/src/App.ts',
          workspaceTarget: WORKTREE,
          file: { fileRootId: 'repo-1', relativePath: 'src/App.ts' },
        }),
      ],
      result: (value) => expect(value).toMatchObject({ content: 'body' }),
    },
    {
      name: 'reads a catalog root canonically',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'src/./App.ts',
      },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileReadContent, {
          absolutePath: '/root/src/App.ts',
          workspaceTarget: WORKTREE,
          file: { fileRootId: 'repo-1', relativePath: 'src/App.ts' },
        }),
      ],
      result: (value) =>
        expect(value).toMatchObject({
          fileRootLocalId: 'repo-1',
          content: 'body',
          version: 'v1',
          language: 'ts',
        }),
    },
    {
      name: 'reads a host-local root without the catalog',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'archive',
        relativePath: 'notes.md',
      },
      replies: {
        [C.fileReadContent]: () => ({
          kind: 'text',
          content: 'n',
          sizeBytes: 1,
          modifiedAtMs: 5_000,
          truncated: false,
        }),
      },
      calls: [
        call(C.fileReadContent, {
          absolutePath: '/archive/notes.md',
          workspaceTarget: WORKTREE,
        }),
      ],
      result: (value) =>
        expect(value).toMatchObject({
          version: '1:5000',
          fileRootLocalId: 'archive',
        }),
    },
    {
      name: 'rejects traversal before the host',
      args: { ...WORKTREE, fileRootLocalId: 'archive', relativePath: '../etc' },
      calls: [],
      rejects: /escapes the file root/,
    },
    {
      name: 'refuses binary files',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', relativePath: 'a.png' },
      replies: { [C.fileReadContent]: () => ({ kind: 'image' }) },
      rejects: /Binary files/,
    },
  ],
  'diff.read': [
    {
      name: 'builds a unified patch from the file diff',
      args: {
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        path: 'src/App.ts',
        source: 'committed',
        repoId: 'repo-1',
      },
      calls: [
        call(C.activityFileDiff, {
          ...WORKTREE,
          filePath: 'src/App.ts',
          source: 'committed',
          repoId: 'repo-1',
        }),
      ],
      result: (value) => {
        expect(value.patch).toBe(
          '--- a/src/App.ts\n+++ b/src/App.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
        );
        expect(value.files).toEqual([
          {
            filePath: 'src/App.ts',
            status: 'modified',
            repoId: 'repo-1',
            insertions: 1,
            deletions: 1,
          },
        ]);
      },
    },
    {
      name: 'reports binary files without a patch',
      args: {
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        path: 'a.png',
      },
      replies: {
        [C.activityFileDiff]: () => ({
          oldValue: '',
          newValue: '',
          filePath: 'a.png',
          source: 'uncommitted',
          truncated: false,
          binary: true,
        }),
      },
      result: (value) => {
        expect(value.binary).toBe(true);
        expect(value.patch).toBeUndefined();
      },
    },
    {
      name: 'refuses the combined worktree diff without a call',
      args: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'file.roots': [
    {
      name: 'lists roots',
      args: WORKTREE,
      calls: [call(C.fileTreeRoots, WORKTREE)],
      result: (value) =>
        expect(value).toEqual([
          {
            workspaceLocalId: 'project-1',
            worktreeLocalId: 'worktree-1',
            fileRootLocalId: 'repo-1',
            label: 'Repo',
            absolutePath: '/root/',
          },
        ]),
    },
  ],
  'file.directory': [
    {
      name: 'lists one directory',
      args: { ...WORKTREE, repoId: 'repo-1', relativeDir: '' },
      calls: [
        call(C.fileTreeDirectory, {
          ...WORKTREE,
          repoId: 'repo-1',
          relativeDir: '',
        }),
      ],
      result: (value) =>
        expect(value.entries).toEqual([
          { name: 'src', path: 'src', type: 'directory' },
        ]),
    },
  ],
  'chat.history': [
    {
      name: 'reads the newest page and issues a cursor',
      args: {
        scope: 'worktree',
        chatId: 'chat-1',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        before: null,
      },
      calls: [call(C.chatGetTranscriptPage, { ...WORKTREE, chatId: 'chat-1' })],
      result: (value) => {
        expect(value.segment).toBe('historical');
        expect(value.messages.map((message) => message.messageId)).toEqual([
          'user-1',
          'assistant-1',
        ]);
        expect(value.nextCursor).toBe('ipc-transcript-v1:40:7');
      },
    },
    {
      name: 'pages with the cursor and its transcript revision',
      args: {
        scope: 'worktree',
        chatId: 'chat-1',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        before: 'ipc-transcript-v1:40:7',
      },
      replies: {
        [C.chatGetTranscriptPage]: () => ({
          ...TRANSCRIPT_PAGE,
          before: undefined,
        }),
      },
      calls: [
        call(C.chatGetTranscriptPage, {
          ...WORKTREE,
          chatId: 'chat-1',
          before: 40,
          transcriptRevision: 7,
        }),
      ],
      result: (value) => expect(value.nextCursor).toBeNull(),
    },
    {
      name: 'routes a standalone chat outside any workspace',
      args: {
        scope: 'standalone',
        chatId: 'chat-2',
        worktreeLocalId: 'entry-1',
        before: null,
      },
      calls: [
        call(C.chatGetTranscriptPage, {
          projectId: 'standalone-chat',
          worktreeId: 'entry-1',
          chatId: 'chat-2',
        }),
      ],
    },
    {
      name: 'rejects a foreign cursor before the host',
      args: {
        scope: 'worktree',
        chatId: 'chat-1',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        before: 'portal:123',
      },
      calls: [],
      rejects: ChatHistoryCursorError,
    },
    {
      name: 'surfaces a stale-revision refusal from the host',
      args: {
        scope: 'worktree',
        chatId: 'chat-1',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        before: 'ipc-transcript-v1:40:6',
      },
      replies: {
        [C.chatGetTranscriptPage]: () => {
          throw new Error('The chat changed. Reload it.');
        },
      },
      rejects: /The chat changed/,
    },
  ],
  'chat.readVisual': [
    {
      name: 'reads one byte range of a visual (CAN-7432)',
      args: VISUAL_READ,
      replies: { [C.chatReadVisual]: () => VISUAL_RANGE },
      calls: [call(C.chatReadVisual, VISUAL_READ)],
      result: (value) => expect(value).toStrictEqual(VISUAL_RANGE),
    },
    {
      name: 'passes an archived container through',
      args: { ...VISUAL_READ, archivedContainerId: 'worktree-1' },
      replies: { [C.chatReadVisual]: () => VISUAL_RANGE },
      calls: [
        call(C.chatReadVisual, {
          ...VISUAL_READ,
          archivedContainerId: 'worktree-1',
        }),
      ],
    },
    {
      name: 'rejects a malformed reply',
      args: VISUAL_READ,
      replies: { [C.chatReadVisual]: () => ({ data: 'PHA+' }) },
      channels: [C.chatReadVisual],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'rejects a reply longer than the requested range',
      args: { ...VISUAL_READ, limit: 2 },
      replies: { [C.chatReadVisual]: () => VISUAL_RANGE },
      channels: [C.chatReadVisual],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'plan.get': [
    {
      name: 'reads the latest revision',
      args: { ...WORKTREE, planId: 'plan-1' },
      calls: [call(C.trackedPlansGet, { ...WORKTREE, planId: 'plan-1' })],
      result: (value) =>
        expect(value).toMatchObject({ content: 'v2 body', revisionNumber: 2 }),
    },
    {
      name: 'reads a pinned revision',
      args: { ...WORKTREE, planId: 'plan-1', revisionNumber: 1 },
      result: (value) =>
        expect(value).toMatchObject({
          content: 'v1 body',
          reviewStatus: 'approved',
        }),
    },
    {
      name: 'rejects a missing plan',
      args: { ...WORKTREE, planId: 'gone' },
      replies: { [C.trackedPlansGet]: () => null },
      rejects: /Plan not found/,
    },
  ],
  'chat.getTabSettings': [
    {
      name: 'answers null before anything is persisted',
      args: { chatId: 'chat-1' },
      calls: [],
      result: (value) => expect(value).toBeNull(),
    },
  ],
  'workspace.claudeMd.get': [
    {
      name: 'reads CLAUDE.md',
      args: { workspaceId: 'project-1' },
      calls: [call(C.workspaceLoadClaudeMd, { workspaceId: 'project-1' })],
      result: (value) => expect(value).toBe('# Instructions'),
    },
  ],
  'workspace.scripts.get': [
    {
      name: 'reads workspace scripts',
      args: { workspaceId: 'project-1' },
      calls: [call(C.workspaceReadScripts, { workspaceId: 'project-1' })],
    },
  ],
  'appAdvisor.settings.get': [
    {
      name: 'reads the settings Portal serves',
      args: NO_ARGS,
      replies: { [C.appAdvisorSettingsView]: () => ADVISOR_SETTINGS },
      calls: [call(C.appAdvisorSettingsView)],
      result: (value) => expect(value).toEqual(ADVISOR_SETTINGS),
    },
    {
      name: 'rejects a malformed reply',
      args: NO_ARGS,
      replies: { [C.appAdvisorSettingsView]: () => ({ model: 1 }) },
      channels: [C.appAdvisorSettingsView],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'turnFeedback.list': [
    {
      name: 'lists ratings for a chat',
      args: { clientChatId: 'chat-1' },
      calls: [call(C.turnFeedbackList, { clientChatId: 'chat-1' })],
    },
  ],
  'account.installUpdateEmails.get': [
    {
      name: 'reads the preference',
      args: NO_ARGS,
      calls: [call(C.settingsLoadInstallUpdateEmailPreference)],
    },
  ],
  'cloneJobs.list': [
    {
      name: 'projects each job without its remote URL or host path',
      args: {},
      calls: [call(C.cloneJobsList)],
      result: (value) => expect(value).toEqual([PORTABLE_CLONE_JOB]),
    },
    {
      name: 'skips a job with an unknown status or a malformed shape',
      args: {},
      replies: {
        [C.cloneJobsList]: () => [
          { ...HOST_CLONE_JOB, id: 'job-new', status: 'paused' },
          { ...HOST_CLONE_JOB, id: 'job-bad', background: 'yes' },
          'not a job',
          HOST_CLONE_JOB,
        ],
      },
      channels: [C.cloneJobsList],
      result: (value) => expect(value).toEqual([PORTABLE_CLONE_JOB]),
    },
    {
      name: 'rejects a reply that is not a list',
      args: {},
      replies: { [C.cloneJobsList]: () => ({ jobs: [] }) },
      channels: [C.cloneJobsList],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'installedItems.listStatus': [
    {
      name: 'reads the snapshot with no argument',
      args: {},
      replies: { [C.installedItemsListStatus]: () => INSTALLED_SNAPSHOT },
      calls: [call(C.installedItemsListStatus)],
      result: (value) => expect(value).toEqual(INSTALLED_SNAPSHOT),
    },
    {
      name: 'rejects a snapshot that does not parse',
      args: {},
      replies: {
        [C.installedItemsListStatus]: () => ({
          items: [{ ...INSTALLED_SNAPSHOT.items[0], extra: true }],
        }),
      },
      channels: [C.installedItemsListStatus],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: {},
      replies: {
        [C.installedItemsListStatus]: hostRefusesChannel(
          C.installedItemsListStatus,
        ),
      },
      channels: [C.installedItemsListStatus],
      rejects: RemoteHostOutdatedError,
    },
  ],
  'providerUsage.get': [
    {
      name: 'sends no argument, even with a host selected',
      args: { workspaceLocalId: 'project-1' },
      calls: [call(C.providerUsageLoad)],
      result: (value) => expect(value).toEqual(PROVIDER_USAGE),
    },
    {
      name: 'rejects an invalid projection',
      args: {},
      replies: { [C.providerUsageLoad]: () => ({ providers: [] }) },
      channels: [C.providerUsageLoad],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'orgProjects.findRepositoryOwner': [
    {
      name: 'sends exactly the remote URL',
      args: { remoteUrl: 'https://github.com/acme/app.git' },
      calls: [
        call(C.orgProjectsFindRepositoryOwner, {
          remoteUrl: 'https://github.com/acme/app.git',
        }),
      ],
      result: (value) => expect(value).toEqual({ kind: 'none' }),
    },
    {
      name: 'rejects a malformed lookup',
      args: { remoteUrl: 'https://github.com/acme/app.git' },
      replies: { [C.orgProjectsFindRepositoryOwner]: () => ({ kind: 'x' }) },
      channels: [C.orgProjectsFindRepositoryOwner],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'orgProjects.catalog': [
    {
      name: 'reads the cached catalog',
      args: { context: { kind: 'personal' } },
      calls: [call(C.orgProjectsList, { context: { kind: 'personal' } })],
    },
    {
      name: 'refreshes with repositories',
      args: {
        context: { kind: 'personal' },
        refresh: true,
        repositories: true,
      },
      calls: [
        call(C.orgProjectsRefresh, {
          context: { kind: 'personal' },
          force: true,
          repositories: true,
        }),
      ],
    },
    {
      name: 'rejects a malformed catalog',
      args: { context: { kind: 'personal' } },
      replies: { [C.orgProjectsList]: () => ({ context: 'personal' }) },
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'personalOrganization.projects': [
    {
      name: 'parses the project list',
      args: NO_ARGS,
      calls: [call(C.personalOrganizationUpgradeList)],
      result: (value) => expect(value).toEqual({ projects: [] }),
    },
  ],
  'personalOrganization.operationStatus': [
    {
      name: 'reads one operation',
      args: { operationId: 'op-1' },
      calls: [
        call(C.personalOrganizationUpgradeStatus, { operationId: 'op-1' }),
      ],
      result: (value) => expect(value).toBeNull(),
    },
  ],
  'workspaceContext.get': [
    {
      name: 'validates the context state',
      args: NO_ARGS,
      calls: [call(C.workspaceContextGet)],
      result: (value) => expect(value.revision).toBe(3),
    },
    {
      name: 'rejects a malformed state',
      args: NO_ARGS,
      replies: { [C.workspaceContextGet]: () => ({ revision: -1 }) },
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'referencePreview.linearScope': [
    {
      name: 'reads scope',
      args: NO_ARGS,
      calls: [call(C.referencePreviewLinearScope)],
    },
  ],
  'referencePreview.linearTeams': [
    {
      name: 'reads teams',
      args: NO_ARGS,
      calls: [call(C.referencePreviewLinearTeams)],
    },
  ],
  'referencePreview.linearIssue':
    passthroughQuery<'referencePreview.linearIssue'>(
      C.referencePreviewLinearIssue,
      'issue',
    ),
  'referencePreview.githubScope': [
    {
      name: 'reads scope',
      args: NO_ARGS,
      calls: [call(C.referencePreviewGitHubScope)],
    },
  ],
  'referencePreview.githubOrigin':
    passthroughQuery<'referencePreview.githubOrigin'>(
      C.referencePreviewGitHubOrigin,
      'origin',
    ),
  'referencePreview.github': passthroughQuery<'referencePreview.github'>(
    C.referencePreviewGitHub,
    'github',
  ),
  'scriptActions.list': [
    {
      name: 'restores a typed script action error',
      args: opaque('list'),
      replies: {
        [C.scriptActionsList]: () => ({
          ok: false,
          error: { code: 'not_found', message: 'Gone' },
        }),
      },
      rejects: /^Gone$/,
    },
    {
      name: 'rejects an invalid snapshot',
      args: opaque('list'),
      rejects: /Invalid script action response/,
    },
  ],
  'scriptActions.receipt': [
    {
      name: 'accepts a missing receipt',
      args: opaque('receipt'),
      calls: [call(C.scriptActionsReceipt, { opaque: 'receipt' })],
      result: (value) => expect(value).toBeNull(),
    },
  ],
  'onboardingTips.get': narrowPreferenceScenarios<'onboardingTips.get'>(
    C.preferencesLoadOnboardingTips,
    {
      reply: { dismissed: { 'worktree-chat': '2026-11-01T10:00:00.000Z' } },
      expected: { dismissed: { 'worktree-chat': '2026-11-01T10:00:00.000Z' } },
      olderHostExpected: { dismissed: {} },
      olderHostFailures: [
        {
          name: 'rejects a failed preferences load',
          reply: { __error: 'broken' },
          rejects: /Preferences could not be loaded/,
        },
        {
          name: 'rejects a host without tip dismissals',
          reply: {},
          rejects: /does not store onboarding tip dismissals/,
        },
      ],
    },
  ),
  'suggestions.get': narrowPreferenceScenarios<'suggestions.get'>(
    C.preferencesLoadSuggestions,
    {
      reply: {
        enabled: false,
        dismissed: { 'plan-mode-hint': '2026-11-01T10:00:00.000Z' },
      },
      expected: {
        enabled: false,
        dismissed: { 'plan-mode-hint': '2026-11-01T10:00:00.000Z' },
      },
      olderHostExpected: { enabled: true, dismissed: {} },
      olderHostFailures: [
        {
          name: 'rejects a host without suggestion preferences',
          reply: {},
          rejects: /does not store suggestion preferences/,
        },
      ],
    },
  ),
  'claudeMods.get': passthroughQuery<'claudeMods.get'>(C.claudeModsGet, 'mods'),
};

const TAB_SETTINGS: ChatTabSettings = {
  planMode: false,
  proposalMode: 'optional',
  thinkingLevel: 'medium',
};

function prAction(
  action: RemoteControlPrActionPayload['action'],
  extra: Record<string, unknown> = {},
): RemoteControlPrActionPayload {
  const value: unknown = {
    workspaceLocalId: 'single',
    worktreeLocalId: 'wt-a',
    action,
    ...extra,
  };
  return value as RemoteControlPrActionPayload;
}

const COMMAND_SCENARIOS: CommandScenarios = {
  ...SHELL_COMMAND_SCENARIOS,
  'chat.resolvePlanExit': [
    {
      name: 'decides the chat, approves the plan, then starts its turn',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState(PENDING_PLAN_TAB),
        [C.trackedPlansUpdate]: () => APPROVED_PLAN,
      },
      result: (value, context) => {
        expect(value).toEqual({ outcome: 'started' });
        expect(context.fake.calls.slice(0, 3)).toEqual([
          call(C.chatGetState, WORKTREE),
          PLAN_DECISION,
          PLAN_REVIEW_SYNC,
        ]);
        const send = context.fake.calls[3];
        expect(send?.channel).toBe(C.chatCommand);
        expect(send?.args[0]).toMatchObject({
          command: {
            type: 'chat.send_message',
            chatId: 'chat-1',
            text: 'Approved',
            trackedPlanImplementation: {
              planId: 'plan-1',
              revisionNumber: 2,
              startedAt: NOW,
            },
          },
        });
        expect(context.fake.calls).toHaveLength(4);
      },
    },
    {
      name: 'sends the proposal message for a Codex proposal',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState({
          ...PENDING_PLAN_TAB,
          pendingPlanExit: { source: 'codex' },
          trackedPlanSource: 'codex',
        }),
        [C.trackedPlansUpdate]: () => APPROVED_PLAN,
      },
      result: (value, context) => {
        expect(value).toEqual({ outcome: 'started' });
        expect(context.fake.calls[3]?.args[0]).toMatchObject({
          command: { text: 'Approved. Implement the plan.' },
        });
      },
    },
    {
      name: 'refuses an OpenCode proposal without writing',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState({
          ...PENDING_PLAN_TAB,
          pendingPlanExit: { source: 'opencode' },
          trackedPlanSource: 'opencode',
        }),
      },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) => expect(value).toEqual({ outcome: 'rejected' }),
    },
    {
      name: 'refuses an exit without a source instead of reading it as Claude',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState({
          ...PENDING_PLAN_TAB,
          pendingPlanExit: {},
        }),
      },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) => expect(value).toEqual({ outcome: 'rejected' }),
    },
    {
      name: 'answers a stale revision with a conflict and no write',
      args: { ...CHAT, approval: { ...PLAN_APPROVAL, revisionNumber: 1 } },
      replies: { [C.chatGetState]: planExitState(PENDING_PLAN_TAB) },
      calls: [call(C.chatGetState, WORKTREE)],
      result: (value) => expect(value).toEqual({ outcome: 'conflict' }),
    },
    {
      name: 'answers a lost decision race with a conflict',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState(PENDING_PLAN_TAB),
        [C.chatCommand]: () => ({ commandId: 'c', outcome: 'conflict' }),
      },
      calls: [call(C.chatGetState, WORKTREE), PLAN_DECISION],
      result: (value) => expect(value).toEqual({ outcome: 'conflict' }),
    },
    {
      name: 'sends nothing when the plan review did not sync',
      args: { ...CHAT, approval: PLAN_APPROVAL },
      replies: {
        [C.chatGetState]: planExitState(PENDING_PLAN_TAB),
        [C.trackedPlansUpdate]: () => PLAN,
      },
      calls: [call(C.chatGetState, WORKTREE), PLAN_DECISION, PLAN_REVIEW_SYNC],
      result: (value) =>
        expect(value).toEqual({ outcome: 'approved_not_started' }),
    },
  ],
  'chat.retryFailedTurn': [
    {
      name: 're-sends the original message with its attachments',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([
          RETRY_USER_MESSAGE,
          RETRY_NOTICE,
        ]),
      },
      result: (value, context) => {
        expect(value.disposition).toBe('applied');
        expect(value.userMessageId).toMatch(/^failed-turn-retry-[0-9a-f]{32}$/);
        expect(context.fake.calls.map((entry) => entry.channel)).toEqual([
          C.chatGetState,
          C.chatGetTranscriptPage,
          C.chatCommand,
        ]);
        expect(context.fake.calls[2]?.args[0]).toMatchObject({
          command: {
            type: 'chat.send_message',
            chatId: 'chat-1',
            userMessageId: value.userMessageId,
            text: 'Fix the bug',
            attachmentPaths: ['/tmp/a.png'],
          },
        });
      },
    },
    {
      name: 'sends Continue after agent work, and repeats the same id',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([
          RETRY_USER_MESSAGE,
          {
            id: 'assistant-1',
            role: 'assistant',
            timestamp: NOW,
            blocks: [{ type: 'text', text: 'Working on it' }],
          },
          RETRY_NOTICE,
        ]),
        [C.chatCommand]: () => ({ commandId: 'c', outcome: 'already_applied' }),
      },
      result: (value, context) => {
        expect(value.disposition).toBe('already_applied');
        const send = context.fake.calls.find(
          (entry) => entry.channel === C.chatCommand,
        );
        expect(send?.args[0]).toMatchObject({
          command: { text: 'Continue' },
        });
        const sent: unknown = send?.args[0];
        expect(
          isRecord(sent) && isRecord(sent.command)
            ? sent.command.attachmentPaths
            : 'missing',
        ).toBeUndefined();
      },
    },
    {
      name: 'refuses, without sending, when the chat is busy',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: () => ({
          tabsFile: { tabs: [{ id: 'chat-1' }] },
          runtimeByChatId: { 'chat-1': { queuedMessageIds: ['queued-1'] } },
        }),
      },
      calls: [call(C.chatGetState, WORKTREE)],
      rejects: /can't be retried/,
    },
    {
      name: 'rejects a refused send',
      args: RETRY_ARGS,
      replies: {
        [C.chatGetState]: IDLE_CHAT_STATE,
        [C.chatGetTranscriptPage]: transcriptPage([
          RETRY_USER_MESSAGE,
          RETRY_NOTICE,
        ]),
        [C.chatCommand]: () => ({
          commandId: 'c',
          outcome: 'conflict',
          reason: 'The chat changed.',
        }),
      },
      channels: [C.chatGetState, C.chatGetTranscriptPage, C.chatCommand],
      rejects: /The chat changed/,
    },
  ],
  'chat.attachments.upload': [
    {
      name: 'stores the file through the upload port and mints its reference',
      args: {
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        chatId: 'chat-1',
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        bytes: new Uint8Array([104, 101, 108, 108, 111]),
        contentSha256: 'a'.repeat(64),
      },
      calls: [],
      result: (value, context) => {
        expect(value).toEqual(UPLOADED_ATTACHMENT);
        expect(context.uploads).toEqual([['notes.txt', 5]]);
      },
    },
  ],
  'chat.attachments.delete': [
    {
      name: 'is local: the stored copy expires on its own',
      args: {
        workspaceLocalId: 'project-1',
        chatId: 'chat-1',
        attachmentId: 'attachment-1',
      },
      calls: [],
    },
  ],
  // U7: the values go only to the session port, never to a channel, and the
  // routing id stays in the client.
  'chat.secretRequest.settle': [
    {
      name: 'sends entered values to the session port only',
      args: {
        workspaceLocalId: 'project-1',
        action: 'provide',
        requestId: '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01',
        values: { API_TOKEN: 'canary-value' },
        useHeld: ['DATABASE_URL'],
      },
      calls: [],
      result: (value, context) => {
        expect(value).toEqual({ accepted: true });
        expect(context.secretAnswers).toEqual([
          {
            action: 'provide',
            requestId: '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01',
            values: { API_TOKEN: 'canary-value' },
            useHeld: ['DATABASE_URL'],
          },
        ]);
      },
    },
    {
      name: 'declines through the session port',
      args: {
        workspaceLocalId: 'project-1',
        action: 'decline',
        requestId: '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01',
      },
      calls: [],
      result: (value, context) => {
        expect(value).toEqual({ accepted: true });
        expect(context.secretAnswers).toEqual([
          {
            action: 'decline',
            requestId: '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01',
          },
        ]);
      },
    },
  ],
  'delegation.extendLifetimeLimit':
    passthroughCommand<'delegation.extendLifetimeLimit'>(
      C.managedDelegationExtendLifetimeLimit,
      'extend',
    ),
  'providerUsage.refresh': [
    {
      name: 'sends exactly the provider and answers the projection',
      args: { provider: 'claude', workspaceLocalId: 'project-1' },
      calls: [call(C.providerUsageRefresh, { provider: 'claude' })],
      result: (value) => expect(value).toEqual(PROVIDER_USAGE),
    },
    {
      name: 'rejects an invalid projection',
      args: { provider: 'codex' },
      replies: { [C.providerUsageRefresh]: () => undefined },
      channels: [C.providerUsageRefresh],
      rejects: RemoteIpcMalformedReplyError,
    },
  ],
  'cloneJobs.cancel': [
    {
      name: 'cancels one job by id',
      args: { jobId: 'job-1' },
      calls: [call(C.cloneJobsCancel, 'job-1')],
    },
  ],
  'cloneJobs.dismiss': [
    {
      name: 'dismisses one job by id',
      args: { jobId: 'job-1' },
      calls: [call(C.cloneJobsDismiss, 'job-1')],
    },
  ],
  'installedItems.setStatus': [
    {
      name: 'sends exactly the target and status and parses the result',
      args: { target: PLUGIN_TARGET, status: 'disabled' },
      replies: { [C.installedItemsSetStatus]: () => MUTATION_RESULT },
      calls: [
        call(C.installedItemsSetStatus, {
          target: PLUGIN_TARGET,
          status: 'disabled',
        }),
      ],
      result: (value) => expect(value).toEqual(MUTATION_RESULT),
    },
    {
      name: "rejects with the computer's message",
      args: { target: PLUGIN_TARGET, status: 'active' },
      replies: {
        [C.installedItemsSetStatus]: () => {
          throw new Error(
            "Error invoking remote method 'installed-items:set-status': Error: Installed item was not found.",
          );
        },
      },
      channels: [C.installedItemsSetStatus],
      rejects: /^Installed item was not found\.$/,
    },
    {
      name: 'rejects a result that does not parse',
      args: { target: PLUGIN_TARGET, status: 'active' },
      replies: { [C.installedItemsSetStatus]: () => null },
      channels: [C.installedItemsSetStatus],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { target: PLUGIN_TARGET, status: 'active' },
      replies: {
        [C.installedItemsSetStatus]: hostRefusesChannel(
          C.installedItemsSetStatus,
        ),
      },
      channels: [C.installedItemsSetStatus],
      rejects: /Update the desktop app/,
    },
  ],
  'installedItems.uninstall': [
    {
      name: 'sends exactly the target and parses the result',
      args: { target: PLUGIN_TARGET },
      replies: {
        [C.installedItemsUninstall]: () => ({
          ...MUTATION_RESULT,
          requestedStatus: undefined,
          removed: [PLUGIN_TARGET],
        }),
      },
      calls: [call(C.installedItemsUninstall, { target: PLUGIN_TARGET })],
      result: (value) => expect(value.removed).toEqual([PLUGIN_TARGET]),
    },
    {
      name: 'rejects a result that does not parse',
      args: { target: PLUGIN_TARGET },
      replies: { [C.installedItemsUninstall]: () => ({ success: true }) },
      channels: [C.installedItemsUninstall],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { target: PLUGIN_TARGET },
      replies: {
        [C.installedItemsUninstall]: hostRefusesChannel(
          C.installedItemsUninstall,
        ),
      },
      channels: [C.installedItemsUninstall],
      rejects: RemoteHostOutdatedError,
    },
  ],
  'plugins.install': [
    {
      name: 'sends the names with an empty source URL',
      args: { marketplaceId: 'acme', pluginName: 'lint' },
      replies: {
        [C.pluginsInstallPlugin]: () => ({
          success: true,
          data: INSTALLED_PLUGIN,
        }),
      },
      calls: [call(C.pluginsInstallPlugin, 'acme', 'lint', '')],
      result: (value) => expect(value).toEqual(INSTALLED_PLUGIN),
    },
    {
      name: "rejects with the computer's refusal",
      args: { marketplaceId: 'acme', pluginName: 'lint' },
      replies: {
        [C.pluginsInstallPlugin]: () => ({
          success: false,
          error: SOURCE_MISMATCH,
        }),
      },
      channels: [C.pluginsInstallPlugin],
      rejects: /^Remote control can only install this plugin from the source/,
    },
    {
      name: 'rejects a result with a field the browser projection never sends',
      args: { marketplaceId: 'acme', pluginName: 'lint' },
      replies: {
        [C.pluginsInstallPlugin]: () => ({
          success: true,
          data: { ...INSTALLED_PLUGIN, sourcePath: '/Users/me/plugins/lint' },
        }),
      },
      channels: [C.pluginsInstallPlugin],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { marketplaceId: 'acme', pluginName: 'lint' },
      replies: {
        [C.pluginsInstallPlugin]: hostRefusesChannel(C.pluginsInstallPlugin),
      },
      channels: [C.pluginsInstallPlugin],
      rejects: /Update the desktop app/,
    },
  ],
  'plugins.installBuiltIn': [
    {
      name: 'answers a partial install with each provider outcome',
      args: {
        marketplaceId: 'curated/cloud',
        pluginName: 'notes',
        providers: ['claude', 'codex'],
      },
      replies: {
        [C.pluginsInstallBuiltInPlugin]: () => ({
          success: true,
          data: {
            plugin: CURATED_PLUGIN,
            providerOutcomes: {
              claude: { installed: true },
              codex: { installed: false, error: 'Codex facet is unavailable.' },
            },
          },
        }),
      },
      calls: [
        call(C.pluginsInstallBuiltInPlugin, {
          marketplaceId: 'curated/cloud',
          pluginName: 'notes',
          providers: ['claude', 'codex'],
        }),
      ],
      result: (value) =>
        expect(value).toEqual({
          plugin: CURATED_PLUGIN,
          providerOutcomes: {
            claude: { installed: true },
            codex: { installed: false, error: 'Codex facet is unavailable.' },
          },
        }),
    },
    {
      name: "rejects with the first provider's error when none installed",
      args: {
        marketplaceId: 'curated/cloud',
        pluginName: 'notes',
        providers: ['claude', 'codex'],
      },
      replies: {
        [C.pluginsInstallBuiltInPlugin]: () => ({
          success: false,
          error:
            "Couldn't install this plugin. Check the desktop app for details.",
          data: {
            plugin: CURATED_PLUGIN,
            providerOutcomes: {
              claude: {
                installed: false,
                error: 'Claude facet is unavailable.',
              },
              codex: { installed: false, error: 'Codex facet is unavailable.' },
            },
          },
        }),
      },
      channels: [C.pluginsInstallBuiltInPlugin],
      rejects: /^Claude facet is unavailable\.$/,
    },
    {
      name: 'rejects a result that does not parse',
      args: {
        marketplaceId: 'curated/cloud',
        pluginName: 'notes',
        providers: ['claude'],
      },
      replies: {
        [C.pluginsInstallBuiltInPlugin]: () => ({ success: 'yes' }),
      },
      channels: [C.pluginsInstallBuiltInPlugin],
      rejects: RemoteIpcMalformedReplyError,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: {
        marketplaceId: 'curated/cloud',
        pluginName: 'notes',
        providers: ['claude'],
      },
      replies: {
        [C.pluginsInstallBuiltInPlugin]: hostRefusesChannel(
          C.pluginsInstallBuiltInPlugin,
        ),
      },
      channels: [C.pluginsInstallBuiltInPlugin],
      rejects: /Update the desktop app/,
    },
  ],
  'repoRules.apply': passthroughCommand<'repoRules.apply'>(
    C.repoRulesApply,
    'apply',
  ),
  'sidebar.itemGroups.create': passthroughCommand<'sidebar.itemGroups.create'>(
    C.sidebarItemGroupsCreate,
    'g-create',
  ),
  'sidebar.itemGroups.update': passthroughCommand<'sidebar.itemGroups.update'>(
    C.sidebarItemGroupsUpdate,
    'g-update',
  ),
  'sidebar.itemGroups.ungroup':
    passthroughCommand<'sidebar.itemGroups.ungroup'>(
      C.sidebarItemGroupsUngroup,
      'g-ungroup',
    ),
  'sidebar.itemGroups.moveItem':
    passthroughCommand<'sidebar.itemGroups.moveItem'>(
      C.sidebarItemGroupsMoveItem,
      'g-item',
    ),
  'sidebar.itemGroups.moveGroup':
    passthroughCommand<'sidebar.itemGroups.moveGroup'>(
      C.sidebarItemGroupsMoveGroup,
      'g-group',
    ),
  'terminal.spawn': passthroughCommand<'terminal.spawn'>(
    C.terminalSpawn,
    'spawn',
  ),
  'terminal.attach': passthroughCommand<'terminal.attach'>(
    C.terminalAttach,
    'attach',
  ),
  'terminal.write': passthroughCommand<'terminal.write'>(
    C.terminalWrite,
    'write',
  ),
  'terminal.resize': passthroughCommand<'terminal.resize'>(
    C.terminalResize,
    'resize',
  ),
  'terminal.kill': passthroughCommand<'terminal.kill'>(C.terminalKill, 'kill'),
  'terminal.restore': passthroughCommand<'terminal.restore'>(
    C.terminalRestore,
    'restore',
  ),
  'terminal.worktreeState.save':
    passthroughCommand<'terminal.worktreeState.save'>(
      C.terminalSaveWorktreeState,
      'save-state',
    ),
  'file.create': [
    {
      name: 'creates a file in the resolved root',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', relativePath: 'new.ts' },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileTreeMutate, {
          ...WORKTREE,
          operation: 'create-file',
          target: { repoId: 'repo-1', relativePath: 'new.ts' },
        }),
      ],
      result: (value) =>
        expect(value).toEqual({
          fileRootLocalId: 'repo-1',
          path: 'new.ts',
          kind: 'create',
        }),
    },
  ],
  'file.mkdir': [
    {
      name: 'creates a directory',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', relativePath: 'dir' },
      channels: [C.fileTreeRoots, C.fileTreeMutate],
      result: (value) => expect(value.kind).toBe('mkdir'),
    },
  ],
  'file.rename': [
    {
      name: 'moves with conflict refusal',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'a.ts',
        toRelativePath: 'b.ts',
      },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileTreeMutate, {
          ...WORKTREE,
          operation: 'move',
          source: { repoId: 'repo-1', relativePath: 'a.ts' },
          target: { repoId: 'repo-1', relativePath: 'b.ts' },
          conflict: 'error',
        }),
      ],
    },
  ],
  'file.delete': [
    {
      name: 'moves to the trash',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', relativePath: 'a.ts' },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileTreeMutate, {
          ...WORKTREE,
          operation: 'delete',
          target: { repoId: 'repo-1', relativePath: 'a.ts' },
          useTrash: true,
        }),
      ],
    },
    {
      name: 'unwraps a host failure',
      args: { ...WORKTREE, fileRootLocalId: 'repo-1', relativePath: 'a.ts' },
      replies: {
        [C.fileTreeMutate]: () => {
          throw new Error(
            "Error invoking remote method 'file-tree:mutate': Error: Busy",
          );
        },
      },
      rejects: /^Busy$/,
    },
  ],
  'session.end': [{ name: 'is local', args: NO_ARGS, calls: [] }],
  'chat.persistTabSettings': [
    {
      name: 'patches tab settings for a worktree chat',
      args: {
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        settings: TAB_SETTINGS,
      },
      calls: [
        call(C.chatCommand, {
          schemaVersion: 1,
          commandId: 'renderer-chat-settings-chat-1-random-id',
          ...WORKTREE,
          command: {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: {
              planMode: false,
              proposalMode: 'optional',
              modelConfig: { thinkingLevel: 'medium' },
              pendingPlanExit: null,
            },
          },
        }),
      ],
    },
    {
      name: 'falls back to the active Work Entry for a standalone chat',
      args: {
        chatId: 'chat-2',
        scope: 'standalone',
        workspaceLocalId: 'cowork',
        settings: TAB_SETTINGS,
      },
      ports: {
        standaloneChatActiveWork: () => ({
          chatProjectId: 'cowork',
          workEntryId: 'entry-9',
        }),
      },
      result: (_value, context) =>
        expect(context.fake.calls[0]?.args[0]).toMatchObject({
          projectId: 'cowork',
          worktreeId: 'entry-9',
        }),
    },
    {
      name: 'rejects an unapplied outcome',
      args: {
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        settings: TAB_SETTINGS,
      },
      replies: {
        [C.chatCommand]: () => ({ outcome: 'rejected', reason: 'Stale' }),
      },
      rejects: /^Stale$/,
    },
  ],
  'chat.queue.cancel': passthroughCommand<'chat.queue.cancel'>(
    C.chatQueueCancel,
    'cancel',
  ),
  'chat.queue.edit': passthroughCommand<'chat.queue.edit'>(
    C.chatQueueEdit,
    'edit',
  ),
  'chat.queue.force': passthroughCommand<'chat.queue.force'>(
    C.chatQueueForce,
    'force',
  ),
  'chat.queue.steer': [
    {
      name: 'steers through chat:command',
      args: { ...WORKTREE, chatId: 'chat-1', entryId: 'entry-1' },
      calls: [
        call(C.chatCommand, {
          schemaVersion: 1,
          commandId: 'random-id',
          ...WORKTREE,
          command: {
            type: 'chat.steer_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'entry-1',
          },
        }),
      ],
    },
  ],
  'chat.inputDelivery': [
    {
      name: 'acts on a delivery row',
      args: {
        ...WORKTREE,
        chatId: 'chat-1',
        rowId: 'row',
        rowRevision: 2,
        action: 'dismiss',
      },
      channels: [C.chatCommand],
    },
  ],
  'chat.queue.set_edit_lock': passthroughCommand<'chat.queue.set_edit_lock'>(
    C.chatQueueSetEditLock,
    'lock',
  ),
  'file.save': [
    {
      name: 'saves and returns the re-read preview',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'a.ts',
        content: 'new body',
        expectedModifiedAtMs: 1_000,
      },
      calls: [
        call(C.fileTreeRoots, WORKTREE),
        call(C.fileSaveContent, {
          ...WORKTREE,
          absolutePath: '/root/a.ts',
          content: 'new body',
          expectedModifiedAtMs: 1_000,
        }),
      ],
      result: (value) => expect(value.version).toBe('9:2000'),
    },
    {
      name: 'restores the typed save conflict',
      args: {
        ...WORKTREE,
        fileRootLocalId: 'repo-1',
        relativePath: 'a.ts',
        content: 'x',
      },
      replies: {
        [C.fileSaveContent]: () => {
          throw new Error(
            "Error invoking remote method 'file:save-content': FileSaveConflictError: Changed on disk",
          );
        },
      },
      rejects: FileSaveConflictError,
    },
  ],
  'activity.setSectionOrder': [
    {
      name: 'persists known sections only',
      args: {
        workspaceLocalId: 'single',
        order: ['plans', 'unknown', 'summary'],
      },
      channels: [C.projectsLoad, C.projectsSave],
      result: (_value, context) => {
        const saved = context.fake.calls[1]?.args[0];
        expect(saved).toEqual([
          { ...PROJECTS.items[0], activitySectionOrder: ['plans', 'summary'] },
          PROJECTS.items[1],
          PROJECTS.items[2],
        ]);
      },
    },
  ],
  'activity.stopBackgroundTask': [
    {
      name: 'stops one task',
      args: { ...WORKTREE, chatId: 'chat-1', taskId: 'task-1' },
      calls: [
        call(C.activityStopBgProcess, {
          ...WORKTREE,
          chatId: 'chat-1',
          taskId: 'task-1',
        }),
      ],
    },
  ],
  'workspace.create': [
    {
      name: 'clones and invalidates the snapshot',
      args: { kind: 'remote-clone', remoteUrl: 'https://example.com/r.git' },
      calls: [
        call(C.repoDefaultCloneDir),
        call(C.workspaceAddFromRemote, {
          remoteUrl: 'https://example.com/r.git',
          destinationDir: '/clones',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (value) =>
        expect(value).toEqual({
          status: 'completed',
          workspaceId: 'new-workspace',
        }),
    },
    {
      name: 'returns the post-add script scan operation',
      args: { kind: 'remote-clone', remoteUrl: 'https://example.com/r.git' },
      replies: {
        [C.workspaceAddFromRemote]: () => ({
          id: 'new-workspace',
          scriptActionsOperationId: 'op-1',
        }),
      },
      result: (value) =>
        expect(value).toEqual({
          status: 'completed',
          workspaceId: 'new-workspace',
          scriptActionsOperationId: 'op-1',
        }),
    },
    {
      name: 'omits an empty script scan operation',
      args: { kind: 'remote-clone', remoteUrl: 'https://example.com/r.git' },
      replies: {
        [C.workspaceAddFromRemote]: () => ({
          id: 'new-workspace',
          scriptActionsOperationId: '',
        }),
      },
      result: (value) =>
        expect(value).toEqual({
          status: 'completed',
          workspaceId: 'new-workspace',
        }),
    },
  ],
  'workspace.update': [
    {
      name: 'updates metadata',
      args: { workspaceId: 'single', name: 'Renamed' },
      calls: [
        call(C.workspaceUpdateMetadata, {
          workspaceId: 'single',
          name: 'Renamed',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
  ],
  'workspace.setArchiveRetention': [
    {
      name: 'sends only the retention days, then refreshes the snapshot',
      args: { workspaceId: 'single', archiveRetentionDays: 14 },
      calls: [
        call(C.workspaceSetArchiveRetention, {
          workspaceId: 'single',
          archiveRetentionDays: 14,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'rejects with the host message when the computer refuses',
      args: { workspaceId: 'single', archiveRetentionDays: 9999 },
      replies: {
        [C.workspaceSetArchiveRetention]: () => {
          throw new Error(
            "Error invoking remote method 'workspace:set-archive-retention': Error: Archive retention must be null or an integer from 0 to 365",
          );
        },
      },
      channels: [C.workspaceSetArchiveRetention],
      rejects: /^Archive retention must be/,
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { workspaceId: 'single', archiveRetentionDays: 14 },
      replies: {
        [C.workspaceSetArchiveRetention]: () => {
          throw new RemoteChannelUnavailableError(
            C.workspaceSetArchiveRetention,
          );
        },
      },
      channels: [C.workspaceSetArchiveRetention],
      rejects: /Update the desktop app/,
    },
  ],
  'workspace.delete': [
    {
      name: 'deletes a single-repo project',
      args: { workspaceId: 'single' },
      calls: [
        call(C.projectsLoad),
        call(C.projectDelete, { projectId: 'single' }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'deletes a multi-repo workspace, superseding an interrupted deletion',
      args: { workspaceId: 'multi', supersedeInterruptedDeletion: 'op-1' },
      calls: [
        call(C.projectsLoad),
        call(C.workspaceDelete, {
          workspaceId: 'multi',
          supersedeInterruptedDeletion: 'op-1',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'deletes a project with exact reviewed pending archive recovery',
      args: {
        workspaceId: 'single',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      calls: [
        call(C.projectsLoad),
        call(C.projectDelete, {
          projectId: 'single',
          discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'deletes a workspace with exact reviewed pending archive recovery',
      args: {
        workspaceId: 'multi',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      calls: [
        call(C.projectsLoad),
        call(C.workspaceDelete, {
          workspaceId: 'multi',
          discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'refuses pending archive tokens before invoking a host without live resolution',
      args: {
        workspaceId: 'single',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      ports: {
        capabilities: {
          ...CAPABILITIES,
          worktreeRecoveryResolution: undefined,
        },
      },
      rejects: /can't discard pending archive recovery/,
      calls: [],
    },
    {
      name: 'refuses pending archive tokens before invoking a host that denies live resolution',
      args: {
        workspaceId: 'multi',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      ports: {
        capabilities: { ...CAPABILITIES, worktreeRecoveryResolution: false },
      },
      rejects: /can't discard pending archive recovery/,
      calls: [],
    },
    {
      // CAN-7444: a CAN-7439 to CAN-7443 computer refuses a browser's
      // `discardPendingRecovery`.
      name: 'asks for a desktop update when an older computer refuses pending archive recovery',
      args: {
        workspaceId: 'single',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      replies: {
        [C.projectDelete]: () => {
          throw new RemoteChannelUnavailableError(C.projectDelete);
        },
      },
      channels: [C.projectsLoad, C.projectDelete],
      rejects:
        /^Update the desktop app to discard the worktrees that block this deletion\.$/,
    },
    {
      name: 'asks for a desktop update when an older computer refuses a workspace deletion with pending archive recovery',
      args: {
        workspaceId: 'multi',
        discardPendingRecovery: PENDING_ARCHIVE_RECOVERY,
      },
      replies: {
        [C.workspaceDelete]: () => {
          throw new RemoteChannelUnavailableError(C.workspaceDelete);
        },
      },
      channels: [C.projectsLoad, C.workspaceDelete],
      rejects:
        /^Update the desktop app to discard the worktrees that block this deletion\.$/,
    },
    {
      name: 'keeps the refusal of a deletion without pending archive recovery',
      args: { workspaceId: 'single' },
      replies: {
        [C.projectDelete]: () => {
          throw new RemoteChannelUnavailableError(C.projectDelete);
        },
      },
      channels: [C.projectsLoad, C.projectDelete],
      rejects: /is not available while controlling another computer/,
    },
    {
      name: 'rejects an unknown project',
      args: { workspaceId: 'missing' },
      rejects: /Project missing not found/,
    },
  ],
  'lifecycleJournal.inspect': [
    {
      name: 'inspects',
      args: NO_ARGS,
      calls: [call(C.lifecycleJournalInspect)],
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: NO_ARGS,
      replies: {
        [C.lifecycleJournalInspect]: () => {
          throw new RemoteChannelUnavailableError(C.lifecycleJournalInspect);
        },
      },
      channels: [C.lifecycleJournalInspect],
      rejects: /^Update the desktop app to review this record\.$/,
    },
  ],
  'lifecycleJournal.quarantine': [
    ...passthroughCommand<'lifecycleJournal.quarantine'>(
      C.lifecycleJournalQuarantine,
      'quarantine',
    ),
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: opaque('quarantine'),
      replies: {
        [C.lifecycleJournalQuarantine]: () => {
          throw new RemoteChannelUnavailableError(C.lifecycleJournalQuarantine);
        },
      },
      channels: [C.lifecycleJournalQuarantine],
      rejects: /^Update the desktop app to review this record\.$/,
    },
  ],
  'worktree.recovery.list': [
    {
      name: 'lists exact live recovery independent of cold recovery',
      args: { workspaceId: 'single' },
      replies: {
        [C.worktreeRecoveryList]: () => ({
          entries: [],
          resolutions: [],
          check: 'ok',
        }),
      },
      calls: [call(C.worktreeRecoveryList, { workspaceId: 'single' })],
      result: (value: unknown) =>
        expect(value).toEqual({ entries: [], resolutions: [], check: 'ok' }),
    },
    // CAN-7439: the list is read only and needs no action capability.
    {
      name: 'lists with recovery reads and without live resolution',
      args: { workspaceId: 'single' },
      ports: {
        capabilities: {
          ...CAPABILITIES,
          worktreeRecoveryResolution: undefined,
        },
      },
      replies: {
        [C.worktreeRecoveryList]: () => ({ entries: [], check: 'ok' }),
      },
      calls: [call(C.worktreeRecoveryList, { workspaceId: 'single' })],
      result: (value: unknown) =>
        expect(value).toEqual({ entries: [], check: 'ok' }),
    },
    {
      name: 'refuses before the transport without recovery reads',
      args: { workspaceId: 'single' },
      ports: {
        capabilities: { ...CAPABILITIES, worktreeRecoveryReads: undefined },
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'reports an older host refusing the channel as unsupported (with its code)',
      args: { workspaceId: 'single' },
      replies: {
        [C.worktreeRecoveryList]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeRecoveryList);
        },
      },
      calls: [call(C.worktreeRecoveryList, { workspaceId: 'single' })],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'reports an older host refusing the channel as unsupported (Electron-wrapped)',
      args: { workspaceId: 'single' },
      replies: {
        [C.worktreeRecoveryList]: () => {
          throw new Error(
            `Error invoking remote method '${C.worktreeRecoveryList}': Error: ${channelUnavailableMessage(C.worktreeRecoveryList)}`,
          );
        },
      },
      calls: [call(C.worktreeRecoveryList, { workspaceId: 'single' })],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'rethrows any other failure unchanged',
      args: { workspaceId: 'single' },
      replies: {
        [C.worktreeRecoveryList]: () => {
          throw new Error('Recovery evidence belongs to this desktop.');
        },
      },
      calls: [call(C.worktreeRecoveryList, { workspaceId: 'single' })],
      rejects: /Recovery evidence belongs to this desktop/,
    },
  ],
  'worktree.recovery.resolve': [
    ...(['keep-worktree', 'release', 'delete-hold'] as const).map((action) => ({
      name: `resolves only the reviewed operation: ${action}`,
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
        action,
      },
      replies: {
        [C.worktreeRecoveryResolve]: () => ({
          status: 'refused',
          operationId: '12345678-1234-4234-8234-123456789abc',
          check: 'resolution-not-admitted',
        }),
      },
      calls: [
        call(C.worktreeRecoveryResolve, {
          workspaceId: 'single',
          operationId: '12345678-1234-4234-8234-123456789abc',
          revision: 'a'.repeat(64),
          action,
        }),
      ],
      result: (value: unknown) =>
        expect(value).toMatchObject({
          status: 'refused',
          check: 'resolution-not-admitted',
        }),
    })),
    // CAN-7444: a CAN-7439 to CAN-7443 computer refuses the channel.
    {
      name: 'asks for a desktop update when an older computer refuses Resolve (with its code)',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
        action: 'release',
      },
      replies: {
        [C.worktreeRecoveryResolve]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeRecoveryResolve);
        },
      },
      channels: [C.worktreeRecoveryResolve],
      rejects: /^Update the desktop app to resolve this archive\.$/,
    },
    {
      name: 'asks for a desktop update when an older computer refuses Resolve (Electron-wrapped)',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
        action: 'release',
      },
      replies: {
        [C.worktreeRecoveryResolve]: () => {
          throw new Error(
            `Error invoking remote method '${C.worktreeRecoveryResolve}': Error: ${channelUnavailableMessage(C.worktreeRecoveryResolve)}`,
          );
        },
      },
      channels: [C.worktreeRecoveryResolve],
      rejects: /^Update the desktop app to resolve this archive\.$/,
    },
    {
      name: 'passes another Resolve failure through unchanged',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
        action: 'release',
      },
      replies: {
        [C.worktreeRecoveryResolve]: () => {
          throw new Error('Recovery evidence belongs to this desktop.');
        },
      },
      channels: [C.worktreeRecoveryResolve],
      rejects: /^Recovery evidence belongs to this desktop\.$/,
    },
  ],
  'worktree.recovery.finish': [
    {
      name: 'keeps separately pending cleanup distinct from completion',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
      },
      replies: {
        [C.worktreeRecoveryFinish]: () => ({
          status: 'cleanup-pending',
          operationId: '12345678-1234-4234-8234-123456789abc',
          cleanupRequired: true,
          gitCleanupPending: false,
        }),
      },
      calls: [
        call(C.worktreeRecoveryFinish, {
          workspaceId: 'single',
          operationId: '12345678-1234-4234-8234-123456789abc',
          revision: 'a'.repeat(64),
        }),
      ],
      result: (value: unknown) =>
        expect(value).toMatchObject({
          status: 'cleanup-pending',
          cleanupRequired: true,
        }),
    },
    {
      name: 'asks for a desktop update when an older computer refuses Finish (with its code)',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
      },
      replies: {
        [C.worktreeRecoveryFinish]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeRecoveryFinish);
        },
      },
      channels: [C.worktreeRecoveryFinish],
      rejects: /^Update the desktop app to resolve this archive\.$/,
    },
    {
      name: 'asks for a desktop update when an older computer refuses Finish (Electron-wrapped)',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
      },
      replies: {
        [C.worktreeRecoveryFinish]: () => {
          throw new Error(
            `Error invoking remote method '${C.worktreeRecoveryFinish}': Error: ${channelUnavailableMessage(C.worktreeRecoveryFinish)}`,
          );
        },
      },
      channels: [C.worktreeRecoveryFinish],
      rejects: /^Update the desktop app to resolve this archive\.$/,
    },
    {
      name: 'passes another Finish failure through unchanged',
      args: {
        workspaceId: 'single',
        operationId: '12345678-1234-4234-8234-123456789abc',
        revision: 'a'.repeat(64),
      },
      replies: {
        [C.worktreeRecoveryFinish]: () => {
          throw new Error('Recovery evidence belongs to this desktop.');
        },
      },
      channels: [C.worktreeRecoveryFinish],
      rejects: /^Recovery evidence belongs to this desktop\.$/,
    },
  ],
  'worktree.discard.describe': [
    {
      name: 'refreshes recovery with explicit intent and incarnation',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'delete', expectedCreatedAt: NOW },
      },
      calls: [
        call(IPC_CHANNELS.worktreeDiscardDescribe, {
          projectId: 'single',
          worktreeId: 'wt-a',
          recovery: { intent: 'delete', expectedCreatedAt: NOW },
        }),
      ],
    },
    {
      name: 'refreshes unattributable recovery without inventing an incarnation',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'archive', expectedCreatedAt: null },
      },
      calls: [
        call(IPC_CHANNELS.worktreeDiscardDescribe, {
          projectId: 'single',
          worktreeId: 'wt-a',
          recovery: { intent: 'archive', expectedCreatedAt: null },
        }),
      ],
    },
    {
      name: 'describes with retained archives',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        retainedArchives: true,
      },
      calls: [
        call(C.worktreeDiscardDescribe, {
          projectId: 'single',
          worktreeId: 'wt-a',
          retainedArchives: true,
        }),
      ],
    },
    {
      // CAN-7443: a target without settled recovery (web) gets the plain
      // description; a browser controller is refused the key outright.
      name: 'omits recovery, as a key, for a target without worktree recovery',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'delete', expectedCreatedAt: NOW },
      },
      ports: { capabilities: { ...CAPABILITIES, worktreeRecovery: false } },
      calls: [
        call(C.worktreeDiscardDescribe, {
          projectId: 'single',
          worktreeId: 'wt-a',
        }),
      ],
      result: (_value, context) =>
        expect(
          context.fake.calls.map(({ args }) =>
            args.some(
              (arg) =>
                typeof arg === 'object' &&
                arg !== null &&
                Object.prototype.hasOwnProperty.call(arg, 'recovery'),
            ),
          ),
        ).toEqual([false]),
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { workspaceId: 'single', worktreeId: 'wt-a' },
      replies: {
        [C.worktreeDiscardDescribe]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeDiscardDescribe);
        },
      },
      channels: [C.worktreeDiscardDescribe],
      rejects: /^Update the desktop app to discard this worktree\.$/,
    },
    {
      // CAN-7444: a CAN-7439 to CAN-7443 computer refuses a browser's
      // `recovery` with the same code.
      name: 'asks for a desktop update when an older computer refuses recovery',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'archive', expectedCreatedAt: NOW },
      },
      replies: {
        [C.worktreeDiscardDescribe]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeDiscardDescribe);
        },
      },
      channels: [C.worktreeDiscardDescribe],
      rejects: /^Update the desktop app to discard this worktree\.$/,
    },
    {
      name: 'passes another refusal through unchanged',
      args: { workspaceId: 'single', worktreeId: 'wt-a' },
      replies: {
        [C.worktreeDiscardDescribe]: () => {
          throw new Error('This worktree is busy.');
        },
      },
      channels: [C.worktreeDiscardDescribe],
      rejects: /^This worktree is busy\.$/,
    },
  ],
  'worktree.discard': [
    {
      name: 'discards with confirmation',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        confirmation: opaque('confirmation'),
      },
      calls: [
        call(C.worktreeDiscard, {
          projectId: 'single',
          worktreeId: 'wt-a',
          confirmation: { opaque: 'confirmation' },
        }),
      ],
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        confirmation: opaque('confirmation'),
      },
      replies: {
        [C.worktreeDiscard]: () => {
          throw new RemoteChannelUnavailableError(C.worktreeDiscard);
        },
      },
      channels: [C.worktreeDiscard],
      rejects: /^Update the desktop app to discard this worktree\.$/,
    },
  ],
  'workspace.delete.discard.describe': [
    {
      name: 'describes a project deletion',
      args: { workspaceId: 'multi' },
      calls: [call(C.workspaceDeleteDiscardDescribe, { workspaceId: 'multi' })],
    },
    {
      name: 'asks for a desktop update when an older computer refuses the channel',
      args: { workspaceId: 'multi' },
      replies: {
        [C.workspaceDeleteDiscardDescribe]: () => {
          throw new RemoteChannelUnavailableError(
            C.workspaceDeleteDiscardDescribe,
          );
        },
      },
      channels: [C.workspaceDeleteDiscardDescribe],
      rejects:
        /^Update the desktop app to discard the worktrees that block this deletion\.$/,
    },
  ],
  'workspace.reorder': [
    {
      name: 'reorders and invalidates',
      args: opaque('reorder'),
      calls: [
        call(C.workspaceReorder, { opaque: 'reorder' }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
  ],
  'worktree.create': [
    {
      name: 'creates in a single-repo project from the selected branch',
      args: { workspaceId: 'single', baseBranch: 'local:feature' },
      calls: [
        call(C.projectsLoad),
        call(C.worktreeCreate, {
          projectId: 'single',
          repoPath: '/repos/single',
          existingWorktreeIds: ['wt-a', 'wt-b'],
          baseBranch: 'local:feature',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (value) =>
        expect(value).toEqual({
          status: 'completed',
          worktreeId: 'wt-new',
          branchName: 'branch-new',
        }),
    },
    {
      name: 'branches in a multi-repo workspace and carries open tabs',
      args: {
        workspaceId: 'multi',
        baseWorktreeId: 'wt-a',
        forkOpenTabs: true,
      },
      calls: [
        call(C.projectsLoad),
        call(C.workspaceCreateWorktree, {
          workspaceId: 'multi',
          existingWorktreeIds: ['wt-a', 'wt-b'],
          baseWorktreeId: 'wt-a',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (_value, context) =>
        expect(context.forks).toEqual([
          {
            projectId: 'multi',
            sourceWorktreeId: 'wt-a',
            destinationWorktreeId: 'wt-new',
          },
        ]),
    },
    {
      name: 'reports completion when carrying tabs fails',
      args: {
        workspaceId: 'multi',
        baseWorktreeId: 'wt-a',
        forkOpenTabs: true,
      },
      ports: {
        forkWorktreeState: () => Promise.reject(new Error('fork failed')),
      },
      result: (value, context) => {
        expect(value.status).toBe('completed');
        expect(context.logged).toEqual([
          'Failed to carry open tabs to portal-created branched worktree',
        ]);
      },
    },
    {
      name: 'refuses a cowork project',
      args: { workspaceId: 'cowork' },
      rejects: /cowork project/,
    },
  ],
  'worktree.update': [
    {
      name: 'labels and hides',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        label: 'Label',
        hidden: true,
      },
      calls: [
        call(C.worktreeSetLabel, {
          projectId: 'single',
          worktreeId: 'wt-a',
          label: 'Label',
        }),
        call(C.worktreeSetHidden, {
          projectId: 'single',
          worktreeId: 'wt-a',
          hidden: true,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'does nothing without a change',
      args: { workspaceId: 'single', worktreeId: 'wt-a' },
      calls: [],
    },
  ],
  'worktree.archive': [
    {
      name: 'settles row-less cleanup and preserves recovery identity and safety choices',
      args: {
        workspaceId: 'multi',
        worktreeId: 'removed',
        mode: 'delete',
        recovery: { intent: 'delete', expectedCreatedAt: NOW },
        deleteBranch: false,
        expectedBranchName: 'confirmed-branch',
        deleteWithoutRetentionIfMissing: true,
      },
      replies: {
        [C.workspaceArchiveWorktree]: () => ({
          success: true,
          warnings: ['cleanup warning'],
        }),
      },
      calls: [
        call(C.projectsLoad),
        call(C.workspaceArchiveWorktree, {
          workspaceId: 'multi',
          worktreeId: 'removed',
          expectedCreatedAt: NOW,
          remainingWorktreeOrder: ['wt-a', 'wt-b'],
          expectedRemainingWorktreeOrder: ['wt-a', 'wt-b'],
          lockAfterArchive: false,
          typedRefusal: true,
          deleteBranch: false,
          expectedBranchName: 'confirmed-branch',
          deleteWithoutRetentionIfMissing: true,
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
      result: (value) =>
        expect(value).toEqual({
          status: 'completed',
          warnings: ['cleanup warning'],
        }),
    },
    {
      name: 'unconfirmed recovery never invalidates the successful-removal snapshot',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'archive', expectedCreatedAt: NOW },
      },
      replies: { [C.worktreeArchive]: () => undefined },
      channels: [C.projectsLoad, C.worktreeArchive],
      result: (value) => expect(value).toEqual({ status: 'unconfirmed' }),
    },
    {
      name: 'a recovery transport rejection is settled, not a wrapped exception',
      args: {
        workspaceId: 'single',
        worktreeId: 'wt-a',
        recovery: { intent: 'archive', expectedCreatedAt: NOW },
      },
      replies: {
        [C.worktreeArchive]: () => {
          throw new Error('Error invoking remote method');
        },
      },
      channels: [C.projectsLoad, C.worktreeArchive],
      result: (value) => expect(value).toEqual({ status: 'transport-failed' }),
    },
    {
      name: 'archives in a single-repo project',
      args: { workspaceId: 'single', worktreeId: 'wt-a' },
      calls: [
        call(C.projectsLoad),
        call(C.worktreeArchive, {
          projectId: 'single',
          worktreeId: 'wt-a',
          repoPath: '/repos/single',
          remainingWorktreeOrder: ['wt-b'],
          expectedRemainingWorktreeOrder: ['wt-b'],
          expectedCreatedAt: '2026-01-01T00:00:00.000Z',
        }),
        call(C.desktopSessionSnapshotInvalidate),
      ],
    },
    {
      name: 'archives in a multi-repo workspace',
      args: { workspaceId: 'multi', worktreeId: 'wt-b' },
      channels: [
        C.projectsLoad,
        C.workspaceArchiveWorktree,
        C.desktopSessionSnapshotInvalidate,
      ],
    },
  ],
  'worktree.reorder': [
    {
      name: 'reorders and invalidates',
      args: opaque('wt-reorder'),
      channels: [C.worktreeReorder, C.desktopSessionSnapshotInvalidate],
    },
  ],
  'workspace.claudeMd.save': [
    {
      name: 'saves and invalidates',
      args: opaque('claude-md'),
      channels: [C.workspaceSaveClaudeMd, C.desktopSessionSnapshotInvalidate],
    },
  ],
  'workspace.scripts.save': [
    {
      name: 'merges and invalidates',
      args: opaque('scripts'),
      channels: [C.workspaceMergeScripts, C.desktopSessionSnapshotInvalidate],
    },
  ],
  'appAdvisor.settings.save': [
    {
      name: 'saves the patch as Portal applies it',
      args: { thinkingLevel: 'high', autoArchiveDays: 7 },
      replies: { [C.appAdvisorSettingsPatch]: () => ({ ok: true }) },
      calls: [
        call(C.appAdvisorSettingsPatch, {
          thinkingLevel: 'high',
          autoArchiveDays: 7,
        }),
      ],
    },
    {
      name: "rejects with the computer's refusal",
      args: { autoArchiveDays: 0 },
      replies: {
        [C.appAdvisorSettingsPatch]: () => ({
          ok: false,
          code: 'invalid_payload',
          error: 'Invalid Orchestrator settings.',
        }),
      },
      channels: [C.appAdvisorSettingsPatch],
      rejects: /Invalid Orchestrator settings/,
    },
  ],
  'script.run': [
    {
      name: 'narrows a workspace-repo run',
      args: {
        target: 'workspace-repo',
        scriptName: 'dev',
        workspaceId: 'multi',
        worktreeId: 'wt-a',
        repoId: 'repo-1',
      },
      calls: [
        call(C.scriptRun, {
          target: 'workspace-repo',
          scriptName: 'dev',
          workspaceId: 'multi',
          worktreeId: 'wt-a',
          repoId: 'repo-1',
        }),
      ],
    },
    {
      name: 'rejects a project run without routing ids',
      args: { target: 'project', scriptName: 'dev' },
      calls: [],
      rejects: /requires projectId and worktreeId/,
    },
  ],
  'script.cancel': [
    {
      name: 'stops one script',
      args: { ...WORKTREE, scriptKey: 'key' },
      calls: [call(C.scriptStop, { ...WORKTREE, scriptKey: 'key' })],
    },
  ],
  'hook.run': [
    {
      name: 'narrows a project hook',
      args: {
        target: 'project',
        triggerName: 'pre',
        projectId: 'single',
        worktreeId: 'wt-a',
      },
      calls: [
        call(C.hookRun, {
          target: 'project',
          triggerName: 'pre',
          projectId: 'single',
          worktreeId: 'wt-a',
        }),
      ],
    },
  ],
  'hook.cancel': [
    {
      name: 'stops one hook',
      args: { ...WORKTREE, hookKey: 'key' },
      calls: [call(C.hookStop, { ...WORKTREE, hookKey: 'key' })],
    },
  ],
  'pipeline.run': [
    {
      name: 'discovers, loads and executes',
      args: {
        ...WORKTREE,
        pipelineId: 'pipeline-1',
        inputs: { a: '1' },
        modelConfig: { speed: 'fast' },
      },
      calls: [
        call(C.worktreeGetPath, WORKTREE),
        call(C.pipelinesDiscoverProject, '/wt'),
        call(C.pipelinesGet, {
          id: 'pipeline-1',
          cwd: '/wt',
          filePath: '/wt/.canopy/p.yml',
        }),
        call(C.pipelinesExecute, 'name: p', {
          cwd: '/wt',
          pipelineId: 'pipeline-1',
          pipelineFilePath: '/wt/.canopy/p.yml',
          repoPath: '/wt',
          ...WORKTREE,
          inputs: { a: '1' },
          modelConfig: { speed: 'fast', fastMode: true },
        }),
      ],
    },
    {
      name: 'refuses an explicit cwd',
      args: { ...WORKTREE, pipelineId: 'pipeline-1', cwd: 'sub' },
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'surfaces a failed start',
      args: { ...WORKTREE, pipelineId: 'pipeline-1' },
      replies: {
        [C.pipelinesExecute]: () => ({ success: false, error: 'Busy' }),
      },
      rejects: /^Busy$/,
    },
  ],
  'pipeline.cancel': [
    {
      name: 'cancels an execution',
      args: { executionId: 'exec-1' },
      calls: [call(C.pipelinesCancelExecution, 'exec-1')],
    },
  ],
  'pr.action': [
    {
      name: 'commits and pushes the selected repos with the caller message',
      args: {
        workspaceLocalId: 'single',
        worktreeLocalId: 'wt-a',
        action: 'commit_and_push',
        commitMessage: 'msg',
        repoIds: ['repo-2'],
      },
      calls: [
        call(C.worktreeListRepoEntries, {
          projectId: 'single',
          worktreeId: 'wt-a',
        }),
        call(C.githubCommitAndPush, {
          projectId: 'single',
          worktreeId: 'wt-a',
          messages: [{ repoId: 'repo-2', repoName: 'Two', message: 'msg' }],
          repoIds: ['repo-2'],
        }),
      ],
    },
    {
      name: 'fails fast on a partial commit',
      args: {
        workspaceLocalId: 'single',
        worktreeLocalId: 'wt-a',
        action: 'commit_and_push',
        commitMessage: 'msg',
      },
      replies: {
        [C.githubCommitAndPush]: () => ({
          failedRepos: [{ repoName: 'One', error: 'denied' }],
          agentResolutionRepos: [],
        }),
      },
      rejects: /did not complete for all repos: failed repos — One: denied/,
    },
    {
      name: 'pushes',
      args: {
        workspaceLocalId: 'single',
        worktreeLocalId: 'wt-a',
        action: 'push',
      },
      calls: [
        call(C.githubPushOnly, { projectId: 'single', worktreeId: 'wt-a' }),
      ],
    },
    {
      name: 'pulls',
      args: {
        workspaceLocalId: 'single',
        worktreeLocalId: 'wt-a',
        action: 'pull',
      },
      calls: [call(C.githubPull, { projectId: 'single', worktreeId: 'wt-a' })],
    },
    {
      name: 'refuses a repo-scoped push',
      args: {
        workspaceLocalId: 'single',
        worktreeLocalId: 'wt-a',
        action: 'push',
        repoIds: ['repo-1'],
      },
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'refuses create',
      args: prAction('create', { title: 't', body: 'b' }),
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'refuses update_base_branch',
      args: prAction('update_base_branch', { baseBranch: 'main' }),
      calls: [],
      rejects: UnsupportedOperationError,
    },
    {
      name: 'refuses actions no desktop channel honors',
      args: prAction('merge', {
        expectedBaseBranch: 'main',
        expectedHeadBranch: 'feature',
        expectedPrNumber: 1,
      }),
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'pr.create': [
    {
      name: 'is unsupported',
      args: opaque('pr'),
      calls: [],
      rejects: UnsupportedOperationError,
    },
  ],
  'pr.refresh': [
    {
      name: 'requests a status refresh',
      args: { workspaceLocalId: 'single', worktreeLocalId: 'wt-a' },
      calls: [
        call(C.githubRequestRefresh, {
          projectId: 'single',
          worktreeId: 'wt-a',
        }),
      ],
    },
  ],
  'plan.update': [
    {
      name: 'narrows the update request',
      args: {
        ...WORKTREE,
        planId: 'plan-1',
        source: 'codex',
        reviewStatus: 'approved',
        hidden: false,
      },
      calls: [
        call(C.trackedPlansUpdate, {
          ...WORKTREE,
          planId: 'plan-1',
          hidden: false,
          source: 'codex',
          reviewStatus: 'approved',
        }),
      ],
    },
    {
      name: 'refuses an unknown source before the host',
      args: { ...WORKTREE, planId: 'plan-1', source: 'other' },
      calls: [],
      rejects: /Unknown plan source/,
    },
  ],
  'sourceRepository.star': [
    {
      name: 'stars',
      args: NO_ARGS,
      calls: [call(C.settingsStarSourceRepository)],
    },
  ],
  'turnFeedback.rate': [
    {
      name: 'rates a turn',
      args: {
        clientUserMessageId: 'm1',
        clientChatId: 'chat-1',
        rating: 'up',
        provider: 'claude',
      },
      calls: [
        call(C.turnFeedbackRate, {
          clientUserMessageId: 'm1',
          clientChatId: 'chat-1',
          rating: 'up',
          provider: 'claude',
        }),
      ],
      result: (value) => expect(value).toEqual({ feedbackId: 'feedback-1' }),
    },
  ],
  'turnFeedback.detail': [
    {
      name: 'adds detail',
      args: { clientUserMessageId: 'm1', reason: 'got-stuck' },
      calls: [
        call(C.turnFeedbackDetail, {
          clientUserMessageId: 'm1',
          reason: 'got-stuck',
        }),
      ],
    },
  ],
  'turnFeedback.clear': [
    {
      name: 'clears a rating',
      args: { clientUserMessageId: 'm1', feedbackId: 'f' },
      calls: [
        call(C.turnFeedbackClear, {
          clientUserMessageId: 'm1',
          feedbackId: 'f',
        }),
      ],
    },
  ],
  'account.installUpdateEmails.set': [
    {
      name: 'saves the preference',
      args: { enabled: true },
      calls: [
        call(C.settingsSaveInstallUpdateEmailPreference, { enabled: true }),
      ],
    },
  ],
  'orgProjects.setPreference': [
    {
      name: 'files the preference under the window context',
      args: { projectId: 'org-project-1', preference: 'DISMISSED' },
      ports: {
        workspaceContext: () => ({
          kind: 'organization',
          organizationId: '00000000-0000-4000-8000-000000000001',
        }),
      },
      calls: [
        call(C.orgProjectsSetPreference, {
          context: {
            kind: 'organization',
            organizationId: '00000000-0000-4000-8000-000000000001',
          },
          projectId: 'org-project-1',
          preference: 'DISMISSED',
        }),
      ],
    },
  ],
  'orgProjects.setupStart': [
    {
      name: 'starts setup',
      args: { projectId: 'org-project-1', destinationRoot: '/dest' },
      calls: [
        call(C.orgProjectsSetupStart, {
          projectId: 'org-project-1',
          destinationRoot: '/dest',
        }),
      ],
      result: (value) => expect(value.state).toBe('materializing'),
    },
    {
      name: 'rejects a malformed setup reply',
      args: { projectId: 'org-project-1' },
      replies: { [C.orgProjectsSetupStart]: () => ({ state: 'weird' }) },
      rejects: /Malformed organization project setup reply/,
    },
  ],
  'orgProjects.setupCancel': [
    {
      name: 'cancels setup',
      args: { projectId: 'org-project-1' },
      calls: [call(C.orgProjectsSetupCancel, { projectId: 'org-project-1' })],
    },
  ],
  'personalOrganization.upgrade': [
    {
      name: 'restores a typed refusal',
      args: opaque('upgrade'),
      calls: [
        call(C.personalOrganizationUpgradePromote, { opaque: 'upgrade' }),
      ],
      replies: {
        [C.personalOrganizationUpgradePromote]: () => ({
          error: 'Conflict',
          code: 'conflict',
          status: 409,
        }),
      },
      rejects: OrganizationOperationFailure,
    },
  ],
  'personalOrganization.convertProjects': [
    {
      name: 'rejects an invalid operation reply',
      args: opaque('convert'),
      calls: [
        call(C.personalOrganizationUpgradeConvert, { opaque: 'convert' }),
      ],
      rejects: Error,
    },
  ],
  'organization.invite': [
    {
      name: 'invites and restores a typed refusal',
      args: { organizationId: 'org', invite: opaque('invite') },
      calls: [
        call(C.personalOrganizationUpgradeInvite, {
          organizationId: 'org',
          invite: { opaque: 'invite' },
        }),
      ],
      replies: {
        [C.personalOrganizationUpgradeInvite]: () => ({
          error: 'Not found',
          code: 'not_found',
        }),
      },
      rejects: OrganizationOperationFailure,
    },
  ],
  'workspaceContext.set': [
    {
      name: 'sets the context with its expected revision',
      args: { context: { kind: 'personal' }, expectedRevision: 3 },
      calls: [
        call(C.workspaceContextSet, {
          context: { kind: 'personal' },
          expectedRevision: 3,
        }),
      ],
    },
  ],
  'scriptActions.rescan': [
    {
      name: 'rescans',
      args: opaque('rescan'),
      channels: [C.scriptActionsRescan],
      rejects: /Invalid script action response/,
    },
  ],
  'scriptActions.review': [
    {
      name: 'reviews',
      args: opaque('review'),
      channels: [C.scriptActionsReview],
      rejects: /Invalid script action response/,
    },
  ],
  'scriptActions.setShortcut': [
    {
      name: 'sets a shortcut',
      args: opaque('shortcut'),
      channels: [C.scriptActionsSetShortcut],
      rejects: /Invalid script action response/,
    },
  ],
  'scriptActions.setPinned': [
    {
      name: 'pins',
      args: opaque('pin'),
      channels: [C.scriptActionsSetPinned],
      rejects: /Invalid script action response/,
    },
  ],
  'scriptActions.enableShellAliasScan': [
    {
      name: 'enables alias scan',
      args: opaque('alias'),
      channels: [C.scriptActionsEnableShellAliasScan],
      rejects: /Invalid script action response/,
    },
  ],
  'onboardingTips.update': passthroughCommand<'onboardingTips.update'>(
    C.preferencesUpdateOnboardingTips,
    'tips',
  ),
  'suggestions.update': passthroughCommand<'suggestions.update'>(
    C.preferencesUpdateSuggestions,
    'suggestions',
  ),
  'claudeMods.surfaceCommand': passthroughCommand<'claudeMods.surfaceCommand'>(
    C.claudeModSurfaceCommand,
    'mod-surface-command',
  ),
  'claudeMods.update': passthroughCommand<'claudeMods.update'>(
    C.claudeModsUpdate,
    'mods-update',
  ),
};

// ---------------------------------------------------------------------------
// Event scenarios: a push in, a domain event out, and unsubscription.
// ---------------------------------------------------------------------------

interface EventScenario<K extends DomainEventName> {
  readonly name: string;
  readonly filter?: Parameters<
    ReturnType<typeof harness>['client']['subscribe']
  >[2];
  readonly ports?: Partial<IpcCanopyClientPorts>;
  /** Pushes to emit after subscribing, as [channel, payload]. */
  readonly pushes: readonly (readonly [string, unknown])[];
  readonly expected: (events: readonly DomainEventMap[K][]) => void;
  /** Calls the subscription makes; default none. */
  readonly calls?: readonly Call[];
}

type EventScenarios = {
  [K in DomainEventName]: readonly EventScenario<K>[];
};

const TERMINAL_OUTPUT = {
  ...WORKTREE,
  terminalId: 't1',
  seq: 1,
  data: new Uint8Array([104, 105]),
};

const SURFACE_BAND = {
  kind: 'tree',
  site: 'band',
  instanceId: 'above-prompt',
  tree: {
    type: 'Box',
    direction: 'column',
    children: [
      {
        type: 'Button',
        key: 'press',
        label: 'Press me',
        variant: 'secondary',
        press: { plugin: 'mod', handle: 1 },
      },
    ],
  },
};
const SURFACE_COMPOSER_REQUEST = {
  kind: 'composer-request',
  requestId: 'request-1',
  request: { kind: 'read' },
  expiresAt: 1,
};

const EVENT_SCENARIOS: EventScenarios = {
  'chat.transientRetry': [
    {
      name: 'decodes automatic-retry state and drops malformed payloads',
      filter: { chatLocalId: 'chat-1' },
      pushes: [
        [
          C.chatEvent,
          {
            ...WORKTREE,
            chatId: 'chat-1',
            data: {
              type: 'canopy_transient_retry_state',
              provider: 'claude',
              active: true,
              attempt: 1,
              maxAttempts: 3,
              nextRetryAt: 1_000,
              exhausted: false,
            },
          },
        ],
        [
          C.chatEvent,
          {
            ...WORKTREE,
            chatId: 'chat-1',
            data: { type: 'canopy_transient_retry_state', active: 'yes' },
          },
        ],
        [
          C.chatEvent,
          {
            ...WORKTREE,
            chatId: 'chat-2',
            data: {
              type: 'canopy_transient_retry_state',
              active: true,
              attempt: 1,
              maxAttempts: 3,
              nextRetryAt: null,
              exhausted: true,
            },
          },
        ],
        [
          C.chatEvent,
          { ...WORKTREE, chatId: 'chat-1', data: { type: 'assistant' } },
        ],
      ],
      expected: (events) => {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          ...WORKTREE,
          chatId: 'chat-1',
          active: true,
          exhausted: false,
          attempt: 1,
          maxAttempts: 3,
          nextRetryAt: 1_000,
        });
      },
    },
  ],
  'claudeMods.surface': [
    {
      name: 'delivers valid Mod updates only for the subscribed chat',
      filter: { ...WORKTREE, chatLocalId: 'chat-1' },
      pushes: [
        [
          C.claudeModSurfacePush,
          {
            ...WORKTREE,
            chatId: 'chat-1',
            push: { kind: 'status', plugin: 'mod', text: 'Ready' },
          },
        ],
        [
          C.claudeModSurfacePush,
          {
            ...WORKTREE,
            chatId: 'other',
            push: { kind: 'status', plugin: 'mod', text: 'Hidden' },
          },
        ],
        [
          C.claudeModSurfacePush,
          { ...WORKTREE, chatId: 'chat-1', push: { kind: 'unknown' } },
        ],
        // Main validated this tree; it arrives with its controls intact.
        [
          C.claudeModSurfacePush,
          { ...WORKTREE, chatId: 'chat-1', push: SURFACE_BAND },
        ],
        // Never relayed to the Portal, but the desktop window answers it.
        [
          C.claudeModSurfacePush,
          { ...WORKTREE, chatId: 'chat-1', push: SURFACE_COMPOSER_REQUEST },
        ],
      ],
      expected: (events) =>
        expect(events).toEqual([
          {
            ...WORKTREE,
            chatId: 'chat-1',
            push: { kind: 'status', plugin: 'mod', text: 'Ready' },
            occurredAt: NOW,
          },
          {
            ...WORKTREE,
            chatId: 'chat-1',
            push: SURFACE_BAND,
            occurredAt: NOW,
          },
          {
            ...WORKTREE,
            chatId: 'chat-1',
            push: SURFACE_COMPOSER_REQUEST,
            occurredAt: NOW,
          },
        ]),
    },
  ],
  'worktree.activityChanged': [
    {
      name: 'announces panel pushes for the filtered worktree',
      filter: WORKTREE,
      pushes: [
        [
          C.pipelinesExecutionEvent,
          {
            executionId: 'run-1',
            type: 'execution.updated',
            state: { project_id: 'project-1', worktree_id: 'worktree-1' },
          },
        ],
        [C.trackedPlansUpdated, { ...WORKTREE, planId: 'p', change: 'remove' }],
        [C.hookStarted, { ...WORKTREE, hook: {} }],
        [C.hookComplete, { ...WORKTREE, hook: {}, result: {} }],
        [C.scriptStarted, { ...WORKTREE, script: {} }],
        [C.scriptComplete, { ...WORKTREE, script: {}, result: {} }],
        [C.worktreeSummaryUpdated, { ...WORKTREE, summary: {} }],
        [C.worktreeSummaryGenerating, { ...WORKTREE, generating: true }],
        [C.hookStarted, { projectId: 'project-1', worktreeId: 'other' }],
        [
          C.pipelinesExecutionEvent,
          { executionId: 'run-2', state: { worktree_id: 'other' } },
        ],
      ],
      expected: (events) =>
        expect(events.map((event) => event.reason)).toEqual([
          'pipelines',
          'plans',
          'hooks',
          'hooks',
          'scripts',
          'scripts',
          'summary',
          'summary',
        ]),
    },
    {
      name: 'passes a change the computer did not scope',
      filter: WORKTREE,
      pushes: [[C.pipelinesExecutionEvent, { executionId: 'run-3' }]],
      expected: (events) =>
        expect(events).toEqual([{ reason: 'pipelines', occurredAt: NOW }]),
    },
  ],
  'terminal.output': [
    {
      name: 'delivers valid frames in scope and drops malformed ones',
      filter: WORKTREE,
      pushes: [
        [C.terminalOutput, TERMINAL_OUTPUT],
        [C.terminalOutput, { ...TERMINAL_OUTPUT, data: 'text' }],
        [C.terminalOutput, { ...TERMINAL_OUTPUT, worktreeId: 'other' }],
      ],
      expected: (events) => expect(events).toEqual([TERMINAL_OUTPUT]),
    },
  ],
  'terminal.exit': [
    {
      name: 'stamps occurredAt',
      pushes: [
        [
          C.terminalExit,
          { ...WORKTREE, terminalId: 't1', exitCode: 0, signal: null },
        ],
      ],
      expected: (events) => expect(events[0]?.occurredAt).toBe(NOW),
    },
  ],
  'terminal.running-changed': [
    {
      name: 'stamps occurredAt',
      pushes: [
        [
          C.terminalRunningChanged,
          { ...WORKTREE, terminalId: 't1', running: true, processName: null },
        ],
      ],
      expected: (events) => expect(events).toHaveLength(1),
    },
  ],
  'connection.status': [
    {
      name: 'reports the local link active',
      pushes: [],
      expected: (events) =>
        expect(events).toEqual([{ status: 'active', occurredAt: NOW }]),
    },
  ],
  'session.snapshot-stale': [
    {
      name: 'signals staleness',
      pushes: [[C.desktopSessionSnapshotStale, undefined]],
      expected: (events) => expect(events).toEqual([{ occurredAt: NOW }]),
    },
  ],
  'chat.message': [
    {
      name: 'projects runtime events for the filtered chat',
      filter: { chatLocalId: 'chat-1' },
      pushes: [
        [
          C.chatEvent,
          {
            ...WORKTREE,
            chatId: 'chat-1',
            data: {
              type: 'assistant',
              message: {
                id: 'msg-1',
                content: [{ type: 'text', text: 'Hello' }],
              },
            },
          },
        ],
        [
          C.chatEvent,
          { ...WORKTREE, chatId: 'chat-2', data: { type: 'assistant' } },
        ],
        [C.chatEvent, { malformed: true }],
      ],
      expected: (events) => {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          scope: 'worktree',
          workspaceLocalId: 'project-1',
          chatId: 'chat-1',
          message: { text: 'Hello' },
        });
      },
    },
    {
      name: 'routes cowork chats as standalone',
      ports: { isCoworkChatTarget: (projectId) => projectId === 'cowork' },
      pushes: [
        [
          C.chatEvent,
          {
            projectId: 'cowork',
            worktreeId: 'entry-1',
            chatId: 'chat-3',
            data: {
              type: 'assistant',
              message: {
                id: 'msg-2',
                content: [{ type: 'text', text: 'Cowork' }],
              },
            },
          },
        ],
      ],
      expected: (events) =>
        expect(events[0]).toMatchObject({
          scope: 'standalone',
          workspaceLocalId: 'cowork',
        }),
    },
  ],
  'workspace-context.changed': [
    {
      name: 'splits the reason from the state and drops malformed broadcasts',
      pushes: [
        [C.workspaceContextChanged, { ...CONTEXT_STATE, reason: 'switch' }],
        [C.workspaceContextChanged, { ...CONTEXT_STATE, reason: 'bogus' }],
      ],
      expected: (events) =>
        expect(events).toEqual([
          { occurredAt: NOW, state: CONTEXT_STATE, reason: 'switch' },
        ]),
    },
  ],
  'org-projects.changed': [
    {
      name: 'announces a catalog change',
      pushes: [[C.orgProjectsChanged, CATALOG]],
      expected: (events) =>
        expect(events).toEqual([
          { occurredAt: NOW, context: { kind: 'personal' }, reason: 'catalog' },
        ]),
    },
  ],
  'org-projects.setup-progress': [
    {
      name: 'forwards valid progress',
      pushes: [
        [C.orgProjectsSetupProgress, SETUP_PROGRESS],
        [C.orgProjectsSetupProgress, { state: 'bad' }],
      ],
      expected: (events) =>
        expect(events).toEqual([{ progress: SETUP_PROGRESS, occurredAt: NOW }]),
    },
  ],
  'delegation.lifetimeChanged': [
    {
      name: 'filters by worktree',
      filter: WORKTREE,
      pushes: [
        [C.managedDelegationLifetimeChanged, { ...WORKTREE }],
        [
          C.managedDelegationLifetimeChanged,
          { projectId: 'project-1', worktreeId: 'x' },
        ],
      ],
      expected: (events) =>
        expect(events).toEqual([{ ...WORKTREE, occurredAt: NOW }]),
    },
  ],
  'appAdvisor.changed': [
    {
      name: 'declares the surface ready, keeps questions and refuses other views',
      pushes: [
        [
          C.appAdvisorToolRequest,
          {
            requestId: 'req-1',
            kind: 'ask_user_question',
            chatId: 'adv-1',
            question: ADVISOR_QUESTION,
          },
        ],
        [
          C.appAdvisorToolRequest,
          {
            requestId: 'req-2',
            kind: 'show_files',
            originChatTabId: 'adv-1',
          },
        ],
        [C.appAdvisorToolRequestCancelled, { requestId: 'req-1' }],
      ],
      calls: [
        call(C.appAdvisorWindowRendererReady),
        call(C.appAdvisorToolResponse, {
          requestId: 'req-2',
          originChatId: 'adv-1',
          ok: false,
          error: {
            code: 'unsupported_action',
            message:
              'This view is unavailable in the browser. Open it on your computer.',
          },
        }),
      ],
      expected: (events) =>
        expect(events).toEqual([
          { reason: 'question', occurredAt: NOW },
          { reason: 'question', occurredAt: NOW },
        ]),
    },
  ],
  'installedItems.changed': [
    {
      name: 'forwards each notice with no payload',
      pushes: [
        [C.installedItemsChanged, undefined],
        [C.installedItemsChanged, undefined],
      ],
      expected: (events) =>
        expect(events).toEqual([{ occurredAt: NOW }, { occurredAt: NOW }]),
    },
  ],
  'cloneJobs.changed': [
    {
      name: 'forwards the projected list and drops a push that is not one',
      pushes: [
        [
          C.cloneJobsChanged,
          [HOST_CLONE_JOB, { ...HOST_CLONE_JOB, id: 'x', status: 'paused' }],
        ],
        [C.cloneJobsChanged, { jobs: [] }],
        [C.cloneJobsChanged, []],
      ],
      expected: (events) =>
        expect(events).toEqual([
          { jobs: [PORTABLE_CLONE_JOB], occurredAt: NOW },
          { jobs: [], occurredAt: NOW },
        ]),
    },
  ],
  'scriptActions.changed': [
    {
      name: 'forwards valid contexts',
      pushes: [
        [
          C.scriptActionsChanged,
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        ],
        [C.scriptActionsChanged, { projectId: '../bad', worktreeId: 'x' }],
      ],
      expected: (events) =>
        expect(events).toEqual([{ ...WORKTREE, occurredAt: NOW }]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Runners and manifest attribution.
// ---------------------------------------------------------------------------

const observedInvokes = new Map<string, Set<string>>();
const observedListens = new Map<string, Set<string>>();

function observe(
  map: Map<string, Set<string>>,
  operation: string,
  channels: readonly string[],
): void {
  const set = map.get(operation) ?? new Set<string>();
  channels.forEach((channel) => set.add(channel));
  map.set(operation, set);
}

function expectWithinManifest(
  entry: RemoteOperationChannels,
  invoked: readonly string[],
  listened: readonly string[],
): void {
  const use = remoteOperationChannelUse(entry);
  for (const channel of invoked) expect(use.invoke).toContain(channel);
  for (const channel of listened) expect(use.listen).toContain(channel);
}

async function runScenario<Args, Result>(
  kind: 'query' | 'command',
  operation: string,
  entry: RemoteOperationChannels,
  scenario: Scenario<Args, Result>,
  execute: (context: Harness, args: Args) => Promise<Result>,
): Promise<void> {
  const context = harness(scenario.replies, scenario.ports);
  if (scenario.before !== undefined) {
    await scenario.before(context);
    context.fake.calls.length = 0;
    context.fake.listened.length = 0;
  }
  const outcome = execute(context, scenario.args);
  if (scenario.rejects !== undefined) {
    if (scenario.rejects instanceof RegExp) {
      await expect(outcome).rejects.toThrow(scenario.rejects);
    } else {
      await expect(outcome).rejects.toBeInstanceOf(scenario.rejects);
    }
  } else {
    const value = await outcome;
    scenario.result?.(value, context);
  }
  if (scenario.calls !== undefined) {
    expect(context.fake.calls).toEqual(scenario.calls);
  }
  if (scenario.channels !== undefined) {
    expect(context.fake.calls.map((entryCall) => entryCall.channel)).toEqual(
      scenario.channels,
    );
  }
  const invoked = context.fake.calls.map((entryCall) => entryCall.channel);
  expectWithinManifest(entry, invoked, context.fake.listened);
  observe(observedInvokes, `${kind}:${operation}`, invoked);
}

function keysOf<T extends object>(value: T): (keyof T & string)[] {
  return Object.keys(value).filter(
    (key): key is keyof T & string => key in value,
  );
}

function defineQueryTests<K extends QueryName>(operation: K): void {
  const scenarios: QueryScenarios[K] = QUERY_SCENARIOS[operation];
  for (const scenario of scenarios) {
    test(`${operation}: ${scenario.name}`, async () => {
      await runScenario(
        'query',
        operation,
        REMOTE_QUERY_CHANNELS[operation],
        scenario,
        (context, args) => context.client.query(operation, args),
      );
    });
  }
}

function defineCommandTests<K extends CommandName>(operation: K): void {
  const scenarios: CommandScenarios[K] = COMMAND_SCENARIOS[operation];
  for (const scenario of scenarios) {
    test(`${operation}: ${scenario.name}`, async () => {
      await runScenario(
        'command',
        operation,
        REMOTE_COMMAND_CHANNELS[operation],
        scenario,
        (context, args) => context.client.command(operation, args),
      );
    });
  }
}

function defineEventTests<K extends DomainEventName>(operation: K): void {
  const scenarios: EventScenarios[K] = EVENT_SCENARIOS[operation];
  for (const scenario of scenarios) {
    test(`${operation}: ${scenario.name}, then unsubscribes`, () => {
      const context = harness({}, scenario.ports);
      const events: DomainEventMap[K][] = [];
      const unsubscribe = context.client.subscribe(
        operation,
        (event) => events.push(event),
        scenario.filter,
      );
      for (const [channel, payload] of scenario.pushes) {
        context.fake.emit(channel, payload);
      }
      scenario.expected(events);
      const entry: RemoteOperationChannels = REMOTE_EVENT_CHANNELS[operation];
      const invoked = context.fake.calls.map((entryCall) => entryCall.channel);
      expectWithinManifest(entry, invoked, context.fake.listened);
      observe(observedListens, `event:${operation}`, context.fake.listened);
      observe(observedInvokes, `event:${operation}`, invoked);
      const callsBefore = context.fake.calls.length;
      const listened = [...new Set(context.fake.listened)];
      unsubscribe();
      unsubscribe();
      for (const channel of listened) {
        expect(context.fake.listenerCount(channel)).toBe(0);
      }
      const before = events.length;
      for (const [channel, payload] of scenario.pushes) {
        context.fake.emit(channel, payload);
      }
      expect(events).toHaveLength(before);
      // Only the declared calls: in particular no output reset was tunneled,
      // and nothing more after unsubscribing.
      expect(context.fake.calls).toEqual(scenario.calls ?? []);
      expect(context.fake.calls).toHaveLength(callsBefore);
    });
  }
}

describe('portable CanopyClient adapter (golden)', () => {
  test('channel constants are the desktop catalog values', () => {
    expect([
      catalogTypesMatch,
      pipelineTypesMatch,
      marketplaceTypesMatch,
      queryKeysMatch,
      commandKeysMatch,
      eventKeysMatch,
    ]).toEqual([true, true, true, true, true, true]);
    for (const key of keysOf(REMOTE_IPC_CHANNELS)) {
      const value = REMOTE_IPC_CHANNELS[key];
      if (key in PIPELINE_KEYS) {
        expect(Reflect.get(PIPELINE_KEYS, key)).toBe(value);
      } else if (key in MARKETPLACE_KEYS) {
        expect(Reflect.get(MARKETPLACE_KEYS, key)).toBe(value);
      } else if (key.startsWith('scriptActions')) {
        expect(Object.values(SCRIPT_ACTIONS_CHANNELS)).toContain(value);
        expect(Reflect.get(IPC_CHANNELS, key)).toBe(value);
      } else {
        expect(Reflect.get(IPC_CHANNELS, key)).toBe(value);
      }
      // Every reachable channel is classified for remote control.
      expect(['tunnel', 'local', 'blocked']).toContain(
        getRemoteChannelDisposition(value),
      );
    }
    // The host-local output reset is never in the adapter's reach.
    expect(Object.values(REMOTE_IPC_CHANNELS)).not.toContain(
      IPC_CHANNELS.chatEventOutputReset,
    );
  });

  test('the scenario tables and the channel manifest name the same operations', () => {
    expect(keysOf(QUERY_SCENARIOS).sort()).toEqual(
      keysOf(REMOTE_QUERY_CHANNELS).sort(),
    );
    expect(keysOf(COMMAND_SCENARIOS).sort()).toEqual(
      keysOf(REMOTE_COMMAND_CHANNELS).sort(),
    );
    expect(keysOf(EVENT_SCENARIOS).sort()).toEqual(
      keysOf(REMOTE_EVENT_CHANNELS).sort(),
    );
    for (const name of keysOf(QUERY_SCENARIOS)) {
      expect(QUERY_SCENARIOS[name].length).toBeGreaterThan(0);
    }
    for (const name of keysOf(COMMAND_SCENARIOS)) {
      expect(COMMAND_SCENARIOS[name].length).toBeGreaterThan(0);
    }
    const reachable = new Set<string>(deriveRemoteIpcChannels());
    expect([...reachable].sort()).toEqual(
      [...new Set<string>(Object.values(REMOTE_IPC_CHANNELS))].sort(),
    );
  });

  describe('queries', () => {
    for (const operation of keysOf(QUERY_SCENARIOS))
      defineQueryTests(operation);
  });

  describe('commands', () => {
    for (const operation of keysOf(COMMAND_SCENARIOS))
      defineCommandTests(operation);
  });

  describe('events', () => {
    for (const operation of keysOf(EVENT_SCENARIOS))
      defineEventTests(operation);
  });

  test('sharedMultiRepo maps each member to its channel', async () => {
    const context = harness();
    const shared = context.client.sharedMultiRepo;
    if (!shared) throw new Error('missing sharedMultiRepo');
    await expect(shared.prepare(opaque('prepare'))).rejects.toThrow();
    await expect(shared.create(opaque('create'))).rejects.toThrow();
    await expect(shared.resume?.('key')).rejects.toThrow();
    await expect(shared.getCreation('key')).rejects.toThrow();
    await expect(shared.listCreations()).rejects.toThrow();
    await shared.catalog('org-1');
    await shared.cancelSetup('org-1', 'project-1');
    expect(context.fake.calls).toEqual([
      call(C.orgProjectsSharedMultiRepoPrepare, { opaque: 'prepare' }),
      call(C.orgProjectsSharedMultiRepoCreate, { opaque: 'create' }),
      call(C.orgProjectsSharedMultiRepoCreate, { creationKey: 'key' }),
      call(C.orgProjectsSharedMultiRepoGetCreation, { creationKey: 'key' }),
      call(C.orgProjectsSharedMultiRepoListCreations, { limit: 50 }),
      call(C.orgProjectsRefresh, {
        context: { kind: 'organization', organizationId: 'org-1' },
      }),
      call(C.orgProjectsSetupCancel, { projectId: 'project-1' }),
    ]);
    expectWithinManifest(
      REMOTE_MEMBER_CHANNELS.sharedMultiRepo,
      context.fake.calls.map((entryCall) => entryCall.channel),
      [],
    );
    observe(
      observedInvokes,
      'member:sharedMultiRepo',
      context.fake.calls.map((entryCall) => entryCall.channel),
    );
  });

  // CAN-7432: delegate transcript reads over the delegation channels for a
  // controller without a transcript port. Reads resolve, never reject.
  test('transcripts maps each read to its delegation channel', async () => {
    const target = {
      kind: 'delegation',
      chatId: 'chat-1',
      delegationId: 'delegation-1',
      runGeneration: 1,
    } as const;
    const source = {
      scope: {
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };
    const wire = { ...WORKTREE, chatId: 'chat-1', target };
    const content = {
      ...source,
      target,
      messageId: 'message-1',
      blockOrdinal: 2,
      field: 'output',
      offset: 0,
      limit: 64,
    } as const;
    const blocks = { ...source, target, messageId: 'message-1', limit: 8 };
    const page = { messages: [], totalMessages: 0, transcriptRevision: 3 };
    const range = { text: 'body', byteLength: 4 };
    const blocksPage = {
      projection: 'bounded-v1',
      messageId: 'message-1',
      firstBlockOrdinal: 0,
      entries: [],
      blockCount: 0,
      transcriptRevision: 3,
    };
    const signal = new AbortController().signal;
    const ok =
      (value: unknown): (() => unknown) =>
      (): unknown => ({ ok: true, value });
    const capabilities = {
      ...CAPABILITIES,
      delegationTranscriptReads: true,
      delegationBlockReads: true,
    };
    const context = harness(
      {
        [C.chatReadDelegationPage]: ok(page),
        [C.chatReadDelegationContent]: ok(range),
        [C.chatReadDelegationBlocks]: ok(blocksPage),
      },
      { capabilities },
    );
    const reads = context.client.transcripts;
    if (!reads) throw new Error('missing transcripts');
    await expect(
      reads.delegationPage({ ...source, target, cursor: 'next' }, signal),
    ).resolves.toMatchObject({ ok: true, value: { transcriptRevision: 3 } });
    await expect(
      reads.content({ ...content, fieldSource: 'logical' }, signal),
    ).resolves.toStrictEqual({ ok: true, value: range });
    await expect(reads.blocks(blocks, signal)).resolves.toMatchObject({
      ok: true,
      value: { messageId: 'message-1', transcriptRevision: 3 },
    });
    // A primary target's content is never read here.
    await expect(
      reads.content(
        { ...content, target: { kind: 'primary', chatId: 'chat-1' } },
        signal,
      ),
    ).resolves.toStrictEqual({ ok: false, kind: 'unavailable' });
    expect(context.fake.calls).toEqual([
      call(C.chatReadDelegationPage, { ...wire, cursor: 'next' }),
      call(C.chatReadDelegationContent, {
        ...wire,
        messageId: 'message-1',
        blockOrdinal: 2,
        field: 'output',
        fieldSource: 'logical',
        offset: 0,
        limit: 64,
      }),
      call(C.chatReadDelegationBlocks, {
        ...wire,
        messageId: 'message-1',
        limit: 8,
      }),
    ]);
    expectWithinManifest(
      REMOTE_MEMBER_CHANNELS.transcripts,
      context.fake.calls.map((entryCall) => entryCall.channel),
      [],
    );
    observe(
      observedInvokes,
      'member:transcripts',
      context.fake.calls.map((entryCall) => entryCall.channel),
    );

    // Typed failures pass through; anything malformed or rejected fails.
    const replying = (
      reply: () => unknown,
    ): ReturnType<typeof harness>['client']['transcripts'] =>
      harness({ [C.chatReadDelegationPage]: reply }, { capabilities }).client
        .transcripts;
    for (const reason of ['stale', 'unavailable', 'failed'] as const) {
      await expect(
        replying(() => ({ ok: false, reason }))?.delegationPage(
          { ...source, target },
          signal,
        ),
      ).resolves.toStrictEqual({ ok: false, kind: reason });
    }
    const failed = { ok: false, kind: 'failed' };
    await expect(
      replying(() => ({ ok: true, value: { rows: 'no' } }))?.delegationPage(
        { ...source, target },
        signal,
      ),
    ).resolves.toStrictEqual(failed);
    await expect(
      replying(() => ({ ok: 'yes' }))?.delegationPage(
        { ...source, target },
        signal,
      ),
    ).resolves.toStrictEqual(failed);
    await expect(
      replying(() => {
        throw new Error('transport dropped');
      })?.delegationPage({ ...source, target }, signal),
    ).resolves.toStrictEqual(failed);
    // An older host refuses the channel: the read is unavailable.
    await expect(
      replying(() => {
        throw Object.assign(new Error('refused'), {
          code: 'remote_channel_unavailable',
        });
      })?.delegationPage({ ...source, target }, signal),
    ).resolves.toStrictEqual({ ok: false, kind: 'unavailable' });

    // Aborts resolve `cancelled`, before and after the invoke.
    const aborted = new AbortController();
    aborted.abort();
    const idle = harness({}, { capabilities });
    await expect(
      idle.client.transcripts?.delegationPage(
        { ...source, target },
        aborted.signal,
      ),
    ).resolves.toStrictEqual({ ok: false, kind: 'cancelled' });
    expect(idle.fake.calls).toEqual([]);
    const late = new AbortController();
    await expect(
      replying(() => {
        late.abort();
        return { ok: true, value: page };
      })?.delegationPage({ ...source, target }, late.signal),
    ).resolves.toStrictEqual({ ok: false, kind: 'cancelled' });

    // Block reads need their own gate; without it nothing is invoked.
    const noBlocks = harness(
      {},
      { capabilities: { ...capabilities, delegationBlockReads: false } },
    );
    await expect(
      noBlocks.client.transcripts?.blocks(blocks, signal),
    ).resolves.toStrictEqual({ ok: false, kind: 'unavailable' });
    expect(noBlocks.fake.calls).toEqual([]);

    // Without the capability there is no member; a host port always wins.
    expect(harness().client.transcripts).toBeUndefined();
    const port = harness({}, { capabilities, transcripts: reads });
    expect(port.client.transcripts).toBe(reads);
  });

  test('every manifest channel is exercised by some scenario', () => {
    const tables: readonly [
      string,
      Readonly<Record<string, RemoteOperationChannels>>,
    ][] = [
      ['query', REMOTE_QUERY_CHANNELS],
      ['command', REMOTE_COMMAND_CHANNELS],
      ['event', REMOTE_EVENT_CHANNELS],
      ['member', REMOTE_MEMBER_CHANNELS],
    ];
    for (const [kind, table] of tables) {
      for (const [operation, entry] of Object.entries(table)) {
        const use = remoteOperationChannelUse(entry);
        const key = `${kind}:${operation}`;
        expect({
          key,
          invoke: [...(observedInvokes.get(key) ?? [])].sort(),
        }).toEqual({
          key,
          invoke: [...use.invoke].sort(),
        });
        expect({
          key,
          listen: [...(observedListens.get(key) ?? [])].sort(),
        }).toEqual({
          key,
          listen: [...use.listen].sort(),
        });
      }
    }
  });

  test('every invoke rejection is restored from the app-error carrier', async () => {
    const carrier = new IpcAppErrorRejection(
      'Error: The worktree is busy',
      undefined,
      undefined,
    );
    const context = harness({
      [C.trackedPlansGet]: () => {
        throw new Error(
          `Error invoking remote method 'tracked-plans:get': ${carrier.name}: ${carrier.message}`,
        );
      },
    });
    await expect(
      context.client.query('plan.get', { ...WORKTREE, planId: 'plan-1' }),
    ).rejects.toThrow(
      "Error invoking remote method 'tracked-plans:get': Error: The worktree is busy",
    );
  });

  test('a controller allowlist refuses other channels before the transport', async () => {
    const context = harness(
      {},
      { authorizedChannels: new Set([C.trackedPlansGet]) },
    );
    await expect(
      context.client.query('file.roots', WORKTREE),
    ).rejects.toBeInstanceOf(RemoteIpcChannelUnauthorizedError);
    expect(() =>
      context.client.subscribe('chat.message', () => undefined),
    ).toThrow(RemoteIpcChannelUnauthorizedError);
    expect(context.fake.calls).toEqual([]);
    await context.client.query('plan.get', { ...WORKTREE, planId: 'plan-1' });
    expect(context.fake.calls.map((entryCall) => entryCall.channel)).toEqual([
      C.trackedPlansGet,
    ]);
  });

  test('chat events share one listener and decode outputs, resetting only through the port', () => {
    const resets: string[] = [];
    const context = harness(
      {},
      {
        requestChatEventOutputReset: (epoch) => {
          resets.push(epoch);
          return Promise.resolve();
        },
      },
    );
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = context.client.subscribe('chat.message', (event) =>
      first.push(event),
    );
    const stopSecond = context.client.subscribe('chat.message', (event) =>
      second.push(event),
    );
    expect(context.fake.listenerCount(C.chatEvent)).toBe(1);
    expect(resets).toHaveLength(1);
    context.fake.emit(C.chatEvent, {
      ...WORKTREE,
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      },
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    stopFirst();
    expect(context.fake.listenerCount(C.chatEvent)).toBe(1);
    stopSecond();
    expect(context.fake.listenerCount(C.chatEvent)).toBe(0);
    expect(context.fake.calls).toEqual([]);
  });

  test('a transport that delivers decoded chat events gets no decoder or reset', () => {
    const resets: string[] = [];
    const context = harness(
      {},
      {
        chatEventsDecoded: true,
        requestChatEventOutputReset: (epoch) => {
          resets.push(epoch);
          return Promise.resolve();
        },
      },
    );
    const events: unknown[] = [];
    const stop = context.client.subscribe('chat.message', (event) =>
      events.push(event),
    );
    context.fake.emit(C.chatEvent, {
      ...WORKTREE,
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] },
      },
    });
    expect(events).toHaveLength(1);
    expect(resets).toEqual([]);
    stop();
    expect(context.fake.listenerCount(C.chatEvent)).toBe(0);
  });

  test('a mention reference resolves to its computer path on send and rebinds as is', async () => {
    const context = harness();
    const mentions = await context.client.query('editor.fileMentions', {
      payload: { ...WORKTREE, query: 'app' },
    });
    const files: unknown = mentions.result?.files;
    expect(files).toEqual([
      expect.objectContaining({
        referenceId: 'direct-ref-1',
        relativePath: 'src/App.ts',
      }),
    ]);
    const reference = {
      displayPath: 'src/App.ts',
      referenceId: 'direct-ref-1',
      textStart: 4,
    };
    const rebound = await context.client.query('editor.fileMentions', {
      payload: {
        ...WORKTREE,
        rebind: {
          sourceProjectId: 'p',
          sourceWorktreeId: 'w',
          fileReferences: [reference],
        },
      },
    });
    expect(rebound.result?.fileReferences).toEqual([reference]);
    context.fake.calls.length = 0;
    await context.client.command('chat.send', {
      payload: {
        ...CHAT,
        userMessageId: 'user-1',
        text: 'See @App',
        fileReferences: [reference],
      },
    });
    expect(context.fake.calls).toEqual([
      chatEnvelope(WORKTREE, {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'user-1',
        text: 'See @App',
        fileReferences: [
          {
            displayPath: 'src/App.ts',
            absolutePath: '/root/src/App.ts',
            repoName: 'Repo',
            kind: 'file',
            textStart: 4,
          },
        ],
      }),
    ]);
  });

  test('Orchestrator questions are kept per chat and answered on the surface', async () => {
    const context = harness(ADVISOR_REPLIES);
    const events: unknown[] = [];
    const stop = context.client.subscribe('appAdvisor.changed', (event) =>
      events.push(event),
    );
    context.fake.emit(C.appAdvisorToolRequest, {
      requestId: 'req-1',
      kind: 'ask_user_question',
      chatId: 'adv-1',
      question: ADVISOR_QUESTION,
    });
    // A redelivery of the same question changes nothing.
    context.fake.emit(C.appAdvisorToolRequest, {
      requestId: 'req-1',
      kind: 'ask_user_question',
      chatId: 'adv-1',
      question: ADVISOR_QUESTION,
    });
    expect(events).toHaveLength(1);
    const { chats } = await context.client.query('appAdvisor.chats', {});
    expect(chats[0]?.pendingQuestions).toEqual([
      { requestId: 'req-1', questions: [ADVISOR_QUESTION], answered: false },
    ]);
    expect(chats[1]?.pendingQuestions).toBeUndefined();
    const receipt = await context.client.command('appAdvisor.answerQuestion', {
      payload: {
        chatId: 'adv-1',
        requestId: 'req-1',
        answers: [{ question: 'Which city?', selectedOptions: ['Rome'] }],
      },
    });
    expect(receipt.ok).toBe(true);
    expect(context.fake.calls.at(-1)).toEqual(
      call(C.appAdvisorToolResponse, {
        requestId: 'req-1',
        originChatId: 'adv-1',
        ok: true,
        answer: { question: 'Which city?', selectedOptions: ['Rome'] },
      }),
    );
    // Answered: no longer held, and a second answer is refused.
    const again = await context.client.command('appAdvisor.dismissQuestion', {
      payload: { chatId: 'adv-1', requestId: 'req-1' },
    });
    expect(again.ok).toBe(false);
    stop();
    expect(context.fake.listenerCount(C.appAdvisorToolRequest)).toBe(0);
  });

  test('lists every Orchestrator Work Entry, so one whose chats all closed stays in the nav (CAN-7604)', async () => {
    const slackEntry = {
      id: 'slack-entry',
      title: 'Slack conversations',
      createdAt: NOW,
      lastMessageAt: NOW,
    };
    const context = harness({
      [C.workEntriesList]: () => ({
        entries: [...WORK_ENTRIES.entries, slackEntry],
      }),
      // Its Slack tabs closed on their own; none is open.
      [C.chatGetState]: (request) =>
        typeof request === 'object' &&
        request !== null &&
        Reflect.get(request, 'worktreeId') === slackEntry.id
          ? { ...ADVISOR_STATE, tabsFile: { tabs: [] }, runtimeByChatId: {} }
          : ADVISOR_STATE,
    });
    const { chats, workEntries } = await context.client.query(
      'appAdvisor.chats',
      {},
    );
    expect(chats.every((chat) => chat.workEntryId === 'entry-a')).toBe(true);
    expect(workEntries).toEqual([
      {
        id: 'entry-a',
        title: 'Plan the trip',
        createdAt: NOW,
        lastMessageAt: NOW,
        order: 0,
      },
      { ...slackEntry, order: 1 },
    ]);
  });

  test('without an App Advisor surface the Orchestrator refuses before the transport', async () => {
    const fake = fakeTransport(ADVISOR_REPLIES);
    const client = createIpcCanopyClient(fake.transport, {
      capabilities: CAPABILITIES,
      openExternalUrl: () => undefined,
      randomId: () => 'random-id',
    });
    await expect(client.query('appAdvisor.chats', {})).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(
      client.command('appAdvisor.send', { payload: { text: 'Hi' } }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(
      client.command('chat.attachments.upload', {
        workspaceLocalId: 'project-1',
        chatId: 'chat-1',
        fileName: 'a.txt',
        mediaType: 'text/plain',
        bytes: new Uint8Array([1]),
        contentSha256: 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    // Without the session port, secret values are refused before anything
    // is sent.
    await expect(
      client.command('chat.secretRequest.settle', {
        workspaceLocalId: 'project-1',
        action: 'provide',
        requestId: '5b1f0f2e-4d8a-4c1e-9b3a-2f6d7e8c9a01',
        values: { API_TOKEN: 'canary-value' },
        useHeld: [],
      }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    const stop = client.subscribe('appAdvisor.changed', () => undefined);
    stop();
    expect(fake.calls).toEqual([]);
    expect(fake.listened).toEqual([]);
  });

  test('a log read and a hook pause re-announce the worktree rows, one listener per push', async () => {
    const context = harness({
      [C.scriptReadRunLog]: () => ({ lines: [] }),
      [C.hookChangePause]: () => ({ ok: true, pausedHookKeys: [] }),
    });
    const events: DomainEventMap['worktree.activityChanged'][] = [];
    const unsubscribe = context.client.subscribe(
      'worktree.activityChanged',
      (event) => events.push(event),
      WORKTREE,
    );
    expect(context.fake.listenerCount(C.hookComplete)).toBe(1);
    await context.client.command('script.requestLog', {
      payload: { ...WORKTREE, scriptKey: 'project:dev' },
    });
    await context.client.command('hook.pause', {
      payload: { ...WORKTREE, hookKey: 'lint' },
    });
    await context.client.command('hook.pause', {
      payload: { projectId: 'project-1', worktreeId: 'other', hookKey: 'lint' },
    });
    expect(events).toEqual([
      { ...WORKTREE, reason: 'scripts', occurredAt: NOW },
      { ...WORKTREE, reason: 'hooks', occurredAt: NOW },
    ]);
    unsubscribe();
    await context.client.command('hook.pause', {
      payload: { ...WORKTREE, hookKey: 'lint' },
    });
    expect(events).toHaveLength(2);
    expect(context.fake.listenerCount(C.hookComplete)).toBe(0);
  });

  test('a persisted tab setting is served back in the same session', async () => {
    const context = harness();
    await context.client.command('chat.persistTabSettings', {
      chatId: 'chat-1',
      scope: 'worktree',
      workspaceLocalId: 'project-1',
      worktreeLocalId: 'worktree-1',
      settings: opaque('settings'),
    });
    await expect(
      context.client.query('chat.getTabSettings', { chatId: 'chat-1' }),
    ).resolves.toEqual({ opaque: 'settings' });
  });

  test('capabilities narrow by host support and channel authorization', () => {
    const base: CanopyCapabilities = {
      ...CAPABILITIES,
      scriptActions: true,
      terminalPty: true,
      worktreeRemoval: 'delete',
      chatWorkflows: { planMode: true, planReview: true },
    };
    const narrowed = intersectCanopyCapabilities(
      base,
      {
        fileSystemAccess: 'read',
        worktreeRemoval: 'archive',
        chatWorkflows: { planReview: false },
      },
      capabilityLimitForChannels(new Set([C.trackedPlansGet])),
    );
    expect(narrowed.fileSystemAccess).toBe('read');
    expect(narrowed.worktreeRemoval).toBe('archive');
    expect(narrowed.chatWorkflows).toEqual({
      planMode: true,
      planReview: false,
    });
    expect(narrowed.scriptActions).toBe(false);
    expect(narrowed.terminalPty).toBe(false);
    // A limit never raises a capability.
    expect(
      intersectCanopyCapabilities(
        { ...CAPABILITIES, voice: false },
        { voice: true },
      ).voice,
    ).toBe(false);
  });

  test('a branch gate narrows only its own capability', () => {
    const withCommands = capabilityLimitForChannels(new Set([C.chatCommand]));
    expect(withCommands.chatCreateTabSettings).toBeUndefined();
    expect(withCommands.deferredPluginPolicy).toBeUndefined();
    const readOnly = capabilityLimitForChannels(new Set([C.chatGetState]));
    expect(readOnly.chatCreateTabSettings).toBe(false);
    expect(readOnly.deferredPluginPolicy).toBe(false);
    expect(readOnly.chatFailureRetry).toBeUndefined();
    expect(readOnly.planProposalReview).toBeUndefined();
    // A branch with no channels of its own (a host port) is never narrowed
    // by an allowlist.
    expect(
      capabilityLimitForChannels(new Set<string>()).worktreeBranching,
    ).toBeUndefined();
  });

  test('the allowlist derivation follows capability gates and branches', () => {
    const withoutTerminals = deriveRemoteIpcChannels({
      capabilities: { ...CAPABILITIES, terminalPty: false },
    });
    expect(withoutTerminals).not.toContain(C.terminalWrite);
    expect(withoutTerminals).not.toContain(C.terminalOutput);
    const readOnly = deriveRemoteIpcChannels({
      operations: { commands: ['file.save'] },
      capabilities: { ...CAPABILITIES, fileSystemAccess: 'read' },
    });
    expect(readOnly).toEqual([]);
    const archive = deriveRemoteIpcChannels({
      operations: { commands: ['worktree.archive'] },
      capabilities: { ...CAPABILITIES, worktreeRemoval: 'archive' },
    });
    expect(archive).toEqual(
      [
        C.desktopSessionSnapshotInvalidate,
        C.projectsLoad,
        C.workspaceArchiveWorktree,
        C.worktreeArchive,
      ].sort(),
    );
  });
});

describe('discard and journal on an older computer (CAN-7443)', () => {
  test('keeps the refusal code on the update message', async () => {
    const refused = harness({
      [C.worktreeDiscard]: () => {
        throw new RemoteChannelUnavailableError(C.worktreeDiscard);
      },
    });
    const outcome = refused.client.command('worktree.discard', {
      workspaceId: 'single',
      worktreeId: 'wt-a',
      confirmation: opaque('confirmation'),
    });
    await expect(outcome).rejects.toMatchObject({
      message: 'Update the desktop app to discard this worktree.',
      code: CHANNEL_UNAVAILABLE_CODE,
    });
  });
});

describe('archive recovery actions on an older computer (CAN-7444)', () => {
  const target = {
    workspaceId: 'single',
    operationId: '12345678-1234-4234-8234-123456789abc',
    revision: 'a'.repeat(64),
  };

  test('marks the update message so the shared UI trusts that nothing ran', async () => {
    const refused = harness({
      [C.worktreeRecoveryResolve]: () => {
        throw new RemoteChannelUnavailableError(C.worktreeRecoveryResolve);
      },
      [C.worktreeRecoveryFinish]: () => {
        throw new RemoteChannelUnavailableError(C.worktreeRecoveryFinish);
      },
    });
    await expect(
      refused.client.command('worktree.recovery.resolve', {
        ...target,
        action: 'delete-hold',
      }),
    ).rejects.toMatchObject({
      message: 'Update the desktop app to resolve this archive.',
      code: CHANNEL_UNAVAILABLE_CODE,
      hostOutdated: true,
    });
    await expect(
      refused.client.command('worktree.recovery.finish', target),
    ).rejects.toMatchObject({
      message: 'Update the desktop app to resolve this archive.',
      hostOutdated: true,
    });
  });

  test('never marks another failure', async () => {
    const failed = harness({
      [C.worktreeRecoveryResolve]: () => {
        throw new Error('The link dropped.');
      },
    });
    const outcome = failed.client
      .command('worktree.recovery.resolve', { ...target, action: 'release' })
      .catch((error: unknown) => error);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(Reflect.get(Object(error), 'hostOutdated')).toBeUndefined();
  });
});

describe('scoped file queries (CAN-6175)', () => {
  test("a scoped work entry's file reads and saves reach its port, never the transport", async () => {
    const preview = {
      workspaceLocalId: 'project-1',
      worktreeLocalId: 'web-core:chat-1',
      fileRootLocalId: 'workspace',
      path: 'a.ts',
      content: 'a',
      size: 1,
      version: 'v1',
      truncated: false,
    };
    const root = {
      workspaceLocalId: 'project-1',
      worktreeLocalId: 'web-core:chat-1',
      fileRootLocalId: 'workspace',
      label: 'Workspace',
      absolutePath: 'web-core:chat-1/workspace/',
    };
    const seen: string[] = [];
    const context = harness(
      {},
      {
        scopedFiles: (worktreeId) =>
          worktreeId === 'web-core:chat-1'
            ? {
                'file.read': (): Promise<typeof preview> => {
                  seen.push('read');
                  return Promise.resolve(preview);
                },
                'file.resolveLink': (): Promise<{
                  fileRootLocalId: string;
                  relativePath: string;
                }> => {
                  seen.push('link');
                  return Promise.resolve({
                    fileRootLocalId: 'workspace',
                    relativePath: 'a.ts',
                  });
                },
                'file.roots': (): Promise<(typeof root)[]> => {
                  seen.push('roots');
                  return Promise.resolve([root]);
                },
                'file.save': (): Promise<typeof preview> => {
                  seen.push('save');
                  return Promise.resolve(preview);
                },
              }
            : undefined,
      },
    );
    const scope = { projectId: 'project-1', worktreeId: 'web-core:chat-1' };
    await expect(
      context.client.query('file.read', {
        ...scope,
        fileRootLocalId: 'workspace',
        relativePath: 'a.ts',
      }),
    ).resolves.toEqual(preview);
    await expect(
      context.client.query('file.resolveLink', { ...scope, href: 'a.ts' }),
    ).resolves.toEqual({ fileRootLocalId: 'workspace', relativePath: 'a.ts' });
    await expect(context.client.query('file.roots', scope)).resolves.toEqual([
      root,
    ]);
    await expect(
      context.client.command('file.save', {
        ...scope,
        fileRootLocalId: 'workspace',
        relativePath: 'a.ts',
        content: 'a',
        expectedVersion: 'v1',
      }),
    ).resolves.toEqual(preview);
    expect(seen).toEqual(['read', 'link', 'roots', 'save']);
    expect(context.fake.calls).toEqual([]);
  });
});
