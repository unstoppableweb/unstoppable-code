import type { DomainEventMap } from '@canopy/app-core';
import {
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
} from '@canopy/protocol/terminal';
import type {
  DurablePtyClientOptions,
  DurablePtyDimensions,
} from '../durable-pty-client';

/**
 * What each fake shell recorded. Like the real client it drops input until
 * it opens; the wire is covered by the web reattach golden.
 */
interface FakePty {
  readonly options: DurablePtyClientOptions;
  readonly writes: string[];
  readonly sizes: DurablePtyDimensions[];
  connected: boolean;
  disposed: boolean;
  state: 'idle' | 'connecting' | 'open' | 'closed';
  open(): void;
}
const ptys: FakePty[] = [];
jest.mock('../durable-pty-client', () => ({
  DurablePtyClient: class {
    readonly connect: () => void;
    readonly write: (bytes: Uint8Array) => void;
    readonly resize: (size: DurablePtyDimensions) => void;
    readonly dispose: () => void;
    private readonly pty: FakePty;
    constructor(options: DurablePtyClientOptions) {
      const pty: FakePty = {
        options,
        writes: [],
        sizes: [],
        connected: false,
        disposed: false,
        state: 'idle',
        open: (): void => {
          pty.state = 'open';
          options.onOpen?.();
        },
      };
      this.pty = pty;
      ptys.push(pty);
      this.connect = (): void => {
        pty.connected = true;
        pty.state = 'connecting';
      };
      this.write = (bytes): void => {
        if (pty.state !== 'open') return;
        pty.writes.push(new TextDecoder().decode(bytes));
      };
      this.resize = (size): void => {
        pty.sizes.push(size);
      };
      this.dispose = (): void => {
        pty.disposed = true;
        pty.state = 'closed';
      };
    }
    get state(): FakePty['state'] {
      return this.pty.state;
    }
  },
}));

import { createDurableTerminalClient } from '../durable-terminal-client';
import { createScopedTerminalClient } from '../scoped-terminal-client';

const CLOUD = 'web-core:chat-1';
const spawnArgs = {
  projectId: 'project-1',
  worktreeId: CLOUD,
  cols: 80,
  rows: 24,
};
const connection = {
  invoker: {
    request: (): Promise<never> => Promise.reject(new Error('unused')),
    openStream: (): Promise<never> => Promise.reject(new Error('unused')),
  },
  signal: new AbortController().signal,
};

function client(
  maxTerminals = 2,
): ReturnType<typeof createDurableTerminalClient> {
  let id = 0;
  return createDurableTerminalClient({
    connection: () => connection,
    chatIdOf: (worktreeId) =>
      worktreeId.startsWith('web-core:') ? worktreeId.slice(9) : null,
    maxTerminals,
    randomUUID: () => `terminal-${(id += 1)}`,
    now: () => 1_000,
  });
}

beforeEach(() => {
  ptys.length = 0;
});

