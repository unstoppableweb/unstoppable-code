import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ArchivedChatsFile,
  ChatCoreMutation,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  AgentDelegationBrokerOptions,
  StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import type * as DelegationBrokerModule from '@canopy/desktop-shared/node/delegation/broker';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation/types';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import {
  FileDelegationStorage,
  FileManagedDelegationMessageStorage,
} from '@canopy/desktop-shared/node/delegation/storage';
import type { StoredManagedDelegationMessageReceipt } from '@canopy/desktop-shared/node/delegation/storage';
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import { DelegationIoTrace } from './helpers/delegation-io-trace';
import type {
  RepositoryDelegationTranscriptChatState,
  DelegationRecordReadPort,
} from '../agents/delegation/repository-transcript-port';
import type { ChatStateService } from '../services/chat-state-service';
import type { ChatReadSelection } from '../services/chat-state-v2-backend';

type WorktreeScope = { projectId: string; worktreeId: string };
type ChatScope = WorktreeScope & { chatId: string };
type FixtureName =
  | 'replay-events'
  | 'saved-parent-rows'
  | 'live-durable-remote-control-payloads'
  | 'recovery-mutations'
  | 'tree'
  | 'transcript-page'
  | 'roots'
  | 'receipt-replay';

const FIXTURE_DIRECTORY = path.join(
  __dirname,
  'fixtures',
  'delegation-readers-golden',
);
// Expected bytes were captured once on unchanged phase 11a code; never regenerate them.
const FIXED_NOW = 1_798_000_000_000;
let mockDataRoot = '';
let mockTrace: DelegationIoTrace;
let currentComposition = '';
const absentTraces = new Map<FixtureName, string>();
const mockForbiddenRead = (method: string, args: unknown[]): Promise<never> =>
  mockTrace.call(`registry.${method}`, undefined, args, () =>
    Promise.reject(new Error(`Unexpected registry call: ${method}`)),
  );
type HostDouble = RepositoryDelegationTranscriptChatState &
  Pick<DelegationRecordReadPort, 'readStoredParentMessage'> &
  Pick<ChatStateService, 'childStreamCompatibilityPage'>;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
let temporaryRoot = '';

function legacyEmptyChatTabs(): ChatTabsFile {
  const tabs: ChatTabsFile = { version: 1, activeTabId: '', tabs: [] };
  // Preserve the older no-active-tab input used by these compatibility tests.
  Reflect.set(tabs, 'activeTabId', null);
  return tabs;
}

function legacyRouteSnapshot(
  selectedModelId: string,
  runtimeModelId: string,
  harnessId: string,
): PersistedAgentRouteSnapshot {
  const routeSnapshot: PersistedAgentRouteSnapshot = {
    ...projectAgentRoute(
      routeFixture({ selectedModelId, runtimeModelId, harnessId }),
    ),
  };
  const fieldsAbsentFromLegacySnapshots: readonly (keyof PersistedAgentRouteSnapshot)[] =
    [
      'runtimeKind',
      'runnerRegistrationId',
      'runtimeVersion',
      'adapterVersion',
      'modelSource',
      'providerType',
      'assignmentRevision',
      'billingAuthority',
      'aiCreditsRouted',
      'capabilities',
      'supportedThinkingLevels',
      'capabilitySnapshotHash',
      'capabilityGeneration',
      'policyRevision',
    ];
  for (const field of fieldsAbsentFromLegacySnapshots)
    Reflect.deleteProperty(routeSnapshot, field);
  return routeSnapshot;
}

const mockInitialize = jest.fn((): Promise<void> => Promise.resolve());
const mockTranscripts = jest.fn<
  Promise<readonly AgentDelegationTranscript[]>,
  [DelegationParentContext, string?]
>(() => Promise.resolve([]));
const mockGetCompatibilityTabs = jest.fn<
  Promise<ChatTabsFile>,
  [WorktreeScope, ChatReadSelection?]
>(() => Promise.resolve(legacyEmptyChatTabs()));
const mockGetCompatibilityArchives = jest.fn<
  Promise<ArchivedChatsFile>,
  [WorktreeScope, ChatReadSelection?]
