import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';

jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: jest.fn(),
}));
jest.mock('../../lib/chat-visuals-feature-flag', () => ({
  isChatVisualsEnabled: (): boolean => true,
}));
jest.mock('../../browser/visual-preview-service', () => ({
  getVisualPreviewService: (): unknown => ({
    measure: (): Promise<unknown> => Promise.resolve({ status: 'unavailable' }),
  }),
}));
jest.mock('../../lib/workspace-registry', (): object => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../../canopy-runtime/annotation-legacy-projection', () => ({
  ...jest.requireActual<object>(
    '../../canopy-runtime/annotation-legacy-projection',
  ),
  createHostAnnotationProjection: jest.fn(() => Promise.resolve({})),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANNOTATION_GRANTS,
  ANNOTATION_INSTRUCTION_DEFINITIONS,
  ANNOTATION_QUERY_DEFINITIONS,
  CONFIG_GRANTS,
  CORE_AGENT_DEFERRED_TOOLS_GRANTS,
  CORE_AGENT_DEFERRED_TOOLS_INSTRUCTION_DEFINITIONS,
  CORE_AGENT_DEFERRED_TOOLS_QUERY_DEFINITIONS,
  CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_VISUAL_STAGE_GRANTS,
  CORE_CHAT_VISUAL_STAGE_INSTRUCTION_DEFINITIONS,
  WORKER_VISUAL_GRANTS,
  WORKER_VISUAL_QUERY_DEFINITIONS,
  CORE_CONFIG_QUERY_DEFINITIONS,
  CORE_INITIATED_WORK_WATCHER_GRANTS,
  CORE_INITIATED_WORK_WATCHER_INSTRUCTION_DEFINITIONS,
  CORE_INITIATED_WORK_WATCHER_QUERY_DEFINITIONS,
  CORE_MEMORY_INSTRUCTION_DEFINITIONS,
  CORE_MEMORY_QUERY_DEFINITIONS,
  MEMORY_GRANTS,
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
  CORE_PULL_REQUEST_QUERY_DEFINITIONS,
  LEDGER_GRANTS,
  LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_SCRIPT_GRANTS,
  WORKER_SCRIPT_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  readWorktreeCodeGraphStatus,
  setCodeGraphReadDispatcherForTests,
} from '../../code-graph/graph-reads';
import { loadScriptOutputSnapshot } from '../../mcp/script-output';
import { readWorktreePipelineYaml } from '../pipeline-yaml-reader';
import { desktopWatcherPort } from '../../agent-actions/desktop-watcher-port';
import {
  loadGitPreferences,
  readLocalMemory,
  saveLocalMemory,
  searchLocalMemory,
} from '../session-runtime';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  isInvocationKeyedInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { handleCanopyDynamicToolCall } from '../../codex/canopy-dynamic-tools';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
  type ReadLocalMemoryInput,
  type SaveLocalMemoryInput,
  type SearchLocalMemoryInput,
} from '../core';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  AGENT_CORE_TOOL_OPERATIONS,
  AgentToolOperationRefusedError,
  agentCoreOperations,
  type AgentCoreOperationDispatcher,
} from '../agent-core-operations';
import { readFileCommentThreads } from '../file-comment-core-client';
import { createShowVisualHost } from '../show-visual-host';
import {
  DESKTOP_LEDGER_TOOLS_HOST,
  LedgerChatToolsSession,
  bindLedgerToolsDispatcher,
  type LedgerChatSettings,
  type LedgerToolsHost,
} from '../ledger-tools-runtime';
import { DESKTOP_SUMMARY_PUBLICATION_HOST } from '../../ledger/summary-publication';

interface Recorded {
  name: string;
  grants: readonly string[];
  principalId?: string;
  params?: unknown;
  metadata?: unknown;
}

function recordingDispatcher(
  answer: unknown = {},
  options: { principals?: boolean; params?: boolean } = {},
): {
  dispatcher: AgentCoreOperationDispatcher;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const principals = options.principals === true;
  const withParams = options.params === true;
  const record = (
    name: string,
    params: unknown,
    options: { caller: CanopyCallerDescriptor; metadata?: unknown },
  ): Promise<unknown> => {
    recorded.push({
      name,
      grants: options.caller.grants,
      ...(principals ? { principalId: options.caller.principalId } : {}),
      ...(withParams ? { params, metadata: options.metadata } : {}),
    });
    return Promise.resolve(answer);
  };
  return {
    dispatcher: {
      query: record,
      instruction: record,
    } as unknown as AgentCoreOperationDispatcher,
    recorded,
  };
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'daemon',
  grants,
});

// Calls through the wrapper by an arbitrary operation name.
const dispatchQuery = (
  dispatcher: AgentCoreOperationDispatcher,
  name: string,
  grants: CanopyCallerDescriptor['grants'],
): Promise<unknown> =>
  (
    dispatcher.query as unknown as (
      name: string,
      params: unknown,
      options: { caller: CanopyCallerDescriptor },
    ) => Promise<unknown>
  )(name, {}, { caller: caller(grants) });
const dispatchInstruction = (
  dispatcher: AgentCoreOperationDispatcher,
  name: string,
  grants: CanopyCallerDescriptor['grants'],
): Promise<unknown> =>
  (
    dispatcher.instruction as unknown as (
      name: string,
      params: unknown,
      options: { caller: CanopyCallerDescriptor },
    ) => Promise<unknown>
  )(name, {}, { caller: caller(grants) });

