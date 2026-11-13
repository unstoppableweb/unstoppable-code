import {
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  CoreIntegrationCredentialSetParamsSchema,
  CoreIntegrationCredentialClearParamsSchema,
  CoreIntegrationCredentialResultSchema,
} from '../core/integration/credential';
import { z } from 'zod';

import {
  WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CanopyCallerDescriptorSchema,
  CanopyErrorPayloadSchema,
  CanopyRequestMetadataSchema,
  composeCanopyQueryRegistries,
  composeCanopyInstructionRegistries,
  composeCanopyStreamRegistries,
  defineCanopyCommand,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
  CanopyStreamCursorSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  type CanopyQueryHandlerMap,
  type CanopyQueryName,
  type CanopyQueryParams,
  type CanopyQueryResult,
  type CanopyInstructionName,
  type CorePlaneQueryName,
  type WorkerPlaneQueryName,
  type CanopyWorkspaceScope,
  COST_GRANTS,
  PIPELINE_GRANTS,
  COST_INSTRUCTION_DEFINITIONS,
  COST_QUERY_DEFINITIONS,
  CostRefreshRequestSchema,
  CostIndexRefreshParamsSchema,
  CostScopeGetResultSchema,
  CostScopeRequestSchema,
} from '..';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
} from '../core';
import {
  CoreChatQueueSummarySchema,
  CoreChatSnapshotGetResultSchema,
} from '../core/chat/snapshot';
import {
  CoreChatQueueEntryCancelParamsSchema,
  CoreChatQueueEntryForceParamsSchema,
  CoreChatQueueEntryUpdateParamsSchema,
} from '../core/chat/commands-messaging';
import {
  CoreChatTranscriptPageParamsSchema,
  CoreChatTranscriptPageResultSchema,
  CoreChatTranscriptSearchParamsSchema,
  CoreChatTranscriptSearchResultSchema,
  CoreChatToolOutputReadParamsSchema,
  CoreChatToolOutputReadResultSchema,
  CoreChatContentReadParamsSchema,
  CoreChatContentReadResultSchema,
  CoreChatTranscriptBlocksPageParamsSchema,
  CoreChatTranscriptBlocksPageResultSchema,
  CoreChatTranscriptBlocksPageErrorSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES,
} from '../core';
import {
  WORKER_QUERY_DEFINITIONS,
  WorkerFilesystemDirectoryListParamsSchema,
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemRootsListParamsSchema,
  WorkerFilesystemRootsListResultSchema,
} from '../worker';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _QueryNamesAreExact = Expect<
  Equal<
    CanopyQueryName,
    | 'worker.agent.provider.list'
    | 'worker.filesystem.roots.list'
    | 'worker.filesystem.directory.list'
    | 'worker.filesystem.file.read'
    | 'worker.filesystem.search'
    | 'worker.git.branch.list'
    | 'worker.git.executable.get'
    | 'worker.git.remote.get'
    | 'worker.git.worktree.health.get'
    | 'worker.git.diff.get'
    | 'worker.script.execution.get'
    | 'worker.script.execution.list'
    | 'worker.filesystem.link.resolve'
    | 'worker.pipeline.execution.get'
    | 'worker.pipeline.execution.list'
    | 'worker.codeGraph.buildQueue.get'
    | 'worker.codeGraph.status.get'
    | 'worker.codeGraph.query'
    | 'worker.codeGraph.snapshot.export'
    | 'worker.codeGraph.languages.validate'
    | 'core.chat.snapshot.get'
    | 'core.chat.list'
    | 'core.chat.locate'
    | 'core.workspace.list'
    | 'core.workspace.get'
    | 'core.workspace.sharedMultiRepo.prepare'
    | 'core.workspace.sharedMultiRepo.getCreation'
    | 'core.workspace.sharedMultiRepo.listCreations'
    | 'core.chat.transcript.page'
    | 'core.chat.transcript.search'
    | 'core.chat.toolOutput.read'
    | 'core.chat.content.read'
    | 'core.chat.transcript.blocks.page'
    | 'core.chat.visual.read'
    | 'core.chat.transfer.list'
    | 'core.chat.send.receipt'
    | 'core.workspace.instructions.get'
    | 'core.workspace.item.get'
    | 'core.workspace.item.list'
    | 'core.workspace.repoRules.scan'
    | 'core.workspace.repoRules.preview'
    | 'core.workspace.repoRules.status'
    | 'core.worktree.list'
    | 'core.worktree.get'
    | 'core.ledger.entries.search'
    | 'core.ledger.entry.get'
    | 'core.ledger.owners.list'
    | 'core.ledger.changes.list'
    | 'core.ledger.rollups.list'
    | 'core.ledger.workSummary.get'
    | 'core.cost.scope.get'
    | 'core.cost.chat.get'
    | 'core.cost.pipelineRun.get'
    | 'core.update.status.get'
    | 'core.search.query'
    | 'core.annotation.document.get'
    | 'core.annotation.thread.get'
    | 'core.annotation.thread.list'
    | 'core.script.definition.list'
    | 'core.script.definition.get'
    | 'core.initiatedWork.source.list'
    | 'core.initiatedWork.source.get'
    | 'core.pipeline.definition.list'
    | 'core.pipeline.definition.get'
    | 'core.pipeline.definition.validate'
    | 'core.operation.get'
    | 'core.operation.list'
    | 'core.execution.status.get'
    | 'core.observability.audit.list'
    | 'core.observability.audit.transcript.get'
    | 'core.observability.usage.query'
    | 'core.observability.summary.get'
    // CAN-4114.
    | 'core.summary.get'
    | 'core.integration.get'
    | 'core.integration.list'
    | 'core.integration.resource.list'
    | 'core.pullRequest.get'
    | 'core.pullRequest.list'
    | 'core.pullRequest.mergeQueue.get'
    | 'core.terminal.settings.get'
  >
>;
type _WorkerNamesAreExact = Expect<
  Equal<
    WorkerPlaneQueryName,
    | 'worker.agent.provider.list'
    | 'worker.filesystem.roots.list'
    | 'worker.filesystem.directory.list'
    | 'worker.filesystem.file.read'
    | 'worker.filesystem.search'
    | 'worker.git.branch.list'
    | 'worker.git.executable.get'
    | 'worker.git.remote.get'
    | 'worker.git.worktree.health.get'
    | 'worker.git.diff.get'
    | 'worker.script.execution.get'
    | 'worker.script.execution.list'
    | 'worker.filesystem.link.resolve'
    | 'worker.pipeline.execution.get'
    | 'worker.pipeline.execution.list'
    | 'worker.codeGraph.buildQueue.get'
    | 'worker.codeGraph.status.get'
    | 'worker.codeGraph.query'
    | 'worker.codeGraph.snapshot.export'
    | 'worker.codeGraph.languages.validate'
  >
>;
type _CoreNamesAreExact = Expect<
  Equal<
    CorePlaneQueryName,
    | 'core.chat.snapshot.get'
    | 'core.chat.send.receipt'
    | 'core.chat.list'
    | 'core.chat.locate'
    | 'core.workspace.list'
    | 'core.workspace.get'
    | 'core.workspace.sharedMultiRepo.prepare'
    | 'core.workspace.sharedMultiRepo.getCreation'
    | 'core.workspace.sharedMultiRepo.listCreations'
    | 'core.chat.transcript.page'
    | 'core.chat.transcript.search'
    | 'core.chat.toolOutput.read'
    | 'core.chat.content.read'
    | 'core.chat.transcript.blocks.page'
    | 'core.chat.visual.read'
    | 'core.chat.transfer.list'
    | 'core.ledger.entries.search'
    | 'core.ledger.entry.get'
    | 'core.ledger.owners.list'
    | 'core.ledger.changes.list'
    | 'core.ledger.rollups.list'
    | 'core.ledger.workSummary.get'
    | 'core.cost.scope.get'
    | 'core.cost.chat.get'
    | 'core.cost.pipelineRun.get'
    | 'core.update.status.get'
    | 'core.search.query'
    | 'core.annotation.document.get'
    | 'core.annotation.thread.get'
    | 'core.annotation.thread.list'
    | 'core.script.definition.list'
    | 'core.script.definition.get'
    | 'core.initiatedWork.source.list'
    | 'core.initiatedWork.source.get'
    | 'core.pipeline.definition.list'
    | 'core.pipeline.definition.get'
    | 'core.pipeline.definition.validate'
    | 'core.operation.get'
    | 'core.operation.list'
    | 'core.execution.status.get'
    | 'core.observability.audit.list'
    | 'core.observability.audit.transcript.get'
    | 'core.observability.usage.query'
    | 'core.observability.summary.get'
    // CAN-4114.
    | 'core.summary.get'
    | 'core.integration.get'
    | 'core.integration.list'
    | 'core.integration.resource.list'
    | 'core.pullRequest.get'
    | 'core.pullRequest.list'
    | 'core.pullRequest.mergeQueue.get'
    | 'core.terminal.settings.get'
    | 'core.workspace.instructions.get'
    | 'core.workspace.item.get'
    | 'core.workspace.item.list'
    | 'core.workspace.repoRules.scan'
    | 'core.workspace.repoRules.preview'
    | 'core.workspace.repoRules.status'
    | 'core.worktree.list'
    | 'core.worktree.get'
  >
>;
type _CostRefreshInstructionIsRegistered = Expect<
  Equal<
    Extract<CanopyInstructionName, 'core.cost.index.refresh'>,
    'core.cost.index.refresh'
  >
>;
type _RootsParamsAreMapped = Expect<
  Equal<
    CanopyQueryParams<'worker.filesystem.roots.list'>,
    { scope: CanopyWorkspaceScope; catalogRevision?: string | undefined }
  >
