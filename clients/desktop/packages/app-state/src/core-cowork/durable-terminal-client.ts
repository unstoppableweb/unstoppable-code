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
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
  type TerminalSession,
  type WorktreeTerminalLayoutState,
} from '@canopy/protocol/terminal';
import {
  DurablePtyClient,
  type DurablePtyCloseReason,
  type DurablePtyResume,
  type DurableTerminalConnection,
} from './durable-pty-client';

/** As the desktop PTY host keeps for a terminal's first mount. */
const REPLAY_MAX_BYTES = 256 * 1024;
/** As the web runtime holds while a durable shell is still connecting. */
const PENDING_INPUT_MAX_BYTES = 64 * 1024;
const SHELL = '/bin/bash';

/**
 * What links a panel's terminal to its shell across a reload (CAN-6939): the
 * panel binds `sessionId`, which this client mints, while the web core names
 * the shell `shellTerminalId`, known once the shell exists.
 */
export interface DurableTerminalRecord {
  readonly sessionId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  /** The chat whose sandbox runs the shell. */
  readonly chatId: string;
  readonly shellTerminalId: string | null;
  readonly createdAt: number;
}

/** Where a host keeps the records; none means nothing outlives the page. */
export interface DurableTerminalRecordStore {
  list(projectId: string, worktreeId: string): readonly DurableTerminalRecord[];
  put(record: DurableTerminalRecord): void;
  remove(sessionId: string): void;
}

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
  readonly records?: DurableTerminalRecordStore;
  /**
   * The terminal ids the host's panels bind for a work entry, saved or
   * live. Only a bound terminal is brought back: a record no panel binds is
   * a closed tab's, and goes. A bound one that no record brings back shows
   * as ended, with its restart, rather than loading forever.
   */
  readonly boundTerminalIds?: (
    projectId: string,
    worktreeId: string,
  ) => readonly string[];
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

interface Ended {
  readonly session: TerminalSession;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The output it held when it ended, for a pane that attaches later. */
  readonly replay: Uint8Array;
  readonly seq: number;
  /** The same output as lines, which hydration reports. */
  readonly scrollbackLines: readonly string[];
}

/** As the shared terminal store keeps a persisted terminal's history. */
const SCROLLBACK_MAX_LINES = 5000;