describe('agent core operations (CAN-4125)', () => {
  const both = [LEDGER_GRANTS.read, LEDGER_GRANTS.write];

  it('each tool dispatches only the operations its row grants, with exactly their grants', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const ledger = agentCoreOperations('ledger', dispatcher);
    const annotation = agentCoreOperations('annotation', dispatcher);

    await dispatchQuery(ledger, 'core.ledger.entries.search', both);
    await dispatchInstruction(ledger, 'core.ledger.entry.add', both);
    await dispatchInstruction(annotation, 'core.annotation.thread.reply', [
      ANNOTATION_GRANTS.write,
    ]);
    await dispatchQuery(ledger, 'core.ledger.entry.get', [
      ANNOTATION_GRANTS.read,
    ]);

    expect(recorded).toEqual([
      { name: 'core.ledger.entries.search', grants: [LEDGER_GRANTS.read] },
      { name: 'core.ledger.entry.add', grants: [LEDGER_GRANTS.write] },
      {
        name: 'core.annotation.thread.reply',
        grants: [ANNOTATION_GRANTS.write],
      },
      { name: 'core.ledger.entry.get', grants: [] },
    ]);
  });

  it('an operation outside the family is refused before dispatch', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const ledger = agentCoreOperations('ledger', dispatcher);
    const annotation = agentCoreOperations('annotation', dispatcher);

    for (const attempt of [
      dispatchQuery(ledger, 'core.annotation.thread.list', both),
      dispatchInstruction(ledger, 'core.ledger.summary.publish', both),
      dispatchInstruction(annotation, 'core.annotation.document.save', [
        ANNOTATION_GRANTS.write,
      ]),
      dispatchInstruction(annotation, 'core.chat.update', [
        ANNOTATION_GRANTS.write,
      ]),
    ])
      await expect(attempt).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );
    expect(recorded).toEqual([]);
  });

  it('the table names only real operations with their declared grants', () => {
    const definitions: Record<string, { requiredGrants: readonly string[] }> = {
      ...ANNOTATION_QUERY_DEFINITIONS,
      ...ANNOTATION_INSTRUCTION_DEFINITIONS,
      ...LEDGER_QUERY_DEFINITIONS,
      ...LEDGER_INSTRUCTION_DEFINITIONS,
      ...CORE_INSTRUCTION_DEFINITIONS,
      ...WORKER_SCRIPT_QUERY_DEFINITIONS,
      ...WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
      ...WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
      ...WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
      ...CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS,
      ...CORE_CONFIG_QUERY_DEFINITIONS,
      ...CORE_MEMORY_QUERY_DEFINITIONS,
      ...CORE_MEMORY_INSTRUCTION_DEFINITIONS,
      ...WORKER_GIT_QUERY_DEFINITIONS,
      ...CORE_PULL_REQUEST_QUERY_DEFINITIONS,
      ...CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
      ...PIPELINE_DEFINITION_QUERY_DEFINITIONS,
      ...CORE_INITIATED_WORK_WATCHER_QUERY_DEFINITIONS,
      ...CORE_INITIATED_WORK_WATCHER_INSTRUCTION_DEFINITIONS,
      ...CORE_AGENT_DEFERRED_TOOLS_QUERY_DEFINITIONS,
      ...CORE_AGENT_DEFERRED_TOOLS_INSTRUCTION_DEFINITIONS,
      ...CORE_CHAT_VISUAL_STAGE_INSTRUCTION_DEFINITIONS,
      ...WORKER_VISUAL_QUERY_DEFINITIONS,
    };
    expect(Object.keys(AGENT_CORE_TOOL_OPERATIONS.annotation)).toEqual([
      'core.annotation.thread.get',
      'core.annotation.thread.list',
      'core.annotation.thread.reply',
    ]);
    expect(Object.keys(AGENT_CORE_TOOL_OPERATIONS.ledger)).toEqual([
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.ledger.workSummary.get',
      'core.ledger.entry.add',
      'core.ledger.entry.update',
    ]);
    for (const row of Object.values(AGENT_CORE_TOOL_OPERATIONS))
      for (const [operation, grants] of Object.entries<readonly string[]>(
        row,
      )) {
        expect(Object.hasOwn(definitions, operation)).toBe(true);
        expect([...(definitions[operation]?.requiredGrants ?? [])]).toEqual([
          ...grants,
        ]);
      }
  });

  it('the file comment tools reach core only through the wrapper', async () => {
    const { dispatcher, recorded } = recordingDispatcher({ threads: [] });
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );

    await readFileCommentThreads({ projectId: 'p', worktreeId: 'w' });

    expect(recorded).toEqual([
      {
        name: 'core.annotation.thread.list',
        grants: [ANNOTATION_GRANTS.read],
      },
    ]);
  });

  it('Ledger tools reach core only through the wrapper, and internal callers keep the bound dispatcher', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const createdAt = '2026-11-06T00:00:00.000Z';
    const host: LedgerToolsHost = {
      ...DESKTOP_LEDGER_TOOLS_HOST,
      dispatcher: () => dispatcher,
      registry: () => ({
        register: () => 'binding-1',
        resolve: () => ({}),
        revoke: () => true,
      }),
      isFlagEnabled: () => true,
      isRecordingEnabled: () => Promise.resolve(true),
      workspaceType: () => 'single-repo',
      containerCreatedAt: () => Promise.resolve(createdAt),
      chatTitle: () => Promise.resolve('Chat'),
      databaseMayExist: () => Promise.resolve(true),
    };
    const session = new LedgerChatToolsSession({
      target: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      scope: {
        container: { kind: 'code_worktree', workspaceId: 'p', worktreeId: 'w' },
        containerCreatedAt: createdAt,
      },
      harness: 'claude',
      readSettings: (): LedgerChatSettings => ({
        model: null,
        thinkingEffort: null,
        planMode: false,
      }),
      host,
    });
    await session.execute('search_ledger_entries', {});
    expect(recorded[0]).toEqual({
      name: 'core.ledger.entries.search',
      grants: [LEDGER_GRANTS.read],
    });
    const wrapped = (
      session as unknown as {
        agentDispatcher(): AgentCoreOperationDispatcher | null;
      }
    ).agentDispatcher();
    expect(wrapped).not.toBeNull();
    if (wrapped === null) return;
    await expect(
      dispatchInstruction(wrapped, 'core.ledger.summary.publish', both),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);

    // Summary publication shares the host accessor and must reach core unchanged.
    const internal = recordingDispatcher();
    bindLedgerToolsDispatcher(internal.dispatcher);
    const publisher = DESKTOP_SUMMARY_PUBLICATION_HOST.dispatcher();
    expect(publisher).toBe(internal.dispatcher);
    await dispatchInstruction(
      internal.dispatcher,
      'core.ledger.summary.publish',
      [LEDGER_GRANTS.publishSummary],
    );
    expect(internal.recorded).toEqual([
      {
        name: 'core.ledger.summary.publish',
        grants: [LEDGER_GRANTS.publishSummary],
      },
    ]);
    bindLedgerToolsDispatcher(null);
    expect(DESKTOP_LEDGER_TOOLS_HOST.dispatcher()).toBeNull();
  });
});