>;
type CompileTimeAssertions = [
  _QueryNamesAreExact,
  _WorkerNamesAreExact,
  _CoreNamesAreExact,
  _CostRefreshInstructionIsRegistered,
  _RootsParamsAreMapped,
];
const compileTimeAssertions: CompileTimeAssertions = [
  true,
  true,
  true,
  true,
  true,
];
void compileTimeAssertions;

const typedHandlers: Pick<
  CanopyQueryHandlerMap<{ requestId: string }>,
  | 'worker.filesystem.roots.list'
  | 'worker.filesystem.directory.list'
  | 'worker.filesystem.file.read'
  | 'worker.filesystem.search'
  | 'worker.filesystem.link.resolve'
  | 'core.chat.snapshot.get'
  | 'core.chat.list'
  | 'core.chat.locate'
  | 'core.chat.transcript.page'
  | 'core.chat.transcript.search'
  | 'core.chat.toolOutput.read'
  | 'core.chat.content.read'
  | 'core.chat.transcript.blocks.page'
  | 'core.chat.visual.read'
  | 'core.chat.transfer.list'
> = {
  'core.chat.snapshot.get': (params) => ({
    workspaceId: params.scope.workspaceId,
    worktreeId: params.scope.worktreeId,
    revision: 0,
    tabs: { activeTabId: '', items: [] },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  }),
  'core.chat.list': () => ({ items: [], nextCursor: null }),
  'core.chat.locate': () => ({ worktreeId: null, archivedInWorktreeId: null }),
  'core.chat.transcript.page': () => ({
    messages: [],
    totalMessages: 0,
    transcriptRevision: 0,
  }),
  'core.chat.transcript.search': () => ({ matches: [], totalCount: 0 }),
  'core.chat.transfer.list': () => ({ transfers: [], nextCursor: null }),
  'core.chat.toolOutput.read': () => ({ text: '', byteLength: 0 }),
  'core.chat.content.read': () => ({ text: '', byteLength: 0 }),
  'core.chat.transcript.blocks.page': () => ({
    messageId: 'message-1',
    firstBlockOrdinal: 0,
    blocks: [],
    blockCount: 0,
    transcriptRevision: 0,
  }),
  'core.chat.visual.read': () => ({
    data: '',
    offset: 0,
    length: 0,
    byteLength: 0,
    sha256: '0'.repeat(64),
  }),
  'worker.filesystem.roots.list': (params, context) =>
    Promise.resolve({
      roots: [
        {
          fileRootId: `${context.requestId}:${params.scope.workspaceId}`,
          name: 'Workspace',
          kind: 'workspace-root',
        },
      ],
    }),
  'worker.filesystem.directory.list': (params) => ({
    entries: [
      {
        name: params.relativePath || 'src',
        relativePath: params.relativePath,
        kind: 'directory',
        isIgnored: false,
        isIndexExcluded: false,
        isSymlink: false,
        hasChildren: true,
      },
    ],
  }),
  'worker.filesystem.file.read': (params) => ({
    fileRootId: params.fileRootId,
    relativePath: params.relativePath,
    name: 'a.ts',
    contentKind: 'text',
    encoding: 'utf8',
    content: '',
    sizeBytes: 0,
    returnedBytes: 0,
    truncated: false,
    modifiedAt: '2026-10-24T00:00:00.000Z',
    version: '0:0',
  }),
  'worker.filesystem.search': (params) => ({
    matches: [
      {
        fileRootId: params.fileRootId,
        path: 'src/a.ts',
        kind: 'file',
        name: 'a.ts',
        isIgnored: false,
      },
    ],
    nextCursor: null,
    truncated: false,
  }),
  'worker.filesystem.link.resolve': (params) => ({
    fileRootId: params.base?.fileRootId ?? 'repo',
    relativePath: 'docs/guide.md',
    name: 'guide.md',
    kind: 'file',
  }),
};
void typedHandlers;

const rootResult: CanopyQueryResult<'worker.filesystem.roots.list'> = {
  roots: [
    {
      fileRootId: 'workspace-root',
      name: 'Workspace',
      kind: 'workspace-root',
    },
  ],
};
void rootResult;