describe('cloud chat durable terminal client (CAN-6175 R10)', () => {
  it("spawns a durable shell in the scope's chat and refuses what it cannot run", async () => {
    const terminals = client(1);
    await expect(
      terminals.command('terminal.spawn', spawnArgs),
    ).resolves.toEqual({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: CLOUD,
      shell: '/bin/bash',
      shellBasename: 'bash',
      cwd: '',
      createdAt: 1_000,
    });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]).toMatchObject({
      connected: true,
      options: { chatId: 'chat-1', dimensions: { cols: 80, rows: 24 } },
    });

    // The cap keeps relay streams for chats.
    await expect(
      terminals.command('terminal.spawn', spawnArgs),
    ).rejects.toThrow('at most 1 open terminals');
    await expect(
      terminals.command('terminal.spawn', {
        ...spawnArgs,
        worktreeId: 'local-wt',
      }),
    ).rejects.toThrow('Not a cloud chat terminal scope.');
    await expect(
      client().command('terminal.spawn', {
        ...spawnArgs,
        initialCommand: 'ls',
      }),
    ).rejects.toThrow('startup command');
    expect(ptys).toHaveLength(1);
  });

  it('delivers output, replays it on attach and forwards input and size', async () => {
    const terminals = client();
    const outputs: DomainEventMap['terminal.output'][] = [];
    terminals.subscribe('terminal.output', (event) => outputs.push(event), {
      worktreeId: CLOUD,
    });
    terminals.subscribe(
      'terminal.output',
      () => {
        throw new Error('another scope saw it');
      },
      { worktreeId: 'other' },
    );
    const session = await terminals.command('terminal.spawn', spawnArgs);
    const pty = ptys[0];
    if (!pty) throw new Error('no shell');
    pty.open();

    pty.options.onData(new TextEncoder().encode('hello '));
    pty.options.onData(new TextEncoder().encode('world'));
    expect(outputs.map((event) => [event.terminalId, event.seq])).toEqual([
      ['terminal-1', 6],
      ['terminal-1', 11],
    ]);
    const attached = await terminals.command('terminal.attach', {
      terminalId: session.id,
    });
    expect(new TextDecoder().decode(attached.replay)).toBe('hello world');
    expect(attached.seq).toBe(11);

    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'ls\\r',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('written');
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'ls\\r',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('already_written');
    await terminals.command('terminal.resize', {
      terminalId: session.id,
      cols: 100,
      rows: 30,
    });
    expect(pty.writes).toEqual(['ls\\r']);
    expect(pty.sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('holds input typed before the shell opens and sends it on open', async () => {
    const terminals = client();
    const session = await terminals.command('terminal.spawn', spawnArgs);
    const pty = ptys[0];
    if (!pty) throw new Error('no shell');

    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'echo hi',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('written');
    await terminals.command('terminal.write', {
      terminalId: session.id,
      data: '!',
    });
    // Past the hold, a write is refused and its key stays free to retry.
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'x'.repeat(64 * 1024),
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow('Terminal is still connecting. Try again.');
    expect(pty.writes).toEqual([]);

    pty.open();
    expect(pty.writes).toEqual(['echo hi!']);
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'y',
        idempotencyKey: 'k2',
      }),
    ).resolves.toBe('written');
    await expect(
      terminals.command('terminal.write', {
        terminalId: session.id,
        data: 'echo hi',
        idempotencyKey: 'k1',
      }),
    ).resolves.toBe('already_written');
    expect(pty.writes).toEqual(['echo hi!', 'y']);
  });

  it('keeps write receipts per terminal', async () => {
    const terminals = client();
    const first = await terminals.command('terminal.spawn', spawnArgs);
    const second = await terminals.command('terminal.spawn', spawnArgs);
    ptys.forEach((pty) => pty.open());
    for (const terminalId of [first.id, second.id])
      await expect(
        terminals.command('terminal.write', {
          terminalId,
          data: 'ls',
          idempotencyKey: 'same',
        }),
      ).resolves.toBe('written');
    expect(ptys.map((pty) => pty.writes)).toEqual([['ls'], ['ls']]);
  });

  it('reports an exit once: the shell ending, a lost connection, or a kill', async () => {
    const terminals = client(3);
    const exits: [string, number | null, string | null][] = [];
    terminals.subscribe('terminal.exit', (event) =>
      exits.push([event.terminalId, event.exitCode, event.signal]),
    );
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.spawn', spawnArgs);
    const [first, second, third] = ptys;
    if (!first || !second || !third) throw new Error('no shells');

    first.options.onClose({ kind: 'exit', code: 0 });
    second.options.onClose({ kind: 'connection-lost', phase: 'open' });
    await terminals.command('terminal.kill', { terminalId: 'terminal-3' });
    third.options.onClose({ kind: 'exit', code: null });

    expect(third.disposed).toBe(true);
    expect(exits).toEqual([
      ['terminal-1', 0, null],
      ['terminal-2', null, TERMINAL_CONNECTION_LOST_SIGNAL],
      ['terminal-3', null, TERMINAL_USER_CLOSE_SIGNAL],
    ]);
    await expect(
      terminals.query('terminal.list', { worktreeId: CLOUD }),
    ).resolves.toEqual([]);
    await expect(
      terminals.command('terminal.write', {
        terminalId: 'terminal-1',
        data: 'x',
      }),
    ).rejects.toThrow('no longer available');
  });

  it('keeps the panel layout in memory and kills every shell on dispose', async () => {
    const terminals = client();
    await terminals.command('terminal.spawn', spawnArgs);
    await terminals.command('terminal.worktreeState.save', {
      projectId: 'project-1',
      worktreeId: CLOUD,
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 2,
      groupOrdinals: {},
      terminalCustomNames: { 'terminal-1': 'build' },
      groupCustomNames: {},
    });
    await expect(
      terminals.query('terminal.worktreeState.get', {
        projectId: 'project-1',
        worktreeId: CLOUD,
      }),
    ).resolves.toMatchObject({
      drawerCollapsed: true,
      terminalCustomNames: { 'terminal-1': 'build' },
      terminals: [],
      liveTerminalIds: ['terminal-1'],
    });
    await expect(
      terminals.command('terminal.restore', {
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('cannot be restored');

    terminals.dispose();
    expect(ptys.every((pty) => pty.disposed)).toBe(true);
    expect(terminals.owns('terminal-1')).toBe(false);
  });
});

describe('scoped terminal client (CAN-6175 R10)', () => {
  it('sends cloud scopes and their terminals to the cloud client, everything else local', async () => {
    // Two durable clients told apart by the chat their shells run in.
    let localId = 0;
    const local = createDurableTerminalClient({
      connection: () => connection,
      chatIdOf: () => 'local-host',
      maxTerminals: 2,
      randomUUID: () => `local-${(localId += 1)}`,
    });
    const cloud = client();
    const scoped = createScopedTerminalClient({
      local,
      cloud,
      isCloudScope: (worktreeId) => worktreeId.startsWith('web-core:'),
    });
    const exits: string[] = [];
    const stop = scoped.subscribe('terminal.exit', (event) =>
      exits.push(event.terminalId),
    );

    await scoped.command('terminal.spawn', spawnArgs);
    await scoped.command('terminal.spawn', {
      ...spawnArgs,
      worktreeId: 'local-wt',
    });
    expect(ptys.map((pty) => pty.options.chatId)).toEqual([
      'chat-1',
      'local-host',
    ]);
    ptys.forEach((pty) => pty.open());

    await scoped.command('terminal.write', {
      terminalId: 'terminal-1',
      data: 'a',
    });
    await scoped.command('terminal.write', {
      terminalId: 'local-1',
      data: 'b',
    });
    expect(ptys.map((pty) => pty.writes)).toEqual([['a'], ['b']]);

    await expect(scoped.query('terminal.list', {})).resolves.toHaveLength(2);
    await expect(
      scoped.query('terminal.list', { worktreeId: 'local-wt' }),
    ).resolves.toMatchObject([{ id: 'local-1' }]);

    await scoped.command('terminal.kill', { terminalId: 'terminal-1' });
    await scoped.command('terminal.kill', {
      terminalId: 'local-1',
      scope: { projectId: 'project-1', worktreeId: 'local-wt' },
    });
    expect(exits).toEqual(['terminal-1', 'local-1']);
    stop();
  });
});