describe('agent core operations for script output and Code Graph (CAN-5825)', () => {
  afterEach(() => setCodeGraphReadDispatcherForTests(null));

  it('script output reads only worker.script.execution.get, as its own principal with the read grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { run: null },
      { principals: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );

    const snapshot = await loadScriptOutputSnapshot({
      projectId: 'p',
      worktreeId: 'w',
      scriptId: 'project:launch',
    });

    expect(snapshot).toMatchObject({
      found: false,
      scriptKey: 'project:launch',
    });
    expect(recorded).toEqual([
      {
        name: 'worker.script.execution.get',
        grants: [WORKER_SCRIPT_GRANTS.read],
        principalId: 'desktop-agent-script-output',
      },
    ]);
    await expect(
      dispatchInstruction(
        agentCoreOperations('scriptOutput', dispatcher),
        'worker.script.execute',
        [WORKER_SCRIPT_GRANTS.read, WORKER_SCRIPT_GRANTS.execute],
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    expect(recorded).toHaveLength(1);
  });

  it('Code Graph reads drop the write grant and builds carry only write', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const codeGraph = agentCoreOperations('codeGraph', dispatcher);
    const both = [
      WORKER_CODE_GRAPH_GRANTS.read,
      WORKER_CODE_GRAPH_GRANTS.write,
    ];

    await dispatchQuery(codeGraph, 'worker.codeGraph.query', both);
    await dispatchQuery(codeGraph, 'worker.codeGraph.status.get', both);
    await dispatchInstruction(codeGraph, 'worker.codeGraph.build', both);
    for (const attempt of [
      dispatchQuery(codeGraph, 'worker.codeGraph.languages.validate', both),
      dispatchInstruction(codeGraph, 'worker.codeGraph.builds.cancel', both),
      dispatchInstruction(codeGraph, 'worker.codeGraph.snapshot.import', both),
    ])
      await expect(attempt).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );

    expect(recorded).toEqual([
      {
        name: 'worker.codeGraph.query',
        grants: [WORKER_CODE_GRAPH_GRANTS.read],
      },
      {
        name: 'worker.codeGraph.status.get',
        grants: [WORKER_CODE_GRAPH_GRANTS.read],
      },
      {
        name: 'worker.codeGraph.build',
        grants: [WORKER_CODE_GRAPH_GRANTS.write],
      },
    ]);
  });

  it('a Code Graph read through the agent table carries only the read grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher({
      presence: 'present',
    });
    setCodeGraphReadDispatcherForTests(dispatcher);

    await readWorktreeCodeGraphStatus(
      { projectId: 'p', worktreeId: 'w' },
      { via: (inner) => agentCoreOperations('codeGraph', inner) },
    );
    await readWorktreeCodeGraphStatus({ projectId: 'p', worktreeId: 'w' });

    expect(recorded.map(({ grants }) => grants)).toEqual([
      [WORKER_CODE_GRAPH_GRANTS.read],
      [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
    ]);
  });

  it('every Code Graph read and build the agent tools make goes through the table', () => {
    const source = readFileSync(
      join(__dirname, '..', 'code-graph-runtime.ts'),
      'utf8',
    );
    const calls = [
      ...source.matchAll(
        /\b(readWorktreeCodeGraph|readWorktreeCodeGraphStatus|buildWorktreeCodeGraphForAgent)\(([\s\S]*?)\)\s*[;,)]/g,
      ),
    ];
    expect(calls.map(([, name]) => name).sort()).toEqual([
      'buildWorktreeCodeGraphForAgent',
      'readWorktreeCodeGraph',
      'readWorktreeCodeGraphStatus',
    ]);
    for (const [, , args] of calls)
      expect(args).toMatch(/via: viaAgent(Build)?Table\b/);
    expect(source).toContain("agentCoreOperations('codeGraph', dispatcher)");
    expect(source).toContain("agentCoreInstructions('codeGraph', dispatcher)");
  });
});

