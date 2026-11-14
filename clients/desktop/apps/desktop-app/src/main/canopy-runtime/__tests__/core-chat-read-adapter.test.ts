import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatToolOutputResponse,
  ChatTranscriptBlocksRequest,
  ChatTranscriptBlocksPage,
  ChatTranscriptContentRequest,
} from '@canopy/desktop-shared/types';
import {
  type CoreChatTranscriptBlocksPageResult,
  CoreChatContentReadResultSchema,
  CoreChatSendReceiptParamsSchema,
  CoreChatSendReceiptResultSchema,
  CoreChatTranscriptPageResultSchema,
  CoreChatTranscriptBlocksPageResultSchema,
} from '@canopy/protocol/canopy-core';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';
import { createDesktopRuntime } from '../desktop-runtime';
import { ChatVisualReadError } from '../../lib/chat-visual-read-errors';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};
const scope = {
  workspaceId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('canonical send receipt reads', () => {
  const identity = {
    userMessageId: 'user-message',
    fingerprint: 'a'.repeat(64),
  };
  const receipt = {
    commandId: 'original-command',
    revision: 3,
    outcome: 'applied' as const,
    entityId: 'chat-1',
    messageId: 'user-message',
  };

  it('checks grants and local scope before querying any receipt', async () => {
    const port = portFixture();
    const probe = jest.fn().mockResolvedValue({ outcome: 'matched', receipt });
    port.getPortalSendReceipt = probe;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'retry-command', identity },
          { caller: { ...caller, grants: [] } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          {
            scope: { ...scope, authorityId: 'remote-core' },
            commandId: 'retry-command',
            identity,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          {
            scope: { ...scope, targetId: 'worker' },
            commandId: 'retry-command',
            identity,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(probe).not.toHaveBeenCalled();
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'retry-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'matched', receipt });
      expect(probe).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        commandId: 'retry-command',
        identity: { chatId: 'chat-1', ...identity },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('does not return another chat receipt and omits host fields from matching receipts', async () => {
    const port = portFixture();
    const read = jest.fn().mockResolvedValue({
      ...receipt,
      portalSend: { chatId: 'other-chat', ...identity },
    });
    port.getCommandReceipt = read;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command' },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'conflict' });
      read.mockResolvedValue({
        ...receipt,
        reason: '/local/private',
        portalSend: { chatId: 'chat-1', ...identity },
      });
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'matched', receipt });
      read.mockResolvedValue(null);
      await expect(
        dispatcher.query(
          'core.chat.send.receipt',
          { scope, commandId: 'original-command', identity },
          { caller },
        ),
      ).resolves.toEqual({ outcome: 'missing' });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('rejects malformed identifiers and host paths in the portable contract', () => {
    expect(
      CoreChatSendReceiptParamsSchema.safeParse({
        scope,
        commandId: '/local/command',
        identity,
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptParamsSchema.safeParse({
        scope,
        commandId: 'command',
        identity: { ...identity, fingerprint: 'invalid' },
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptResultSchema.safeParse({
        outcome: 'matched',
        receipt: { ...receipt, entityId: '/local/private' },
      }).success,
    ).toBe(false);
    expect(
      CoreChatSendReceiptResultSchema.safeParse({
        outcome: 'matched',
        receipt: { ...receipt, reason: '/local/private' },
      }).success,
    ).toBe(false);
  });
});

function portFixture(): ChatStateCommandPort {
  return {
    getState: jest.fn<Promise<ChatStateSnapshot>, []>(),
    getTranscriptPage: jest.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [
            { type: 'text', text: '/Users/alice/project/file.ts' },
            { type: 'image', path: '/local/private.png', alt: 'image' },
            { type: 'compaction_info', transcriptPath: '/local/raw.jsonl' },
            { type: 'revert_info', attachmentPath: '/local/revert.md' },
          ],
          timestamp: 1,
          absolutePath: '/local/private',
          attachmentPaths: ['/local/attachment.md'],
          attachmentPromptContexts: [],
        },
        {
          id: 'hidden-1',
          role: 'system',
          blocks: [{ type: 'text', text: 'host orchestration' }],
          timestamp: 2,
          hidden: true,
        },
      ],
      totalMessages: 2,
      transcriptRevision: 2,
      turns: [
        {
          id: 'turn-1',
          start: 0,
          end: 2,
          complete: true,
          finalMessageIds: ['message-1'],
          outcomes: { blocked: 1, failed: 2 },
          deniedToolUseIds: ['denied-tool'],
          files: [{ path: '/local/deliverable.md', state: 'ready' }],
        },
      ],
    }),
    searchTranscript: jest
      .fn()
      .mockResolvedValue({ matches: [], totalCount: 0 }),
    readToolOutput: jest
      .fn()
      .mockResolvedValue({ text: 'hello', byteLength: 5 }),
    readVisual: jest.fn().mockResolvedValue({
      bytes: Uint8Array.from([0xf0, 0x9f, 0x8c, 0xb2]),
      offset: 0,
      length: 4,
      byteLength: 4,
      sha256: 'a'.repeat(64),
    }),
    command: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
  };
}

describe('core chat read adapter', () => {
  const visualReference = {
    version: 1 as const,
    visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    byteLength: 4,
    sha256: 'a'.repeat(64),
    mediaType: 'text/html' as const,
    title: 'Visual',
    maxHeight: 400,
  };

  it('projects raw visual bytes and maps typed failures without host details', async () => {
    const port = portFixture();
    const visualMock = jest.spyOn(port, 'readVisual');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const params = {
      scope,
      messageId: 'result',
      toolUseId: 'call',
      reference: visualReference,
      offset: 0,
      limit: 4,
    };
    await expect(
      dispatcher.query('core.chat.visual.read', params, { caller }),
    ).resolves.toMatchObject({ data: '8J+Msg==', length: 4 });
    expect(visualMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        reference: visualReference,
      }),
      expect.any(AbortSignal),
    );
    for (const [reason, kind, code] of [
      ['not_found', 'not_found', 'core.chat.visual.read.notFound'],
      [
        'invalid_state',
        'failed_precondition',
        'core.chat.visual.read.invalidState',
      ],
    ] as const) {
      jest
        .spyOn(port, 'readVisual')
        .mockRejectedValueOnce(new ChatVisualReadError(reason));
      await expect(
        dispatcher.query('core.chat.visual.read', params, { caller }),
      ).rejects.toMatchObject({ payload: { kind, code } });
    }
    await expect(
      dispatcher.query(
        'core.chat.visual.read',
        {
          ...params,
          limit: 1_048_577,
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    jest
      .spyOn(port, 'readVisual')
      .mockRejectedValueOnce(
        Object.assign(
          new Error("EIO: i/o error, read '/Users/someone/visuals/x.html'"),
          { code: 'EIO' },
        ),
      );
    await expect(
      dispatcher.query('core.chat.visual.read', params, { caller }),
    ).rejects.toMatchObject({
      payload: { kind: 'internal', message: 'Chat visual read failed.' },
    });
  });
  it('captures the exact legacy results from all three dispatched service calls', async () => {
    const port = portFixture();
    const searchMock = jest.spyOn(port, 'searchTranscript');
    const toolOutputMock = jest.spyOn(port, 'readToolOutput');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const page = await dispatcher.queryChatTranscriptPageForLegacyIpc(
      { scope },
      { caller },
    );
    expect(page.legacyResult).toEqual(
      await port.getTranscriptPage({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/private',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/attachment.md',
    );
    expect(JSON.stringify(page.canonicalResult)).toContain(
      '/Users/alice/project/file.ts',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/private.png',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/raw.jsonl',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/revert.md',
    );
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      'host orchestration',
    );
    expect(page.canonicalResult.messages).toHaveLength(1);
    expect(page.legacyResult.turns?.[0]?.files).toEqual([
      { path: '/local/deliverable.md', state: 'ready' },
    ]);
    expect(page.canonicalResult.turns?.[0]).not.toHaveProperty('files');
    expect(page.legacyResult.turns?.[0]?.outcomes).toEqual({
      blocked: 1,
      failed: 2,
    });
    expect(page.canonicalResult.turns?.[0]).toHaveProperty('outcomes', {
      blocked: 1,
      failed: 2,
    });
    expect(page.legacyResult.turns?.[0]?.deniedToolUseIds).toEqual([
      'denied-tool',
    ]);
    expect(page.canonicalResult.turns?.[0]).toHaveProperty('deniedToolUseIds', [
      'denied-tool',
    ]);
    expect(JSON.stringify(page.canonicalResult)).not.toContain(
      '/local/deliverable.md',
    );
    expect(
      CoreChatTranscriptPageResultSchema.safeParse(page.canonicalResult)
        .success,
    ).toBe(true);
    expect(JSON.stringify(page.canonicalResult)).toContain(
      '/Users/alice/project/file.ts',
    );
    const search = await dispatcher.queryChatTranscriptSearchForLegacyIpc(
      { scope, query: 'hello' },
      { caller },
      'search-1',
    );
    expect(search.legacyResult).toEqual(
      await port.searchTranscript({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        query: 'hello',
        requestId: 'search-1',
      }),
    );
    const reference = {
      version: 1 as const,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 5,
      encoding: 'utf-8' as const,
      mediaType: 'text/plain' as const,
    };
    const output = await dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
        offset: 0,
        limit: 4,
      },
      { caller },
      'output-1',
    );
    expect(output.legacyResult).toEqual(
      await port.readToolOutput({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
        offset: 0,
        limit: 4,
        requestId: 'output-1',
      }),
    );
    expect(searchMock).toHaveBeenNthCalledWith(
      1,
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        query: 'hello',
        requestId: 'search-1',
      },
      expect.any(AbortSignal),
    );
    expect(toolOutputMock).toHaveBeenNthCalledWith(
      1,
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference,
        offset: 0,
        limit: 4,
        requestId: 'output-1',
      },
      expect.any(AbortSignal),
    );
    expect(toolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'output-1' }),
      expect.any(AbortSignal),
    );
  });

  it('refuses revision 2 of a transcript page before any read (CAN-6509)', async () => {
    const port = portFixture();
    const pageRead = jest.spyOn(port, 'getTranscriptPage');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.transcript.page',
          { scope, revision: 2 },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { unsupported: ['revision'], reason: 'unserved' },
        },
      });
      expect(pageRead).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('forwards transcript targets and stream cursors without changing unscoped requests', async () => {
    const port = portFixture();
    const pageRead = jest.spyOn(port, 'getTranscriptPage');
    const searchRead = jest.spyOn(port, 'searchTranscript');
    const outputRead = jest.spyOn(port, 'readToolOutput');
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat-1',
      delegationId: 'delegation-1',
      runGeneration: 1,
    };
    const reference = {
      version: 1 as const,
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 5,
      encoding: 'utf-8' as const,
      mediaType: 'text/plain' as const,
    };
    try {
      await dispatcher.query(
        'core.chat.transcript.page',
        { scope },
        { caller },
      );
      expect(pageRead).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      });

      await dispatcher.query(
        'core.chat.transcript.page',
        { scope, target, cursor: 'transcript-cursor' },
        { caller },
      );
      expect(pageRead).toHaveBeenLastCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        target,
        cursor: 'transcript-cursor',
      });

      await dispatcher.query(
        'core.chat.transcript.search',
        { scope, target, query: 'hello' },
        { caller },
      );
      expect(searchRead).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          target,
          query: 'hello',
        }),
        expect.any(AbortSignal),
      );
      expect(typeof searchRead.mock.calls.at(-1)?.[0].requestId).toBe('string');

      await dispatcher.query(
        'core.chat.toolOutput.read',
        {
          scope,
          target,
          messageId: 'message-1',
          toolUseId: 'tool-1',
          reference,
          offset: 0,
          limit: 4,
        },
        { caller },
      );
      expect(outputRead).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          target,
          messageId: 'message-1',
          toolUseId: 'tool-1',
        }),
        expect.any(AbortSignal),
      );
      expect(typeof outputRead.mock.calls.at(-1)?.[0].requestId).toBe('string');
    } finally {
      await dispatcher.shutdown();
    }
  });

  it.each(['page', 'blocks', 'content'] as const)(
    'retains delegation run truncation through the dispatched %s result',
    async (operation) => {
      const port = portFixture();
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat-1',
        delegationId: 'delegation-1',
        runGeneration: 1,
      };
      const page = {
        messages: [],
        totalMessages: 0,
        transcriptRevision: 7,
        runTruncated: true as const,
      };
      const blocks = {
        messageId: 'message-1',
        firstBlockOrdinal: 0,
        blocks: [],
        blockCount: 0,
        transcriptRevision: 7,
        runTruncated: true as const,
      };
      const content = {
        text: 'kept',
        byteLength: 4,
        runTruncated: true as const,
      };
      jest.spyOn(port, 'getTranscriptPage').mockResolvedValue(page);
      port.getTranscriptBlocks = jest.fn().mockResolvedValue(blocks);
      port.readTranscriptContent = jest.fn().mockResolvedValue(content);
      const dispatcher = createDesktopRuntime({
        chatServices: { getPort: () => port },
      });
      try {
        if (operation === 'page') {
          expect(
            await dispatcher.query(
              'core.chat.transcript.page',
              { scope, target },
              { caller },
            ),
          ).toEqual({
            messages: [],
            totalMessages: 0,
            transcriptRevision: 7,
            runTruncated: true,
          });
        } else if (operation === 'blocks') {
          expect(
            await dispatcher.query(
              'core.chat.transcript.blocks.page',
              { scope, target, messageId: 'message-1', limit: 1 },
              { caller },
            ),
          ).toEqual({
            messageId: 'message-1',
            firstBlockOrdinal: 0,
            blocks: [],
            blockCount: 0,
            transcriptRevision: 7,
            runTruncated: true,
          });
        } else {
          expect(
            await dispatcher.query(
              'core.chat.content.read',
              {
                scope,
                target,
                messageId: 'message-1',
                blockOrdinal: 0,
                field: 'text',
                offset: 0,
                limit: 4,
              },
              { caller },
            ),
          ).toEqual({ text: 'kept', byteLength: 4, runTruncated: true });
        }
      } finally {
        await dispatcher.shutdown();
      }
    },
  );

  it('reads content and paged blocks through their optional host capabilities', async () => {
    const port = portFixture();
    const content = { text: 'user-authored excerpt', byteLength: 21 };
    const userTextBlock = Object.assign(
      {
        type: 'text' as const,
        text: 'Please open /Users/alice/project/file.ts',
      },
      {
        attachmentPath: '/local/attachment.md',
        attachmentPaths: ['/local/second-attachment.md'],
        metadata: {
          source: 'preserved',
          attachmentPromptContexts: [
            { absolutePath: '/local/nested-prompt-context.json' },
          ],
        },
      },
    );
    const blocksPage: ChatTranscriptBlocksPage = {
      messageId: 'message-1',
      firstBlockOrdinal: 0,
      blocks: [
        userTextBlock,
        { type: 'image', path: '/local/private.png', alt: 'image' },
        {
          type: 'compaction_info',
          timestamp: 1,
          provider: 'claude',
          interfaceMode: 'canopy',
          summary: 'summary',
          transcriptPath: '/local/raw.jsonl',
        },
        {
          type: 'file_references',
          references: [
            { displayPath: 'notes.md', absolutePath: '/local/notes.md' },
          ],
        },
        {
          type: 'revert_info',
          timestamp: 1,
          revertedFromMessageId: 'user-message-1',
          revertedFromTimestamp: 0,
          files: [],
          totalInsertions: 0,
          totalDeletions: 0,
          attachmentPath: '/local/revert.md',
        },
      ],
      blockCount: 5,
      nextBlockOrdinal: 5,
      cursor: 'next-block-page',
      transcriptRevision: 2,
    };
    const readContent = jest
      .fn<
        Promise<ChatToolOutputResponse>,
        [ChatTranscriptContentRequest, AbortSignal?]
      >()
      .mockResolvedValue(content);
    const readBlocks = jest
      .fn<
        Promise<ChatTranscriptBlocksPage>,
        [ChatTranscriptBlocksRequest, AbortSignal?]
      >()
      .mockResolvedValue(blocksPage);
    port.readTranscriptContent = readContent;
    port.getTranscriptBlocks = readBlocks;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const target = { kind: 'primary' as const, chatId: 'chat-1' };
    try {
      await expect(
        dispatcher.query(
          'core.chat.content.read',
          {
            scope,
            standaloneHistory: true,
            target,
            messageId: 'message-1',
            blockOrdinal: 0,
            field: 'text',
            fieldSource: 'logical',
            offset: 0,
            limit: 21,
          },
          { caller },
        ),
      ).resolves.toEqual(content);
      expect(readContent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          standaloneHistory: true,
          target,
          messageId: 'message-1',
          blockOrdinal: 0,
          field: 'text',
          fieldSource: 'logical',
          offset: 0,
          limit: 21,
        }),
        expect.any(AbortSignal),
      );
      expect(typeof readContent.mock.calls[0]?.[0].requestId).toBe('string');

      const blocksResult = await dispatcher.query(
        'core.chat.transcript.blocks.page',
        {
          scope,
          archivedContainerId: 'worktree-1',
          target,
          messageId: 'message-1',
          cursor: 'block-cursor',
          limit: 5,
        },
        { caller },
      );
      expect(readBlocks).toHaveBeenCalledWith(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          archivedContainerId: 'worktree-1',
          target,
          messageId: 'message-1',
          cursor: 'block-cursor',
          limit: 5,
        },
        expect.any(AbortSignal),
      );
      if (!('blocks' in blocksResult))
        throw new Error('Expected raw block page');
      expect(blocksResult.blocks).toEqual([
        {
          type: 'text',
          text: 'Please open /Users/alice/project/file.ts',
          metadata: { source: 'preserved' },
        },
        { type: 'image', alt: 'image' },
        {
          type: 'compaction_info',
          timestamp: 1,
          provider: 'claude',
          interfaceMode: 'canopy',
          summary: 'summary',
        },
        { type: 'file_references', references: [{ displayPath: 'notes.md' }] },
        {
          type: 'revert_info',
          timestamp: 1,
          revertedFromMessageId: 'user-message-1',
          revertedFromTimestamp: 0,
          files: [],
          totalInsertions: 0,
          totalDeletions: 0,
        },
      ]);
      expect(JSON.stringify(blocksResult)).not.toContain('/local/');
      expect(
        CoreChatTranscriptBlocksPageResultSchema.safeParse(blocksResult)
          .success,
      ).toBe(true);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('rejects malformed portable content results', async () => {
    const port = portFixture();
    port.readTranscriptContent = jest
      .fn()
      .mockResolvedValue({ text: 'valid text', byteLength: -1 });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.content.read',
          {
            scope,
            messageId: 'message-1',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 8,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
      expect(
        CoreChatContentReadResultSchema.safeParse({
          text: 'valid text',
          byteLength: -1,
        }).success,
      ).toBe(false);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('fails closed when the host does not implement content or block reads', async () => {
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => portFixture() },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.content.read',
          {
            scope,
            messageId: 'message-1',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 8,
          },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      await expect(
        dispatcher.query(
          'core.chat.transcript.blocks.page',
          { scope, messageId: 'message-1', limit: 8 },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('keeps the new transcript reads local and behind core.chat.read', async () => {
    const port = portFixture();
    const readContent = jest
      .fn<
        Promise<ChatToolOutputResponse>,
        [ChatTranscriptContentRequest, AbortSignal?]
      >()
      .mockResolvedValue({ text: 'snippet', byteLength: 7 });
    const readBlocks = jest
      .fn<
        Promise<ChatTranscriptBlocksPage>,
        [ChatTranscriptBlocksRequest, AbortSignal?]
      >()
      .mockResolvedValue({
        messageId: 'message-1',
        firstBlockOrdinal: 0,
        blocks: [],
        blockCount: 0,
        transcriptRevision: 2,
      });
    port.readTranscriptContent = readContent;
    port.getTranscriptBlocks = readBlocks;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const contentParams = {
      scope,
      messageId: 'message-1',
      blockOrdinal: 0,
      field: 'text' as const,
      offset: 0,
      limit: 8,
    };
    const blocksParams = { scope, messageId: 'message-1', limit: 8 };
    try {
      for (const [name, params] of [
        ['core.chat.content.read', contentParams],
        ['core.chat.transcript.blocks.page', blocksParams],
      ] as const) {
        await expect(
          dispatcher.query(name, params, {
            caller: { ...caller, grants: [] },
          }),
        ).rejects.toMatchObject({
          payload: { kind: 'permission_denied' },
        });
      }
      await expect(
        dispatcher.query(
          'core.chat.content.read',
          { ...contentParams, scope: { ...scope, authorityId: 'remote-core' } },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      await expect(
        dispatcher.query(
          'core.chat.transcript.blocks.page',
          { ...blocksParams, scope: { ...scope, targetId: 'remote-worker' } },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      expect(readContent).not.toHaveBeenCalled();
      expect(readBlocks).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it.each([
    ['Unknown child stream', 'not_found'],
    ['Stale transcript stream cursor', 'failed_precondition'],
  ])(
    'classifies child transcript page error %s as %s',
    async (message, kind) => {
      const port = portFixture();
      jest
        .spyOn(port, 'getTranscriptPage')
        .mockRejectedValue(new Error(message));
      const dispatcher = createDesktopRuntime({
        chatServices: { getPort: () => port },
      });
      try {
        await expect(
          dispatcher.query(
            'core.chat.transcript.page',
            {
              scope,
              target: {
                kind: 'delegation',
                chatId: 'chat-1',
                delegationId: 'delegation-1',
                runGeneration: 1,
              },
              cursor: 'cursor',
            },
            { caller },
          ),
        ).rejects.toMatchObject({ payload: { kind } });
      } finally {
        await dispatcher.shutdown();
      }
    },
  );

  it('names a stale child page cursor with its own code', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'getTranscriptPage')
      .mockRejectedValue(new Error('Stale transcript stream cursor'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.transcript.page',
          {
            scope,
            target: {
              kind: 'delegation',
              chatId: 'chat-1',
              delegationId: 'delegation-1',
              runGeneration: 1,
            },
            cursor: 'cursor',
          },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.chat.transcript.page.staleCursor',
        },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses a child page too large for the renderer relay', async () => {
    const port = portFixture();
    jest.spyOn(port, 'getTranscriptPage').mockResolvedValue({
      messages: [
        {
          id: 'row',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'x'.repeat(1_000_000) }],
        },
      ],
      totalMessages: 1,
      transcriptRevision: 1,
    });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.transcript.page',
          {
            scope,
            target: {
              kind: 'delegation',
              chatId: 'chat-1',
              delegationId: 'delegation-1',
              runGeneration: 1,
            },
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it.each([
    ['Unknown child stream', 'not_found'],
    ['Transcript message not found', 'not_found'],
    ['Invalid transcript block range', 'invalid_argument'],
    ['Stale transcript blocks cursor', 'failed_precondition'],
  ])('classifies block page error %s as %s', async (message, kind) => {
    const port = portFixture();
    port.getTranscriptBlocks = jest.fn().mockRejectedValue(new Error(message));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.transcript.blocks.page',
          { scope, messageId: 'message-1', cursor: 'cursor', limit: 8 },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind } });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it.each([
    'Invalid tool output range',
    'Tool output offset splits a UTF-8 character',
    'Tool output offset splits a UTF-16 code unit',
  ])(
    'classifies content range error %s as invalid_argument',
    async (message) => {
      const port = portFixture();
      port.readTranscriptContent = jest
        .fn()
        .mockRejectedValue(new Error(message));
      const dispatcher = createDesktopRuntime({
        chatServices: { getPort: () => port },
      });
      try {
        await expect(
          dispatcher.query(
            'core.chat.content.read',
            {
              scope,
              messageId: 'message-1',
              blockOrdinal: 0,
              field: 'text',
              offset: 1_000_000,
              limit: 16,
            },
            { caller },
          ),
        ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      } finally {
        await dispatcher.shutdown();
      }
    },
  );

  it('classifies a transcript content field without a stored body as not found', async () => {
    const port = portFixture();
    port.readTranscriptContent = jest
      .fn()
      .mockRejectedValue(
        new Error('Transcript field has no stored body for this row'),
      );
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.content.read',
          {
            scope,
            messageId: 'message-1',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 8,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('rejects absent services and foreign authorities before reading', async () => {
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => null },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc(
        { scope: { ...scope, authorityId: 'remote' } },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('reports service identifier failures as invalid arguments', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'getTranscriptPage')
      .mockRejectedValue(new IdentifierValidationError('Invalid chatId'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it.each([
    ['Unknown chat: chat-1', 'not_found'],
    ['Standalone archive not found', 'not_found'],
    ['Invalid transcript page cursor', 'invalid_argument'],
    ['Unknown transcript turn', 'invalid_argument'],
    ['Invalid turn page cursor', 'invalid_argument'],
    ["Couldn't load messages.", 'internal'],
  ])('classifies page service error %s as %s', async (message, kind) => {
    const port = portFixture();
    const cause = new Error(message);
    jest.spyOn(port, 'getTranscriptPage').mockRejectedValue(cause);
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptPageForLegacyIpc({ scope }, { caller }),
    ).rejects.toMatchObject({ payload: { kind }, runtimeCause: cause });
  });

  it('classifies an unknown chat in search as not found', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'searchTranscript')
      .mockRejectedValue(new Error('Unknown chat: chat-1'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.queryChatTranscriptSearchForLegacyIpc(
        { scope, query: 'hello' },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('classifies an unknown chat in a canonical tool-output read as not found', async () => {
    const port = portFixture();
    jest
      .spyOn(port, 'readToolOutput')
      .mockRejectedValue(new Error('Unknown chat: chat-1'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    await expect(
      dispatcher.query(
        'core.chat.toolOutput.read',
        {
          scope,
          messageId: 'message-1',
          toolUseId: 'tool-1',
          reference: {
            version: 1,
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            byteLength: 5,
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
          offset: 0,
          limit: 4,
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });

  it('aborts a running search through the dispatcher signal', async () => {
    const port = portFixture();
    let observed: AbortSignal | undefined;
    jest
      .spyOn(port, 'searchTranscript')
      .mockImplementation((_request, signal) => {
        observed = signal;
        return new Promise(() => undefined);
      });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatTranscriptSearchForLegacyIpc(
      { scope, query: 'hello' },
      { caller, signal: controller.signal },
      'search-1',
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    expect(observed?.aborted).toBe(true);
  });

  it('keeps the backend result when cancellation races with tool-output completion', async () => {
    const port = portFixture();
    let observed: AbortSignal | undefined;
    let release: (() => void) | undefined;
    jest
      .spyOn(port, 'readToolOutput')
      .mockImplementation((_request, signal) => {
        observed = signal;
        return new Promise((resolve) => {
          release = (): void => resolve({ text: 'hello', byteLength: 5 });
        });
      });
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference: {
          version: 1,
          artifactId: `sha256-v1-${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          byteLength: 5,
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
        offset: 0,
        limit: 4,
      },
      { caller, signal: controller.signal },
      'output-1',
    );
    let settled = false;
    const outcome = pending.then(
      () => {
        settled = true;
        return 'resolved';
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await Promise.resolve();
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release?.();
    await expect(outcome).resolves.toBe('resolved');
    await expect(pending).resolves.toEqual({
      canonicalResult: { text: 'hello', byteLength: 5 },
      legacyResult: { text: 'hello', byteLength: 5 },
    });
    expect(observed?.aborted).toBe(true);
  });

  it('keeps the backend error when cancellation races with tool-output failure', async () => {
    const port = portFixture();
    const backendError = new Error('backend read failed');
    backendError.name = 'AbortError';
    let rejectRead: ((error: Error) => void) | undefined;
    jest.spyOn(port, 'readToolOutput').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    const controller = new AbortController();
    const pending = dispatcher.queryChatToolOutputForLegacyIpc(
      {
        scope,
        messageId: 'message-1',
        toolUseId: 'tool-1',
        reference: {
          version: 1,
          artifactId: `sha256-v1-${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          byteLength: 5,
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
        offset: 0,
        limit: 4,
      },
      { caller, signal: controller.signal },
      'output-1',
    );
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    rejectRead?.(backendError);
    await expect(outcome).resolves.toBe(backendError);
  });
});

describe('bounded block projection regression', () => {
  async function read(
    blocks: unknown[],
    first = 0,
    limit = 512,
  ): Promise<{
    result: CoreChatTranscriptBlocksPageResult;
    probe: jest.Mock<
      Promise<ChatTranscriptBlocksPage>,
      [ChatTranscriptBlocksRequest]
    >;
  }> {
    const port = portFixture();
    const probe = jest.fn(
      (
        request: ChatTranscriptBlocksRequest,
      ): Promise<ChatTranscriptBlocksPage> => {
        const start =
          request.cursor === undefined
            ? (request.firstBlockOrdinal ?? 0)
            : Number(request.cursor.split(':')[0]);
        const selected = blocks.slice(start, start + request.limit);
        const end = start + selected.length;
        return Promise.resolve({
          messageId: request.messageId,
          firstBlockOrdinal: start,
          blocks: selected as ChatTranscriptBlocksPage['blocks'],
          blockCount: blocks.length,
          transcriptRevision: 7,
          ...(end < blocks.length
            ? { nextBlockOrdinal: end, cursor: `${end}:` + 'c'.repeat(2040) }
            : {}),
        });
      },
    );
    port.getTranscriptBlocks = probe;
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      const result = await dispatcher.query(
        'core.chat.transcript.blocks.page',
        {
          scope,
          messageId: 'm'.repeat(512),
          projection: 'bounded-v1',
          firstBlockOrdinal: first,
          limit,
        },
        { caller },
      );
      return { result, probe };
    } finally {
      await dispatcher.shutdown();
    }
  }

  it('turns a giant body and stored fields into readable previews with no storage or host metadata', async () => {
    const { result, probe } = await read([
      {
        type: 'tool_result',
        output: 'x'.repeat(900000),
        outputRef: { path: '/local/body' },
        toolUseId: 'tool',
        absolutePath: '/local/secret',
      },
      { type: 'text', text: 'short', textRef: { path: '/local/text' } },
    ]);
    expect(result).toMatchObject({
      projection: 'bounded-v1',
      firstBlockOrdinal: 0,
      entries: [
        {
          kind: 'preview',
          ordinal: 0,
          block: {
            type: 'tool_result',
            output: 'x'.repeat(4000),
            toolUseId: 'tool',
          },
          omittedFields: ['output'],
        },
        {
          kind: 'preview',
          ordinal: 1,
          block: { type: 'text', text: 'short' },
          omittedFields: ['text'],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Ref|local|truncated/);
    expect(probe.mock.calls.every(([request]) => request.limit <= 16)).toBe(
      true,
    );
  });

  it('stops before metadata overflow without an ordinal gap and fits the real relay reply shape', async () => {
    const { result } = await read(
      Array.from({ length: 8 }, () => ({
        type: 'text',
        text: 'ok',
        metadata: '"\\\n'.repeat(40000),
      })),
    );
    expect(result).toMatchObject({
      projection: 'bounded-v1',
      entries: [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }],
      nextBlockOrdinal: 3,
    });
    expect(result.cursor).toMatch(/^3:/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      786432,
    );
    expect(
      Buffer.byteLength(JSON.stringify({ ok: true, value: result })),
    ).toBeLessThanOrEqual(1048576);
  });

  it('returns unsupported and tooLarge notices and permits an empty true end', async () => {
    const { result } = await read([
      { type: 'image', path: '/local/file' },
      { type: 'text', text: 'ok', metadata: 'z'.repeat(800000) },
    ]);
    expect(result).toMatchObject({
      projection: 'bounded-v1',
      entries: [
        {
          kind: 'notice',
          ordinal: 0,
          reason: 'unsupported',
          blockType: 'image',
        },
      ],
      nextBlockOrdinal: 1,
    });
    const { result: oversized } = await read([
      { type: 'text', text: 'ok', metadata: 'z'.repeat(800000) },
    ]);
    expect(oversized).toMatchObject({
      entries: [{ kind: 'notice', ordinal: 0, reason: 'tooLarge' }],
    });
    const { result: end } = await read([], 0);
    expect(end).toEqual({
      projection: 'bounded-v1',
      messageId: 'm'.repeat(512),
      firstBlockOrdinal: 0,
      entries: [],
      blockCount: 0,
      transcriptRevision: 7,
    });
  });

  it('gives stale block cursors the stable code', async () => {
    const port = portFixture();
    port.getTranscriptBlocks = jest
      .fn()
      .mockRejectedValue(new Error('Stale transcript blocks cursor'));
    const dispatcher = createDesktopRuntime({
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        dispatcher.query(
          'core.chat.transcript.blocks.page',
          {
            scope,
            messageId: 'row',
            limit: 1,
            cursor: 'bad',
            projection: 'bounded-v1',
          },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.chat.transcript.blocks.page.staleCursor',
        },
      });
    } finally {
      await dispatcher.shutdown();
    }
  });
});