>(() => Promise.resolve({ version: 1, archived: [] }));
/** The replay's one leased read, over the same compatibility rows. */
async function mockConsumeTranscript<T>(
  scope: WorktreeScope,
  chatId: string,
  _fullOutputs: boolean,
  consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
): Promise<T> {
  const selection = { chatIds: [chatId], fullTranscript: true };
  const tabs = await mockGetCompatibilityTabs(scope, selection);
  const archives = await mockGetCompatibilityArchives(scope, selection);
  const tab = [
    ...tabs.tabs,
    ...archives.archived.map((entry) => entry.tab),
  ].find((candidate) => candidate.id === chatId && candidate.kind !== 'file');
  return consume(
    (async function* (): AsyncGenerator<PersistedChatMessage> {
      for (const message of tab?.messages ?? [])
        yield await Promise.resolve(message);
    })(),
  );
}
const mockReadDelegationItems = jest.fn<
  Promise<AgentDelegationTranscriptItem[]>,
  [
    {
      projectId: string;
      worktreeId: string;
      chatId: string;
      delegationId: string;
      runGeneration: number;
    },
  ]
>(() => Promise.resolve([]));
const mockRemoteControlRead = jest.fn<
  Promise<ChatTabsFile>,
  [string, string, ChatReadSelection?]
>(() => Promise.resolve(legacyEmptyChatTabs()));

jest.mock('@canopy/desktop-shared/node/delegation/broker', () => ({
  ...jest.requireActual<typeof DelegationBrokerModule>(
    '@canopy/desktop-shared/node/delegation/broker',
  ),
  AgentDelegationBroker: jest.fn((options: AgentDelegationBrokerOptions) => ({
    initialize: mockInitialize,
    parentCwd: (): string => options.cwd,
    // The service reports the worktree's lifetime allowance once the broker loads.
    lifetimeSnapshot: (): {
      kind: 'available';
      occupied: number;
      retained: number;
      limit: number;
      cap: number;
      atLimit: boolean;
      extension: 'at_cap';
    } => ({
      kind: 'available',
      occupied: 0,
      retained: 0,
      limit: 512,
      cap: 512,
      atLimit: false,
      extension: 'at_cap',
    }),
    replayQueuedBackground: mockInitialize,
    transcripts: (
      ...args: Parameters<typeof mockTranscripts>
    ): ReturnType<typeof mockTranscripts> =>
      mockTrace.call('broker.transcripts', undefined, args, () =>
        mockTranscripts(...args),
      ),
    recordStore: (): 'legacy' => 'legacy',
    deliver: mockInitialize,
    inspect: (...args: unknown[]): { runGeneration: number } =>
      mockTrace.sync('broker.inspect', undefined, args, () => ({
        runGeneration: 1,
      })),
    list: (...args: unknown[]): AgentDelegationSnapshot[] =>
      mockTrace.sync('broker.list', undefined, args, () => []),
    activeCount: (): number => 0,
    queuedCount: (): number => 0,
    stop: (
      ...args: unknown[]
    ): Promise<{ ok: true; value: AgentDelegationSnapshot }> =>
      mockTrace.call('broker.stop', undefined, args, () =>
        Promise.resolve({
          ok: true,
          value: {
            delegationId: 'child',
            status: 'cancelled',
            outputTruncated: false,
          },
        }),
      ),
    close: mockInitialize,
    closeOwner: mockInitialize,
    revokeHarness: mockInitialize,
    childContext: (): undefined => undefined,
    continuationCandidates: (): [] => [],
    delegationLineage: (): undefined => undefined,
  })),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    path.join(mockDataRoot, projectId, worktreeId),
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): HostDouble & Record<string, unknown> =>
    ({
      getCompatibilityTabs: (
        ...args: Parameters<typeof mockGetCompatibilityTabs>
      ): ReturnType<typeof mockGetCompatibilityTabs> =>
        mockTrace.call('compatibility.tabs', undefined, args, () =>
          mockGetCompatibilityTabs(...args),
        ),
      consumeTranscript: mockConsumeTranscript,
      getCompatibilityArchives: (
        ...args: Parameters<typeof mockGetCompatibilityArchives>
      ): ReturnType<typeof mockGetCompatibilityArchives> =>
        mockTrace.call('compatibility.archives', undefined, args, () =>
          mockGetCompatibilityArchives(...args),
        ),
      readDelegationItems: (
        ...args: Parameters<typeof mockReadDelegationItems>
      ): Promise<AgentDelegationTranscriptItem[]> =>
        mockTrace.call(
          'compatibility.readDelegationItems',
          undefined,
          args,
          () => mockReadDelegationItems(...args),
        ),
      appendDelegationReceipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendDelegationReceipt', args),
      itemAdmission: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('itemAdmission', args),
      settleDelegationResult: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('settleDelegationResult', args),
      withChildStreamTarget: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('withChildStreamTarget', args),
      openChildStream: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('openChildStream', args),
      commitChildStream: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('commitChildStream', args),
      commitPreparedChildStream: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('commitPreparedChildStream', args),
      readChildStreamContent: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('readChildStreamContent', args),
      childStreamCompatibilityPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('childStreamCompatibilityPage', args),
      generation: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('generation', args),
      resultByGeneration: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultByGeneration', args),
      generationsPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('generationsPage', args),
      appendReceipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendReceipt', args),
      receipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('receipt', args),
      open: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('open', args),
      appendChanges: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendChanges', args),
      flush: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('flush', args),
      result: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('result', args),
      resultBySettlementKey: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultBySettlementKey', args),
      resultAnswerRange: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultAnswerRange', args),
      page: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('page', args),
      message: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('message', args),
      contentRange: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('contentRange', args),
      resultsPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultsPage', args),
      current: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('current', args),
      registerGeneration: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('registerGeneration', args),
      updateCardState: (
        ...args: Parameters<
          RepositoryDelegationTranscriptChatState['updateCardState']
        >
      ): ReturnType<
        RepositoryDelegationTranscriptChatState['updateCardState']
      > => mockForbiddenRead('updateCardState', args),
      beginSettlement: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('beginSettlement', args),
      settle: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('settle', args),
      getChildStreamState: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('getChildStreamState', args),
      getChildStreamMessage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('getChildStreamMessage', args),
      getChildStreamPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('getChildStreamPage', args),
      readStoredParentMessage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('readStoredParentMessage', args),

      subscribe: (listener: unknown): (() => void) => {
        void listener;
        return () => undefined;
      },
    }) satisfies HostDouble & Record<string, unknown>,
}));