describe('agent core operations for Git preferences (CAN-5992)', () => {
  const gitConfig = (value: object): object => ({
    namespace: 'git',
    scope: {},
    revision: 1,
    value,
    enforcedPaths: [],
  });

  it('GetGitPreferences reads only core.config.get for the git namespace, as its own principal with the read grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      gitConfig({
        branchName: {
          instructions: 'Use the ticket id.',
          prefixMode: 'github',
          prefix: 'octo/',
        },
        pullRequest: { instructions: 'Link the ticket.' },
        commitMessage: { instructions: '' },
      }),
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );

    await expect(loadGitPreferences({ type: 'branch-name' })).resolves.toBe(
      [
        'Git preferences for branch-name:',
        'Branch naming instructions:\nUse the ticket id.',
        'Prefix the branch with octo/',
      ].join('\n\n'),
    );
    await expect(loadGitPreferences({ type: 'pr-generation' })).resolves.toBe(
      [
        'Git preferences for pr-generation:',
        'Effective PR generation instructions:\nLink the ticket.',
      ].join('\n\n'),
    );
    await expect(loadGitPreferences({ type: 'commit-message' })).resolves.toBe(
      [
        'Git preferences for commit-message:',
        'No commit message instructions are set.',
      ].join('\n\n'),
    );
    const read = {
      name: 'core.config.get',
      grants: [CONFIG_GRANTS.read],
      principalId: 'desktop-agent-git-preferences',
      params: { namespace: 'git' },
    };
    expect(recorded).toEqual([read, read, read]);
    await expect(
      dispatchQuery(
        agentCoreOperations('gitPreferences', dispatcher),
        'core.catalog.snapshot.get',
        [CONFIG_GRANTS.read, 'core.catalog.read'],
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    expect(recorded).toHaveLength(3);
  });

  it('GetGitPreferences fails rather than formatting a value outside the git schema', async () => {
    const { dispatcher } = recordingDispatcher(
      gitConfig({ branchName: { instructions: 'x' } }),
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    await expect(loadGitPreferences({ type: 'branch-name' })).rejects.toThrow();
  });
});

