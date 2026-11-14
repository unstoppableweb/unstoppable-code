/**
 * The E2E harness's fake web core for desktop cloud chats (CAN-6280) answers
 * every operation it serves in the shape the protocol defines: each params
 * the desktop would send parses with the operation's params schema, and each
 * answer and stream item parses with its result or item schema. So a seeded
 * cloud chat on screen is one the real web core could have produced, and a
 * protocol change breaks this test before it breaks the harness. It also
 * refuses what the real web core refuses (CAN-6342), with an error each
 * operation's error schema parses, so a desktop request the web core would
 * refuse can't pass in the harness.
 */
import type { ZodType } from 'zod';
import {
  WEB_CORE_HOST_DEFINITIONS,
  WEB_CORE_RELAY_DEFINITIONS,
} from '../../canopy-runtime/renderer-relay/web-core-relay-definitions';

interface CloudChatsWorld {
  readonly state: {
    readonly sends: unknown[];
    readonly answers: unknown[];
    readonly creates: unknown[];
    createDelayMs: number;
    readonly createRefusals: unknown[];
    readonly extraAnswers: Map<string, (params: unknown) => unknown>;
    replyDelayMs: number;
    readonly cancels: unknown[];
    sandboxAsleep: boolean;
    readonly files: Record<string, string>;
    readonly deletes: unknown[];
  };
  addDeliverable(
    chatId: string,
    deliverable: { session: string; name: string; content: string },
  ): string;
  call(method: string, params: Record<string, unknown>): unknown;
  addWorkspaceFile(file: { name: string }): void;
  raiseApproval(
    chatId: string,
    card: { toolName: string; toolCallId: string; command: string },
  ): string;
  deleteChat(chatId: string, options?: { endStream?: boolean }): void;
  onNotification(listener: (notification: unknown) => void): () => void;
  served(): string[];
  streams(): string[];
}
const { createCloudChatsWorld, SEEDED_CLOUD_CHATS } = jest.requireActual<{
  createCloudChatsWorld: (options: { accountId: string }) => CloudChatsWorld;
  SEEDED_CLOUD_CHATS: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly rootChatId: string;
    readonly secondChatId: string;
    readonly questionId: string;
    readonly questionToolUseId: string;
  };
}>('../../../../tests/electron/fixtures/cloudChatsWorld.js');

interface Definition {
  readonly params: ZodType;
  readonly result?: ZodType;
  readonly item?: ZodType;
  readonly end?: ZodType;
  readonly openResult?: ZodType;
  readonly error?: ZodType;
}

/** What the renderer may call on the web core, and what main itself calls. */
const DEFINITIONS = {
  ...WEB_CORE_RELAY_DEFINITIONS.queries,
  ...WEB_CORE_RELAY_DEFINITIONS.instructions,
  ...WEB_CORE_RELAY_DEFINITIONS.streams,
  ...WEB_CORE_HOST_DEFINITIONS.instructions,
} as Record<string, Definition>;

const SCOPE = {
  workspaceId: SEEDED_CLOUD_CHATS.workspaceId,
  worktreeId: SEEDED_CLOUD_CHATS.taskId,
};

function definition(method: string): Definition {
  const found = DEFINITIONS[method];
  if (found === undefined) throw new Error(`${method} has no definition`);
  return found;
}