jest.mock('../services/remote-control-chat-tabs-cache', () => ({
  remoteControlChatTabsCache: {
    read: (
      ...args: Parameters<typeof mockRemoteControlRead>
    ): ReturnType<typeof mockRemoteControlRead> =>
      mockTrace.call('compatibility.portalTabs', undefined, args, () =>
        mockRemoteControlRead(...args),
      ),
  },
}));

jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(() => ({
    resolve: (): Promise<never> => Promise.reject(new Error('unused route')),
    release: (): void => undefined,
    dispose: (): void => undefined,
    discoverCapabilities: (): Promise<{ capabilities: [] }> =>
      Promise.resolve({ capabilities: [] }),
  })),
}));

jest.mock('../agents/delegation/claude-runner', () => ({
  createClaudeDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'claude', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/codex-runner', () => ({
  createCodexDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'codex', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/cursor-runner', () => ({
  createCursorDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'cursor', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/copilot-runner', () => ({
  createCopilotDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'copilot', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/opencode-runner', () => ({
  createOpenCodeDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'opencode', version: '1', capabilities: [] }),
}));
jest.mock('../cursor/connection', () => ({
  getCursorAccountGeneration: (): number => 1,
}));
jest.mock('../copilot/connection', () => ({
  getCopilotAccountGeneration: (): number => 1,
}));
jest.mock('../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => 1,
}));
jest.mock('@canopy/desktop-shared/node/delegation/runner-registry', () => ({
  AgentRunnerRegistry: jest.fn(() => ({ register: (): void => undefined })),
}));
jest.mock('../agents/session-manager', () => ({
  getSession: (): undefined => undefined,
  getProviderAuthGeneration: (): number => 1,
  getSessionPluginSelections: (): undefined => undefined,
  getSessionGlobalPluginDefaultsRevision: (): undefined => undefined,
  getGlobalPluginDefaultsRevision: (): number => 0,
  subscribeGlobalPluginDefaultsRevision: (): (() => void) => () => undefined,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));

import { DelegationCardPersistence } from '../agents/delegation/card-persistence';
import { DelegationCardPublisher } from '../agents/delegation/card-publication';
import { DelegationLiveFrames } from '../agents/delegation/item-changes';
import { loadDelegationRecoveryMutations } from '../agents/delegation/recovery';
import {
  configureManagedDelegationReaders,
  createManagedDelegationSession,
  messageManagedDelegationForUser,
  readManagedDelegationRootsForUser,
  readManagedDelegationTranscriptForUser,
  readManagedDelegationTreeForUser,
} from '../agents/delegation/service';
import { closeDelegationScope } from '../agents/delegation/lifecycle';

function transcript(
  delegationId: string,
  runGeneration: number,
  sequence: number,
  options: {
    readonly description?: string;
    readonly prompt?: string;
    readonly status?: AgentDelegationSnapshot['status'];
    readonly text?: string;
    readonly items?: readonly AgentDelegationTranscriptItem[];
    readonly store?: 'chat-log-v1';
    readonly snapshot?: Partial<AgentDelegationSnapshot>;
  } = {},
): AgentDelegationTranscript {
  const status = options.status ?? 'completed';
  return {
    delegationId,
    runGeneration,
    sequence,
    parentHarnessId: 'codex',
    parentTurnId: 'turn',
    parentToolCallId: `call-${delegationId}`,
    createdAt: 100 + sequence,
    task: {
      description: options.description ?? 'Review',
      prompt: options.prompt ?? 'Inspect retained evidence',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      status,
      outputTruncated: false,
      routeSnapshot: publicRouteFixture(),
      ...(status === 'completed'
        ? { finalText: options.text ?? 'Complete' }
        : {}),
      ...options.snapshot,
    },
    transcript: [...(options.items ?? [])],
    ...(options.store
      ? { transcriptStore: options.store, transcriptMode: 'patch' as const }
      : {}),
  };
}

function textItem(
  id: string,
  sequence: number,
  text: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text };
}