describe('agent core operations for local memory (CAN-5993)', () => {
  const useDispatcher = (dispatcher: AgentCoreOperationDispatcher): void => {
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
  };
  const chat = { projectId: 'p', worktreeId: 'w' };

  it('the memory tools call only core.memory operations, as their own principal, each with only its grant', async () => {
    const save = recordingDispatcher(
      { memory: 'workspace', fileKey: 'inbox/n.md' },
      { principals: true, params: true },
    );
    useDispatcher(save.dispatcher);
    await expect(
      saveLocalMemory({
        ...chat,
        text: 'Use pnpm.',
        scope: 'workspace',
        provider: 'claude',
        chatId: 'c',
        sessionId: 's',
        invocationId: 'toolu_1',
      }),
    ).resolves.toBe('Saved workspace memory to inbox/n.md');
    const key = 'agent-memory-save:c:toolu_1';
    expect(save.recorded).toEqual([
      {
        name: 'core.memory.entry.append',
        grants: [MEMORY_GRANTS.write],
        principalId: 'desktop-agent-memory',
        params: {
          scope: { workspaceId: 'p', worktreeId: 'w' },
          memory: 'workspace',
          content: 'Use pnpm.',
          source: { provider: 'claude', chatId: 'c', sessionId: 's' },
          _meta: { idempotencyKey: key },
        },
        metadata: { idempotencyKey: key },
      },
    ]);

    const search = recordingDispatcher(
      {
        hits: [
          {
            memory: 'user',
            fileKey: 'topics/build.md',
            heading: 'Build',
            snippet: 'pnpm',
          },
        ],
      },
      { principals: true },
    );
    useDispatcher(search.dispatcher);
    await expect(searchLocalMemory({ ...chat, query: 'pnpm' })).resolves.toBe(
      'Local memory search results:\n\n1. [user] topics/build.md > Build\npnpm',
    );
    const read = recordingDispatcher(
      { memory: 'user', fileKey: 'MEMORY.md', content: '# Memory' },
      { principals: true },
    );
    useDispatcher(read.dispatcher);
    await expect(
      readLocalMemory({ ...chat, scope: 'user', file: 'MEMORY.md' }),
    ).resolves.toBe('# Memory');
    expect([...search.recorded, ...read.recorded]).toEqual([
      {
        name: 'core.memory.search',
        grants: [MEMORY_GRANTS.read],
        principalId: 'desktop-agent-memory',
      },
      {
        name: 'core.memory.entry.get',
        grants: [MEMORY_GRANTS.read],
        principalId: 'desktop-agent-memory',
      },
    ]);
    await expect(
      dispatchQuery(
        agentCoreOperations('memory', save.dispatcher),
        'core.memory.entry.delete',
        [MEMORY_GRANTS.write],
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
  });

  it('ReadMemory opens archive keys from search through tool validation and refuses pruned or escaping keys', async () => {
    const read = recordingDispatcher(
      {
        memory: 'workspace',
        fileKey: 'inbox/.consolidated/note.md',
        content: 'archived detail',
      },
      { params: true },
    );
    useDispatcher(read.dispatcher);
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: (): Promise<never> =>
        Promise.reject(new Error('Unused')),
      loadScriptOutput: (): Promise<never> =>
        Promise.reject(new Error('Unused')),
      readLocalMemory: (request: ReadLocalMemoryInput): Promise<string> =>
        readLocalMemory({ ...chat, ...request }),
    };
    for (const file of [
      'inbox/.consolidated/note.md',
      'imported/.consolidated/import.md',
    ]) {
      await expect(
        executeCanopyInjectedTool(
          'read_memory',
          { scope: 'workspace', file },
          runtime,
        ),
      ).resolves.toEqual({ text: 'archived detail' });
    }
    expect(read.recorded).toHaveLength(2);
    expect(read.recorded.map((entry) => entry.params)).toEqual([
      {
        scope: { workspaceId: 'p', worktreeId: 'w' },
        memory: 'workspace',
        fileKey: 'inbox/.consolidated/note.md',
      },
      {
        scope: { workspaceId: 'p', worktreeId: 'w' },
        memory: 'workspace',
        fileKey: 'imported/.consolidated/import.md',
      },
    ]);
    for (const file of [
      'inbox/.consolidated/topic-pruned.md',
      'inbox/.consolidated/Topic-pruned-2.md',
      'inbox/.consolidated/../../private.md',
      'inbox/.consolidated/nested/note.md',
    ]) {
      await expect(
        executeCanopyInjectedTool(
          'read_memory',
          { scope: 'workspace', file },
          runtime,
        ),
      ).resolves.toMatchObject({ isError: true });
    }
    expect(read.recorded).toHaveLength(2);
  });

  it('the memory scope comes only from the calling chat, never from tool input', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { memory: 'workspace', fileKey: 'inbox/n.md', hits: [], content: '' },
      { params: true },
    );
    useDispatcher(dispatcher);
    // As the sessions bind them: the chat's ids first, then the tool input.
    const session = { projectId: 'p', worktreeId: 'w' };
    const runtime = {
      saveLocalMemory: (request: SaveLocalMemoryInput) =>
        saveLocalMemory({
          ...session,
          chatId: 'c',
          provider: 'claude',
          ...request,
        }),
      searchLocalMemory: (request: SearchLocalMemoryInput) =>
        searchLocalMemory({ ...session, ...request }),
      readLocalMemory: (request: ReadLocalMemoryInput) =>
        readLocalMemory({ ...session, ...request }),
    } as unknown as CanopyInjectedToolRuntime;
    const forged = {
      projectId: 'other',
      worktreeId: 'other',
      workspaceId: 'other',
      chatId: 'other',
    };
    await executeCanopyInjectedTool(
      'save_memory',
      { text: 'x', scope: 'workspace', ...forged },
      runtime,
      { invocationId: 'toolu_9' },
    );
    await executeCanopyInjectedTool(
      'search_memory',
      { query: 'x', ...forged },
      runtime,
    );
    await executeCanopyInjectedTool(
      'read_memory',
      { scope: 'workspace', file: 'MEMORY.md', ...forged },
      runtime,
    );
    expect(
      recorded.map((entry) =>
        typeof entry.params === 'object' && entry.params !== null
          ? (entry.params as { scope?: unknown }).scope
          : undefined,
      ),
    ).toEqual([
      { workspaceId: 'p', worktreeId: 'w' },
      { workspaceId: 'p', worktreeId: 'w' },
      { workspaceId: 'p', worktreeId: 'w' },
    ]);
  });

  it('a Codex SaveMemory call keys its save by its thread, turn and call ids', async () => {
    const saves: SaveLocalMemoryInput[] = [];
    const runtime = {
      saveLocalMemory: (request: SaveLocalMemoryInput) => {
        saves.push(request);
        return Promise.resolve('Saved');
      },
    } as unknown as CanopyInjectedToolRuntime;
    for (let attempt = 0; attempt < 2; attempt += 1)
      await handleCanopyDynamicToolCall(
        {
          tool: CANOPY_INJECTED_TOOL_REGISTRY.save_memory.codexToolName,
          arguments: { text: 'x', scope: 'user' },
          threadId: 't',
          turnId: 'u',
          callId: 'call_1',
        } as unknown as Parameters<typeof handleCanopyDynamicToolCall>[0],
        runtime,
      );
    expect(saves.map((save) => save.invocationId)).toEqual([
      'codex:t:u:call_1',
      'codex:t:u:call_1',
    ]);
  });

  it('a core memory refusal reads as the text the tool showed before; other failures still fail', async () => {
    const refusing = (error: Error): AgentCoreOperationDispatcher => ({
      query: () => Promise.reject(error),
      instruction: () => Promise.reject(error),
    });
    useDispatcher(
      refusing(
        new CanopyOperationError({
          kind: 'failed_precondition',
          code: 'core.memory.disabled',
          message: 'Local memory is disabled',
          retry: { kind: 'never' },
        }),
      ),
    );
    await expect(searchLocalMemory({ ...chat, query: 'x' })).resolves.toBe(
      'Local memory is disabled',
    );
    useDispatcher(
      refusing(
        new CanopyOperationError({
          kind: 'permission_denied',
          message: 'The caller is not permitted to perform this operation.',
          retry: { kind: 'never' },
        }),
      ),
    );
    await expect(
      readLocalMemory({ ...chat, scope: 'user', file: 'MEMORY.md' }),
    ).rejects.toBeInstanceOf(CanopyOperationError);
  });
});

