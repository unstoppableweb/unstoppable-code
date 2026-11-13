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
  type RemoteIpcChannelKey,
  type RemoteOperationChannels,
} from '@canopy/protocol/remote-control/channels';
import type { PortalPrActionPayload } from '@canopy/protocol/portal';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import { SCRIPT_ACTIONS_CHANNELS } from '@canopy/protocol/script-actions';
import {
  ChatHistoryCursorError,
  RemoteIpcChannelUnauthorizedError,
  RemoteIpcMalformedReplyError,
  UnsupportedOperationError,
  capabilityLimitForChannels,
  createIpcCanopyClient,
  intersectCanopyCapabilities,
  type IpcCanopyClientPorts,
} from '../index';

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
  `pipelines${string}` | `scriptActions${string}`
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

const DEFAULT_REPLIES: Replies = {
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
};

interface Harness {
  readonly fake: FakeTransport;
  readonly client: ReturnType<typeof createIpcCanopyClient>;
  readonly forks: unknown[];
  readonly logged: string[];
  /** Files the upload port stored, as [fileName, byte length]. */
  readonly uploads: (readonly [string, number])[];
}

function harness(
  replies: Replies = {},
  ports: Partial<IpcCanopyClientPorts> = {},
): Harness {
  const fake = fakeTransport(replies);
  const forks: unknown[] = [];
  const logged: string[] = [];
  const uploads: (readonly [string, number])[] = [];
  const client = createIpcCanopyClient(fake.transport, {
    capabilities: CAPABILITIES,
    // The App Advisor surface shares the fake, so its calls and listeners
    // are attributed like any other.
    appAdvisorTransport: fake.transport,
    uploadFile: (fileName, bytes) => {
      uploads.push([fileName, bytes.byteLength]);
      return Promise.resolve(`/uploads/${fileName}`);
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
  return { fake, client, forks, logged, uploads };
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
      result: (value) =>
        expectAccepted(value, {
          commands: [{ name: 'review', section: 'discovered' }],
          stale: false,
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

const QUERY_SCENARIOS: QueryScenarios = {
  ...SHELL_QUERY_SCENARIOS,
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
  'onboardingTips.get': [
    {
      name: 'reads dismissals from preferences',
      args: NO_ARGS,
      calls: [call(C.preferencesLoad, undefined)],
      result: (value) => expect(value).toEqual({ dismissed: {} }),
    },
    {
      name: 'rejects a failed preferences load',
      args: NO_ARGS,
      replies: { [C.preferencesLoad]: () => ({ __error: 'broken' }) },
      rejects: /Preferences could not be loaded/,
    },
  ],
  'suggestions.get': [
    {
      name: 'reads suggestion preferences',
      args: NO_ARGS,
      calls: [call(C.preferencesLoad, undefined)],
      result: (value) => expect(value.enabled).toBe(true),
    },
    {
      name: 'rejects a host without suggestion preferences',
      args: NO_ARGS,
      replies: { [C.preferencesLoad]: () => ({}) },
      rejects: /does not store suggestion preferences/,
    },
  ],
  'claudeMods.get': passthroughQuery<'claudeMods.get'>(C.claudeModsGet, 'mods'),
};

const TAB_SETTINGS: ChatTabSettings = {
  planMode: false,
  proposalMode: 'optional',
  thinkingLevel: 'medium',
};

function prAction(
  action: PortalPrActionPayload['action'],
  extra: Record<string, unknown> = {},
): PortalPrActionPayload {
  const value: unknown = {
    workspaceLocalId: 'single',
    worktreeLocalId: 'wt-a',
    action,
    ...extra,
  };
  return value as PortalPrActionPayload;
}

const COMMAND_SCENARIOS: CommandScenarios = {
  ...SHELL_COMMAND_SCENARIOS,
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
  'delegation.extendLifetimeLimit':
    passthroughCommand<'delegation.extendLifetimeLimit'>(
      C.managedDelegationExtendLifetimeLimit,
      'extend',
    ),
  'providerUsage.refresh': [
    {
      name: 'refreshes one provider',
      args: { provider: 'claude' },
      calls: [call(C.observabilityRefreshUsage, 'claude')],
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
  ],
  'lifecycleJournal.quarantine':
    passthroughCommand<'lifecycleJournal.quarantine'>(
      C.lifecycleJournalQuarantine,
      'quarantine',
    ),
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
  ],
  'workspace.delete.discard.describe': [
    {
      name: 'describes a project deletion',
      args: { workspaceId: 'multi' },
      calls: [call(C.workspaceDeleteDiscardDescribe, { workspaceId: 'multi' })],
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
      name: 'creates in a single-repo project',
      args: { workspaceId: 'single' },
      calls: [
        call(C.projectsLoad),
        call(C.worktreeCreate, {
          projectId: 'single',
          repoPath: '/repos/single',
          existingWorktreeIds: ['wt-a', 'wt-b'],
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

const EVENT_SCENARIOS: EventScenarios = {
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
      queryKeysMatch,
      commandKeysMatch,
      eventKeysMatch,
    ]).toEqual([true, true, true, true, true]);
    for (const key of keysOf(REMOTE_IPC_CHANNELS)) {
      const value = REMOTE_IPC_CHANNELS[key];
      if (key in PIPELINE_KEYS) {
        expect(Reflect.get(PIPELINE_KEYS, key)).toBe(value);
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