function publicRouteFixture(): ReturnType<typeof routeFixture> {
  const route: Mutable<ReturnType<typeof routeFixture>> = { ...routeFixture() };
  delete route.authAccountKey;
  return route;
}

function toolItem(
  id: string,
  sequence: number,
  output?: string,
): AgentDelegationTranscriptItem {
  return {
    id,
    sequence,
    occurredAt: sequence,
    type: 'tool',
    toolName: 'Bash',
    input: 'git status --short',
    ...(output === undefined ? {} : { output }),
  };
}

function savedParentRows(
  run: AgentDelegationTranscript,
): PersistedChatMessage[] {
  return delegationTranscriptMessages(run);
}

function task(): StoredDelegation['task'] {
  return {
    modelId: 'logical-review-model',
    description: 'Review',
    prompt: 'Inspect retained evidence',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
    executionMode: 'background',
  };
}

function storedRecord(
  id: string,
  options: {
    readonly version: 1 | 2;
    readonly chatId?: string;
    readonly createdAt: number;
    readonly generation?: number;
    readonly sequence?: number;
    readonly status?: StoredDelegation['state']['status'];
    readonly phase?: StoredDelegation['launch']['phase'];
    readonly items?: readonly AgentDelegationTranscriptItem[];
    readonly history?: readonly AgentDelegationTranscript[];
    readonly admission?: StoredDelegation['admission'];
    readonly finishedAt?: number;
  },
): StoredDelegation {
  const generation = options.generation ?? 1;
  const status = options.status ?? 'completed';
  const phase =
    options.phase ?? (status === 'completed' ? 'settled' : 'starting');
  const chatId = options.chatId ?? 'reader-chat';
  return {
    version: options.version,
    ...(options.version === 2
      ? { transcriptRevision: options.sequence ?? 1 }
      : {}),
    ...(options.history ? { history: [...options.history] } : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    parent: {
      harnessId: 'codex',
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
      chatId,
      sessionKey: `reader-project/reader-worktree/${chatId}`,
      turnId: 'turn',
      toolCallId: `call-${id}`,
      runtimeGeneration: 1,
      depth: 0,
    },
    task: task(),
    route: publicRouteFixture(),
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: options.createdAt,
    deadlineAt: options.createdAt + 1000,
    state: {
      delegationId: id,
      runGeneration: generation,
      sequence: options.sequence ?? 1,
      status,
      outputTruncated: false,
      ...(status === 'completed' ? { finalText: `Final result ${id}` } : {}),
      ...(status === 'completed' && options.finishedAt !== undefined
        ? { finishedAt: options.finishedAt }
        : {}),
      ...(options.items ? { transcript: [...options.items] } : {}),
    },
    launch: {
      version: 1,
      delegationId: id,
      launchKey: 'a'.repeat(64),
      runGeneration: generation,
      phase,
      ...(status === 'completed' ? { terminalStatus: 'completed' } : {}),
    },
    delivery: { status: 'unclaimed' },
  };
}

function parentTurn(): PersistedChatMessage {
  return {
    id: 'turn',
    role: 'user',
    timestamp: 90,
    blocks: [{ type: 'text', text: 'Please inspect the retained task.' }],
  };
}

function chatTabs(messages: PersistedChatMessage[]): ChatTabsFile {
  const tab: PersistedChatTab = {
    id: 'reader-chat',
    title: 'Reader fixture',
    createdAt: '2026-10-17T00:00:00.000Z',
    messages,
  };
  return { version: 1, activeTabId: tab.id, tabs: [tab] };
}

async function saveRecords(
  scope: ChatScope,
  records: readonly StoredDelegation[],
): Promise<void> {
  const storage = new FileDelegationStorage(
    path.join(
      mockDataRoot,
      scope.projectId,
      scope.worktreeId,
      'delegation',
      'runs',
    ),
  );
  for (const record of records) await storage.commit(record);
}

/** Replace only a randomized temporary-path prefix; transcript content stays byte-exact. */
function normalizeVolatile(value: unknown): unknown {
  if (typeof value === 'string')
    return temporaryRoot && value.startsWith(temporaryRoot)
      ? value.replace(temporaryRoot, '<TEMP_ROOT>')
      : value;
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeVolatile(entry),
      ]),
    );
  return value;
}