describe('agent core operations for watchers (CAN-5994)', () => {
  const runtime = {
    worktreeWatcherRuntime: {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      delegationId: 'd',
    },
  } as unknown as CanopyInjectedToolRuntime;
  const recipient = {
    workspaceId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    delegation: { delegationId: 'd' },
  };

  it('the watcher tools call only the watcher operations, as their own principal, each with only its grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { accepted: true, report: '{"ok":true}' },
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    const call = { host: runtime, toolUseId: 'toolu_1' };
    await expect(
      desktopWatcherPort.search({ query: 'ci' }, call),
    ).resolves.toEqual({ text: '{"ok":true}' });
    await expect(
      desktopWatcherPort.setup({ watchers: [] }, call),
    ).resolves.toEqual({ text: '{"ok":true}' });
    await expect(
      desktopWatcherPort.delete({ watcherIds: ['w1'] }, call),
    ).resolves.toEqual({ text: '{"ok":true}' });
    await expect(
      executeCanopyInjectedTool(
        'schedule_wakeup',
        { delaySeconds: 60 },
        runtime,
        { toolUseId: 'toolu_2', invocationId: 'claude:toolu_2' },
      ),
    ).resolves.toEqual({ text: '{"ok":true}' });
    const read = [CORE_INITIATED_WORK_WATCHER_GRANTS.read];
    const write = [CORE_INITIATED_WORK_WATCHER_GRANTS.write];
    const principalId = 'desktop-agent-watchers';
    const keyOf = (index: number): string =>
      String(
        (recorded[index]?.metadata as { idempotencyKey?: string } | undefined)
          ?.idempotencyKey,
      );
    const setupKey = keyOf(1);
    const deleteKey = keyOf(2);
    expect(setupKey).toMatch(/^agent-watcher-create:c:d:/);
    expect(setupKey).not.toContain('toolu_1');
    expect(deleteKey).toMatch(/^agent-watcher-delete:c:d:/);
    expect(recorded).toEqual([
      {
        name: 'core.initiatedWork.watcher.list',
        grants: read,
        principalId,
        params: { recipient, search: { query: 'ci' } },
        metadata: undefined,
      },
      {
        name: 'core.initiatedWork.watcher.create',
        grants: write,
        principalId,
        params: {
          recipient,
          request: { kind: 'setup', input: { watchers: [] } },
          createdBy: 'toolu_1',
          _meta: { idempotencyKey: setupKey },
        },
        metadata: { idempotencyKey: setupKey },
      },
      {
        name: 'core.initiatedWork.watcher.delete',
        grants: write,
        principalId,
        params: {
          recipient,
          watcherIds: ['w1'],
          _meta: { idempotencyKey: deleteKey },
        },
        metadata: { idempotencyKey: deleteKey },
      },
      {
        name: 'core.initiatedWork.watcher.create',
        grants: write,
        principalId,
        params: {
          recipient,
          request: { kind: 'wakeup', delaySeconds: 60 },
          createdBy: 'toolu_2',
          _meta: { idempotencyKey: 'agent-watcher-create:c:d:claude:toolu_2' },
        },
        metadata: { idempotencyKey: 'agent-watcher-create:c:d:claude:toolu_2' },
      },
    ]);
    await expect(
      dispatchQuery(
        agentCoreOperations('watchers', dispatcher),
        'core.initiatedWork.source.list',
        read,
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
  });

  it('two calls that share a reused JSON-RPC id get their own keys, so neither replays the other', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { accepted: true, report: '{"ok":true}' },
      { params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    // A new connection counts JSON-RPC ids from 1 again.
    const call = { host: runtime, toolUseId: '2' };
    await desktopWatcherPort.setup(
      { watchers: [{ target: { pipelineId: 'first' } }] },
      call,
    );
    await desktopWatcherPort.setup(
      { watchers: [{ target: { pipelineId: 'second' } }] },
      call,
    );
    const keys = recorded.map(
      (entry) => (entry.metadata as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('WatchCommand and WatchGitHubItems send the session ids, never a path, and refuse a path in tool input', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { accepted: true, report: '{"ok":true}' },
      { params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    const session = {
      worktreeWatcherRuntime: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: '/session/checkout',
      },
      worktreeActionRuntime: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: '/session/checkout',
        repoId: 'repo-a',
      },
    } as unknown as CanopyInjectedToolRuntime;
    const command = { command: 'true', intervalSeconds: 5, maxAttempts: 1 };
    const pullRequest = { items: ['https://github.com/o/r/pull/1'] };

    for (const [key, args] of [
      ['watch_command', { ...command, cwd: '/agent/path' }],
      ['watch_github_items', { ...pullRequest, repositoryCwd: '/agent/path' }],
      ['watch_github_items', { ...pullRequest, cwd: '/agent/path' }],
    ] as const)
      await expect(
        executeCanopyInjectedTool(key, args, session, { toolUseId: 't' }),
      ).resolves.toMatchObject({ isError: true });
    expect(recorded).toEqual([]);

    await executeCanopyInjectedTool('watch_command', command, session, {
      toolUseId: 't1',
    });
    await executeCanopyInjectedTool(
      'watch_github_items',
      pullRequest,
      session,
      {
        toolUseId: 't2',
      },
    );
    const anyInput: unknown = expect.any(Object);
    expect(
      recorded.map(
        (entry) =>
          (entry.params as { request: Record<string, unknown> }).request,
      ),
    ).toEqual([
      // CAN-6031: the host resolves the directory from these ids.
      { kind: 'command', ...command, repoId: 'repo-a' },
      { kind: 'github', input: anyInput, repoId: 'repo-a' },
    ]);
  });

  it('a refused watcher request is a tool error with the service’s report', async () => {
    const { dispatcher } = recordingDispatcher({
      accepted: false,
      report: 'Watchers are not available.',
    });
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    await expect(
      desktopWatcherPort.search({}, { host: runtime }),
    ).resolves.toEqual({ text: 'Watchers are not available.', isError: true });
  });
});

describe('agent core operations for deferred tools (CAN-5995)', () => {
  const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
  const runtime = {
    deferredToolsRuntime: { scope, providerType: 'claude', allowed: true },
  } as unknown as CanopyInjectedToolRuntime;
  const recipient = { workspaceId: 'p', worktreeId: 'w', chatId: 'c' };
  const principalId = 'desktop-agent-deferred-tools';

  it('SearchDeferredTools and LoadDeferredTools call only their operations, as their own principal, each with only its grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { accepted: true, report: '{"ok":true}' },
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    await expect(
      executeCanopyInjectedTool(
        'search_deferred_tools',
        { queries: [{ text: 'review' }] },
        runtime,
        { toolUseId: 'toolu_1' },
      ),
    ).resolves.toEqual({ text: '{"ok":true}' });
    await expect(
      executeCanopyInjectedTool(
        'load_deferred_tools',
        { items: [{ ref: 'deferred:v1:a' }] },
        runtime,
        { toolUseId: 'toolu_2', invocationId: 'claude:toolu_2' },
      ),
    ).resolves.toEqual({ text: '{"ok":true}' });
    const idempotencyKey = 'agent-deferred-load:c:claude:toolu_2:toolu_2';
    expect(recorded).toEqual([
      {
        name: 'core.agent.deferredTools.search',
        grants: [CORE_AGENT_DEFERRED_TOOLS_GRANTS.search],
        principalId,
        params: {
          recipient,
          session: { providerType: 'claude' },
          input: { queries: [{ text: 'review' }] },
        },
        metadata: undefined,
      },
      {
        name: 'core.agent.deferredTools.load',
        grants: [CORE_AGENT_DEFERRED_TOOLS_GRANTS.load],
        principalId,
        params: {
          recipient,
          session: { providerType: 'claude' },
          input: { items: [{ ref: 'deferred:v1:a' }] },
          toolCallId: 'toolu_2',
          _meta: { idempotencyKey },
        },
        metadata: { idempotencyKey },
      },
    ]);
    expect(isInvocationKeyedInjectedToolKey('load_deferred_tools')).toBe(true);
  });

  it('the chat write grant reaches no other chat or catalog operation', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const family = agentCoreOperations('deferredTools', dispatcher);
    for (const attempt of [
      dispatchInstruction(family, 'core.chat.update', ['core.chat.write']),
      dispatchInstruction(family, 'core.chat.message.send', [
        'core.chat.write',
      ]),
      dispatchQuery(family, 'core.catalog.snapshot.get', ['core.catalog.read']),
      dispatchInstruction(family, 'core.catalog.selection.update', [
        'core.catalog.write',
        'core.chat.write',
      ]),
    ])
      await expect(attempt).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );
    expect(recorded).toEqual([]);
    expect(AGENT_CORE_TOOL_OPERATIONS.deferredTools).toEqual({
      'core.agent.deferredTools.search': ['core.catalog.read'],
      'core.agent.deferredTools.load': ['core.chat.write'],
    });
  });

  it('a chat without deferred tools, or with invalid input, never dispatches', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    const off = {
      deferredToolsRuntime: { scope, allowed: false },
    } as unknown as CanopyInjectedToolRuntime;
    await expect(
      executeCanopyInjectedTool('search_deferred_tools', {}, off),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      executeCanopyInjectedTool('load_deferred_tools', { items: [] }, runtime, {
        toolUseId: 't',
      }),
    ).resolves.toEqual({
      text: 'Invalid arguments for LoadDeferredTools.',
      isError: true,
    });
    expect(recorded).toEqual([]);
  });
});

