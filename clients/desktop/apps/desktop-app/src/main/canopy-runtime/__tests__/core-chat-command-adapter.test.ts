import { setChatStateCommandPort } from '../../ipc/chat-state';
import { createDesktopRuntime } from '../desktop-runtime';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCommand,
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import type { DispatchChatCommandOptions } from '../core-chat-command-adapter';
import {
  CoreChatCreateParamsSchema,
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import { listFileTreeRoots } from '../../services/files-service';
import {
  canopyUnavailableError,
  canopyCancelledError,
} from '@canopy/core-runtime';
import {
  CHAT_COMMAND_ROUTES,
  createCoreChatCommandAdapter,
  createChatCommandDispatchOptions,
  dispatchChatCommandForLegacyIpc,
  dispatchTrustedChatCommand,
  getOutOfRootChatPathFallthroughCount,
  getIncompatibleLegacyChatPayloadFallthroughCount,
  getUnsupportedChatHostPathFallthroughCount,
} from '../core-chat-command-adapter';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
}));

const grants: 'core.chat.write'[] = ['core.chat.write'];
const caller = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop' as const,
  grants,
};

function makePort(): {
  port: ChatStateCommandPort;
  command: jest.Mock<Promise<ChatCommandResult>, [ChatCommandRequest]>;
} {
  const command = jest.fn(
    (request: ChatCommandRequest): Promise<ChatCommandResult> =>
      Promise.resolve({
        commandId: request.commandId,
        revision: 7,
        outcome: 'applied' as const,
        entityId: 'tab',
      }),
  );
  const port: ChatStateCommandPort = {
    command,
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    searchTranscript: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
  };
  return { port, command };
}

