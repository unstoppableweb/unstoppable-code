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
  };
  call(method: string, params: Record<string, unknown>): unknown;
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
  };
}>('../../../../tests/electron/fixtures/cloudChatsWorld.js');

interface Definition {
  readonly params: ZodType;
  readonly result?: ZodType;
  readonly item?: ZodType;
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
    call('core.catalog.snapshot.get', {
      scope: { workspaceId: SEEDED_CLOUD_CHATS.workspaceId },
      kinds: [],
      includeUnavailable: true,
    });
    call('core.catalog.selection.get', {
      scope: { chatId: SEEDED_CLOUD_CHATS.rootChatId },
    });
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

  it('pushes a sent message and its reply, and a question’s answer, as chat events', async () => {
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
    const receipt = call('core.chat.message.send', {
      scope: SCOPE,
      commandId: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21',
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      messageId: 'message-1',
      text: 'Studio B, please.',
      _meta: { idempotencyKey: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21' },
    }) as { outcome: string };
    expect(receipt.outcome).toBe('applied');
    call('core.chat.question.respond', {
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      questionId: SEEDED_CLOUD_CHATS.questionId,
      answers: { room: { selectedOptions: ['Studio B'] } },
    });
    expect(items.map((each) => each.method)).toEqual([
      'core.chat.live.events.item',
      'core.chat.events.item',
      'core.chat.events.item',
    ]);
    expectItemsValid();
    expect(world.state.sends).toHaveLength(1);
    expect(world.state.answers).toHaveLength(1);
    const matched = call('core.chat.send.receipt', {
      scope: { ...SCOPE, chatId: SEEDED_CLOUD_CHATS.rootChatId },
      commandId: '0f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f1a21',
    }) as { outcome: string };
    expect(matched.outcome).toBe('matched');
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
    expect(fresh.call('core.chat.archive', {})).toBeUndefined();
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
    expect(pushed.at(-1)).toMatchObject({
      method: 'core.chat.events.item',
      params: { item: { worktreeId: taskId } },
    });
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