describe('agent core operations for pipeline YAML (CAN-5991)', () => {
  it('ReadPipelineYaml reads only core.pipeline.definition.get, as its own principal with the read grant, and prints no host path', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      {
        definition: {
          definitionId: 'project--build.yaml',
          name: 'Build',
          source: 'project',
          document: 'pipeline:\n  name: Build\n  jobs: {}\n',
        },
      },
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    const result = await readWorktreePipelineYaml({
      projectId: 'p',
      worktreeId: 'w',
      repoId: 'member',
      pipelineId: 'project--build.yaml',
      pattern: 'name',
    });
    expect(result).toEqual({
      ok: true,
      text: [
        'Pipeline YAML: Build (project--build.yaml)',
        'Source: project',
        'Total lines: 3',
        'Pattern: name',
        'Matched lines: 1',
        '---',
        '2:   name: Build',
      ].join('\n'),
    });
    expect(recorded).toEqual([
      {
        name: 'core.pipeline.definition.get',
        grants: [PIPELINE_GRANTS.read],
        principalId: 'desktop-agent-pipeline-yaml',
        params: {
          definitionId: 'project--build.yaml',
          scope: { workspaceId: 'p', worktreeId: 'w', repoId: 'member' },
        },
      },
    ]);
    await expect(
      dispatchQuery(
        agentCoreOperations('pipelineYaml', dispatcher),
        'core.pipeline.definition.list',
        [PIPELINE_GRANTS.read],
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
  });

  it('a workflow core does not serve this agent reads as not found, as before', async () => {
    const missing: AgentCoreOperationDispatcher = {
      query: () =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'not_found',
            code: 'core.pipeline.definitionNotFound',
            message: 'Workflow not found: hidden',
            retry: { kind: 'never' },
          }),
        ),
      instruction: () => Promise.reject(new Error('unused')),
    };
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        missing as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    await expect(
      readWorktreePipelineYaml({
        projectId: 'p',
        worktreeId: 'w',
        pipelineId: 'hidden',
      }),
    ).resolves.toEqual({ ok: false, error: 'Pipeline hidden was not found.' });
  });
});