function joined(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function scrollbackOf(replay: Uint8Array): string[] {
  return new TextDecoder()
    .decode(replay)
    .split('\n')
    .slice(-SCROLLBACK_MAX_LINES);
}

type Listener<K extends TerminalEventName> = {
  readonly handler: (event: DomainEventMap[K]) => void;
  readonly filter?: SubscriptionFilter;
};

/**
 * The shared terminal slice's client for cloud chat work entries (CAN-6175
 * R10): one durable shell per terminal on the web core's `worker.terminal.*`
 * operations, through `DurablePtyClient`. With a record store, a later page
 * reattaches each of a work entry's own shells from its record (CAN-6939);
 * there is no saved scrollback beyond what the web core replays.
 * `terminal.restore` starts a fresh shell in a terminal that ended without
 * the user closing it. The panel's layout lives in memory for the binding's
 * lifetime.
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
  // Shells that ended without the user closing them: a restart brings a fresh
  // shell up in the same terminal (CAN-6732), so they stay this client's.
  const ended = new Map<string, Ended>();
  // Terminals brought back from records, which hydration reports.
  const reattached = new Set<string>();
  // Shells past the cap at a reload, by terminal: a restart resumes them.
  const held = new Map<string, string>();
  /** Ends a held shell, which has no client of its own to end it. */
  const killHeld = (terminalId: string): void => {
    const shell = held.get(terminalId);
    held.delete(terminalId);
    const worktreeId = ended.get(terminalId)?.session.worktreeId;
    const chatId =
      worktreeId === undefined ? null : options.chatIdOf(worktreeId);
    const connection = options.connection();
    if (shell === undefined || chatId === null || !connection) return;
    void connection.invoker
      .request('worker.terminal.kill', { scope: { chatId }, terminalId: shell })
      .catch((): undefined => undefined);
  };
  const history = (
    replay: Uint8Array,
    seq: number,
  ): Pick<Ended, 'replay' | 'seq' | 'scrollbackLines'> => ({
    replay,
    seq,
    scrollbackLines: scrollbackOf(replay),
  });
  const reattachedScopes = new Set<string>();
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
    if (signal !== TERMINAL_USER_CLOSE_SIGNAL)
      ended.set(entry.session.id, {
        session: entry.session,
        exitCode,
        signal,
        // A shell can end before its pane attaches; its history stays.
        ...history(joined(entry.replay, entry.replayBytes), entry.seq),
      });
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

  /**
   * Starts a durable shell for `session` in the chat. The create is only
   * started here, and a refused one ends the terminal through its close.
   */
  const record = (
    session: TerminalSession,
    chatId: string,
    shellTerminalId: string | null,
  ): void =>
    options.records?.put({
      sessionId: session.id,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      chatId,
      shellTerminalId,
      createdAt: session.createdAt,
    });

  const start = (
    session: TerminalSession,
    chatId: string,
    size: { readonly cols: number; readonly rows: number } | undefined,
    resume?: DurablePtyResume,
  ): TerminalSession => {
    ended.delete(session.id);
    const slot: { entry?: Entry } = {};
    const pty = new DurablePtyClient({
      client: options.connection,
      chatId,
      ...(size === undefined
        ? {}
        : { dimensions: { cols: size.cols, rows: size.rows } }),
      ...(resume === undefined ? {} : { resume }),
      randomUUID,
      onOpen: (): void => {
        const entry = slot.entry;
        if (!entry) return;
        const shell = entry.pty.resume;
        if (shell && !resume) record(session, chatId, shell.terminalId);
        if (!entry.pendingInput) return;
        entry.pty.write(entry.pendingInput);
        entry.pendingInput = null;
      },
      onData: (bytes): void => {
        const entry = slot.entry;
        if (!entry || entry.exited) return;
        entry.seq += bytes.byteLength;
        entry.replay.push(bytes);
        entry.replayBytes += bytes.byteLength;
        while (entry.replayBytes > REPLAY_MAX_BYTES && entry.replay.length > 1)
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
        // The sandbox sleeps, which a sent message wakes: the relay carries
        // no wake of its own (CAN-6690).
        else if (reason.kind === 'sandbox-asleep')
          emitExit(entry, null, TERMINAL_SANDBOX_ASLEEP_SIGNAL);
        else {
          // Its shell is gone for good: nothing is left to reattach to.
          if (reason.gone) options.records?.remove(session.id);
          emitExit(entry, null, TERMINAL_CONNECTION_LOST_SIGNAL);
        }
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
    if (!resume) record(session, chatId, null);
    pty.connect();
    return session;
  };

  /**
   * Brings back a work entry's own terminals from their records, once per
   * client (CAN-6939). Only a record of this project and work entry, in the
   * chat it names now, reattaches, and only to the one shell it names; the
   * web core refuses another chat's terminal, and nothing else running in
   * the sandbox is adopted. Any other record, and a bound terminal with no
   * record at all, ends with its restart.
   */
  const reattach = (projectId: string, worktreeId: string): void => {
    const scopeKey = JSON.stringify([projectId, worktreeId]);
    if (reattachedScopes.has(scopeKey)) return;
    reattachedScopes.add(scopeKey);
    const chatId = options.chatIdOf(worktreeId);
    const tracked = (id: string): boolean => entries.has(id) || ended.has(id);
    const sessionOf = (id: string, createdAt: number): TerminalSession => ({
      id,
      projectId,
      worktreeId,
      shell: SHELL,
      shellBasename: 'bash',
      cwd: '',
      createdAt,
    });
    const end = (session: TerminalSession): void => {
      reattached.add(session.id);
      ended.set(session.id, {
        session,
        exitCode: null,
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
        ...history(new Uint8Array(), 0),
      });
    };
    const bound = options.boundTerminalIds?.(projectId, worktreeId);
    const binds = (id: string): boolean => bound?.includes(id) ?? true;
    for (const saved of options.records?.list(projectId, worktreeId) ?? []) {
      if (
        saved.projectId !== projectId ||
        saved.worktreeId !== worktreeId ||
        tracked(saved.sessionId)
      )
        continue;
      // No panel binds it: its tab was closed.
      if (!binds(saved.sessionId)) {
        options.records?.remove(saved.sessionId);
        continue;
      }
      const session = sessionOf(saved.sessionId, saved.createdAt);
      const ours =
        chatId !== null &&
        saved.chatId === chatId &&
        saved.shellTerminalId !== null;
      if (
        chatId !== null &&
        saved.chatId === chatId &&
        saved.shellTerminalId !== null &&
        entries.size < options.maxTerminals
      ) {
        reattached.add(session.id);
        start(session, chatId, undefined, {
          terminalId: saved.shellTerminalId,
          offset: 0,
        });
        continue;
      }
      // Past the cap: still this work entry's shell, which a restart resumes.
      if (ours && saved.shellTerminalId !== null)
        held.set(session.id, saved.shellTerminalId);
      // No shell of this work entry's chat to come back to.
      if (!ours) options.records?.remove(saved.sessionId);
      end(session);
    }
    for (const id of bound ?? []) if (!tracked(id)) end(sessionOf(id, now()));
  };

  const queries: {
    [K in TerminalQueryName]: (
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
  } = {
    'terminal.list': (args) => {
      if (args.projectId !== undefined && args.worktreeId !== undefined)
        reattach(args.projectId, args.worktreeId);
      return Promise.resolve(
        [...entries.values()]
          .filter(
            (entry) =>
              (args.projectId === undefined ||
                entry.session.projectId === args.projectId) &&
              (args.worktreeId === undefined ||
                entry.session.worktreeId === args.worktreeId),
          )
          .map((entry) => entry.session),
      );
    },
    'terminal.worktreeState.get': (args) => {
      reattach(args.projectId, args.worktreeId);
      const inScope = (session: TerminalSession): boolean =>
        session.projectId === args.projectId &&
        session.worktreeId === args.worktreeId;
      // A reattached terminal reaches the panel here, live or ended, so a
      // panel bound to it never waits on a session that never comes.
      const terminals = [...reattached].flatMap((id) => {
        const live = entries.get(id);
        if (live && inScope(live.session))
          return [
            {
              session: live.session,
              scrollbackLines: [],
              exitCode: null,
              signal: null,
            },
          ];
        const gone = ended.get(id);
        return gone && inScope(gone.session)
          ? [
              {
                session: gone.session,
                scrollbackLines: [...gone.scrollbackLines],
                exitCode: gone.exitCode,
                signal: gone.signal,
              },
            ]
          : [];
      });
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
        terminals,
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
      return Promise.resolve(start(session, chatId, args));
    },
    'terminal.attach': ({ terminalId }) =>
      settle(() => {
        const entry = entries.get(terminalId);
        // A shell that ended before its pane attached: its output, read-only.
        const gone = entry ? undefined : ended.get(terminalId);
        if (gone)
          return { session: gone.session, replay: gone.replay, seq: gone.seq };
        const current = live(terminalId);
        return {
          session: current.session,
          replay: joined(current.replay, current.replayBytes),
          seq: current.seq,
        };
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
      // Closed after its shell ended: it is not restarted again.
      killHeld(terminalId);
      ended.delete(terminalId);
      options.records?.remove(terminalId);
      const entry = entries.get(terminalId);
      if (entry) {
        entry.pty.dispose();
        emitExit(entry, null, TERMINAL_USER_CLOSE_SIGNAL);
      }
      return Promise.resolve();
    },
    // A shell that ended without the user closing it, such as one refused
    // while the sandbox slept, restarts as a fresh shell in the same
    // terminal (CAN-6732). Nothing of the old shell is kept.
    'terminal.restore': ({ terminalId, cols, rows }) => {
      const session = ended.get(terminalId)?.session;
      if (session === undefined)
        return Promise.reject(
          new Error('Cloud chat terminals cannot be restored after they end.'),
        );
      const chatId = options.chatIdOf(session.worktreeId);
      if (chatId === null)
        return Promise.reject(new Error('Not a cloud chat terminal scope.'));
      if (entries.size >= options.maxTerminals)
        return Promise.reject(
          new Error(
            `A cloud chat can have at most ${options.maxTerminals} open terminals.`,
          ),
        );
      // A shell left past the cap at a reload is resumed, not replaced.
      const shell = held.get(terminalId);
      held.delete(terminalId);
      return Promise.resolve(
        start(
          { ...session, createdAt: now() },
          chatId,
          { cols, rows },
          shell === undefined ? undefined : { terminalId: shell, offset: 0 },
        ),
      );
    },
    'terminal.worktreeState.save': ({
      projectId,
      worktreeId,
      forgetTerminalIds,
      ...layout
    }) => {
      // terminal.kill drops a closed terminal's history; a layout save never does.
      void forgetTerminalIds;
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
    owns: (terminalId) => entries.has(terminalId) || ended.has(terminalId),
    dispose: () => {
      for (const id of [...held.keys()]) killHeld(id);
      for (const id of [...ended.keys(), ...entries.keys()])
        options.records?.remove(id);
      ended.clear();
      for (const entry of [...entries.values()]) {
        entry.pty.dispose();
        emitExit(entry, null, TERMINAL_USER_CLOSE_SIGNAL);
      }
    },
  };
}