describe('core chat command router', () => {
  let fixtureRoot: string;
  let repoRoot: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'canopy-chat-router-'));
    repoRoot = join(fixtureRoot, 'repo');
    await mkdir(repoRoot);
  });

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.mocked(listFileTreeRoots).mockResolvedValue({
      roots: [
        {
          repoId: 'root',
          repoName: 'Root',
          absolutePath: repoRoot,
          rootKind: 'git-repo',
        },
      ],
    });
  });

  it('routes each lifecycle family to its named instruction', () => {
    expect(Object.keys(CHAT_COMMAND_ROUTES).sort()).toEqual([
      'chat.activate_tab',
      'chat.archive_tab',
      'chat.cancel_queued_message',
      'chat.close_tab',
      'chat.close_tabs',
      'chat.commit_terminal_initial_prompt',
      'chat.create_file_tab',
      'chat.create_tab',
      'chat.dismiss_attention',
      'chat.edit_queued_message',
      'chat.force_queued_message',
      'chat.fork_tab',
      'chat.mark_all_archives_read',
      'chat.mark_archive_read',
      'chat.mark_read',
      'chat.mark_unread',
      'chat.move_queued_message',
      'chat.patch_tab_settings',
      'chat.reject_plan_implementation_delivery',
      'chat.reorder_tabs',
      'chat.restore_archive',
      'chat.send_message',
      'chat.set_approval_mode',
      'chat.set_model',
      'chat.set_queued_message_edit_lock',
      'chat.steer_queued_message',
    ]);
    expect(
      CHAT_COMMAND_ROUTES['chat.set_queued_message_edit_lock']?.instruction,
    ).toBe('core.chat.queue.entry.update');
    expect(CHAT_COMMAND_ROUTES['chat.set_approval_mode']?.instruction).toBe(
      'core.chat.update',
    );
    expect(CHAT_COMMAND_ROUTES['chat.create_tab']?.instruction).toBe(
      'core.chat.create',
    );
    expect(CHAT_COMMAND_ROUTES['chat.patch_tab_settings']?.instruction).toBe(
      'core.chat.update',
    );
    expect(CHAT_COMMAND_ROUTES['chat.archive_tab']?.instruction).toBe(
      'core.chat.archive',
    );
    expect(CHAT_COMMAND_ROUTES['chat.close_tabs']?.instruction).toBe(
      'core.chat.delete',
    );
    expect(CHAT_COMMAND_ROUTES['chat.fork_tab']?.instruction).toBe(
      'core.chat.fork',
    );
  });

  it('accepts additive JSON receipt fields', () => {
    expect(
      CoreChatLifecycleResultSchema.parse({
        commandId: 'command',
        revision: 1,
        outcome: 'applied',
        futureField: { value: true },
      }),
    ).toHaveProperty('futureField', { value: true });
  });

  it.each<{
    command: ChatCommand;
    instructionName:
      | 'core.chat.archive'
      | 'core.chat.delete'
      | 'core.chat.fork';
  }>([
    {
      command: { type: 'chat.archive_tab', tabId: 'tab' },
      instructionName: 'core.chat.archive',
    },
    {
      command: { type: 'chat.restore_archive', archiveEntryId: 'archive' },
      instructionName: 'core.chat.archive',
    },
    {
      command: { type: 'chat.close_tab', tabId: 'tab', mode: 'archive' },
      instructionName: 'core.chat.delete',
    },
    {
      command: {
        type: 'chat.close_tabs',
        targets: [{ tabId: 'tab', mode: 'discard_empty' }],
        replacementTabId: 'starter',
      },
      instructionName: 'core.chat.delete',
    },
    {
      command: {
        type: 'chat.fork_tab',
        sourceTabId: 'tab',
        targetTabId: 'fork',
        atMessageId: 'message',
      },
      instructionName: 'core.chat.fork',
    },
  ])(
    'routes $command.type through $instructionName with its receipt',
    async ({ command: action, instructionName }) => {
      const { port, command } = makePort();
      const adapter = createCoreChatCommandAdapter(() => port);
      const request: ChatCommandRequest = {
        schemaVersion: 1,
        commandId: 'lifecycle',
        projectId: 'project',
        worktreeId: 'worktree',
        expectedRevision: 2,
        command: action,
      };
      const result = await dispatchTrustedChatCommand(request, {
        port,
        caller,
        instruction: async (name, params) => {
          expect(name).toBe(instructionName);
          return adapter.instructions[instructionName](params);
        },
      });
      expect(command).toHaveBeenCalledWith(request);
      expect(result).toMatchObject({
        commandId: request.commandId,
        revision: 7,
        outcome: 'applied',
      });
    },
  );

  it('preserves the command envelope, CAS fields, and result', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'command',
      projectId: 'project',
      worktreeId: 'worktree',
      expectedRevision: 6,
      expectedTabRevision: 5,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: { unread: false },
      },
    };
    const result = await dispatchTrustedChatCommand(request, {
      port,
      caller,
      instruction: async (name, params) => {
        expect(name).toBe('core.chat.update');
        expect(
          CoreChatUpdateParamsSchema.parse(params)._meta.idempotencyKey,
        ).toBe(request.commandId);
        return adapter.instructions['core.chat.update'](params);
      },
    });
    expect(command).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      commandId: 'command',
      revision: 7,
      outcome: 'applied',
      entityId: 'tab',
    });
  });

  it('preserves trusted creation authorization through canonical dispatcher admission', async () => {
    const { port, command } = makePort();
    setChatStateCommandPort(port);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    const canCommitCreate = jest.fn(() => false);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'paired-create',
      projectId: 'project',
      worktreeId: 'worktree',
      command: { type: 'chat.create_tab', tabId: 'tab' },
    };
    try {
      await dispatchTrustedChatCommand(request, {
        ...createChatCommandDispatchOptions(port, runtime, caller),
        executionOptions: { canCommitCreate },
      });
      expect(command).toHaveBeenCalledWith(request, { canCommitCreate });
    } finally {
      await runtime.shutdown();
      setChatStateCommandPort(null);
    }
  });

  it('routes pending plan delivery rejection through core.chat.update to the canonical command port', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'delivery-rejection',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.reject_plan_implementation_delivery',
        chatId: 'tab',
        userMessageId: 'implementation-1',
      },
    };
    const instruction = jest.fn(async (name: string, params: unknown) => {
      expect(name).toBe('core.chat.update');
      expect(CoreChatUpdateParamsSchema.parse(params).action).toEqual(
        request.command,
      );
      return adapter.instructions['core.chat.update'](params);
    });
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(instruction).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(request);
  });

  it('keeps unrouted chat:command IPC commands on the command port', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const request = {
      schemaVersion: 1,
      commandId: 'command',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.dismiss_question',
        chatId: 'tab',
        questionId: 'question',
      },
    };
    await dispatchChatCommandForLegacyIpc(request, {
      port,
      caller,
      instruction,
    });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
  });

  it('uses a portable file reference for a contained file tab', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'create-file',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_file_tab',
        tabId: 'file',
        filePath: join(repoRoot, 'src/file.ts'),
        activate: false,
      },
    };
    await dispatchTrustedChatCommand(request, {
      port,
      caller,
      instruction: async (name, params) => {
        expect(name).toBe('core.chat.create');
        const canonical = JSON.stringify(params);
        expect(canonical).not.toContain(repoRoot);
        expect(canonical).toContain('"fileRootId":"root"');
        expect(canonical).toContain('"relativePath":"src/file.ts"');
        expect(canonical).toContain('"activate":false');
        return adapter.instructions['core.chat.create'](params);
      },
    });
    expect(command).toHaveBeenCalledWith(request);
  });

  it('admits a file-tab command before a later activation in the same scope', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    let releaseRoots: (() => void) | undefined;
    jest.mocked(listFileTreeRoots).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRoots = (): void =>
            resolve({
              roots: [
                {
                  repoId: 'root',
                  repoName: 'Root',
                  absolutePath: repoRoot,
                  rootKind: 'git-repo',
                },
              ],
            });
        }),
    );
    const options: DispatchChatCommandOptions = {
      port,
      caller,
      instruction: (name, params): Promise<unknown> => {
        if (name !== 'core.chat.create' && name !== 'core.chat.update') {
          throw new Error(`Unexpected chat instruction: ${name}`);
        }
        return adapter.instructions[name](params);
      },
    };
    const first = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'create',
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.create_file_tab',
          tabId: 'file',
          filePath: join(repoRoot, 'a.ts'),
        },
      },
      options,
    );
    const second = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'activate',
        projectId: 'project',
        worktreeId: 'worktree',
        command: { type: 'chat.activate_tab', tabId: 'file' },
      },
      options,
    );
    releaseRoots?.();
    await Promise.all([first, second]);
    expect(command.mock.calls.map(([request]) => request.command.type)).toEqual(
      ['chat.create_file_tab', 'chat.activate_tab'],
    );
  });

  it('admits a file-tab command before a later message in the same scope', async () => {
    const { port, command } = makePort();
    setChatStateCommandPort(port);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    let releaseRoots: (() => void) | undefined;
    jest.mocked(listFileTreeRoots).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRoots = (): void =>
            resolve({
              roots: [
                {
                  repoId: 'root',
                  repoName: 'Root',
                  absolutePath: repoRoot,
                  rootKind: 'git-repo',
                },
              ],
            });
        }),
    );
    const options = createChatCommandDispatchOptions(port, runtime, caller);
    const first = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'create',
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.create_file_tab',
          tabId: 'file',
          filePath: join(repoRoot, 'a.ts'),
        },
      },
      options,
    );
    const second = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'activate',
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.send_message',
          chatId: 'file',
          userMessageId: 'message',
          text: 'Hello',
        },
      },
      options,
    );
    releaseRoots?.();
    await Promise.all([first, second]);
    expect(command.mock.calls.map(([request]) => request.command.type)).toEqual(
      ['chat.create_file_tab', 'chat.send_message'],
    );
    await runtime.shutdown();
    setChatStateCommandPort(null);
  });

  it('does not hold the scope while an earlier port command is still running', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    let finishSteer: (() => void) | undefined;
    let finishActivate: (() => void) | undefined;
    command
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            finishSteer = (): void =>
              resolve({
                commandId: request.commandId,
                revision: 7,
                outcome: 'applied',
              });
          }),
      )
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            finishActivate = (): void =>
              resolve({
                commandId: request.commandId,
                revision: 8,
                outcome: 'applied',
              });
          }),
      );
    const options: DispatchChatCommandOptions = {
      port,
      caller,
      instruction: (name, params): Promise<unknown> => {
        if (name !== 'core.chat.create' && name !== 'core.chat.update') {
          throw new Error(`Unexpected chat instruction: ${name}`);
        }
        return adapter.instructions[name](params);
      },
    };
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    const steer = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'steer',
        ...scope,
        command: {
          type: 'chat.dismiss_question',
          chatId: 'tab',
          questionId: 'question',
        },
      },
      options,
    );
    const activate = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'activate',
        ...scope,
        command: { type: 'chat.activate_tab', tabId: 'tab' },
      },
      options,
    );
    const legacyMarkReadCommand: ChatCommand = {
      type: 'chat.mark_read',
      chatId: 'tab',
    };
    Reflect.deleteProperty(legacyMarkReadCommand, 'chatId');
    Reflect.set(legacyMarkReadCommand, 'tabId', 'tab');
    const markRead = await dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'read',
        ...scope,
        command: legacyMarkReadCommand,
      },
      options,
    );
    expect(markRead.outcome).toBe('applied');
    expect(command.mock.calls.map(([request]) => request.command.type)).toEqual(
      ['chat.dismiss_question', 'chat.activate_tab', 'chat.mark_read'],
    );
    finishSteer?.();
    finishActivate?.();
    await Promise.all([steer, activate]);
  });

  it('keeps the direct port available while the dispatcher shuts down', async () => {
    const { port, command } = makePort();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'shutdown',
      projectId: 'project',
      worktreeId: 'worktree',
      command: { type: 'chat.activate_tab', tabId: 'tab' },
    };
    const result = await dispatchTrustedChatCommand(request, {
      port,
      caller,
      isShuttingDown: () => true,
      instruction: (): Promise<ChatCommandResult> =>
        Promise.reject(canopyUnavailableError()),
    });
    expect(command).toHaveBeenCalledWith(request);
    expect(result.outcome).toBe('applied');
  });

  it('returns the in-flight port result when shutdown cancels its dispatcher call', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    let finishCommand: (() => void) | undefined;
    command.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finishCommand = (): void =>
            resolve({
              commandId: request.commandId,
              revision: 7,
              outcome: 'applied',
            });
        }),
    );
    let shuttingDown = false;
    const result = dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId: 'in-flight',
        projectId: 'project',
        worktreeId: 'worktree',
        command: { type: 'chat.activate_tab', tabId: 'tab' },
      },
      {
        port,
        caller,
        isShuttingDown: () => shuttingDown,
        instruction: (_name, params): Promise<ChatCommandResult> => {
          const running = adapter.instructions['core.chat.update'](params);
          shuttingDown = true;
          void running.then(() => undefined);
          return Promise.reject(canopyCancelledError());
        },
      },
    );
    await Promise.resolve();
    finishCommand?.();
    expect((await result).outcome).toBe('applied');
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('reconstructs the host path when a canonical call has no legacy capture', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await adapter.instructions['core.chat.create']({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'remote-file',
      _meta: { idempotencyKey: 'remote-file' },
      action: {
        type: 'chat.create_file_tab',
        tabId: 'file',
        fileRef: { fileRootId: 'root', relativePath: 'src/file.ts' },
      },
    });
    expect(command).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'remote-file',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_file_tab',
        tabId: 'file',
        filePath: join(repoRoot, 'src/file.ts'),
      },
    });
  });

  it('reconstructs a portable path in a canonical seeded tab', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await adapter.instructions['core.chat.create']({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'seeded-file',
      _meta: { idempotencyKey: 'seeded-file' },
      action: {
        type: 'chat.create_tab',
        tabId: 'tab',
        seedTab: {
          id: 'tab',
          title: 'File tab',
          messages: [],
          createdAt: '2026-09-30',
        },
        seedFileRef: { fileRootId: 'root', relativePath: 'src/file.ts' },
      },
    });
    expect(command).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'seeded-file',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_tab',
        tabId: 'tab',
        seedTab: {
          id: 'tab',
          title: 'File tab',
          messages: [],
          createdAt: '2026-09-30',
          filePath: join(repoRoot, 'src/file.ts'),
        },
      },
    });
  });

  it('reattaches a portable file target in a replacement tab', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const seedTab = {
      id: 'replacement',
      title: 'File',
      createdAt: '2026-09-30T00:00:00.000Z',
      messages: [],
    };
    await adapter.instructions['core.chat.delete']({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'replace',
      _meta: { idempotencyKey: 'replace' },
      action: {
        type: 'chat.close_tab',
        tabId: 'old',
        mode: 'archive',
        replacementTab: {
          type: 'chat.create_tab',
          tabId: 'replacement',
          seedTab,
          seedFileRef: { fileRootId: 'root', relativePath: 'src/file.ts' },
        },
      },
    });
    expect(command.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.close_tab',
      replacementTab: {
        seedTab: { filePath: join(repoRoot, 'src/file.ts') },
      },
    });
  });

  it('returns keyed retry guidance when chat state is unavailable', async () => {
    const adapter = createCoreChatCommandAdapter(() => null);
    await expect(
      adapter.instructions['core.chat.create']({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'unavailable',
        _meta: { idempotencyKey: 'unavailable' },
        action: { type: 'chat.create_tab', tabId: 'tab' },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  });

  it('reattaches a portable fork destination file target', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await adapter.instructions['core.chat.fork']({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'fork-file',
      _meta: { idempotencyKey: 'fork-file' },
      action: {
        type: 'chat.fork_tab',
        sourceTabId: 'old',
        targetTabId: 'fork',
        destinationCreate: {
          type: 'chat.create_tab',
          tabId: 'fork',
          seedTab: {
            id: 'fork',
            title: 'File',
            createdAt: '2026-09-30T00:00:00.000Z',
            messages: [],
          },
          seedFileRef: { fileRootId: 'root', relativePath: 'src/file.ts' },
        },
      },
    });
    expect(command.mock.calls[0]?.[0].command).toMatchObject({
      type: 'chat.fork_tab',
      destinationTab: { filePath: join(repoRoot, 'src/file.ts') },
    });
  });

  it('rejects a fork destination that does not create the target tab', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await expect(
      adapter.instructions['core.chat.fork']({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'fork-mismatch',
        _meta: { idempotencyKey: 'fork-mismatch' },
        action: {
          type: 'chat.fork_tab',
          sourceTabId: 'old',
          targetTabId: 'fork',
          destinationCreate: {
            type: 'chat.create_tab',
            tabId: 'other',
            seedTab: {
              id: 'other',
              title: 'File',
              createdAt: '2026-09-30T00:00:00.000Z',
              messages: [],
            },
          },
        },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(command).not.toHaveBeenCalled();
  });

  it('rejects a raw host path in a canonical nested seed', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await expect(
      adapter.instructions['core.chat.delete']({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'unsafe-replacement',
        _meta: { idempotencyKey: 'unsafe-replacement' },
        action: {
          type: 'chat.close_tab',
          tabId: 'old',
          mode: 'archive',
          replacementTab: {
            type: 'chat.create_tab',
            tabId: 'replacement',
            seedTab: {
              id: 'replacement',
              title: 'File',
              createdAt: '2026-09-30T00:00:00.000Z',
              messages: [],
              filePath: '/outside/file.ts',
            },
          },
        },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(command).not.toHaveBeenCalled();
  });

  it('retains an out-of-root host path on the direct port', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'create-outside',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_file_tab',
        tabId: 'file',
        filePath: '/outside/file.ts',
      },
    };
    const before = getOutOfRootChatPathFallthroughCount();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
    expect(getOutOfRootChatPathFallthroughCount()).toBe(before + 1);
  });

  it('rejects file references that cross a root through a symlink', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const outside = join(fixtureRoot, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repoRoot, 'linked'));
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'linked-file',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_file_tab',
        tabId: 'file',
        filePath: join(repoRoot, 'linked/file.ts'),
      },
    };
    const instruction = jest.fn();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();

    await symlink(join(outside, 'missing'), join(repoRoot, 'dangling'));
    await dispatchTrustedChatCommand(
      {
        ...request,
        commandId: 'dangling-file',
        command: {
          type: 'chat.create_file_tab',
          tabId: 'file',
          filePath: join(repoRoot, 'dangling/file.ts'),
        },
      },
      { port, caller, instruction },
    );
    expect(instruction).not.toHaveBeenCalled();

    await expect(
      adapter.instructions['core.chat.create']({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'linked-canonical',
        _meta: { idempotencyKey: 'linked-canonical' },
        action: {
          type: 'chat.create_file_tab',
          tabId: 'file',
          fileRef: { fileRootId: 'root', relativePath: 'linked/file.ts' },
        },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it('retains host attachment patches outside the portable file contract', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'attachment',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: { pendingRevertAttachmentPath: '/private/revert.md' },
      },
    };
    const before = getUnsupportedChatHostPathFallthroughCount();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
    expect(getUnsupportedChatHostPathFallthroughCount()).toBe(before + 1);
  });

  it('routes file view mode removal through core.chat.update without a compatibility fallback', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn().mockResolvedValue({
      commandId: 'clear-file-mode',
      revision: 7,
      outcome: 'applied',
    });
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'clear-file-mode',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'file',
        patch: { fileViewMode: null },
      },
    };
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(instruction).toHaveBeenCalledWith(
      'core.chat.update',
      expect.objectContaining({ action: request.command }),
      { caller, metadata: { idempotencyKey: request.commandId } },
    );
    expect(command).not.toHaveBeenCalled();
  });

  it('preserves legacy plugin tombstones and large JSON payloads on the direct port', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const patch = {
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      disabledGlobalPluginSelections: { collectionIds: ['inherited'] },
      pendingPlanExit: { text: 'x'.repeat(40_000) },
    };
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'large-patch',
      projectId: 'project',
      worktreeId: 'worktree',
      command: { type: 'chat.patch_tab_settings', tabId: 'tab', patch },
    };
    const before = getIncompatibleLegacyChatPayloadFallthroughCount();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
    expect(getIncompatibleLegacyChatPayloadFallthroughCount()).toBe(before + 1);
  });

  it('retains a large plan proposal that exceeds the canonical JSON bound', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'large-plan',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: { pendingPlanExit: { text: 'x'.repeat(40_000) } },
      },
    };
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
  });

  it('retains large seeded tabs on the legacy path', async () => {
    const { port, command } = makePort();
    const instruction = jest.fn();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'large-seed',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.create_tab',
        tabId: 'tab',
        seedTab: {
          id: 'tab',
          title: 'x'.repeat(40_000),
          messages: [],
          createdAt: '2026-09-30',
        },
      },
    };
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(command).toHaveBeenCalledWith(request);
    expect(instruction).not.toHaveBeenCalled();
  });

  it('refuses main-only model-selection fields on direct canonical calls', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const update = adapter.instructions['core.chat.update']({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId: 'model-selection',
      _meta: { idempotencyKey: 'model-selection' },
      action: {
        type: 'chat.set_model',
        tabId: 'tab',
        model: 'model',
        providerType: 'claude',
        preserveModelSelectionMode: true,
        autoRoutedMessageId: 'message',
      },
    });
    await expect(update).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    expect(command).not.toHaveBeenCalled();
  });

  it('accepts schema-valid main-only settings fields on direct canonical calls', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const patches = [
      { description: 'Summary' },
      { pendingRevertAttachmentPath: null },
      { newChatStartedWatcherPending: true },
      { newChatStartedWatcherFiredAt: '2026-09-30T12:00:00Z' },
    ];
    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      const params = {
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: `trusted-patch-${index}`,
        _meta: { idempotencyKey: `trusted-patch-${index}` },
        action: { type: 'chat.patch_tab_settings', tabId: 'tab', patch },
      };
      expect(CoreChatUpdateParamsSchema.safeParse(params).success).toBe(true);
      await adapter.instructions['core.chat.update'](params);
      expect(command.mock.calls[index]?.[0].command).toMatchObject({ patch });
    }
  });

  it('routes a trusted approval-mode change through its dedicated core action', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'approval-mode',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.set_approval_mode',
        tabId: 'tab',
        approvalMode: 'full-access',
      },
    };
    const instruction = jest.fn((name: string, params: unknown) => {
      expect(name).toBe('core.chat.update');
      expect(CoreChatUpdateParamsSchema.parse(params).action).toEqual(
        request.command,
      );
      return adapter.instructions['core.chat.update'](params);
    });
    const before = getIncompatibleLegacyChatPayloadFallthroughCount();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(instruction).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(request);
    expect(getIncompatibleLegacyChatPayloadFallthroughCount()).toBe(before);
  });

  it('admits a trusted approval-mode change through the canonical dispatcher', async () => {
    const { port, command } = makePort();
    setChatStateCommandPort(port);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'dispatched-approval-mode',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.set_approval_mode',
        tabId: 'tab',
        approvalMode: 'auto',
      },
    };
    try {
      await expect(
        dispatchTrustedChatCommand(
          request,
          createChatCommandDispatchOptions(port, runtime, caller),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith(request);
      await expect(
        runtime.instruction(
          'core.chat.update',
          CoreChatUpdateParamsSchema.parse({
            projectId: 'project',
            worktreeId: 'worktree',
            commandId: 'relay-approval-mode',
            _meta: { idempotencyKey: 'relay-approval-mode' },
            action: request.command,
          }),
          { caller, metadata: { idempotencyKey: 'relay-approval-mode' } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      setChatStateCommandPort(null);
    }
  });

  it('rejects direct canonical approval-mode changes outside the setter', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const params = (commandId: string, action: unknown): unknown => ({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId,
      _meta: { idempotencyKey: commandId },
      action,
    });
    await expect(
      adapter.instructions['core.chat.update'](
        params('direct-mode', {
          type: 'chat.set_approval_mode',
          tabId: 'tab',
          approvalMode: 'full-access',
        }),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(() =>
      adapter.instructions['core.chat.update'](
        params('patched-mode', {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { approvalMode: 'full-access' },
        }),
      ),
    ).toThrow('approvalMode');
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses an approval-mode change that differs from the trusted capture', async () => {
    const { port, command } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'captured-mode',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.set_approval_mode',
        tabId: 'tab',
        approvalMode: 'ask',
      },
    };
    const instruction = jest.fn((_name: string, params: unknown) =>
      adapter.instructions['core.chat.update']({
        ...CoreChatUpdateParamsSchema.parse(params),
        action: { ...request.command, approvalMode: 'full-access' },
      }),
    );
    await expect(
      dispatchTrustedChatCommand(request, { port, caller, instruction }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(instruction).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('keeps a trusted settings patch carrying approval mode off the core route', async () => {
    const { port, command } = makePort();
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'trusted-patched-mode',
      projectId: 'project',
      worktreeId: 'worktree',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        // A typed caller cannot build this patch; the port refuses it.
        patch: Object.assign({ title: 'Patched' }, { approvalMode: 'auto' }),
      },
    };
    const instruction = jest.fn();
    const before = getIncompatibleLegacyChatPayloadFallthroughCount();
    await dispatchTrustedChatCommand(request, { port, caller, instruction });
    expect(instruction).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith(request);
    expect(getIncompatibleLegacyChatPayloadFallthroughCount()).toBe(before + 1);
  });

  it('returns invalid_argument for a malformed direct canonical seed', async () => {
    const { port } = makePort();
    const adapter = createCoreChatCommandAdapter(() => port);
    await expect(
      adapter.instructions['core.chat.create']({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'invalid-seed',
        _meta: { idempotencyKey: 'invalid-seed' },
        action: { type: 'chat.create_tab', tabId: 'tab', seedTab: true },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(
      CoreChatCreateParamsSchema.safeParse({
        projectId: 'project',
        worktreeId: 'worktree',
        commandId: 'invalid-seed',
        _meta: { idempotencyKey: 'invalid-seed' },
        action: { type: 'chat.create_tab', tabId: 'tab', seedTab: true },
      }).success,
    ).toBe(true);
  });
});