describe('agent core operations for visuals (CAN-5996)', () => {
  it('ShowVisual measures through worker.visual.render and stages only through core.chat.visual.stage, as its own principal with one grant per call (CAN-6040)', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      {
        visualId: 'vis_00000000-0000-4000-8000-000000000001',
        byteLength: 9,
        sha256: 'a'.repeat(64),
      },
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    const result = await executeCanopyInjectedTool(
      'show_visual',
      { html: '<p>ok</p>', title: 'T', height: 400, chatId: 'other' },
      {
        showVisual: createShowVisualHost({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          cwd: '/tmp',
        }),
      } as unknown as CanopyInjectedToolRuntime,
    );
    expect(result.isError).toBeUndefined();
    expect(recorded).toHaveLength(2);
    const [measure, call] = recorded;
    expect(measure?.name).toBe('worker.visual.render');
    expect(measure?.grants).toEqual([WORKER_VISUAL_GRANTS.render]);
    expect(measure?.principalId).toBe('desktop-agent-visuals');
    expect(measure?.params).toMatchObject({ scope: {}, mode: 'measure' });
    const params = call?.params as {
      recipient: unknown;
      visual: { visualId: string; html: string; title: string };
    };
    expect(call?.name).toBe('core.chat.visual.stage');
    expect(call?.grants).toEqual([CORE_CHAT_VISUAL_STAGE_GRANTS.write]);
    expect(call?.principalId).toBe('desktop-agent-visuals');
    expect(params.recipient).toEqual({
      workspaceId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    });
    expect(params.visual).toMatchObject({ html: '<p>ok</p>', title: 'T' });
    expect(call?.metadata).toEqual({
      idempotencyKey: `agent-visual-stage:c:${params.visual.visualId}`,
    });
  });

  it('the chat write grant reaches no other chat operation', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const family = agentCoreOperations('visuals', dispatcher);
    for (const attempt of [
      dispatchInstruction(family, 'core.chat.update', ['core.chat.write']),
      dispatchInstruction(family, 'core.chat.message.send', [
        'core.chat.write',
      ]),
      dispatchInstruction(family, 'core.chat.archive', ['core.chat.write']),
      dispatchQuery(family, 'core.chat.visual.read', ['core.chat.read']),
      dispatchQuery(family, 'worker.filesystem.file.read', [
        'worker.filesystem.read',
      ]),
    ])
      await expect(attempt).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );
    expect(recorded).toEqual([]);
    expect(AGENT_CORE_TOOL_OPERATIONS.visuals).toEqual({
      'core.chat.visual.stage': ['core.chat.write'],
      'worker.visual.render': ['worker.visual.render'],
    });
  });
});

describe('agent core operations for auto-archive (CAN-6014)', () => {
  it('SetAutoArchive sends only core.chat.update for its own chat, as its own principal with only the chat write grant', async () => {
    const { dispatcher, recorded } = recordingDispatcher(
      { commandId: 'x', revision: 1, outcome: 'applied' },
      { principals: true, params: true },
    );
    jest
      .mocked(getActiveDesktopRuntime)
      .mockReturnValue(
        dispatcher as unknown as ReturnType<typeof getActiveDesktopRuntime>,
      );
    await executeCanopyInjectedTool('set_auto_archive', { enabled: true }, {
      autoArchiveChat: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    } as unknown as CanopyInjectedToolRuntime);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      name: 'core.chat.update',
      grants: ['core.chat.write'],
      principalId: 'desktop-agent-auto-archive',
      params: {
        projectId: 'p',
        worktreeId: 'w',
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'c',
          patch: { autoArchive: true },
        },
      },
    });
  });

  it('the chat write grant reaches no other chat operation', async () => {
    const { dispatcher, recorded } = recordingDispatcher();
    const family = agentCoreOperations('autoArchive', dispatcher);
    for (const attempt of [
      dispatchInstruction(family, 'core.chat.archive', ['core.chat.write']),
      dispatchInstruction(family, 'core.chat.message.send', [
        'core.chat.write',
      ]),
      dispatchInstruction(family, 'core.chat.create', ['core.chat.write']),
      dispatchInstruction(family, 'core.chat.delete', ['core.chat.write']),
    ])
      await expect(attempt).rejects.toBeInstanceOf(
        AgentToolOperationRefusedError,
      );
    expect(recorded).toEqual([]);
    expect(AGENT_CORE_TOOL_OPERATIONS.autoArchive).toEqual({
      'core.chat.update': ['core.chat.write'],
    });
  });
});