describe('core chat read DTOs', () => {
  const scope = {
    workspaceId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  it('serializes each request and result and rejects unknown request fields', () => {
    const pairs = [
      [
        CoreChatTranscriptPageParamsSchema,
        { scope },
        CoreChatTranscriptPageResultSchema,
        { messages: [], totalMessages: 0, transcriptRevision: 1 },
      ],
      [
        CoreChatTranscriptSearchParamsSchema,
        { scope, query: 'hello' },
        CoreChatTranscriptSearchResultSchema,
        { matches: [], totalCount: 0 },
      ],
      [
        CoreChatToolOutputReadParamsSchema,
        {
          scope,
          messageId: 'message-1',
          toolUseId: 'tool-1',
          reference: {
            version: 1,
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            byteLength: 4,
            sha256: 'a'.repeat(64),
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
          offset: 0,
          limit: 4,
        },
        CoreChatToolOutputReadResultSchema,
        { text: 'test', byteLength: 4 },
      ],
      [
        CoreChatContentReadParamsSchema,
        {
          scope,
          messageId: 'message-1',
          blockOrdinal: 0,
          field: 'text',
          offset: 0,
          limit: 4,
        },
        CoreChatContentReadResultSchema,
        { text: 'test', byteLength: 4 },
      ],
      [
        CoreChatTranscriptBlocksPageParamsSchema,
        { scope, messageId: 'message-1', limit: 1 },
        CoreChatTranscriptBlocksPageResultSchema,
        {
          messageId: 'message-1',
          firstBlockOrdinal: 0,
          blocks: [],
          blockCount: 0,
          transcriptRevision: 1,
        },
      ],
    ] as const;
    for (const [paramsSchema, params, resultSchema, result] of pairs) {
      expect(paramsSchema.parse(JSON.parse(JSON.stringify(params)))).toEqual(
        params,
      );
      expect(resultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(
        result,
      );
      expect(
        paramsSchema.safeParse({ ...params, absolutePath: '/private' }).success,
      ).toBe(false);
    }
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            timestamp: 1,
            blocks: [],
            absolutePath: '/private',
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'message-1',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: '/Users/alice/project/file.ts' }],
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(true);
    for (const block of [
      { type: 'image', path: '/Users/alice/private.png', alt: 'image' },
      { type: 'compaction_info', transcriptPath: '/Users/alice/raw.jsonl' },
      { type: 'revert_info', attachmentPath: '/Users/alice/revert.md' },
    ]) {
      expect(
        CoreChatTranscriptPageResultSchema.safeParse({
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              timestamp: 1,
              blocks: [block],
            },
          ],
          totalMessages: 1,
          transcriptRevision: 1,
        }).success,
      ).toBe(false);
    }
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        messages: [
          {
            id: 'hidden-1',
            role: 'system',
            timestamp: 1,
            blocks: [],
            hidden: true,
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      }).success,
    ).toBe(false);
    for (const invalidScope of [
      { ...scope, workspaceId: '../outside' },
      { ...scope, workspaceId: 'a'.repeat(257) },
    ]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse({ scope: invalidScope })
          .success,
      ).toBe(false);
      expect(
        CoreChatTranscriptSearchParamsSchema.safeParse({
          scope: invalidScope,
          query: 'hello',
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { scope, turnId: 'turn-1' },
      { scope, view: 'turns', turnId: '../bad' },
      { scope, archivedContainerId: 'another-worktree' },
      { scope, archivedContainerId: scope.worktreeId, standaloneHistory: true },
    ]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it('preserves run truncation only when true on target-aware read results', () => {
    const page = {
      messages: [],
      totalMessages: 0,
      transcriptRevision: 1,
      runTruncated: true,
    };
    const pageResult = CoreChatTranscriptPageResultSchema.safeParse(page);
    expect(pageResult.success).toBe(true);
    if (pageResult.success) {
      expect(pageResult.data).toMatchObject({ runTruncated: true });
    }
    expect(
      CoreChatTranscriptPageResultSchema.safeParse({
        ...page,
        runTruncated: false,
      }).success,
    ).toBe(false);

    const contentRange = {
      text: 'x',
      byteLength: 1,
      runTruncated: true,
    };
    const contentResult =
      CoreChatContentReadResultSchema.safeParse(contentRange);
    expect(contentResult.success).toBe(true);
    if (contentResult.success) {
      expect(contentResult.data).toMatchObject({ runTruncated: true });
    }
    expect(
      CoreChatContentReadResultSchema.safeParse({
        ...contentRange,
        runTruncated: false,
      }).success,
    ).toBe(false);

    const blockPage = {
      messageId: 'message-1',
      firstBlockOrdinal: 0,
      blocks: [],
      blockCount: 0,
      transcriptRevision: 1,
      runTruncated: true,
    };
    const blockPageResult =
      CoreChatTranscriptBlocksPageResultSchema.safeParse(blockPage);
    expect(blockPageResult.success).toBe(true);
    if (blockPageResult.success) {
      expect(blockPageResult.data).toMatchObject({ runTruncated: true });
    }
    expect(
      CoreChatTranscriptBlocksPageResultSchema.safeParse({
        ...blockPage,
        runTruncated: false,
      }).success,
    ).toBe(false);
  });

  it('rejects malformed tool-output references, ranges, and scopes', () => {
    const valid = {
      scope,
      messageId: 'message-1',
      toolUseId: 'tool-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        byteLength: 4,
        sha256: 'a'.repeat(64),
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    for (const invalid of [
      { ...valid, scope: { worktreeId: 'worktree-1', chatId: 'chat-1' } },
      { ...valid, scope: { ...scope, workspaceId: '../outside' } },
      { ...valid, reference: { ...valid.reference, artifactId: 'other' } },
      { ...valid, offset: 5 },
      { ...valid, standaloneHistory: true, archivedContainerId: 'worktree-1' },
      { ...valid, archivedContainerId: 'other-worktree' },
    ])
      expect(
        CoreChatToolOutputReadParamsSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it('binds each row read target to the scope chat', () => {
    const primaryTarget = { kind: 'primary', chatId: scope.chatId } as const;
    const delegationTarget = {
      kind: 'delegation',
      chatId: scope.chatId,
      delegationId: 'delegation-1',
      runGeneration: 0,
    } as const;
    const otherTargets = [
      { ...primaryTarget, chatId: 'chat-2' },
      { ...delegationTarget, chatId: 'chat-2' },
    ];
    const baseToolOutput = {
      scope,
      messageId: 'message-1',
      toolUseId: 'tool-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        byteLength: 4,
        sha256: 'a'.repeat(64),
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    const baseContent = {
      scope,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'text',
      offset: 0,
      limit: 4,
    };
    const baseBlocksPage = { scope, messageId: 'message-1', limit: 1 };

    for (const target of [primaryTarget, delegationTarget]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse({ scope, target }).success,
      ).toBe(true);
      expect(
        CoreChatTranscriptSearchParamsSchema.safeParse({
          scope,
          target,
          query: 'hello',
        }).success,
      ).toBe(true);
      expect(
        CoreChatToolOutputReadParamsSchema.safeParse({
          ...baseToolOutput,
          target,
        }).success,
      ).toBe(true);
      expect(
        CoreChatContentReadParamsSchema.safeParse({ ...baseContent, target })
          .success,
      ).toBe(true);
      expect(
        CoreChatTranscriptBlocksPageParamsSchema.safeParse({
          ...baseBlocksPage,
          target,
        }).success,
      ).toBe(true);
    }

    for (const target of otherTargets) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse({ scope, target }).success,
      ).toBe(false);
      expect(
        CoreChatTranscriptSearchParamsSchema.safeParse({
          scope,
          target,
          query: 'hello',
        }).success,
      ).toBe(false);
      expect(
        CoreChatToolOutputReadParamsSchema.safeParse({
          ...baseToolOutput,
          target,
        }).success,
      ).toBe(false);
      expect(
        CoreChatContentReadParamsSchema.safeParse({ ...baseContent, target })
          .success,
      ).toBe(false);
      expect(
        CoreChatTranscriptBlocksPageParamsSchema.safeParse({
          ...baseBlocksPage,
          target,
        }).success,
      ).toBe(false);
    }
  });

  it('pages delegation transcripts only by a bounded opaque cursor', () => {
    const delegationTarget = {
      kind: 'delegation',
      chatId: scope.chatId,
      delegationId: 'delegation-1',
      runGeneration: 0,
    } as const;
    const delegationPage = { scope, target: delegationTarget };

    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        ...delegationPage,
        cursor: 'x',
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        ...delegationPage,
        cursor: 'opaque-cursor',
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        ...delegationPage,
        cursor: 'x'.repeat(2048),
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...delegationPage, cursor: '' },
      { ...delegationPage, cursor: 'x'.repeat(2049) },
      { ...delegationPage, before: 0 },
      { ...delegationPage, transcriptRevision: 0 },
      { ...delegationPage, view: 'turns' },
    ]) {
      expect(
        CoreChatTranscriptPageParamsSchema.safeParse(invalid).success,
      ).toBe(false);
    }

    const primaryTarget = { kind: 'primary', chatId: scope.chatId } as const;
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({ scope, cursor: 'opaque' })
        .success,
    ).toBe(false);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        target: primaryTarget,
        cursor: 'opaque',
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({ scope, before: 3 })
        .success,
    ).toBe(true);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        target: primaryTarget,
        before: 3,
        transcriptRevision: 4,
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        view: 'turns',
        turnId: 'turn-1',
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        turnId: 'turn-1',
      }).success,
    ).toBe(false);
  });

  it('bounds stored message-content reads in bytes and validates the body field', () => {
    const base = {
      scope,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'text',
      offset: 0,
      limit: 4,
    };
    for (const field of [
      'output',
      'input',
      'text',
      'partialText',
      'finalText',
    ]) {
      expect(
        CoreChatContentReadParamsSchema.safeParse({ ...base, field }).success,
      ).toBe(true);
    }
    expect(
      CoreChatContentReadParamsSchema.safeParse({ ...base, field: 'path' })
        .success,
    ).toBe(false);
    for (const limit of [4, 65_536])
      expect(
        CoreChatContentReadParamsSchema.safeParse({ ...base, limit }).success,
      ).toBe(true);
    expect(
      CoreChatContentReadParamsSchema.safeParse({ ...base, offset: 3 }).success,
    ).toBe(true);
    for (const invalid of [
      { ...base, offset: -1 },
      { ...base, offset: 1.5 },
      { ...base, limit: 3 },
      { ...base, limit: 65_537 },
      { ...base, limit: 4.5 },
    ])
      expect(CoreChatContentReadParamsSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it('pages logical transcript blocks with exclusive position or cursor', () => {
    const base = { scope, messageId: 'message-1' };
    for (const limit of [1, 512])
      expect(
        CoreChatTranscriptBlocksPageParamsSchema.safeParse({
          ...base,
          firstBlockOrdinal: 0,
          limit,
        }).success,
      ).toBe(true);
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...base,
        cursor: 'opaque-cursor',
        limit: 1,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...base, limit: 0 },
      { ...base, limit: 513 },
      { ...base, limit: 1.5 },
      { ...base, firstBlockOrdinal: 0, cursor: 'opaque-cursor', limit: 1 },
    ])
      expect(
        CoreChatTranscriptBlocksPageParamsSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it('opts into logical field reads and bounded block pages', () => {
    const content = {
      scope,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'output',
      offset: 0,
      limit: 4,
    };
    for (const fieldSource of ['stored', 'logical'])
      expect(
        CoreChatContentReadParamsSchema.safeParse({ ...content, fieldSource })
          .success,
      ).toBe(true);
    expect(
      CoreChatContentReadParamsSchema.safeParse({
        ...content,
        fieldSource: 'inline',
      }).success,
    ).toBe(false);
    const blocks = { scope, messageId: 'message-1', limit: 1 };
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...blocks,
        projection: 'bounded-v1',
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...blocks,
        projection: 'bounded-v2',
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptBlocksPageErrorSchema.safeParse({
        kind: 'failed_precondition',
        message: 'Stale cursor',
        code: 'core.chat.transcript.blocks.page.staleCursor',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
  });

  describe('bounded block pages', () => {
    const page = {
      projection: 'bounded-v1',
      messageId: 'message-1',
      firstBlockOrdinal: 2,
      blockCount: 5,
      transcriptRevision: 3,
    } as const;
    const text = (ordinal: number): Record<string, unknown> => ({
      kind: 'block',
      ordinal,
      block: { type: 'text', text: `block ${ordinal}` },
    });
    const parse = (value: object): boolean =>
      CoreChatTranscriptBoundedBlocksPageResultSchema.safeParse(value).success;

    it('names consecutive ordinals and continues exactly where they end', () => {
      expect(
        parse({
          ...page,
          entries: [text(2), text(3)],
          nextBlockOrdinal: 4,
          cursor: 'next',
        }),
      ).toBe(true);
      // The last page ends at the row's block count, without a cursor.
      expect(parse({ ...page, entries: [text(2), text(3), text(4)] })).toBe(
        true,
      );
      // Only a page at the row's end may be empty.
      expect(parse({ ...page, firstBlockOrdinal: 5, entries: [] })).toBe(true);
      for (const invalid of [
        {
          ...page,
          entries: [text(2), text(4)],
          nextBlockOrdinal: 4,
          cursor: 'c',
        },
        { ...page, entries: [text(3)], nextBlockOrdinal: 3, cursor: 'c' },
        { ...page, entries: [text(2)], nextBlockOrdinal: 4, cursor: 'c' },
        { ...page, entries: [text(2)], cursor: 'c' },
        { ...page, entries: [text(2)], nextBlockOrdinal: 3 },
        { ...page, entries: [text(2)] },
        { ...page, entries: [], nextBlockOrdinal: 2, cursor: 'c' },
        {
          ...page,
          entries: [text(2), text(3), text(4)],
          nextBlockOrdinal: 5,
          cursor: 'c',
        },
        { ...page, firstBlockOrdinal: 4, entries: [text(4), text(5)] },
      ])
        expect(parse(invalid)).toBe(false);
    });

    it('previews and notices consume one ordinal without storage details', () => {
      const end = { ...page, firstBlockOrdinal: 4 };
      expect(
        parse({
          ...end,
          entries: [
            {
              kind: 'preview',
              ordinal: 4,
              block: {
                type: 'tool_result',
                toolUseId: 'call-1',
                output: 'preview',
                isError: false,
              },
              omittedFields: ['output'],
            },
          ],
        }),
      ).toBe(true);
      expect(
        parse({
          ...end,
          entries: [
            {
              kind: 'notice',
              ordinal: 4,
              reason: 'tooLarge',
              blockType: 'thinking',
            },
          ],
        }),
      ).toBe(true);
      for (const entry of [
        // A body reference never crosses, even beside its preview.
        {
          kind: 'preview',
          ordinal: 4,
          block: {
            type: 'tool_result',
            output: 'preview',
            fullOutputRef: { byteLength: 9 },
          },
          omittedFields: ['output'],
        },
        // An omitted field must be a field of the previewed block.
        {
          kind: 'preview',
          ordinal: 4,
          block: { type: 'text', text: 'preview' },
          omittedFields: ['output'],
        },
        {
          kind: 'preview',
          ordinal: 4,
          block: { type: 'text', text: 'preview' },
          omittedFields: ['text', 'text'],
        },
        { kind: 'block', ordinal: 4, block: { type: 'image', path: 'a.png' } },
        {
          kind: 'block',
          ordinal: 4,
          block: { type: 'text', text: 'x', absolutePath: '/Users/a/b' },
        },
        { kind: 'notice', ordinal: 4, reason: 'missing' },
        { kind: 'notice', ordinal: 4, reason: 'unsupported', blockType: 'A b' },
      ])
        expect(parse({ ...end, entries: [entry] })).toBe(false);
    });

    it('fits the byte budget, measured on the serialized page', () => {
      const entry = (length: number): Record<string, unknown> => ({
        kind: 'block',
        ordinal: 4,
        block: { type: 'text', text: '"'.repeat(length) },
      });
      const end = { ...page, firstBlockOrdinal: 4 };
      // Escaping doubles each quote, so the serialized size decides.
      expect(
        parse({
          ...end,
          entries: [entry(TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES / 2 - 200)],
        }),
      ).toBe(true);
      expect(
        parse({
          ...end,
          entries: [entry(TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES / 2)],
        }),
      ).toBe(false);
    });

    it('is a result of the block page operation beside the raw shape', () => {
      expect(
        CoreChatTranscriptBlocksPageResultSchema.safeParse({
          ...page,
          firstBlockOrdinal: 4,
          entries: [text(4)],
        }).success,
      ).toBe(true);
    });
  });

  it('enforces worktree archive scope for transcript row reads', () => {
    const toolOutput = {
      scope,
      messageId: 'message-1',
      toolUseId: 'tool-1',
      reference: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        byteLength: 4,
        sha256: 'a'.repeat(64),
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      offset: 0,
      limit: 4,
    };
    const content = {
      scope,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'text',
      offset: 0,
      limit: 4,
    };
    const blocks = { scope, messageId: 'message-1', limit: 1 };

    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        archivedContainerId: scope.worktreeId,
      }).success,
    ).toBe(true);
    expect(
      CoreChatToolOutputReadParamsSchema.safeParse({
        ...toolOutput,
        archivedContainerId: scope.worktreeId,
      }).success,
    ).toBe(true);
    expect(
      CoreChatContentReadParamsSchema.safeParse({
        ...content,
        archivedContainerId: scope.worktreeId,
      }).success,
    ).toBe(true);
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...blocks,
        archivedContainerId: scope.worktreeId,
      }).success,
    ).toBe(true);

    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        archivedContainerId: 'another-worktree',
      }).success,
    ).toBe(false);
    expect(
      CoreChatToolOutputReadParamsSchema.safeParse({
        ...toolOutput,
        archivedContainerId: 'another-worktree',
      }).success,
    ).toBe(false);
    expect(
      CoreChatContentReadParamsSchema.safeParse({
        ...content,
        archivedContainerId: 'another-worktree',
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...blocks,
        archivedContainerId: 'another-worktree',
      }).success,
    ).toBe(false);

    expect(
      CoreChatTranscriptPageParamsSchema.safeParse({
        scope,
        archivedContainerId: scope.worktreeId,
        standaloneHistory: true,
      }).success,
    ).toBe(false);
    expect(
      CoreChatToolOutputReadParamsSchema.safeParse({
        ...toolOutput,
        archivedContainerId: scope.worktreeId,
        standaloneHistory: true,
      }).success,
    ).toBe(false);
    expect(
      CoreChatContentReadParamsSchema.safeParse({
        ...content,
        archivedContainerId: scope.worktreeId,
        standaloneHistory: true,
      }).success,
    ).toBe(false);
    expect(
      CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...blocks,
        archivedContainerId: scope.worktreeId,
        standaloneHistory: true,
      }).success,
    ).toBe(false);
  });

  it('rejects host-local paths in blocks pages but allows authored path text', () => {
    const result = {
      messageId: 'message-1',
      firstBlockOrdinal: 0,
      blocks: [],
      blockCount: 0,
      transcriptRevision: 1,
    };
    for (const block of [
      { absolutePath: '/Users/alice/project/file.ts' },
      { attachmentPath: '/Users/alice/private.txt' },
      { attachmentPaths: ['/Users/alice/private.txt'] },
      { attachmentPromptContexts: [{ attachmentPath: '/Users/alice/file' }] },
      { type: 'image', path: '/Users/alice/private.png' },
      { type: 'compaction_info', transcriptPath: '/Users/alice/raw.jsonl' },
    ]) {
      expect(
        CoreChatTranscriptBlocksPageResultSchema.safeParse({
          ...result,
          blocks: [block],
        }).success,
      ).toBe(false);
    }
    expect(
      CoreChatTranscriptBlocksPageResultSchema.safeParse({
        ...result,
        blocks: [{ type: 'text', text: 'See /Users/alice/project/file.ts' }],
      }).success,
    ).toBe(true);
  });
});