function assertGoldenMatch(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function compareGolden(name: FixtureName, actual: unknown): unknown {
  mockTrace.enabled = false;
  expect(
    mockTrace.entries.filter((entry) =>
      /^(reader|stream|registry)\./.test(entry.operation),
    ),
  ).toEqual([]);
  const trace = JSON.stringify(mockTrace.entries);
  if (currentComposition === 'absent') absentTraces.set(name, trace);
  else {
    expect(absentTraces.has(name)).toBe(true);
    expect(trace).toBe(absentTraces.get(name));
  }
  const normalized = normalizeVolatile(actual);
  const fixturePath = path.join(FIXTURE_DIRECTORY, `${name}.json`);
  const expected: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assertGoldenMatch(normalized, expected);
  return expected;
}

describe.each(['absent', 'production'])('%s composition', (composition) => {
  let disposeReaders: (() => void) | undefined;
  beforeEach(async () => {
    if (composition === 'absent')
      disposeReaders = configureManagedDelegationReaders({});
    jest.clearAllMocks();
    mockTranscripts.mockReset().mockResolvedValue([]);
    mockGetCompatibilityTabs
      .mockReset()
      .mockResolvedValue(legacyEmptyChatTabs());
    mockGetCompatibilityArchives
      .mockReset()
      .mockResolvedValue({ version: 1, archived: [] });
    mockReadDelegationItems.mockReset().mockResolvedValue([]);
    mockRemoteControlRead.mockReset().mockResolvedValue(legacyEmptyChatTabs());
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reader-goldens-'));
    mockDataRoot = temporaryRoot;
    currentComposition = composition;
    mockTrace = new DelegationIoTrace('golden', temporaryRoot);
    mockTrace.storage();
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(async () => {
    mockTrace.enabled = false;
    disposeReaders?.();
    disposeReaders = undefined;
    jest.restoreAllMocks();
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = '';
  });

  it('replays retained v1, v2 and mixed-generation inline/log cards through the session callback', async () => {
    const v1 = transcript('v1-inline', 1, 2, {
      text: 'v1 terminal text',
      items: [textItem('v1-text', 1, 'v1 child line')],
    });
    const v2 = transcript('v2-inline', 1, 3, {
      text: 'v2 terminal text',
      items: [
        textItem('v2-text', 1, 'v2 child line'),
        toolItem('v2-tool', 2, 'ok'),
      ],
    });
    const mixedFirst = transcript('mixed-run', 1, 4, {
      text: 'first generation',
      items: [textItem('mixed-g1', 1, 'first generation child')],
    });
    const mixedSecond = transcript('mixed-run', 2, 6, {
      text: 'second generation',
      items: [textItem('mixed-g2', 2, 'second generation child')],
    });
    const mixedThird = transcript('mixed-run', 3, 8, {
      store: 'chat-log-v1',
      text: 'third generation',
      items: [],
    });
    const emptyTask = transcript('empty-task', 1, 9, {
      description: '',
      prompt: '',
      text: '',
      items: [],
    });
    const loggedCard = savedParentRows(mixedThird)[0];
    if (!loggedCard) throw new Error('Missing logged parent card');
    const tabs = chatTabs([parentTurn(), loggedCard]);
    mockTranscripts.mockResolvedValueOnce([
      v1,
      v2,
      mixedFirst,
      mixedSecond,
      mixedThird,
      emptyTask,
    ]);
    mockGetCompatibilityTabs.mockResolvedValue(tabs);
    const options = {
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
      chatId: 'reader-chat',
      cwd: '/worktree',
      approvalMode: 'full-access' as const,
    };
    const published: AgentDelegationTranscript[] = [];
    const prepared = await createManagedDelegationSession({
      harness: 'codex',
      sessionKey: `${options.projectId}/${options.worktreeId}/${options.chatId}`,
      currentOptions: () => options,
      currentTurn: () => 'current-turn',
      getWindow: () => null,
    });
    mockTrace.expectedFreshSessionEpoch = prepared.parent.context(
      'trace',
      'trace',
    )?.runtimeGeneration;
    mockTrace.enabled = true;
    try {
      await createManagedDelegationSession({
        harness: 'codex',
        sessionKey: `${options.projectId}/${options.worktreeId}/${options.chatId}`,
        currentOptions: () => options,
        currentTurn: () => 'current-turn',
        getWindow: () => null,
        onTranscript: (entry): void => {
          published.push(entry);
        },
      });
      compareGolden('replay-events', published);
    } finally {
      await closeDelegationScope(options);
    }
  });

  it('records the saved parent rows for v1 inline, v2 inline and v2 chat-log cards', () => {
    const v1 = transcript('v1-saved', 1, 2, {
      text: 'v1 output',
      items: [textItem('v1-child', 1, 'v1 inline child')],
    });
    const v2 = transcript('v2-saved', 2, 4, {
      text: 'v2 output',
      items: [
        textItem('v2-child', 1, 'v2 inline child'),
        toolItem('v2-tool', 2),
      ],
    });
    const logged = transcript('logged-saved', 2, 5, {
      store: 'chat-log-v1',
      text: 'logged output',
      items: [],
    });
    mockTrace.enabled = true;
    compareGolden('saved-parent-rows', {
      v1Inline: savedParentRows(v1),
      v2Inline: savedParentRows(v2),
      v2ChatLog: savedParentRows(logged),
    });
  });

  it('captures live frames and durable cards, and detects a changed output', async () => {
    const itemOne = textItem('live-one', 1, 'first line');
    const itemTwo = textItem('live-two', 2, 'second line');
    const liveInputs = [
      transcript('logged-child', 1, 1, {
        status: 'running',
        items: [itemOne],
        snapshot: { partialText: 'live partial one' },
      }),
      transcript('logged-child', 1, 2, {
        status: 'running',
        items: [itemOne, itemTwo],
        snapshot: { partialText: 'live partial two' },
      }),
      transcript('logged-child', 1, 3, {
        text: 'Done',
        items: [itemOne, itemTwo],
      }),
    ];
    const livePublications: AgentDelegationTranscript[] = [];
    const publisher = new DelegationCardPublisher({
      publish: (entry): number => livePublications.push(entry),
      parentTurnActive: (): boolean => true,
      now: (): number => FIXED_NOW,
    });
    mockTrace.enabled = true;
    for (const entry of liveInputs) publisher.offer(entry);
    publisher.dispose();

    let frameTime = FIXED_NOW;
    const liveFrames = new DelegationLiveFrames({
      now: (): number => frameTime,
    });
    const frames = liveInputs.map((entry, index) => {
      frameTime = FIXED_NOW + index;
      return liveFrames.frame(entry);
    });

    const durableCards: AgentDelegationTranscript[] = [];
    const persistence = new DelegationCardPersistence({
      publish: (entry): number => durableCards.push(entry),
    });
    for (const entry of liveInputs) persistence.offer(entry, Promise.resolve());
    await persistence.flush();
    const output = {
      livePublications,
      liveFrames: frames,
      durableCards,
    };
    const expected = compareGolden(
      'live-durable-remote-control-payloads',
      output,
    );
    const mutated = { ...output, liveFrames: output.liveFrames.slice(0, 2) };
    expect(() =>
      assertGoldenMatch(normalizeVolatile(mutated), expected),
    ).toThrow();
  });

  it('loads recovery mutations for mixed legacy history, queued and dispatched runs', async () => {
    const mixedId = '00000000-0000-4000-8000-000000000001';
    const queuedId = '00000000-0000-4000-8000-000000000002';
    const dispatchedId = '00000000-0000-4000-8000-000000000003';
    const history = [
      transcript(mixedId, 1, 2, {
        text: 'generation one',
        items: [textItem('mixed-one', 1, 'generation one child')],
      }),
      transcript(mixedId, 2, 4, {
        text: 'generation two',
        items: [textItem('mixed-two', 2, 'generation two child')],
      }),
    ];
    const existingLoggedCard = savedParentRows(
      transcript(mixedId, 3, 6, {
        store: 'chat-log-v1',
        text: 'generation three',
        items: [],
      }),
    )[0];
    if (!existingLoggedCard) throw new Error('Missing generation-three card');
    const mixedRecord = storedRecord(mixedId, {
      version: 2,
      createdAt: 100,
      generation: 3,
      sequence: 6,
      status: 'completed',
      items: [textItem('mixed-three', 1, 'generation three child')],
      history,
    });
    const queued = storedRecord(queuedId, {
      version: 1,
      createdAt: 200,
      sequence: 1,
      status: 'pending',
      phase: 'reserved',
      admission: { runGeneration: 1, state: 'waiting', queuedAt: 90 },
    });
    const dispatched = storedRecord(dispatchedId, {
      version: 2,
      createdAt: 300,
      sequence: 2,
      status: 'pending',
      phase: 'starting',
    });
    const scope: ChatScope = {
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
      chatId: 'reader-chat',
    };
    await saveRecords(scope, [mixedRecord, queued, dispatched]);
    const tabs = chatTabs([parentTurn(), existingLoggedCard]);
    mockTrace.enabled = true;
    const output: ChatCoreMutation[] = await loadDelegationRecoveryMutations(
      { projectId: scope.projectId, worktreeId: scope.worktreeId },
      tabs,
      { version: 1, archived: [] },
    );
    compareGolden('recovery-mutations', output);
  });

  it('reads the retained tree in run order through the user operation', async () => {
    const firstId = '00000000-0000-4000-8000-000000000010';
    const mixedId = '00000000-0000-4000-8000-000000000011';
    const siblingId = '00000000-0000-4000-8000-000000000012';
    const first = storedRecord(firstId, {
      version: 1,
      createdAt: 100,
      sequence: 2,
      status: 'completed',
      finishedAt: 120,
      items: [
        textItem('first-answer', 1, 'first answer'),
        toolItem('first-tool', 2, 'done'),
      ],
    });
    const second = storedRecord(mixedId, {
      version: 2,
      createdAt: 200,
      generation: 2,
      sequence: 9,
      status: 'completed',
      finishedAt: 240,
      items: [textItem('second-answer', 3, 'second answer')],
      history: [
        transcript(mixedId, 1, 4, {
          text: 'earlier result',
          items: [textItem('earlier-answer', 1, 'earlier answer')],
        }),
      ],
    });
    const sibling = storedRecord(siblingId, {
      version: 2,
      chatId: 'sibling-chat',
      createdAt: 150,
      sequence: 1,
      status: 'completed',
      finishedAt: 180,
    });
    await saveRecords(
      {
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
      },
      [first, second, sibling],
    );
    mockTrace.enabled = true;
    const tree = await readManagedDelegationTreeForUser({
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
      chatId: 'reader-chat',
    });
    compareGolden('tree', tree);
  });

  it('reads bounded pages from current and earlier retained generations', async () => {
    const firstId = '00000000-0000-4000-8000-000000000020';
    const mixedId = '00000000-0000-4000-8000-000000000021';
    const first = storedRecord(firstId, {
      version: 1,
      createdAt: 100,
      sequence: 3,
      status: 'completed',
      items: [
        textItem('first-one', 1, 'first page item one'),
        textItem('first-two', 2, 'first page item two'),
        toolItem('first-three', 3, 'first tool output'),
      ],
    });
    const second = storedRecord(mixedId, {
      version: 2,
      createdAt: 200,
      generation: 2,
      sequence: 9,
      status: 'completed',
      items: [
        textItem('current-one', 1, 'current item one'),
        textItem('current-two', 4, 'current item two'),
        textItem('current-three', 8, 'current item three'),
      ],
      history: [
        transcript(mixedId, 1, 5, {
          text: 'prior result',
          items: [
            textItem('prior-one', 1, 'prior item one'),
            textItem('prior-two', 3, 'prior item two'),
            textItem('prior-three', 5, 'prior item three'),
          ],
        }),
      ],
    });
    await saveRecords(
      {
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
      },
      [first, second],
    );
    mockTrace.enabled = true;
    const output = {
      v1: await readManagedDelegationTranscriptForUser({
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
        delegationId: firstId,
        beforeSequence: 4,
        limit: 2,
      }),
      priorGeneration: await readManagedDelegationTranscriptForUser({
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
        delegationId: mixedId,
        runGeneration: 1,
        beforeSequence: 6,
        limit: 2,
      }),
      currentGeneration: await readManagedDelegationTranscriptForUser({
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
        delegationId: mixedId,
        runGeneration: 2,
        limit: 2,
      }),
    };
    compareGolden('transcript-page', output);
  });

  it('reads offline roots with fixed ordering and activity timestamps', async () => {
    const first = storedRecord('00000000-0000-4000-8000-000000000030', {
      version: 1,
      createdAt: 100,
      status: 'completed',
      finishedAt: 120,
    });
    const second = storedRecord('00000000-0000-4000-8000-000000000031', {
      version: 2,
      createdAt: 200,
      status: 'completed',
      finishedAt: 240,
    });
    const sibling = storedRecord('00000000-0000-4000-8000-000000000032', {
      version: 2,
      chatId: 'sibling-chat',
      createdAt: 150,
      status: 'completed',
      finishedAt: 180,
    });
    await saveRecords(
      {
        projectId: 'reader-project',
        worktreeId: 'reader-worktree',
        chatId: 'reader-chat',
      },
      [first, second, sibling],
    );
    mockTrace.enabled = true;
    const roots = await readManagedDelegationRootsForUser({
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
    });
    compareGolden('roots', roots);
  });

  it('replays an old completed managed-message receipt with a large success snapshot', async () => {
    const operationId = '00000000-0000-4000-8000-000000000099';
    const request = {
      projectId: 'receipt-project',
      worktreeId: 'receipt-worktree',
      chatId: 'receipt-chat',
      delegationId: '00000000-0000-4000-8000-000000000098',
      operation: 'follow_up' as const,
      message: 'Continue the review.',
      operationId,
    };
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          request.projectId,
          request.worktreeId,
          request.chatId,
          request.delegationId,
          request.operation,
          request.message,
        ]) ?? '',
      )
      .digest('hex');
    const finalText = 'x'.repeat(256 * 1024);
    const receipt: StoredManagedDelegationMessageReceipt = {
      operationId,
      requestHash,
      status: 'complete',
      result: {
        ok: true,
        snapshot: {
          delegationId: request.delegationId,
          status: 'completed',
          outputTruncated: false,
          finalText,
          routeSnapshot: legacyRouteSnapshot(
            'reviewer',
            'reviewer-runtime',
            'claude',
          ),
        },
      },
    };
    const storage = new FileManagedDelegationMessageStorage(
      path.join(
        mockDataRoot,
        request.projectId,
        request.worktreeId,
        'delegation',
        'user-messages',
      ),
    );
    await storage.commit(receipt);
    mockTrace.enabled = true;
    const replayed = await messageManagedDelegationForUser(request);
    expect(finalText.length).toBeGreaterThanOrEqual(256 * 1024);
    compareGolden('receipt-replay', replayed);
  });
});