describe('the fake web core for desktop cloud chats (CAN-6280)', () => {
  const world = createCloudChatsWorld({ accountId: 'acct-1' });
  const items: { method: string; params: { item: unknown } }[] = [];
  world.onNotification((notification: unknown) => {
    items.push(notification as (typeof items)[number]);
  });

  /** Calls `method` with protocol-valid params and parses its answer. */
  const call = (method: string, params: Record<string, unknown>): unknown => {
    const shape = definition(method);
    expect(shape.params.safeParse(params).error).toBeUndefined();
    const answer = world.call(method, params) as
      | { result: unknown }
      | { error: unknown }
      | undefined;
    if (answer === undefined || !('result' in answer))
      throw new Error(`${method} answered ${JSON.stringify(answer)}`);
    const answerShape =
      shape.item === undefined ? shape.result : shape.openResult;
    expect(answerShape).toBeDefined();
    expect(answerShape?.safeParse(answer.result).error).toBeUndefined();
    return answer.result;
  };

  /** Every item pushed so far parses with its stream's item schema. */
  const expectItemsValid = (): void => {
    for (const notification of items) {
      const stream = notification.method.replace(/\.item$/, '');
      const parsed = definition(stream).item?.safeParse(
        notification.params.item,
      );
      expect(parsed?.error).toBeUndefined();
    }
  };

  it('serves only operations the protocol defines', () => {
    for (const method of [...world.served(), ...world.streams()])
      expect(() => definition(method)).not.toThrow();
  });

  it('lists each served operation once, also one a spec overrides', () => {
    const other = createCloudChatsWorld({ accountId: 'acct-1' });
    other.state.extraAnswers.set('core.chat.message.send', () => ({
      result: {},
    }));
    const served = other.served();
    expect(served).toContain('core.chat.message.send');
    expect(new Set(served).size).toBe(served.length);
  });

  it('lists the seeded project and task, and reads both chats', () => {
    call('core.workspace.list', {});
    const tasks = call('core.chat.task.list', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
    }) as { items: { worktreeId: string }[] };
    expect(tasks.items.map((task) => task.worktreeId)).toEqual([
      SEEDED_CLOUD_CHATS.taskId,
    ]);
    const snapshot = call('core.chat.snapshot.get', {
      scope: SCOPE,
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
    }) as {
      tabs: { items: { chatId: string }[] };
      pendingQuestions: { requestId: string }[];
    };
    expect(snapshot.tabs.items.map((tab) => tab.chatId)).toEqual([
      SEEDED_CLOUD_CHATS.rootChatId,
      SEEDED_CLOUD_CHATS.secondChatId,
    ]);
    expect(snapshot.pendingQuestions.map((each) => each.requestId)).toEqual([
      SEEDED_CLOUD_CHATS.questionId,
    ]);
    // The desktop chat store reads the task's chats as core.chat.list names
    // them (CAN-6333).
    const chats = call('core.chat.list', { scope: SCOPE }) as {
      items: { chatId: string }[];
    };
    expect(chats.items.map((chat) => chat.chatId)).toEqual([
      SEEDED_CLOUD_CHATS.rootChatId,
      SEEDED_CLOUD_CHATS.secondChatId,
    ]);
    for (const chatId of [
      SEEDED_CLOUD_CHATS.rootChatId,
      SEEDED_CLOUD_CHATS.secondChatId,
    ]) {
      const page = call('core.chat.transcript.page', {
        scope: { ...SCOPE, chatId },
      }) as { messages: unknown[] };
      expect(page.messages.length).toBeGreaterThan(0);
    }
    // The Plugins picker's rows: a curated skill beside its same-name
    // curated plugin, and a marketplace plugin (CAN-6397).
    const catalog = call('core.catalog.snapshot.get', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
      kinds: [],
      includeUnavailable: true,
    }) as { entries: { entryId: string }[] };
    expect(catalog.entries.map((entry) => entry.entryId)).toEqual([
      'skill:cloud-curated/release-notes',
      'plugin:cloud-curated/release-notes',
      'plugin:marketplace:5f0c6c1e-6a2a-4d4f-9c55-3a8a2b7f0e11/lint-rules',
    ]);
    call('core.catalog.selection.get', {
      scope: { chatId: SEEDED_CLOUD_CHATS.rootChatId },
    });
  });

  it("lists the project's shared workspace files, and no other owner's (CAN-6568)", () => {
    const other = createCloudChatsWorld({ accountId: 'acct-1' });
    const list = (owner: Record<string, unknown>): unknown => {
      const params = {
        owner,
        kinds: ['file'],
        states: ['available'],
        cursor: null,
        limit: 100,
      };
      const shape = definition('core.artifact.list');
      expect(shape.params.safeParse(params).error).toBeUndefined();
      const answer = other.call('core.artifact.list', params) as {
        result: unknown;
      };
      expect(shape.result?.safeParse(answer.result).error).toBeUndefined();
      return answer.result;
    };
    const workspace = { kind: 'workspace', id: SEEDED_CLOUD_CHATS.workspaceId };
    expect(list(workspace)).toEqual({ artifacts: [], nextCursor: null });
    other.addWorkspaceFile({ name: 'ericeira_weather.csv' });
    expect(list(workspace)).toMatchObject({
      artifacts: [{ name: 'ericeira_weather.csv', availability: 'available' }],
    });
    expect(list({ kind: 'chat', id: SEEDED_CLOUD_CHATS.rootChatId })).toEqual({
      artifacts: [],
      nextCursor: null,
    });
  });

  it('resolves a transcript link into the task folder, refuses one outside it, and renames a file (CAN-6587)', () => {
    const other = createCloudChatsWorld({ accountId: 'acct-1' });
    const answer = (
      method: string,
      params: Record<string, unknown>,
    ): { result?: unknown; error?: { code?: string } } => {
      const shape = definition(method);
      expect(shape.params.safeParse(params).error).toBeUndefined();
      const reply = other.call(method, params) as {
        result?: unknown;
        error?: { code?: string };
      };
      if (reply.result !== undefined)
        expect(shape.result?.safeParse(reply.result).error).toBeUndefined();
      return reply;
    };
    const scope = { chatId: SEEDED_CLOUD_CHATS.rootChatId };
    const link = (
      href: string,
    ): { result?: unknown; error?: { code?: string } } =>
      answer('worker.filesystem.link.resolve', {
        scope,
        mode: 'transcript',
        href,
      });
    expect(
      link('/vercel/sandbox/workspace/notes/checklist.md').result,
    ).toMatchObject({ relativePath: 'notes/checklist.md', kind: 'file' });
    expect(link('/etc/hosts').error?.code).toBe(
      'worker.filesystem.link.outsideRoots',
    );
    const root = (
      answer('worker.filesystem.roots.list', { scope }).result as {
        roots: { fileRootId: string }[];
      }
    ).roots[0]?.fileRootId;
    expect(
      answer('worker.filesystem.entry.move', {
        scope,
        sourceFileRootId: root,
        destinationFileRootId: root,
        fromRelativePath: 'README.md',
        toRelativePath: 'LAUNCH.md',
        expectedSourceVersion: null,
        expectedDestinationAbsent: true,
        conflictPolicy: 'error',
        _meta: { idempotencyKey: 'move-1' },
      }).result,
    ).toMatchObject({ toRelativePath: 'LAUNCH.md' });
    expect(
      answer('worker.filesystem.file.read', {
        scope,
        fileRootId: root,
        relativePath: 'LAUNCH.md',
        maxBytes: 65536,
      }).result,
    ).toMatchObject({ relativePath: 'LAUNCH.md' });
  });

  it("lists a chat's saved deliverable, reads it for that chat only, and keeps it while the sandbox sleeps (CAN-6587)", () => {
    const other = createCloudChatsWorld({ accountId: 'acct-1' });
    const answer = (
      method: string,
      params: Record<string, unknown>,
    ): { result?: unknown; error?: { kind?: string; code?: string } } => {
      const shape = definition(method);
      expect(shape.params.safeParse(params).error).toBeUndefined();
      const reply = other.call(method, params) as {
        result?: unknown;
        error?: { kind?: string; code?: string };
      };
      if (reply.result !== undefined)
        expect(shape.result?.safeParse(reply.result).error).toBeUndefined();
      if (reply.error !== undefined)
        expect(shape.error?.safeParse(reply.error).error).toBeUndefined();
      return reply;
    };
    const chatId = SEEDED_CLOUD_CHATS.secondChatId;
    const id = other.addDeliverable(chatId, {
      session: 'session-1',
      name: 'weather.csv',
      content: 'day,temp\nMon,18\n',
    });
    expect(
      answer('core.artifact.list', {
        owner: { kind: 'chat', id: chatId },
        kinds: ['file'],
        states: ['available'],
        cursor: null,
        limit: 500,
      }).result,
    ).toMatchObject({
      artifacts: [{ artifactId: `dlv:${chatId}:${id}`, name: 'weather.csv' }],
    });
    const read = (scopeChatId: string): ReturnType<typeof answer> =>
      answer('worker.artifact.download.read', {
        artifactId: `deliverable:${id}`,
        scope: { chatId: scopeChatId },
        offset: 0,
        length: 4,
      });
    expect(read(chatId).result).toEqual({
      sizeBytes: 16,
      offset: 0,
      data: Buffer.from('day,').toString('base64'),
      nextOffset: 4,
    });
    // Another chat's deliverable reads as missing, as the web core answers.
    expect(read(SEEDED_CLOUD_CHATS.rootChatId).error).toMatchObject({
      kind: 'not_found',
    });

    // Asleep, the sandbox lists its roots and refuses its files.
    other.state.sandboxAsleep = true;
    const scope = { chatId };
    expect(
      answer('worker.filesystem.roots.list', { scope }).result,
    ).toBeDefined();
    expect(
      answer('worker.filesystem.link.resolve', {
        scope,
        mode: 'transcript',
        href: '/vercel/sandbox/workspace/deliverables/session-1/weather.csv',
      }).error,
    ).toMatchObject({ kind: 'failed_precondition' });
    expect(read(chatId).result).toBeDefined();
  });

  it('serves the task folder’s files', () => {
    const scope = { chatId: SEEDED_CLOUD_CHATS.rootChatId };
    const { roots } = call('worker.filesystem.roots.list', { scope }) as {
      roots: { fileRootId: string }[];
    };
    const fileRootId = roots[0]?.fileRootId ?? '';
    const listed = call('worker.filesystem.directory.list', {
      scope,
      fileRootId,
      relativePath: '',
    }) as { entries: { name: string }[] };
    expect(listed.entries.map((entry) => entry.name).sort()).toEqual([
      'README.md',
      'notes',
    ]);
    const nested = call('worker.filesystem.directory.list', {
      scope,
      fileRootId,
      relativePath: 'notes',
    }) as { entries: { relativePath: string }[] };
    expect(nested.entries.map((entry) => entry.relativePath)).toEqual([
      'notes/checklist.md',
    ]);
    call('worker.filesystem.search', {
      scope,
      fileRootId,
      query: '',
      mode: 'name',
      purpose: 'mentions',
      limit: 25_000,
    });
    const read = call('worker.filesystem.file.read', {
      scope,
      fileRootId,
      relativePath: 'README.md',
      maxBytes: 5 * 1024 * 1024,
    }) as { content: string };
    expect(read.content).toContain('Launch plan');
  });

  it("refuses a sleeping sandbox's files as the web core does until a turn wakes it, and deletes an entry (CAN-6543)", async () => {
    const fresh = createCloudChatsWorld({ accountId: 'acct-1' });
    const scope = { chatId: SEEDED_CLOUD_CHATS.rootChatId };
    const fileRootId = 'e2e-cloud-root';
    const listParams = { scope, fileRootId, relativePath: '' };
    const deleteParams = {
      scope,
      fileRootId,
      relativePath: 'notes',
      expectedVersion: null,
      recursive: true,
      disposition: 'permanent',
      _meta: { idempotencyKey: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a31' },
    };
    const sandboxCalls: [string, Record<string, unknown>, string][] = [
      [
        'worker.filesystem.directory.list',
        listParams,
        'worker.filesystem.directory',
      ],
      [
        'worker.filesystem.search',
        {
          scope,
          fileRootId,
          query: '',
          mode: 'name',
          purpose: 'file-explorer',
          limit: 25_000,
        },
        'worker.filesystem.search',
      ],
      [
        'worker.filesystem.file.read',
        { scope, fileRootId, relativePath: 'README.md', maxBytes: 1024 },
        'worker.filesystem.file',
      ],
      [
        'worker.filesystem.entry.delete',
        deleteParams,
        'worker.filesystem.entry',
      ],
    ];
    fresh.state.sandboxAsleep = true;
    // Its roots still list; every read and write of the sandbox is refused
    // with the web core's own sleeping reason, and nothing is deleted.
    expect(
      fresh.call('worker.filesystem.roots.list', { scope }),
    ).toHaveProperty('result');
    for (const [method, params, namespace] of sandboxCalls) {
      expect(definition(method).params.safeParse(params).error).toBe(undefined);
      const answer = fresh.call(method, params) as { error?: unknown };
      expect([method, answer.error]).toEqual([
        method,
        {
          kind: 'failed_precondition',
          message: 'The sandbox is asleep.',
          code: `${namespace}.invalidState`,
          details: {
            reason: 'sandbox_sleeping',
            wakeAllowed: true,
            cloudCode: 'SANDBOX_NOT_READY',
          },
          retry: { kind: 'after_refresh', resource: namespace },
        },
      ]);
      expect(definition(method).error?.safeParse(answer.error).error).toBe(
        undefined,
      );
    }
    expect(fresh.state.deletes).toEqual([]);

    // A sent turn runs in the sandbox and wakes it.
    const commandId = '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a32';
    fresh.state.replyDelayMs = 10;
    expect(
      fresh.call('core.chat.message.send', {
        scope: SCOPE,
        commandId,
        chatId: SEEDED_CLOUD_CHATS.rootChatId,
        messageId: 'message-asleep',
        text: 'List the notes.',
        _meta: { idempotencyKey: commandId },
      }),
    ).toHaveProperty('result');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fresh.state.sandboxAsleep).toBe(false);

    const answer = fresh.call(
      'worker.filesystem.entry.delete',
      deleteParams,
    ) as { result?: unknown };
    expect(
      definition('worker.filesystem.entry.delete').result?.safeParse(
        answer.result,
      ).error,
    ).toBeUndefined();
    expect(answer.result).toEqual({
      deleted: true,
      deletedEntryCount: 1,
      disposition: 'permanent',
    });
    expect(fresh.state.deletes).toEqual([deleteParams]);
    const listed = fresh.call(
      'worker.filesystem.directory.list',
      listParams,
    ) as {
      result: { entries: { name: string }[] };
    };
    expect(listed.result.entries.map((entry) => entry.name)).toEqual([
      'README.md',
    ]);
    // Deleting it again finds nothing, as the web core answers.
    expect(
      (
        fresh.call('worker.filesystem.entry.delete', deleteParams) as {
          error?: { kind: string };
        }
      ).error?.kind,
    ).toBe('not_found');
    // Another world keeps the seeded files.
    const other = createCloudChatsWorld({ accountId: 'acct-1' }).call(
      'worker.filesystem.directory.list',
      listParams,
    ) as { result: { entries: { name: string }[] } };
    expect(other.result.entries.map((entry) => entry.name).sort()).toEqual([
      'README.md',
      'notes',
    ]);
  });

  it('pushes a sent turn and an answered question as the web core reports Core’s turns', async () => {
    call('core.chat.task.events', { scope: 'all', cursor: null });
    call('core.chat.events', {
      scope: {
        projectId: SEEDED_CLOUD_CHATS.workspaceId,
        worktreeId: SEEDED_CLOUD_CHATS.taskId,
      },
      cursor: null,
    });
    call('core.chat.live.events', {
      scope: { ...SCOPE, chatId: SEEDED_CLOUD_CHATS.rootChatId },
    });
    await Promise.resolve();
    const changes = (): {
      type: string;
      runtime?: Record<string, unknown>;
      message?: { id: string; blocks: Record<string, unknown>[] };
    }[] =>
      items
        .filter((each) => each.method === 'core.chat.events.item')
        .flatMap(
          (each) =>
            (each.params.item as { changes: ReturnType<typeof changes> })
              .changes,
        );
    const runtimes = (): Record<string, unknown>[] =>
      changes().flatMap((change) =>
        change.type === 'runtime.patched' && change.runtime
          ? [change.runtime]
          : [],
      );
    // A pending question's turn runs, waiting on the answer.
    expect(
      (
        call('core.chat.snapshot.get', { scope: SCOPE }) as {
          runtimeByChatId: Record<string, unknown>;
        }
      ).runtimeByChatId[SEEDED_CLOUD_CHATS.rootChatId],
    ).toMatchObject({ status: 'awaiting_input' });
    expect(
      (
        call('core.chat.snapshot.get', { scope: SCOPE }) as {
          runtimeByChatId: Record<string, { activeTurnId?: unknown }>;
        }
      ).runtimeByChatId[SEEDED_CLOUD_CHATS.rootChatId]?.activeTurnId,
    ).toEqual(expect.stringMatching(/./));

    // The answer settles the question; the turn runs on to its reply, and
    // Core records no result for the question call.
    call('core.chat.question.respond', {
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      questionId: SEEDED_CLOUD_CHATS.questionId,
      answers: { room: { selectedOptions: ['Studio B'] } },
    });
    expect(changes().map((change) => change.type)).toEqual([
      'pending_question.removed',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const asking = changes().find((change) =>
      change.message?.blocks.some(
        (block) => block.toolUseId === SEEDED_CLOUD_CHATS.questionToolUseId,
      ),
    )?.message;
    expect(asking?.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool_use',
    ]);
    // Core's session still reads streaming in the batch that ends the turn.
    expect(runtimes()).toEqual([{ status: 'streaming', queuedMessageIds: [] }]);

    const receipt = call('core.chat.message.send', {
      scope: SCOPE,
      commandId: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21',
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      messageId: 'message-1',
      text: 'Studio B, please.',
      _meta: { idempotencyKey: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21' },
    }) as { outcome: string; entityId: string };
    expect(receipt.outcome).toBe('applied');
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Queued, then running under the receipt's turn, then committed with no
    // turn and Core's session still streaming.
    expect(runtimes().slice(1)).toEqual([
      { status: 'awaiting_input', queuedMessageIds: ['message-1'] },
      {
        status: 'streaming',
        queuedMessageIds: [],
        activeTurnId: receipt.entityId,
      },
      { status: 'streaming', queuedMessageIds: [] },
    ]);
    expect(
      changes().some((change) =>
        change.message?.blocks.some(
          (block) => block.text === 'Seeded reply: Studio B, please.',
        ),
      ),
    ).toBe(true);
    expectItemsValid();
    expect(world.state.sends).toHaveLength(1);
    expect(world.state.answers).toHaveLength(1);
    const matched = call('core.chat.send.receipt', {
      scope: { ...SCOPE, chatId: SEEDED_CLOUD_CHATS.rootChatId },
      commandId: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21',
    }) as { outcome: string };
    expect(matched.outcome).toBe('matched');

    // Stop on a turn already over is not an error.
    expect(
      call('core.chat.turn.cancel', {
        chatId: SEEDED_CLOUD_CHATS.rootChatId,
        turnId: receipt.entityId,
        reason: 'user',
      }),
    ).toMatchObject({ state: 'idle' });
  });

  it('stops a running turn by its conversation turn id, as the web core does (CAN-6393)', async () => {
    const running = createCloudChatsWorld({ accountId: 'acct-1' });
    running.state.replyDelayMs = 60_000;
    const pushed: { method: string; params: { item: unknown } }[] = [];
    running.onNotification((notification: unknown) => {
      pushed.push(notification as (typeof pushed)[number]);
    });
    const runningCall = (
      method: string,
      params: Record<string, unknown>,
    ): unknown => {
      const shape = definition(method);
      expect(shape.params.safeParse(params).error).toBeUndefined();
      const answer = running.call(method, params) as { result: unknown };
      const answerShape =
        shape.item === undefined ? shape.result : shape.openResult;
      expect(answerShape?.safeParse(answer.result).error).toBeUndefined();
      return answer.result;
    };
    runningCall('core.chat.events', {
      scope: {
        projectId: SEEDED_CLOUD_CHATS.workspaceId,
        worktreeId: SEEDED_CLOUD_CHATS.taskId,
      },
      cursor: null,
    });
    const commandId = '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
    const receipt = runningCall('core.chat.message.send', {
      scope: SCOPE,
      commandId,
      chatId: SEEDED_CLOUD_CHATS.secondChatId,
      messageId: 'message-running',
      text: 'Take your time.',
      _meta: { idempotencyKey: commandId },
    }) as { entityId: string };
    // The receipt names the conversation turn, as the snapshot's activeTurnId does.
    expect(receipt.entityId).toBe(`turn-${commandId}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    runningCall('core.chat.live.events', {
      scope: { ...SCOPE, chatId: SEEDED_CLOUD_CHATS.secondChatId },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const liveItems = (): unknown[] =>
      pushed
        .filter((each) => each.method === 'core.chat.live.events.item')
        .map((each) => each.params.item);
    // A running turn's live stream opens with no idle.
    expect(liveItems()).toEqual([]);
    const ended = runningCall('core.chat.turn.cancel', {
      chatId: SEEDED_CLOUD_CHATS.secondChatId,
      turnId: 'turn-other',
      reason: 'user',
    }) as { state: string };
    expect(ended.state).toBe('idle');
    const stopped = runningCall('core.chat.turn.cancel', {
      chatId: SEEDED_CLOUD_CHATS.secondChatId,
      turnId: receipt.entityId,
      reason: 'user',
    }) as { state: string };
    expect(stopped.state).toBe('running');
    expect(running.state.cancels).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const runtimes = pushed.flatMap((each) =>
      each.method === 'core.chat.events.item'
        ? (
            each.params.item as {
              changes: { type: string; runtime?: Record<string, unknown> }[];
            }
          ).changes.flatMap((change) =>
            change.type === 'runtime.patched' && change.runtime
              ? [change.runtime]
              : [],
          )
        : [],
    );
    // Queued, running under its turn, then the reply so far commits with no
    // turn while Core's session still reads streaming; the live stream says
    // idle.
    expect(runtimes).toEqual([
      { status: 'awaiting_input', queuedMessageIds: ['message-running'] },
      {
        status: 'streaming',
        queuedMessageIds: [],
        activeTurnId: receipt.entityId,
      },
      { status: 'streaming', queuedMessageIds: [] },
    ]);
    expect(liveItems()).toEqual([
      { kind: 'idle', chatId: SEEDED_CLOUD_CHATS.secondChatId },
    ]);
    for (const notification of pushed) {
      const stream = notification.method.replace(/\.item$/, '');
      expect(
        definition(stream).item?.safeParse(notification.params.item).error,
      ).toBeUndefined();
    }
  });

  it('refuses what the real web core refuses, as the web core does', () => {
    const fresh = createCloudChatsWorld({ accountId: 'acct-1' });
    const chat = { ...SCOPE, chatId: SEEDED_CLOUD_CHATS.rootChatId };
    const otherTask = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const send = {
      scope: SCOPE,
      commandId: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a22',
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      messageId: 'message-2',
      text: 'Hello',
      _meta: { idempotencyKey: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a22' },
    };
    const cases: [string, Record<string, unknown>, string][] = [
      // The selection read #8672's send hook first sent.
      [
        'core.catalog.selection.get',
        { scope: SCOPE, targetId: SEEDED_CLOUD_CHATS.rootChatId },
        'invalid_argument',
      ],
      [
        'core.catalog.selection.get',
        {
          scope: {
            chatId: SEEDED_CLOUD_CHATS.rootChatId,
            workspaceId: SEEDED_CLOUD_CHATS.workspaceId,
          },
        },
        'invalid_argument',
      ],
      [
        'core.catalog.snapshot.get',
        {
          scope: { chatId: SEEDED_CLOUD_CHATS.rootChatId },
          kinds: [],
          includeUnavailable: true,
        },
        'invalid_argument',
      ],
      [
        'core.catalog.snapshot.get',
        {
          scope: { organizationId: 'org-1' },
          kinds: [],
          includeUnavailable: true,
        },
        'invalid_argument',
      ],
      [
        'core.chat.transcript.page',
        { scope: { ...chat, organizationId: 'org-1' } },
        'capability_unavailable',
      ],
      ['core.chat.transcript.page', { scope: SCOPE }, 'invalid_argument'],
      [
        'core.chat.message.send',
        { ...send, commandId: 'command-1' },
        'invalid_argument',
      ],
      [
        'core.chat.message.send',
        { ...send, text: undefined },
        'invalid_argument',
      ],
      // Version and variant bits too, as the web core's isUuid checks.
      [
        'core.chat.message.send',
        { ...send, commandId: '00000000-0000-0000-0000-000000000000' },
        'invalid_argument',
      ],
      // A send takes no host execution on the wire.
      [
        'core.chat.message.send',
        { ...send, _execution: {} },
        'invalid_argument',
      ],
      [
        'core.chat.transcript.page',
        { scope: { ...chat, authorityId: 'a-different-core' } },
        'capability_unavailable',
      ],
      [
        'core.chat.snapshot.get',
        { scope: { ...SCOPE, worktreeId: otherTask } },
        'not_found',
      ],
      [
        'worker.filesystem.file.read',
        {
          scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
          fileRootId: 'root',
          relativePath: 'README.md',
          maxBytes: 1024,
        },
        'capability_unavailable',
      ],
      [
        'worker.filesystem.file.read',
        {
          scope: { chatId: otherTask },
          fileRootId: 'root',
          relativePath: 'README.md',
          maxBytes: 1024,
        },
        'not_found',
      ],
    ];
    for (const [method, params, kind] of cases) {
      const answer = fresh.call(method, params) as {
        error?: { kind: string };
      };
      expect([method, answer.error?.kind]).toEqual([method, kind]);
      expect(definition(method).error?.safeParse(answer.error).error).toBe(
        undefined,
      );
    }
    expect(fresh.state.sends).toEqual([]);
    // The wire envelope's `_meta` is the web core's to admit, keyed or not.
    expect(
      fresh.call('core.workspace.list', {
        pageSize: 500,
        _meta: { deadlineAt: '2026-11-11T09:00:00.000Z' },
      }),
    ).toHaveProperty('result');
    // A relay operation the fake doesn't serve answers nothing.
    expect(fresh.call('core.chat.update', {})).toBeUndefined();
  });

  /** `core.chat.create` params for `tabId` in `worktreeId`, protocol-valid. */
  const createParams = (
    tabId: string,
    worktreeId = tabId,
    action: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const commandId = crypto.randomUUID();
    const params = {
      projectId: SEEDED_CLOUD_CHATS.workspaceId,
      worktreeId,
      commandId,
      _meta: { idempotencyKey: commandId },
      action: { type: 'chat.create_tab', tabId, ...action },
    };
    expect(
      definition('core.chat.create').params.safeParse(params).error,
    ).toBeUndefined();
    return params;
  };

  /** A create's answer, parsed with the operation's result or error schema. */
  const create = async (
    target: CloudChatsWorld,
    params: Record<string, unknown>,
  ): Promise<{
    result?: Record<string, unknown>;
    error?: { kind: string };
  }> => {
    const answer = (await target.call('core.chat.create', params)) as {
      result?: Record<string, unknown>;
      error?: { kind: string };
    };
    const shape = definition('core.chat.create');
    if (answer.error === undefined)
      expect(shape.result?.safeParse(answer.result).error).toBeUndefined();
    else expect(shape.error?.safeParse(answer.error).error).toBeUndefined();
    return answer;
  };

  it('creates a task, and a chat in it, that read, send and stream as the seeded one does (CAN-6098)', async () => {
    const fresh = createCloudChatsWorld({ accountId: 'acct-1' });
    const pushed: { method: string; params: { item: unknown } }[] = [];
    fresh.onNotification((notification: unknown) => {
      pushed.push(notification as (typeof pushed)[number]);
    });
    fresh.call('core.chat.task.events', { scope: 'all', cursor: null });
    const taskId = crypto.randomUUID();
    const made = await create(
      fresh,
      createParams(taskId, taskId, { title: 'Book the venue' }),
    );
    // As the web core answers: revision 0, the tab id as the entity.
    expect(made.result).toMatchObject({
      revision: 0,
      entityId: taskId,
      outcome: 'applied',
    });
    expect(pushed.map((each) => [each.method, each.params.item])).toEqual([
      [
        'core.chat.task.events.item',
        expect.objectContaining({ kind: 'task', worktreeId: taskId }),
      ],
    ]);
    const scope = {
      workspaceId: SEEDED_CLOUD_CHATS.workspaceId,
      worktreeId: taskId,
    };
    const listed = fresh.call('core.chat.task.list', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
    }) as { result: { items: { worktreeId: string; title: string }[] } };
    expect(
      listed.result.items.map((task) => [task.worktreeId, task.title]),
    ).toEqual([
      [taskId, 'Book the venue'],
      [SEEDED_CLOUD_CHATS.taskId, 'Plan the launch'],
    ]);
    // A chat added to the task, untitled, takes the web core's default title.
    const chatId = crypto.randomUUID();
    await create(fresh, createParams(chatId, taskId));
    const snapshot = fresh.call('core.chat.snapshot.get', { scope }) as {
      result: {
        tabs: {
          activeTabId: string;
          items: { chatId: string; title: string }[];
        };
      };
    };
    expect(
      definition('core.chat.snapshot.get').result?.safeParse(snapshot.result)
        .error,
    ).toBeUndefined();
    expect(snapshot.result.tabs.activeTabId).toBe(taskId);
    expect(
      snapshot.result.tabs.items.map((tab) => [tab.chatId, tab.title]),
    ).toEqual([
      [taskId, 'Book the venue'],
      [chatId, 'New chat'],
    ]);
    const chats = fresh.call('core.chat.list', { scope }) as {
      result: { items: { chatId: string }[] };
    };
    expect(chats.result.items.map((chat) => chat.chatId)).toEqual([
      taskId,
      chatId,
    ]);
    const page = fresh.call('core.chat.transcript.page', {
      scope: { ...scope, chatId: taskId },
    }) as { result: { messages: unknown[] } };
    expect(page.result.messages).toEqual([]);
    fresh.call('core.chat.events', {
      scope: { projectId: SEEDED_CLOUD_CHATS.workspaceId, worktreeId: taskId },
      cursor: null,
    });
    const commandId = crypto.randomUUID();
    const sent = fresh.call('core.chat.message.send', {
      scope,
      commandId,
      chatId: taskId,
      messageId: 'message-new',
      text: 'Find a venue.',
      _meta: { idempotencyKey: commandId },
    }) as { result: { outcome: string } };
    expect(sent.result.outcome).toBe('applied');
    // The turn runs and commits its reply after the receipt, as Core's does.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      pushed.findLast(
        (notification) => notification.method === 'core.chat.events.item',
      ),
    ).toMatchObject({ params: { item: { worktreeId: taskId } } });
    for (const notification of pushed) {
      const stream = notification.method.replace(/\.item$/, '');
      expect(
        definition(stream).item?.safeParse(notification.params.item).error,
      ).toBeUndefined();
    }
    // A new task has an empty folder.
    const listedFiles = fresh.call('worker.filesystem.directory.list', {
      scope: { chatId: taskId },
      fileRootId: 'e2e-cloud-root',
      relativePath: '',
    }) as { result?: { entries: unknown[] } };
    expect(listedFiles.result?.entries).toEqual([]);
  });

  it('answers a create as the web core does: replayed, conflicting, refused or held (CAN-6098)', async () => {
    jest.useFakeTimers();
    try {
      const fresh = createCloudChatsWorld({ accountId: 'acct-1' });
      const taskId = crypto.randomUUID();
      await create(fresh, createParams(taskId));
      // A repeated create replays the chat it made, under a new command id.
      expect((await create(fresh, createParams(taskId))).result).toMatchObject({
        outcome: 'already_applied',
        entityId: taskId,
      });
      // The tab id held under another task is a conflict, with a reason.
      expect(
        (await create(fresh, createParams(taskId, SEEDED_CLOUD_CHATS.taskId)))
          .result,
      ).toMatchObject({
        outcome: 'conflict',
        reason: 'Another chat already uses this tab id.',
      });
      const kinds: [Record<string, unknown>, string][] = [
        [createParams('tab-1'), 'invalid_argument'],
        [
          createParams(crypto.randomUUID(), undefined, {
            title: 'x'.repeat(257),
          }),
          'invalid_argument',
        ],
        [
          { ...createParams(crypto.randomUUID()), expectedRevision: 1 },
          'capability_unavailable',
        ],
        [
          {
            ...createParams(crypto.randomUUID()),
            projectId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          },
          'not_found',
        ],
        [
          createParams(
            crypto.randomUUID(),
            'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e',
          ),
          'not_found',
        ],
      ];
      for (const [params, kind] of kinds)
        expect((await create(fresh, params)).error?.kind).toBe(kind);
      // A refusal a spec sets answers the next create, and nothing lands.
      fresh.state.createRefusals.push({
        kind: 'failed_precondition',
        message: 'This project is full.',
        retry: { kind: 'never' },
      });
      const refusedId = crypto.randomUUID();
      expect(
        (await create(fresh, createParams(refusedId))).error,
      ).toMatchObject({
        kind: 'failed_precondition',
        message: 'This project is full.',
      });
      expect(
        (
          fresh.call('core.chat.snapshot.get', {
            scope: {
              workspaceId: SEEDED_CLOUD_CHATS.workspaceId,
              worktreeId: refusedId,
            },
          }) as { error?: { kind: string } }
        ).error?.kind,
      ).toBe('not_found');
      // A delayed create lands after its delay; another create of the same
      // tab meanwhile is told to retry under its key, as the web core does.
      fresh.state.createDelayMs = 1500;
      const heldId = crypto.randomUUID();
      let settled = false;
      const first = create(fresh, createParams(heldId)).then((answer) => {
        settled = true;
        return answer;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect((await create(fresh, createParams(heldId))).error).toMatchObject({
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      });
      await jest.advanceTimersByTimeAsync(1499);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect((await first).result).toMatchObject({ outcome: 'applied' });
      expect(fresh.state.creates.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('archives a task through its own chat, which drops it from the list (CAN-6511)', () => {
    const other = createCloudChatsWorld({ accountId: 'acct-1' });
    const archive = (): unknown => {
      const params = {
        commandId: 'cmd-archive',
        projectId: SEEDED_CLOUD_CHATS.workspaceId,
        worktreeId: SEEDED_CLOUD_CHATS.taskId,
        _meta: { idempotencyKey: 'cmd-archive' },
        action: { type: 'chat.archive_tab', tabId: SEEDED_CLOUD_CHATS.taskId },
      };
      const shape = definition('core.chat.archive');
      expect(shape.params.safeParse(params).error).toBeUndefined();
      const answer = other.call('core.chat.archive', params) as {
        result: unknown;
      };
      expect(shape.result).toBeDefined();
      expect(shape.result?.safeParse(answer.result).error).toBeUndefined();
      return answer.result;
    };
    expect(archive()).toMatchObject({ outcome: 'applied' });
    // A retry is already applied, as the web core answers an archived chat.
    expect(archive()).toMatchObject({ outcome: 'already_applied' });
    const tasks = other.call('core.chat.task.list', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
    }) as { result: { items: unknown[] } };
    expect(tasks.result.items).toEqual([]);
  });

  it('raises a chat’s tool approval, lists its card at revision 2 and settles it once answered (CAN-6515)', () => {
    const before = items.length;
    const params = {
      scope: { chatId: SEEDED_CLOUD_CHATS.secondChatId },
      cursor: null,
    };
    call('core.approval.request.events', params);
    const requestId = world.raiseApproval(SEEDED_CLOUD_CHATS.secondChatId, {
      toolName: 'Bash',
      toolCallId: 'toolu_ls',
      command: 'ls -la',
    });
    const listed = call('core.approval.request.list', {
      scope: { chatId: SEEDED_CLOUD_CHATS.secondChatId },
      states: ['pending'],
      cursor: null,
      limit: 500,
      revision: 2,
    }) as { requests: { requestId: string; presentation?: unknown }[] };
    const card: unknown = expect.objectContaining({ toolCallId: 'toolu_ls' });
    expect(listed.requests).toEqual([
      expect.objectContaining({ requestId, presentation: card }),
    ]);
    call('core.approval.request.respond', {
      requestId,
      policyRevision: 0,
      decision: 'allow',
      stopTurn: false,
      message: null,
      createRule: null,
      _meta: { idempotencyKey: 'answer-1' },
    });
    // The request, then its settlement, went to the chat's stream.
    expect(
      items
        .slice(before)
        .filter((each) => each.method === 'core.approval.request.events.item')
        .map((each) => (each.params.item as { kind: string }).kind),
    ).toEqual(['request', 'resolved']);
    expectItemsValid();
    expect(
      call('core.approval.request.list', {
        scope: { chatId: SEEDED_CLOUD_CHATS.secondChatId },
        states: ['pending'],
        cursor: null,
        limit: 500,
        revision: 2,
      }),
    ).toMatchObject({ requests: [] });
  });

  it('deletes a task on another device as the web core reports it: tab.removed, then not found (CAN-6614)', async () => {
    const fresh = createCloudChatsWorld({ accountId: 'acct-1' });
    const pushed: {
      method: string;
      params: { subscriptionId: string; item?: unknown };
    }[] = [];
    fresh.onNotification((notification: unknown) => {
      pushed.push(notification as (typeof pushed)[number]);
    });
    const scope = {
      projectId: SEEDED_CLOUD_CHATS.workspaceId,
      worktreeId: SEEDED_CLOUD_CHATS.taskId,
    };
    const opened = fresh.call('core.chat.events', { scope, cursor: null }) as {
      result: { subscriptionId: string };
    };
    fresh.call('core.chat.task.events', { scope: 'all', cursor: null });
    fresh.deleteChat(SEEDED_CLOUD_CHATS.rootChatId);
    // The task's stream removes its chats, the sidebar's names the task,
    // and the task's stream then ends not found, each as its schema says.
    expect(
      pushed.map((each) => [each.method, each.params.item ?? null]),
    ).toEqual([
      [
        'core.chat.events.item',
        expect.objectContaining({
          worktreeId: SEEDED_CLOUD_CHATS.taskId,
          changes: [
            { type: 'tab.removed', tabId: SEEDED_CLOUD_CHATS.rootChatId },
            { type: 'tab.removed', tabId: SEEDED_CLOUD_CHATS.secondChatId },
          ],
        }),
      ],
      [
        'core.chat.task.events.item',
        expect.objectContaining({ worktreeId: SEEDED_CLOUD_CHATS.taskId }),
      ],
      ['core.chat.events.end', null],
    ]);
    for (const notification of pushed) {
      const [, stream = '', frame] =
        /^(.*)\.(item|end)$/.exec(notification.method) ?? [];
      const shape = definition(stream);
      const { subscriptionId, ...params } = notification.params;
      expect(
        (frame === 'item'
          ? shape.item?.safeParse(params.item)
          : shape.end?.safeParse(params)
        )?.error,
      ).toBeUndefined();
      expect(typeof subscriptionId).toBe('string');
    }
    expect(pushed.at(-1)?.params).toMatchObject({
      subscriptionId: opened.result.subscriptionId,
      outcome: 'error',
      error: { kind: 'not_found' },
    });
    // The task and both its chats are gone: reads, a new chat in it, a send
    // and a reopened stream all answer not found, and the sidebar lists it
    // no more.
    const taskScope = {
      workspaceId: SEEDED_CLOUD_CHATS.workspaceId,
      worktreeId: SEEDED_CLOUD_CHATS.taskId,
    };
    const kindOf = (answer: unknown): unknown =>
      (answer as { error?: { kind: string } }).error?.kind;
    expect(
      kindOf(fresh.call('core.chat.snapshot.get', { scope: taskScope })),
    ).toBe('not_found');
    expect(
      kindOf(
        fresh.call('core.chat.transcript.page', {
          scope: { ...taskScope, chatId: SEEDED_CLOUD_CHATS.secondChatId },
        }),
      ),
    ).toBe('not_found');
    expect(
      kindOf(fresh.call('core.chat.events', { scope, cursor: null })),
    ).toBe('not_found');
    expect(
      (
        await create(
          fresh,
          createParams(crypto.randomUUID(), SEEDED_CLOUD_CHATS.taskId),
        )
      ).error?.kind,
    ).toBe('not_found');
    const listed = fresh.call('core.chat.task.list', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
    }) as { result: { items: unknown[] } };
    expect(listed.result.items).toEqual([]);
  });

  it('holds main’s client lease and takes its acknowledgements', () => {
    call('core.client.lease.acquire', {
      clientInstanceId: 'client-1',
      interfaceKind: 'http',
      label: 'Desktop cloud chats',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 30_000,
      _meta: { idempotencyKey: 'lease-1' },
    });
    call('core.client.lease.renew', {
      expectedRevision: 1,
      interactive: true,
      foreground: true,
    });
    const opened = call('core.chat.task.events', { scope: 'all' }) as {
      subscriptionId: string;
    };
    call('core.events.ack', {
      subscriptionId: opened.subscriptionId,
      cursor: { daemonEpoch: 'web-core-e2e', sequence: 1 },
    });
    const gone = call('core.events.unsubscribe', {
      subscriptionId: opened.subscriptionId,
    }) as { unsubscribed: boolean };
    expect(gone.unsubscribed).toBe(true);
    call('core.client.lease.release', { reason: 'normal_shutdown' });
  });
});