const compileTimeDefinition = defineCanopyQuery({
  error: CanopyErrorPayloadSchema,
  plane: 'worker',
  domain: 'filesystem',
  version: 1,
  placement: 'target-selectable',
  idempotency: 'inherent',
  requiredGrants: ['worker.filesystem.read'],
  params: z.strictObject({}),
  result: z.looseObject({}),
});

function assertInvalidDefinitionsFailToCompile(): void {
  defineCanopyQuery({
    error: CanopyErrorPayloadSchema,
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'target-selectable',
    idempotency: 'inherent',
    // @ts-expect-error a worker definition cannot require a core-owned grant
    requiredGrants: ['core.filesystem.read'],
    params: z.strictObject({}),
    result: z.looseObject({}),
  });

  defineCanopyQuery({
    error: CanopyErrorPayloadSchema,
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    // @ts-expect-error a worker definition cannot declare core-only placement
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['worker.filesystem.read'],
    params: z.strictObject({}),
    result: z.looseObject({}),
  });

  defineCanopyQueryRegistry('worker', {
    // @ts-expect-error definition-site registry keys cannot double a plane prefix
    'worker.worker.filesystem.read': compileTimeDefinition,
  });
}
void assertInvalidDefinitionsFailToCompile;

function withRuntimeProperty<Value extends object>(
  value: Value,
  property: keyof Value,
  replacement: unknown,
): Value {
  const copy = { ...value };
  Object.defineProperty(copy, property, {
    configurable: true,
    enumerable: true,
    value: replacement,
  });
  return copy;
}

function runtimeQueryRegistry(
  name: string,
  definition: typeof compileTimeDefinition,
): { 'worker.filesystem.read': typeof compileTimeDefinition } {
  const registry = { 'worker.filesystem.read': definition };
  return new Proxy(registry, {
    ownKeys: (): string[] => [name],
    getOwnPropertyDescriptor: (_target, key): PropertyDescriptor | undefined =>
      key === name
        ? {
            configurable: true,
            enumerable: true,
            value: definition,
          }
        : undefined,
    get: (_target, key): typeof compileTimeDefinition | undefined =>
      key === name ? definition : undefined,
  });
}

