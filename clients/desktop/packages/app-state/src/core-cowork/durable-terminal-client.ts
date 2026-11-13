import type {
  CommandMap,
  DomainEventMap,
  QueryMap,
  SubscriptionFilter,
  TerminalClient,
  TerminalCommandName,
  TerminalEventName,
  TerminalQueryName,
  Unsubscribe,
} from '@canopy/app-core';
import {
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
  type TerminalSession,
  type WorktreeTerminalLayoutState,
} from '@canopy/protocol/terminal';
import {
  DurablePtyClient,
  type DurablePtyCloseReason,
  type DurableTerminalConnection,
} from './durable-pty-client';

/** As the desktop PTY host keeps for a terminal's first mount. */
const REPLAY_MAX_BYTES = 256 * 1024;
/** As the web runtime holds while a durable shell is still connecting. */
const PENDING_INPUT_MAX_BYTES = 64 * 1024;
const SHELL = '/bin/bash';

export interface DurableTerminalClientOptions {
  /** The current web core connection, read at every call. */
  readonly connection: () => DurableTerminalConnection | undefined;
  /** The cloud chat whose sandbox a work entry's terminals run in. */
  readonly chatIdOf: (worktreeId: string) => string | null;
  /**
   * Live terminals at once. Each holds one relay stream, and the relay's
   * stream cap is shared with chat streams.
   */
  readonly maxTerminals: number;
  readonly randomUUID?: () => string;
  readonly now?: () => number;
}

export interface DurableTerminalClient extends TerminalClient {
  /** Whether this client spawned `terminalId` and still tracks it. */
  owns(terminalId: string): boolean;
  /** Kills every live terminal: the binding ended. */
  dispose(): void;
}

interface Entry {
  readonly session: TerminalSession;
  readonly pty: DurablePtyClient;
  readonly replay: Uint8Array[];
  replayBytes: number;
  /** Bytes of output delivered so far: the last byte's sequence number. */
  seq: number;
  exited: boolean;
  /** Input typed before the shell opened; `DurablePtyClient` drops it until then. */
  pendingInput: Uint8Array<ArrayBuffer> | null;
  /** This terminal's write receipts, as the local terminal service keeps them. */
  readonly writtenKeys: Set<string>;
}

type Listener<K extends TerminalEventName> = {
  readonly handler: (event: DomainEventMap[K]) => void;
  readonly filter?: SubscriptionFilter;
};

/**
 * The shared terminal slice's client for cloud chat work entries (CAN-6175
 * R10): one durable shell per terminal on the web core's `worker.terminal.*`
 * operations, through `DurablePtyClient`. It keeps no history across a
 * restart, so `terminal.restore` and saved scrollback are unavailable; the
 * panel's layout lives in memory for the binding's lifetime.
 */
/** Runs `run` now; a throw becomes the promise's rejection. */
function settle<T>(run: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  });
}