describe('universal Canopy query registry', () => {
  it('accepts only portable pending approval and TODO projections', () => {
    const result = {
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      revision: 1,
      tabs: { activeTabId: '', items: [] },
      archives: [],
      runtimeByChatId: {},
      queue: [],
      pendingApprovals: [{ id: 'approval-1' }],
      todos: [{ id: 'todo-1' }],
    };
    expect(CoreChatSnapshotGetResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      CoreChatSnapshotGetResultSchema.parse({
        ...result,
        futureField: 'ignored',
        tabs: { ...result.tabs, hostPath: '/private/worktree' },
      }),
    ).toEqual(result);
    expect(
      CoreChatSnapshotGetResultSchema.safeParse({
        ...result,
        pendingApprovals: [(): undefined => undefined],
      }).success,
    ).toBe(false);
    expect(
      CoreChatSnapshotGetResultSchema.safeParse({
        ...result,
        todos: [new Date()],
      }).success,
    ).toBe(false);
  });

  it('publishes closed core and worker registries with exact metadata', () => {
    expect(Object.keys(CORE_QUERY_DEFINITIONS)).toEqual([
      'core.chat.send.receipt',
      'core.chat.snapshot.get',
      'core.chat.list',
      'core.chat.locate',
      'core.chat.transcript.page',
      'core.chat.transcript.search',
      'core.chat.toolOutput.read',
      'core.chat.content.read',
      'core.chat.transcript.blocks.page',
      'core.chat.visual.read',
      'core.chat.transfer.list',
      'core.workspace.list',
      'core.workspace.get',
      'core.workspace.sharedMultiRepo.prepare',
      'core.workspace.sharedMultiRepo.getCreation',
      'core.workspace.sharedMultiRepo.listCreations',
      'core.workspace.instructions.get',
      'core.workspace.item.get',
      'core.workspace.item.list',
      'core.workspace.repoRules.scan',
      'core.workspace.repoRules.preview',
      'core.workspace.repoRules.status',
      'core.script.definition.list',
      'core.script.definition.get',
      'core.worktree.list',
      'core.worktree.get',
      'core.initiatedWork.source.list',
      'core.initiatedWork.source.get',
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.ledger.changes.list',
      'core.ledger.rollups.list',
      'core.ledger.workSummary.get',
      'core.cost.scope.get',
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
      // CAN-5899.
      'core.update.status.get',
      // CAN-4114.
      'core.summary.get',
      'core.search.query',
      'core.annotation.document.get',
      'core.annotation.thread.get',
      'core.annotation.thread.list',
      'core.pipeline.definition.list',
      'core.pipeline.definition.get',
      'core.pipeline.definition.validate',
      'core.operation.get',
      'core.operation.list',
      'core.execution.status.get',
      'core.observability.audit.list',
      'core.observability.audit.transcript.get',
      'core.observability.usage.query',
      'core.observability.summary.get',
      'core.integration.get',
      'core.integration.list',
      'core.integration.resource.list',
      'core.pullRequest.get',
      'core.pullRequest.list',
      'core.pullRequest.mergeQueue.get',
      'core.terminal.settings.get',
    ]);
    expect(
      CORE_QUERY_DEFINITIONS['core.pullRequest.mergeQueue.get'],
    ).toMatchObject({
      kind: 'query',
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.pullRequest.read'],
    });
    expect(
      CORE_INSTRUCTION_DEFINITIONS['core.pullRequest.merge'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'pullRequest',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.pullRequest.write'],
    });
    expect(Object.keys(WORKER_QUERY_DEFINITIONS)).toEqual([
      'worker.agent.provider.list',
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
      'worker.filesystem.file.read',
      'worker.filesystem.search',
      'worker.filesystem.link.resolve',
      'worker.git.branch.list',
      'worker.git.executable.get',
      'worker.git.remote.get',
      'worker.git.worktree.health.get',
      'worker.git.diff.get',
      'worker.script.execution.get',
      'worker.script.execution.list',
      'worker.pipeline.execution.get',
      'worker.pipeline.execution.list',
      'worker.codeGraph.buildQueue.get',
      'worker.codeGraph.status.get',
      'worker.codeGraph.query',
      'worker.codeGraph.snapshot.export',
      'worker.codeGraph.languages.validate',
    ]);
    expect(CANOPY_QUERY_DEFINITIONS).toEqual({
      ...CORE_QUERY_DEFINITIONS,
      ...WORKER_QUERY_DEFINITIONS,
    });

    for (const name of [
      'core.chat.transcript.page',
      'core.chat.transcript.search',
      'core.chat.toolOutput.read',
      'core.chat.content.read',
      'core.chat.transcript.blocks.page',
      'core.chat.visual.read',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'chat',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.chat.read'],
      });
    }
    expect(
      CORE_QUERY_DEFINITIONS['core.workspace.instructions.get'],
    ).toMatchObject({
      kind: 'query',
      plane: 'core',
      domain: 'workspace',
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspace.read'],
    });
    expect(
      CANOPY_INSTRUCTION_DEFINITIONS['core.workspace.instructions.update'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'workspace',
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspace.write'],
    });
    for (const name of [
      'core.workspace.item.get',
      'core.workspace.item.list',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'workspace',
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.workspace.read'],
      });
    }
    for (const name of [
      'core.workspace.item.import',
      'core.workspace.item.upsert',
      'core.workspace.item.delete',
    ] as const) {
      expect(CANOPY_INSTRUCTION_DEFINITIONS[name]).toMatchObject({
        kind: 'instruction',
        plane: 'core',
        domain: 'workspace',
        placement: 'core-only',
        idempotency: 'keyed',
        requiredGrants: ['core.workspace.write'],
      });
    }
    for (const name of [
      'core.workspace.repoRules.scan',
      'core.workspace.repoRules.preview',
      'core.workspace.repoRules.status',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'workspace',
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.workspace.read'],
      });
    }
    expect(
      CANOPY_INSTRUCTION_DEFINITIONS['core.workspace.repoRules.apply'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'workspace',
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: ['core.workspace.write'],
    });
    for (const name of [
      'core.script.definition.list',
      'core.script.definition.get',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'script',
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.script.read'],
      });
    }
    for (const name of [
      'core.script.definition.upsert',
      'core.script.definition.delete',
    ] as const) {
      expect(CANOPY_INSTRUCTION_DEFINITIONS[name]).toMatchObject({
        kind: 'instruction',
        plane: 'core',
        domain: 'script',
        placement: 'core-only',
        idempotency: 'keyed',
        requiredGrants: ['core.script.write'],
      });
    }

    for (const name of [
      'core.workspace.sharedMultiRepo.prepare',
      'core.workspace.sharedMultiRepo.getCreation',
      'core.workspace.sharedMultiRepo.listCreations',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'workspace',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.workspace.read'],
      });
    }

    expect(
      CANOPY_INSTRUCTION_DEFINITIONS['core.workspace.sharedMultiRepo.create'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspace.write'],
    });

    for (const [name, definition] of Object.entries(WORKER_QUERY_DEFINITIONS)) {
      const domain = name.split('.')[1];
      expect(definition).toMatchObject({
        kind: 'query',
        plane: 'worker',
        domain,
        version: 1,
        placement: 'target-selectable',
        idempotency: 'inherent',
        requiredGrants: [`worker.${domain}.read`],
      });
    }
  });

  it('strictly validates requests at every nesting level', () => {
    expect(
      WorkerFilesystemRootsListParamsSchema.parse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
      }),
    ).toEqual({
      scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
    });
    expect(
      WorkerFilesystemRootsListParamsSchema.parse({
        scope: {
          authorityId: 'primary-authority',
          targetId: 'worker-target',
        },
      }),
    ).toEqual({
      scope: {
        authorityId: 'primary-authority',
        targetId: 'worker-target',
      },
    });

    const invalidRootsRequests = [
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        principalId: 'spoofed',
      },
      { scope: { unexpectedScopeId: 'spoofed' } },
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        grants: ['worker.filesystem.read'],
      },
      {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        placement: 'worker-only',
      },
    ];
    for (const request of invalidRootsRequests) {
      expect(
        WorkerFilesystemRootsListParamsSchema.safeParse(request).success,
      ).toBe(false);
    }

    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
        clientInstanceId: 'spoofed',
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: {},
        fileRootId: 'r'.repeat(513),
        relativePath: '',
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [
          {
            fileRootId: 'r'.repeat(513),
            name: 'Repository',
            kind: 'git-repo',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListParamsSchema.parse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
      }),
    ).toEqual({
      scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
      fileRootId: 'workspace-root',
      relativePath: '',
    });
    expect(
      WorkerFilesystemDirectoryListParamsSchema.safeParse({
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        fileRootId: 'workspace-root',
        relativePath: '',
        hostPath: '/spoofed/target',
      }).success,
    ).toBe(false);
  });

  it('bounds optional catalog revisions on both filesystem queries', () => {
    for (const name of [
      'worker.filesystem.roots.list',
      'worker.filesystem.directory.list',
    ] as const) {
      const definition = CANOPY_QUERY_DEFINITIONS[name];
      const params = {
        scope: {},
        ...(name.includes('directory')
          ? { fileRootId: 'repo', relativePath: '' }
          : {}),
      };
      const result = name.includes('directory')
        ? { entries: [] }
        : { roots: [] };
      expect(definition.params.safeParse(params).success).toBe(true);
      expect(definition.result.safeParse(result).success).toBe(true);
      for (const revision of ['', 'a'.repeat(129), 7, null]) {
        expect(
          definition.params.safeParse({ ...params, catalogRevision: revision })
            .success,
        ).toBe(false);
        expect(
          definition.result.safeParse({ ...result, catalogRevision: revision })
            .success,
        ).toBe(false);
      }
      expect(
        definition.params.safeParse({
          ...params,
          catalogRevision: 'a'.repeat(128),
        }).success,
      ).toBe(true);
      expect(
        definition.params.safeParse({
          ...params,
          catalogRevision: 'r',
          unexpected: true,
        }).success,
      ).toBe(false);
    }
  });

  it('registers core.cost DTOs as closed contracts with only the read grant', () => {
    expect(Object.keys(COST_QUERY_DEFINITIONS).sort()).toEqual([
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
      'core.cost.scope.get',
    ]);
    expect(Object.keys(COST_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.cost.index.refresh',
    ]);
    const request: CanopyQueryParams<'core.cost.scope.get'> = {
      scope: { kind: 'entry', projectId: 'project', worktreeId: 'entry' },
    };
    expect(CostScopeRequestSchema.parse(request)).toEqual(request);
    expect(
      CostScopeRequestSchema.safeParse({ ...request, untrusted: true }).success,
    ).toBe(false);
    expect(
      CostScopeRequestSchema.safeParse({
        scope: {
          kind: 'entry',
          projectId: 'project',
          worktreeId: 'entry',
          hostPath: '/not-a-DTO-field',
        },
      }).success,
    ).toBe(false);
    expect(
      CostRefreshRequestSchema.safeParse({
        scope: { kind: 'retained', projectId: 'project', containerId: 'c1' },
        trigger: 'manual',
      }).success,
    ).toBe(true);

    const totals = {
      usd: 0,
      bySource: {
        chat: 0,
        pipeline: 0,
        subagents: 0,
        delegations: 0,
        background: 0,
      },
      byBilling: {
        subscription: 0,
        ai_credits: 0,
        account_proxy: 0,
        api_key: 0,
        org_gateway: 0,
        local: 0,
        unknown: 0,
      },
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      notPricedCount: 0,
      hasEstimate: false,
    };
    const scopePayload = {
      scope: request.scope,
      updatedAt: null,
      building: false,
      retentionDays: 7,
      totals,
      chats: [],
      pipelineRuns: [],
      hasCodexEstimate: false,
    };
    const scopeResult: CanopyQueryResult<'core.cost.scope.get'> = scopePayload;
    expect(CostScopeGetResultSchema.parse(scopeResult)).toEqual(scopeResult);
    expect(
      CostScopeGetResultSchema.safeParse({
        ...scopePayload,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      CostScopeGetResultSchema.safeParse({
        status: 'ok',
        value: scopePayload,
      }).success,
    ).toBe(false);
    // A chat the account proxy served names its accounts (CAN-4021).
    const proxyAccount = {
      accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
      label: 'sam@example.com',
      provider: 'claude',
      turnShare: 1.5,
      requestCount: 4,
      usd: 0.25,
      notPricedCount: 0,
    };
    const proxyScope = {
      ...scopePayload,
      chats: [
        {
          chatId: 'chat-1',
          label: 'Chat',
          state: 'open',
          totals,
          turnCount: 2,
          lastActivityAt: '2026-10-08T12:00:00.000Z',
          running: false,
          models: [],
          proxyAccounts: [proxyAccount],
        },
      ],
    };
    expect(CostScopeGetResultSchema.parse(proxyScope)).toEqual(proxyScope);
    expect(
      CostScopeGetResultSchema.safeParse({
        ...proxyScope,
        chats: [
          {
            ...proxyScope.chats[0],
            proxyAccounts: [{ ...proxyAccount, email: 'sam@example.com' }],
          },
        ],
      }).success,
    ).toBe(false);

    for (const definition of Object.values(COST_QUERY_DEFINITIONS)) {
      expect(definition).toMatchObject({
        plane: 'core',
        domain: 'cost',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: [COST_GRANTS.read],
      });
      expect(definition.requiredGrants).toEqual(['core.cost.read']);
    }
    const refresh = COST_INSTRUCTION_DEFINITIONS['core.cost.index.refresh'];
    expect(refresh).toMatchObject({
      plane: 'core',
      domain: 'cost',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [COST_GRANTS.read],
    });
    expect(
      refresh.params.safeParse({
        scope: { kind: 'entry', projectId: 'project', worktreeId: 'worktree' },
        trigger: 'manual',
      }).success,
    ).toBe(false);
    expect(
      CostIndexRefreshParamsSchema.safeParse({
        scope: { kind: 'entry', projectId: 'project', worktreeId: 'worktree' },
        trigger: 'manual',
        _meta: { idempotencyKey: 'cost-refresh-1' },
      }).success,
    ).toBe(true);
    expect(refresh.requiredGrants).toEqual(['core.cost.read']);
    expect(Object.keys(CORE_INSTRUCTION_DEFINITIONS)).toContain(
      'core.cost.index.refresh',
    );
  });

  it('retains additive fields at the result and row levels', () => {
    expect(
      WorkerFilesystemRootsListResultSchema.parse({
        roots: [
          {
            fileRootId: 'repo-1',
            name: 'repo',
            kind: 'git-repo',
            hostPath: '/must-not-cross-the-portable-boundary',
            futureRootField: { supported: true },
          },
        ],
        nextRootCursor: 'cursor',
      }),
    ).toEqual({
      roots: [
        {
          fileRootId: 'repo-1',
          name: 'repo',
          kind: 'git-repo',
          futureRootField: { supported: true },
        },
      ],
      nextRootCursor: 'cursor',
    });

    expect(
      WorkerFilesystemDirectoryListResultSchema.parse({
        entries: [
          {
            name: 'index.ts',
            relativePath: 'src/index.ts',
            hostPath: '/must-not-cross-the-portable-boundary/index.ts',
            kind: 'file',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: false,
            futureEntryField: 1,
          },
        ],
        snapshotVersion: 2,
      }),
    ).toMatchObject({
      entries: [{ futureEntryField: 1 }],
      snapshotVersion: 2,
    });
    expect(
      WorkerFilesystemDirectoryListResultSchema.parse({
        entries: [
          {
            name: 'index.ts',
            relativePath: 'src/index.ts',
            hostPath: '/must-not-cross-the-portable-boundary/index.ts',
            kind: 'file',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: false,
          },
        ],
      }).entries[0],
    ).not.toHaveProperty('hostPath');
  });

  it('rejects non-JSON-safe additive filesystem result fields', () => {
    const root = {
      fileRootId: 'repo-1',
      name: 'repo',
      kind: 'git-repo',
    } as const;
    const entry = {
      name: 'index.ts',
      relativePath: 'src/index.ts',
      kind: 'file',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
    } as const;

    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [{ ...root, futureRootField: new Date() }],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemRootsListResultSchema.safeParse({
        roots: [root],
        futureResultField: new Map(),
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListResultSchema.safeParse({
        entries: [{ ...entry, futureEntryField: new Error('nope') }],
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemDirectoryListResultSchema.safeParse({
        entries: [entry],
        futureResultField: () => undefined,
      }).success,
    ).toBe(false);
  });

  it('validates additive fields without capping normal directory listings', () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      name: `file-${index}.ts`,
      relativePath: `src/file-${index}.ts`,
      kind: 'file' as const,
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
      futureEntryField: { sequence: index },
    }));

    const result = WorkerFilesystemDirectoryListResultSchema.parse({
      entries,
      futureResultField: { snapshotVersion: 2 },
    });
    expect(result.entries).toHaveLength(300);
    expect(result.entries[299]).toMatchObject({
      relativePath: 'src/file-299.ts',
    });
    expect(result.futureResultField).toEqual({ snapshotVersion: 2 });
  });

  it('enforces registry name, metadata, grant, placement, and uniqueness invariants', () => {
    const invalidRegistries = [
      ['core.filesystem.read', compileTimeDefinition],
      ['worker.session.read', compileTimeDefinition],
      [
        'worker.filesystem.read',
        withRuntimeProperty(compileTimeDefinition, 'requiredGrants', [
          'core.filesystem.read',
        ]),
      ],
      [
        'worker.filesystem.read',
        withRuntimeProperty(compileTimeDefinition, 'placement', 'core-only'),
      ],
      ['worker.worker.filesystem.read', compileTimeDefinition],
    ] as const;

    for (const [name, invalidDefinition] of invalidRegistries) {
      expect(() =>
        defineCanopyQueryRegistry('worker', {
          ...runtimeQueryRegistry(name, invalidDefinition),
        }),
      ).toThrow();
    }

    const first = defineCanopyQueryRegistry('worker', {
      'worker.filesystem.read': compileTimeDefinition,
    });
    const duplicate = { ...first };
    expect(() => composeCanopyQueryRegistries(first, duplicate)).toThrow(
      /duplicate/i,
    );
  });
});