export function createDurableTerminalClient(
  options: DurableTerminalClientOptions,
): DurableTerminalClient {
  const randomUUID = options.randomUUID ?? ((): string => crypto.randomUUID());
  const now = options.now ?? ((): number => Date.now());
  const encoder = new TextEncoder();
  const entries = new Map<string, Entry>();
  const layouts = new Map<string, WorktreeTerminalLayoutState>();
  const listeners: { [K in TerminalEventName]: Set<Listener<K>> } = {
    'terminal.output': new Set(),
    'terminal.exit': new Set(),
    // No command tracking yet: never emitted.
    'terminal.running-changed': new Set(),
  };

  const matches = (
    filter: SubscriptionFilter | undefined,
    session: TerminalSession,
  ): boolean =>
    (filter?.projectId === undefined ||
      filter.projectId === session.projectId) &&
    (filter?.worktreeId === undefined ||
      filter.worktreeId === session.worktreeId);

  const emitExit = (
    entry: Entry,
    exitCode: number | null,
    signal: string | null,
  ): void => {
    if (entry.exited) return;
    entry.exited = true;
    entries.delete(entry.session.id);
    const event: DomainEventMap['terminal.exit'] = {
      projectId: entry.session.projectId,
      worktreeId: entry.session.worktreeId,
      terminalId: entry.session.id,
      exitCode,
      signal,
      occurredAt: new Date(now()).toISOString(),
    };
    for (const listener of listeners['terminal.exit'])
      if (matches(listener.filter, entry.session)) listener.handler(event);
  };

  const live = (terminalId: string): Entry => {
    const entry = entries.get(terminalId);
    if (!entry) throw new Error('Terminal session is no longer available');
    return entry;
  };

  const queries: {
    [K in TerminalQueryName]: (
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
  } = {
    'terminal.list': (args) =>
      Promise.resolve(
        [...entries.values()]
          .filter(
            (entry) =>
              (args.projectId === undefined ||
                entry.session.projectId === args.projectId) &&
              (args.worktreeId === undefined ||
                entry.session.worktreeId === args.worktreeId),
          )
          .map((entry) => entry.session),
      ),
    'terminal.worktreeState.get': (args) => {
      const layout = layouts.get(`${args.projectId}/${args.worktreeId}`) ?? {
        drawerCollapsed: false,
        groups: [],
        activeGroupId: null,
        nextGroupOrdinal: 1,
        groupOrdinals: {},
        terminalCustomNames: {},
        groupCustomNames: {},
      };
      return Promise.resolve({
        ...layout,
        terminals: [],
        liveTerminalIds: [...entries.values()]
          .filter((entry) => entry.session.worktreeId === args.worktreeId)
          .map((entry) => entry.session.id),
      });
    },
  };

  const commands: {
    [K in TerminalCommandName]: (
      args: CommandMap[K]['args'],
    ) => Promise<CommandMap[K]['result']>;
  } = {
    'terminal.spawn': (args) => {
      const chatId = options.chatIdOf(args.worktreeId);
      if (chatId === null)
        return Promise.reject(new Error('Not a cloud chat terminal scope.'));
      if (args.initialCommand !== undefined)
        return Promise.reject(
          new Error('Cloud chat terminals cannot run a startup command yet.'),
        );
      if (entries.size >= options.maxTerminals)
        return Promise.reject(
          new Error(
            `A cloud chat can have at most ${options.maxTerminals} open terminals.`,
          ),
        );
      const session: TerminalSession = {
        id: randomUUID(),
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        shell: SHELL,
        shellBasename: 'bash',
        cwd: '',
        createdAt: now(),
      };
      // Filled before connect, which only starts the create.
      const slot: { entry?: Entry } = {};
      const pty = new DurablePtyClient({
        client: options.connection,
        chatId,
        dimensions: { cols: args.cols, rows: args.rows },
        randomUUID,
        onOpen: (): void => {
          const entry = slot.entry;
          if (!entry?.pendingInput) return;
          entry.pty.write(entry.pendingInput);
          entry.pendingInput = null;
        },
        onData: (bytes): void => {
          const entry = slot.entry;
          if (!entry || entry.exited) return;
          entry.seq += bytes.byteLength;
          entry.replay.push(bytes);
          entry.replayBytes += bytes.byteLength;
          while (
            entry.replayBytes > REPLAY_MAX_BYTES &&
            entry.replay.length > 1
          )
            entry.replayBytes -= entry.replay.shift()?.byteLength ?? 0;
          const event: DomainEventMap['terminal.output'] = {
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            terminalId: session.id,
            data: bytes,
            seq: entry.seq,
          };
          for (const listener of listeners['terminal.output'])
            if (matches(listener.filter, session)) listener.handler(event);
        },
        onClose: (reason: DurablePtyCloseReason): void => {
          const entry = slot.entry;
          if (!entry) return;
          if (reason.kind === 'exit') emitExit(entry, reason.code, null);
          else emitExit(entry, null, TERMINAL_CONNECTION_LOST_SIGNAL);
        },
      });
      const entry: Entry = {
        session,
        pty,
        replay: [],
        replayBytes: 0,
        seq: 0,
        exited: false,
        pendingInput: null,
        writtenKeys: new Set(),
      };
      slot.entry = entry;
      entries.set(session.id, entry);
      pty.connect();
      return Promise.resolve(session);
    },
    'terminal.attach': ({ terminalId }) =>
      settle(() => {
        const entry = live(terminalId);
        const replay = new Uint8Array(entry.replayBytes);
        let offset = 0;
        for (const chunk of entry.replay) {
          replay.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { session: entry.session, replay, seq: entry.seq };
      }),
    'terminal.write': ({ terminalId, data, idempotencyKey }) =>
      settle<CommandMap['terminal.write']['result']>(() => {
        const entry = live(terminalId);
        if (
          idempotencyKey !== undefined &&
          entry.writtenKeys.has(idempotencyKey)
        )
          return 'already_written';
        const bytes = encoder.encode(data);
        if (entry.pty.state === 'open') entry.pty.write(bytes);
        else {
          const previous = entry.pendingInput ?? new Uint8Array();
          if (previous.length + bytes.length > PENDING_INPUT_MAX_BYTES)
            throw new Error('Terminal is still connecting. Try again.');
          const pending = new Uint8Array(previous.length + bytes.length);
          pending.set(previous);
          pending.set(bytes, previous.length);
          entry.pendingInput = pending;
        }
        // Only once the bytes are sent or held, so a refused write can retry.
        if (idempotencyKey !== undefined) entry.writtenKeys.add(idempotencyKey);
        return 'written';
      }),
    'terminal.resize': ({ terminalId, cols, rows }) =>
      settle(() => {
        live(terminalId).pty.resize({ cols, rows });
      }),
    // The user closed it: the exit reaches the panel now, even while the
    // web core is unreachable, and the shell's own exit is not reported again.
    'terminal.kill': ({ terminalId }) => {
      const entry = entries.get(terminalId);
      if (entry) {
        entry.pty.dispose();
        emitExit(entry, null, TERMINAL_USER_CLOSE_SIGNAL);
      }
      return Promise.resolve();
    },
    'terminal.restore': () =>
      Promise.reject(
        new Error('Cloud chat terminals cannot be restored after they end.'),
      ),
    'terminal.worktreeState.save': ({ projectId, worktreeId, ...layout }) => {
      layouts.set(`${projectId}/${worktreeId}`, layout);
      return Promise.resolve();
    },
  };

  return {
    query<K extends TerminalQueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      return queries[name](args);
    },
    command<K extends TerminalCommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      return commands[name](args);
    },
    subscribe<K extends TerminalEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void,
      filter?: SubscriptionFilter,
    ): Unsubscribe {
      const listener: Listener<K> = { handler, filter };
      listeners[name].add(listener);
      return (): void => {
        listeners[name].delete(listener);
      };
    },
    owns: (terminalId) => entries.has(terminalId),
    dispose: () => {
      for (const entry of [...entries.values()]) {
        entry.pty.dispose();
        emitExit(entry, null, TERMINAL_USER_CLOSE_SIGNAL);
      }
    },
  };
}