describe('common request and error contracts', () => {
  it('keeps trusted caller data separate and strict', () => {
    const caller = {
      principalId: 'principal',
      clientInstanceId: 'desktop:1',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: ['worker.filesystem.read'],
    };
    expect(CanopyCallerDescriptorSchema.parse(caller)).toEqual(caller);
    expect(
      CanopyCallerDescriptorSchema.safeParse({ ...caller, placement: 'worker' })
        .success,
    ).toBe(false);

    const metadata = {
      idempotencyKey: 'request-key',
      deadlineAt: '2026-08-21T15:00:00.000Z',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
      tracestate: 'vendor=value',
    };
    expect(CanopyRequestMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      CanopyRequestMetadataSchema.safeParse({ ...metadata, requestId: 'nope' })
        .success,
    ).toBe(false);
  });

  it('round-trips stable errors and rejects non-JSON details', () => {
    const payload = {
      kind: 'permission_denied',
      message: 'The caller does not have the required grant.',
      code: 'worker.filesystem.grantMissing',
      details: {
        operation: 'worker.filesystem.directory.list',
        requiredGrants: ['worker.filesystem.read'],
      },
      retry: { kind: 'after_refresh', resource: 'caller-grants', delayMs: 10 },
    };
    const parsed = CanopyErrorPayloadSchema.parse(payload);
    expect(
      CanopyErrorPayloadSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(payload);

    for (const details of [
      new Date(),
      new Error('nope'),
      new Map([['key', 'value']]),
      new Set(['value']),
      1n,
      (): undefined => undefined,
    ]) {
      expect(
        CanopyErrorPayloadSchema.safeParse({
          kind: 'internal',
          message: 'Failure',
          details,
          retry: { kind: 'never' },
        }).success,
      ).toBe(false);
    }

    expect(
      CanopyErrorPayloadSchema.safeParse({
        kind: 'internal',
        message: 'Failure',
        details: { oversized: 'x'.repeat(32_769) },
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });

  it('registers core queries, chat instructions and events, and aliases command to instruction', () => {
    expect(Object.keys(CORE_QUERY_DEFINITIONS).sort()).toEqual([
      'core.annotation.document.get',
      'core.annotation.thread.get',
      'core.annotation.thread.list',
      'core.chat.content.read',
      'core.chat.list',
      'core.chat.locate',
      'core.chat.send.receipt',
      'core.chat.snapshot.get',
      'core.chat.toolOutput.read',
      'core.chat.transcript.blocks.page',
      'core.chat.transcript.page',
      'core.chat.transcript.search',
      'core.chat.transfer.list',
      'core.chat.visual.read',
      'core.cost.chat.get',
      'core.cost.pipelineRun.get',
      'core.cost.scope.get',
      'core.execution.status.get',
      'core.initiatedWork.source.get',
      'core.initiatedWork.source.list',
      'core.integration.get',
      'core.integration.list',
      'core.integration.resource.list',
      'core.ledger.changes.list',
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.ledger.rollups.list',
      'core.ledger.workSummary.get',
      'core.observability.audit.list',
      'core.observability.audit.transcript.get',
      'core.observability.summary.get',
      'core.observability.usage.query',
      'core.operation.get',
      'core.operation.list',
      'core.pipeline.definition.get',
      'core.pipeline.definition.list',
      'core.pipeline.definition.validate',
      'core.pullRequest.get',
      'core.pullRequest.list',
      'core.pullRequest.mergeQueue.get',
      'core.script.definition.get',
      'core.script.definition.list',
      'core.search.query',
      // CAN-4114.
      'core.summary.get',
      'core.terminal.settings.get',
      'core.update.status.get',
      'core.workspace.get',
      'core.workspace.instructions.get',
      'core.workspace.item.get',
      'core.workspace.item.list',
      'core.workspace.list',
      'core.workspace.repoRules.preview',
      'core.workspace.repoRules.scan',
      'core.workspace.repoRules.status',
      'core.workspace.sharedMultiRepo.getCreation',
      'core.workspace.sharedMultiRepo.listCreations',
      'core.workspace.sharedMultiRepo.prepare',
      'core.worktree.get',
      'core.worktree.list',
    ]);
    expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS).sort()).toEqual([
      'core.annotation.document.append',
      'core.annotation.document.dismiss',
      'core.annotation.document.save',
      'core.annotation.thread.reply',
      'core.chat.archive',
      'core.chat.create',
      'core.chat.delete',
      'core.chat.fork',
      'core.chat.message.send',
      'core.chat.queue.entry.cancel',
      'core.chat.queue.entry.force',
      'core.chat.queue.entry.update',
      'core.chat.turn.cancel',
      'core.chat.update',
      'core.cost.index.refresh',
      'core.integration.credential.clear',
      'core.integration.credential.set',
      'core.integration.sourceRepository.star',
      'core.ledger.entry.add',
      'core.ledger.entry.update',
      'core.ledger.summary.publish',
      'core.operation.cancel',
      'core.pipeline.definition.delete',
      'core.pipeline.definition.duplicate',
      // CAN-5076: curated imports and share installs.
      'core.pipeline.definition.import',
      'core.pipeline.definition.setEnabled',
      'core.pipeline.definition.upsert',
      'core.pullRequest.create',
      'core.pullRequest.merge',
      'core.pullRequest.update',
      'core.script.definition.delete',
      'core.script.definition.upsert',
      // CAN-4114.
      'core.summary.regenerate',
      'core.terminal.settings.update',
      // CAN-5899.
      'core.update.apply',
      'core.update.apply.cancel',
      'core.update.check',
      'core.update.download',
      'core.workspace.instructions.update',
      'core.workspace.item.delete',
      'core.workspace.item.import',
      'core.workspace.item.upsert',
      'core.workspace.repoRules.apply',
      'core.workspace.sharedMultiRepo.create',
      // CAN-4149; CAN-4150 adds the snapshot import, CAN-5089 builds.cancel.
      'worker.codeGraph.build',
      'worker.codeGraph.build.cancel',
      'worker.codeGraph.buildQueue.update',
      'worker.codeGraph.builds.cancel',
      'worker.codeGraph.snapshot.import',
      // CAN-5518: create/save instructions admitted to the composed registry.
      'worker.filesystem.directory.create',
      // CAN-5502: entry instructions admitted to the composed registry.
      'worker.filesystem.entry.copy',
      'worker.filesystem.entry.delete',
      'worker.filesystem.entry.move',
      'worker.filesystem.file.write',
      // CAN-4108: the composed git branch-write instructions; CAN-5516 adds
      // branch delete and rename.
      'worker.git.branch.create',
      'worker.git.branch.delete',
      'worker.git.branch.rename',
      'worker.git.checkout',
      'worker.git.commit',
      // CAN-5517.
      'worker.git.fetch',
      'worker.git.merge',
      'worker.git.pull',
      'worker.git.push',
      'worker.git.worktree.add',
      'worker.git.worktree.prune',
      'worker.git.worktree.remove',
      'worker.pipeline.execution.cancel',
      // CAN-4141: the recovery controls.
      'worker.pipeline.execution.resume',
      'worker.pipeline.execution.retry',
      'worker.pipeline.execution.start',
      'worker.pipeline.hostRequest.respond',
      'worker.pipeline.matrixJob.retry',
      'worker.pipeline.matrixVariant.cancel',
      'worker.pipeline.recovery.checkpoint',
      'worker.pipeline.recovery.sweep',
      // CAN-4143.
      'worker.script.execute',
      'worker.script.execution.cancel',
    ]);
    expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).toEqual([
      'core.chat.events',
      'core.operation.events',
      'core.execution.status.events',
      'core.observability.audit.events',
      'core.update.events',
      'worker.filesystem.watch',
      'worker.pipeline.execution.events',
      'worker.pipeline.hostRequests',
    ]);
    expect(defineCanopyCommand).toBe(defineCanopyInstruction);
    const instruction = defineCanopyInstruction({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.example.write'],
      params: z.strictObject({}),
      result: z.strictObject({}),
      error: CanopyErrorPayloadSchema,
    });
    const registry = defineCanopyInstructionRegistry('core', {
      'core.example.write': instruction,
    });
    expect(composeCanopyInstructionRegistries(registry)).toEqual(registry);
    expect(() =>
      composeCanopyInstructionRegistries(registry, registry),
    ).toThrow('Duplicate');
    expect(() =>
      defineCanopyInstructionRegistry('core', {
        'core.example.write': withRuntimeProperty(instruction, 'kind', 'query'),
      }),
    ).toThrow('kind instruction');
  });

  it('keeps handler-less transport definitions out of the dispatched registries', () => {
    expect(Object.keys(CORE_TRANSPORT_QUERY_DEFINITIONS)).toEqual([
      'core.runtime.initialize',
      'core.runtime.health.get',
      'core.runtime.manifest.get',
    ]);
    expect(Object.keys(CORE_TRANSPORT_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.client.lease.acquire',
      'core.client.lease.renew',
      'core.client.lease.release',
      'core.client.capabilities.register',
      'core.events.ack',
      'core.events.unsubscribe',
    ]);
    expect(Object.keys(CORE_TRANSPORT_STREAM_DEFINITIONS)).toEqual([
      'core.runtime.events',
      'core.events.subscribe',
    ]);
    // Composing proves the names are disjoint from the dispatched registries.
    expect(() =>
      composeCanopyQueryRegistries(
        CANOPY_QUERY_DEFINITIONS,
        CORE_TRANSPORT_QUERY_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(() =>
      composeCanopyInstructionRegistries(
        CANOPY_INSTRUCTION_DEFINITIONS,
        CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(() =>
      composeCanopyStreamRegistries(
        CANOPY_STREAM_DEFINITIONS,
        CORE_TRANSPORT_STREAM_DEFINITIONS,
      ),
    ).not.toThrow();
    expect(
      CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.initialize']
        .requiredGrants,
    ).toEqual([]);
    const acquire =
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.acquire'];
    expect(acquire.idempotency).toBe('keyed');
    const params = {
      clientInstanceId: 'client-1',
      interfaceKind: 'cli',
      label: 'CLI',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 15_000,
    };
    expect(acquire.params.safeParse(params).success).toBe(false);
    expect(
      acquire.params.safeParse({ ...params, _meta: { idempotencyKey: 'k1' } })
        .success,
    ).toBe(true);
    expect(
      acquire.params.safeParse({
        ...params,
        interfaceKind: 'worker',
        _meta: { idempotencyKey: 'k1' },
      }).success,
    ).toBe(false);
  });

  it('requires the fields of each chat change variant', () => {
    const item = {
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-09-30T19:00:00Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.removed' }],
    };
    const schema = CANOPY_STREAM_DEFINITIONS['core.chat.events'].item;
    expect(schema.safeParse(item).success).toBe(false);
    expect(
      schema.safeParse({
        ...item,
        changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
      }).success,
    ).toBe(true);
  });

  it('requires an explicit chat event scope and rejects host paths in blocks', () => {
    const stream = CANOPY_STREAM_DEFINITIONS['core.chat.events'];
    expect(stream.params.safeParse({}).success).toBe(false);
    expect(stream.params.safeParse({ scope: 'all' }).success).toBe(true);
    expect(
      stream.params.safeParse({
        scope: { projectId: 'project-1', worktreeId: 'worktree-1' },
      }).success,
    ).toBe(true);
    const item = {
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-09-30T19:00:00Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [
        {
          type: 'message.upserted',
          chatId: 'tab-1',
          message: {
            id: 'message-1',
            role: 'user',
            timestamp: 1,
            blocks: [
              { type: 'image', path: '/private/image.png', alt: 'image' },
            ],
          },
        },
      ],
    };
    expect(stream.item.safeParse(item).success).toBe(false);
    item.changes[0].message.blocks[0].path = '';
    expect(stream.item.safeParse(item).success).toBe(false);
    const portableImage = { type: 'image', alt: 'image' };
    expect(
      stream.item.safeParse({
        ...item,
        changes: [
          {
            ...item.changes[0],
            message: { ...item.changes[0].message, blocks: [portableImage] },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('validates stream cursors and kind metadata', () => {
    expect(
      CanopyStreamCursorSchema.safeParse({ daemonEpoch: 'epoch', sequence: 0 })
        .success,
    ).toBe(true);
    expect(
      CanopyStreamCursorSchema.safeParse({ daemonEpoch: 'epoch', sequence: -1 })
        .success,
    ).toBe(false);
    expect(
      CanopyStreamCursorSchema.safeParse({
        daemonEpoch: 'epoch',
        sequence: 0,
        extra: true,
      }).success,
    ).toBe(false);
    const stream = defineCanopyStream({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.read'],
      params: z.strictObject({
        cursor: CanopyStreamCursorSchema.nullable().optional(),
      }),
      item: z.strictObject({ value: z.string() }),
      end: z.strictObject({
        cursor: CanopyStreamCursorSchema,
        outcome: z.enum(['completed', 'cancelled', 'error']),
        error: CanopyErrorPayloadSchema.nullable(),
      }),
      error: CanopyErrorPayloadSchema,
    });
    const registry = defineCanopyStreamRegistry('core', {
      'core.example.events': stream,
    });
    expect(composeCanopyStreamRegistries(registry)).toEqual(registry);
    expect(() => composeCanopyStreamRegistries(registry, registry)).toThrow(
      'Duplicate',
    );
    expect(() =>
      defineCanopyStreamRegistry('core', {
        'core.example.events': withRuntimeProperty(
          stream,
          'idempotency',
          'keyed',
        ),
      }),
    ).toThrow('inherently idempotent');
  });
});

describe('pipeline owner reads', () => {
  // Interface grants are narrowed to the grants their operations require, so
  // a required owner read grant would hand renderers an owner override.
  it('are required by no operation', () => {
    const required = [
      ...Object.values(CANOPY_QUERY_DEFINITIONS),
      ...Object.values(CANOPY_INSTRUCTION_DEFINITIONS),
      ...Object.values(CANOPY_STREAM_DEFINITIONS),
    ].flatMap((definition) => definition.requiredGrants);
    expect(required).not.toContain(PIPELINE_GRANTS.ownerRead);
  });
});

describe('core.integration.sourceRepository.star', () => {
  const definition =
    CANOPY_INSTRUCTION_DEFINITIONS['core.integration.sourceRepository.star'];

  it('requires only the star grant and is inherently idempotent', () => {
    expect(definition).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'integration',
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.integration.star'],
    });
  });

  it('accepts no params, so a caller cannot name a repository', () => {
    expect(definition.params.safeParse({}).success).toBe(true);
    expect(
      definition.params.safeParse({ owner: 'someone', repo: 'elsewhere' })
        .success,
    ).toBe(false);
  });
});

describe('integration credential write-only wire contract (CAN-5815)', () => {
  it('bounds secrets and generation CAS, allows both credential kinds, and rejects authority injection', () => {
    for (const credentialKind of ['github.pat', 'linear.apiToken']) {
      expect(
        CoreIntegrationCredentialSetParamsSchema.safeParse({
          credentialKind,
          secret: 'x',
        }).success,
      ).toBe(true);
      expect(
        CoreIntegrationCredentialSetParamsSchema.safeParse({
          credentialKind,
          secret: 'x'.repeat(16384),
          expectedLegacyGeneration: 'a'.repeat(64),
        }).success,
      ).toBe(true);
      for (const secret of ['', 'x'.repeat(16385), null])
        expect(
          CoreIntegrationCredentialSetParamsSchema.safeParse({
            credentialKind,
            secret,
          }).success,
        ).toBe(false);
      expect(
        CoreIntegrationCredentialSetParamsSchema.safeParse({
          credentialKind,
          secret: 'x',
          source: { brandId: 'peer', build: 'stable' },
        }).success,
      ).toBe(false);
      expect(
        CoreIntegrationCredentialClearParamsSchema.safeParse({
          credentialKind,
          secret: 'x',
        }).success,
      ).toBe(false);
    }
    for (const expectedLegacyGeneration of [
      '',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
    ])
      expect(
        CoreIntegrationCredentialSetParamsSchema.safeParse({
          credentialKind: 'github.pat',
          secret: 'x',
          expectedLegacyGeneration,
        }).success,
      ).toBe(false);
    expect(
      CoreIntegrationCredentialSetParamsSchema.shape.secret.meta(),
    ).toMatchObject({ writeOnly: true });
  });
  it('returns only r1 presence, requires the grant, and retains keyed set and inherent clear', () => {
    const set =
      CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS[
        'core.integration.credential.set'
      ];
    const clear =
      CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS[
        'core.integration.credential.clear'
      ];
    expect(set.idempotency).toBe('keyed');
    expect(clear.idempotency).toBe('inherent');
    for (const definition of [set, clear])
      expect(definition.requiredGrants).toEqual(['core.integration.write']);
    for (const configured of [true, false]) {
      expect(
        CoreIntegrationCredentialResultSchema.parse({
          credentialKind: 'github.pat',
          configured,
        }),
      ).toEqual({ credentialKind: 'github.pat', configured });
      expect(
        CoreIntegrationCredentialResultSchema.safeParse({
          credentialKind: 'github.pat',
          configured,
          secret: 'x',
        }).success,
      ).toBe(false);
    }
    for (const [definition, suffix] of [
      [set, 'writeFailed'],
      [clear, 'removeFailed'],
    ] as const) {
      for (const code of ['storageUnavailable', suffix])
        expect(
          definition.error.safeParse({
            kind: 'unavailable',
            code: `core.integration.credential.${code}`,
            message: 'redacted',
            retry: { kind: 'never' },
          }).success,
        ).toBe(true);
    }
  });
});

describe('chat queue entry revisions (CAN-4112)', () => {
  const base = {
    scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    commandId: 'command-1',
    _meta: { idempotencyKey: 'command-1' },
    chatId: 'chat-1',
    entryId: 'queue-1',
  };

  it.each([
    ['cancel', CoreChatQueueEntryCancelParamsSchema, base],
    [
      'update',
      CoreChatQueueEntryUpdateParamsSchema,
      { ...base, mutation: { kind: 'steer' } },
    ],
    ['force', CoreChatQueueEntryForceParamsSchema, base],
  ] as const)(
    'queue entry operations accept an optional positive entry revision (%s)',
    (_name, schema, params) => {
      expect(schema.safeParse({ ...params, entryRevision: 1 }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...params, entryRevision: 0 }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...params, entryRevision: 1.5 }).success).toBe(
        false,
      );
      expect(schema.safeParse(params).success).toBe(true);
    },
  );

  it('the lock mutation is strict', () => {
    const parse = (mutation: unknown): boolean =>
      CoreChatQueueEntryUpdateParamsSchema.safeParse({ ...base, mutation })
        .success;
    expect(parse({ kind: 'lock', locked: true })).toBe(true);
    expect(parse({ kind: 'lock', locked: true, extra: 1 })).toBe(false);
    expect(parse({ kind: 'lock' })).toBe(false);
  });

  it('keeps queue entry revisions in the snapshot summary', () => {
    expect(
      CoreChatQueueSummarySchema.parse({
        chatId: 'chat-1',
        entries: [
          { id: 'queue-1', origin: 'desktop', enqueuedAtMs: 1, revision: 3 },
        ],
      }).entries[0]?.revision,
    ).toBe(3);
  });
});

describe('worker.git.merge wire contract (CAN-5884)', () => {
  const definition = CANOPY_INSTRUCTION_DEFINITIONS['worker.git.merge'];
  const params = {
    scope: { workspaceId: 'ws', worktreeId: 'wt' },
    sourceBranch: 'feature/one',
    baseBranch: 'main',
  };
  it('has no idempotency key and preserves a typed conflict outcome', () => {
    expect(definition.idempotency).toBe('none');
    expect(definition.requiredGrants).toEqual(['worker.git.write']);
    expect(definition.params.safeParse(params).success).toBe(true);
    expect(
      definition.params.safeParse({
        ...params,
        _meta: { idempotencyKey: 'key' },
      }).success,
    ).toBe(false);
    expect(definition.result.safeParse({ outcome: 'conflict' }).success).toBe(
      true,
    );
    expect(
      definition.result.safeParse({
        outcome: 'merged',
        mergeCommitHash: 'a'.repeat(40),
      }).success,
    ).toBe(true);
  });
  it.each(['', '--abort', 'a\0b'])(
    'rejects a non-branch argument %p',
    (branch) => {
      expect(
        definition.params.safeParse({ ...params, sourceBranch: branch })
          .success,
      ).toBe(false);
      expect(
        definition.params.safeParse({ ...params, baseBranch: branch }).success,
      ).toBe(false);
    },
  );
});

describe('core.pullRequest.list additive title query (CAN-5891)', () => {
  const definition = CORE_QUERY_DEFINITIONS['core.pullRequest.list'];
  const list = {
    integrationId: null,
    repositoryId: 'repo',
    states: ['open'],
    cursor: null,
    limit: 50,
  };
  it('keeps an omitted query absent and accepts bounded raw title text', () => {
    expect(definition.params.parse(list)).toEqual(list);
    expect(definition.params.parse({ ...list, query: 'fix login' })).toEqual({
      ...list,
      query: 'fix login',
    });
    expect(
      definition.params.safeParse({ ...list, query: 'x'.repeat(100) }).success,
    ).toBe(true);
  });
  it.each([null, 1, '', 'x'.repeat(101)])(
    'rejects a malformed title query (%s)',
    (query) => {
      expect(definition.params.safeParse({ ...list, query }).success).toBe(
        false,
      );
    },
  );
});

describe('desktop-only Git primitive contract (CAN-5931)', () => {
  const definitions = WORKER_GIT_LOCAL_MUTATION_INSTRUCTION_DEFINITIONS;
  it('stays outside the composed registry until the desktop host installs it', () => {
    for (const name of Object.keys(definitions)) {
      expect(Object.hasOwn(CANOPY_INSTRUCTION_DEFINITIONS, name)).toBe(false);
    }
  });
  const bindingId = '00000000-0000-4000-8000-000000000001';
  it('uses the existing write grant, no idempotency and no path-bearing host input', () => {
    for (const definition of Object.values(definitions)) {
      expect(definition.placement).toBe('worker-only');
      expect(definition.idempotency).toBe('none');
      expect(definition.requiredGrants).toEqual(['worker.git.write']);
    }
    const params = { bindingId, treeSha: 'a'.repeat(40) };
    const restore = definitions['worker.git.snapshot.restore'];
    expect(restore.params.safeParse(params).success).toBe(true);
    expect(
      restore.params.safeParse({ ...params, repoPath: '/host' }).success,
    ).toBe(false);
    expect(restore.params.safeParse({ ...params, _meta: {} }).success).toBe(
      false,
    );
    expect(restore.params.safeParse({ ...params, bindingId: '' }).success).toBe(
      false,
    );
    expect(
      definitions['worker.git.repoShadow.ensure'].result.safeParse({
        defaultBranch: 'main',
        lastSyncAt: 'now',
        shadowPath: '/host',
      }).success,
    ).toBe(false);
  });
});

describe('worktree Git writes (CAN-5940)', () => {
  it.each([
    'worker.git.worktree.add',
    'worker.git.worktree.remove',
    'worker.git.worktree.prune',
  ] as const)(
    '%s is unkeyed and accepts no host path or params metadata',
    (name) => {
      const definition =
        WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS[name];
      const params =
        name === 'worker.git.worktree.add'
          ? {
              scope: { workspaceId: 'workspace', worktreeId: 'reserved' },
              branch: 'topic',
            }
          : {
              scope: {
                workspaceId: 'workspace',
                ...(name === 'worker.git.worktree.remove'
                  ? { worktreeId: 'task' }
                  : {}),
              },
            };
      expect(definition.params.safeParse(params).success).toBe(true);
      expect(
        definition.params.safeParse({ ...params, _meta: {} }).success,
      ).toBe(false);
      expect(
        definition.params.safeParse({ ...params, repoPath: '/host' }).success,
      ).toBe(false);
      expect(definition.idempotency).toBe('none');
      expect(definition.requiredGrants).toEqual(['worker.git.write']);
    },
  );
});
