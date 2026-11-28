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
  CanopyErrorPayloadSchema,
  WorkerTerminalAttachItemSchema,
  type CanopyErrorPayload,
  type WorkerTerminalAttachItem,
} from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  TerminalAttachResponse,
  TerminalOutputEvent,
  TerminalWindowApi,
  TerminalWindowRouteResponse,
  TerminalWindowStream,
} from '@canopy/desktop-shared/types';

/**
 * Daemon terminals this window reads on its own connection at once. Main's
 * mirror holds up to 48 of the host's 64 attachments until CAN-8022 2b-5, so
 * the main and Orchestrator windows share the other 16 at 6 each, and hold
 * at most one per terminal (2 with both windows, under the host's 8).
 */
export const MAX_WINDOW_TERMINALS = 6;
/** A dropped stream reattaches after each delay, then returns to the relay. */
const REATTACH_DELAYS_MS = [250, 1_000, 4_000] as const;
/** How long a terminal main kept on the relay waits before asking again. */
const CONNECT_RETRY_MS = 30_000;
/**
 * A window streaming nothing closes its connection after this, so its lease
 * never keeps an idle daemon running; the next grant connects again.
 */
const IDLE_CLOSE_MS = 30_000;

const STREAM_DONE: { readonly done: true } = { done: true };

type Phase = 'relay' | 'attaching' | 'direct' | 'recovering';

interface Route {
  readonly terminalId: string;
  subscribers: number;
  phase: Phase;
  grant: TerminalWindowRouteResponse | null;
  stream: TerminalWindowStream | null;
  /** Bumped whenever the stream or phase is replaced, so stale reads stop. */
  generation: number;
  /** Offset just past the last byte delivered from the stream. */
  offset: number;
  /** Main's relay output, held while the stream, not the relay, is the source. */
  held: (() => void)[];
  /** Writes and resizes, in order. */
  input: Promise<unknown>;
}

interface Listener {
  readonly handler: (event: TerminalOutputEvent) => void;
  readonly filter: SubscriptionFilter | undefined;
}

type Frame =
  | { readonly kind: 'item'; readonly item: WorkerTerminalAttachItem }
  | { readonly kind: 'end'; readonly error: CanopyErrorPayload | null };

export interface WindowTerminalRouterOptions {
  readonly relay: TerminalClient;
  readonly window: TerminalWindowApi;
  /** Counts one direct delivery, as the relay's output diagnostics do. */
  readonly observeOutput?: (
    event: TerminalOutputEvent,
    startedAt: number,
  ) => void;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function frameOf(value: unknown): Frame {
  if (isRecord(value) && value.kind === 'item') {
    const item = WorkerTerminalAttachItemSchema.safeParse(value.item);
    if (item.success) return { kind: 'item', item: item.data };
  }
  const error = isRecord(value)
    ? CanopyErrorPayloadSchema.safeParse(value.error)
    : undefined;
  return { kind: 'end', error: error?.success ? error.data : null };
}

const utf8 = new TextEncoder();

function bytesOf(item: WorkerTerminalAttachItem): Uint8Array {
  return item.encoding === 'utf8'
    ? utf8.encode(item.data)
    : Uint8Array.from(atob(item.data), (char) => char.charCodeAt(0));
}

const matches = (
  event: TerminalOutputEvent,
  filter: SubscriptionFilter | undefined,
): boolean =>
  (filter?.projectId === undefined || filter.projectId === event.projectId) &&
  (filter?.worktreeId === undefined ||
    filter.worktreeId === event.worktreeId) &&
  (filter?.terminalId === undefined || filter.terminalId === event.terminalId);

/**
 * The window's terminal client (CAN-8070, CAN-8022 2b-4): main's IPC relay,
 * with each daemon terminal main grants this window read on the window's own
 * connection, so main stops sending it that terminal's bytes.
 *
 * An attach still answers with main's replay at once. Once main grants the
 * terminal, the router delivers main's replay read after the grant and
 * streams live output from its `seq` (main mirrors the daemon's offsets), so
 * the history and its truncation marker read as before. A stream that ends reattaches from
 * its last byte, asking main to grant again first: a reconnect moves grants
 * to a new window instance. A refusal, or three failed reattaches, hands the
 * terminal back: main relays it again, and its replay fills what the stream
 * missed. Relay output is held meanwhile, so nothing is lost or reordered.
 * A stream ending is never a terminal's loss; main alone decides that.
 *
 * Unkeyed shell input and resizes go direct when the grant allows; a Claude
 * terminal's or a keyed write stays on main's IPC.
 */
export function createWindowTerminalRouter(
  options: WindowTerminalRouterOptions,
): TerminalClient {
  const { relay, window: terminalWindow } = options;
  const now = options.now ?? ((): number => Date.now());
  const schedule =
    options.setTimeout ??
    ((callback: () => void, delayMs: number): void => {
      setTimeout(callback, delayMs);
    });
  const routes = new Map<string, Route>();
  const listeners = new Set<Listener>();
  /** Route and release asks per terminal, in order, across route lifetimes. */
  const asks = new Map<string, Promise<unknown>>();
  /**
   * Per terminal: main refuses an in-process terminal's ask, which must not
   * hold a daemon terminal on the relay.
   */
  const connectAfter = new Map<string, number>();
  /** Upgrades between their connect and their stream, which an idle close would cut. */
  let upgrading = 0;
  let idleCheck = 0;

  const closeWhenIdle = (): void => {
    const check = ++idleCheck;
    schedule(() => {
      if (check !== idleCheck || upgrading > 0 || streaming() > 0) return;
      void terminalWindow.close();
    }, IDLE_CLOSE_MS);
  };

  const ask = <T>(terminalId: string, call: () => Promise<T>): Promise<T> => {
    const next = (asks.get(terminalId) ?? Promise.resolve()).then(call, call);
    // Only orders the next ask; the caller handles `next`'s own failure.
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    asks.set(terminalId, settled);
    void settled.then(() => {
      if (asks.get(terminalId) === settled) asks.delete(terminalId);
    });
    return next;
  };

  const current = (route: Route, generation: number): boolean =>
    routes.get(route.terminalId) === route && route.generation === generation;

  const streaming = (): number =>
    Array.from(routes.values()).filter((route) => route.phase !== 'relay')
      .length;

  /** Connects for a terminal main mirrors in the daemon, or answers false. */
  const connected = async (terminalId: string): Promise<boolean> => {
    const after = connectAfter.get(terminalId);
    if (after !== undefined) {
      if (now() < after) return false;
      connectAfter.delete(terminalId);
    }
    // The preload answers false for every refusal; a rejection is a defect.
    const ok = await terminalWindow
      .connect({ terminalId })
      .catch((error: unknown) => {
        reportClientAppError(error);
        return false;
      });
    if (!ok) {
      for (const [id, until] of connectAfter)
        if (until <= now()) connectAfter.delete(id);
      connectAfter.set(terminalId, now() + CONNECT_RETRY_MS);
    }
    return ok;
  };

  const grant = (
    terminalId: string,
  ): Promise<TerminalWindowRouteResponse | null> =>
    ask(terminalId, () =>
      // Main answers null to keep its relay; a rejection is a defect.
      terminalWindow.route({ terminalId }).catch((error: unknown) => {
        reportClientAppError(error);
        return null;
      }),
    );

  const releaseGrant = (route: Route): Promise<void> => {
    if (!route.grant) return Promise.resolve();
    route.grant = null;
    return ask(route.terminalId, () =>
      terminalWindow.release({ terminalId: route.terminalId }),
    ).catch((error: unknown) => {
      reportClientAppError(error);
    });
  };

  /**
   * Hands back a grant answered after its route was released. Checked in
   * turn: a newer view that holds or awaits its own grant keeps it; one on
   * the relay needs main's relay.
   */
  const releaseLateGrant = (
    terminalId: string,
    granted: TerminalWindowRouteResponse | null,
  ): void => {
    if (!granted) return;
    void ask(terminalId, () =>
      (routes.get(terminalId)?.phase ?? 'relay') === 'relay'
        ? terminalWindow.release({ terminalId })
        : Promise.resolve(),
    ).catch((error: unknown) => {
      reportClientAppError(error);
    });
  };

  const closeStream = (route: Route): void => {
    route.generation += 1;
    void route.stream?.close();
    route.stream = null;
  };

  const flushHeld = (route: Route): void => {
    for (const deliver of route.held.splice(0)) deliver();
  };

  const emit = (event: TerminalOutputEvent): void => {
    const startedAt = performance.now();
    for (const listener of Array.from(listeners))
      if (matches(event, listener.filter)) listener.handler(event);
    options.observeOutput?.(event, startedAt);
  };

  /** Main relays it again; its replay covers what the stream did not deliver. */
  const toRelay = async (route: Route): Promise<void> => {
    closeStream(route);
    route.phase = 'recovering';
    const generation = route.generation;
    await releaseGrant(route);
    let replay: TerminalAttachResponse | null = null;
    try {
      replay = await relay.command('terminal.attach', {
        terminalId: route.terminalId,
      });
    } catch (error) {
      // Main's relay still reports the terminal's end; record why it failed.
      reportClientAppError(error);
    }
    if (!current(route, generation)) return;
    route.phase = 'relay';
    if (streaming() === 0) closeWhenIdle();
    if (replay && replay.seq > route.offset)
      // The pane trims what it already holds by `seq`.
      emit({
        projectId: replay.session.projectId,
        worktreeId: replay.session.worktreeId,
        terminalId: route.terminalId,
        data: replay.replay,
        seq: replay.seq,
      });
    flushHeld(route);
  };

  const deliver = (route: Route, item: WorkerTerminalAttachItem): void => {
    const session = route.grant?.session;
    const bytes = bytesOf(item).subarray(
      Math.max(0, route.offset - item.fromOffset),
    );
    route.offset = Math.max(route.offset, item.toOffset);
    if (!session || bytes.length === 0) return;
    emit({
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      terminalId: route.terminalId,
      data: bytes,
      seq: item.toOffset,
    });
  };

  const read = async (
    route: Route,
    generation: number,
    stream: TerminalWindowStream,
  ): Promise<void> => {
    for (;;) {
      // The shared client ends a stream with an end frame; a rejection is a
      // defect, read as a dropped stream.
      const next = await stream.next().catch((error: unknown) => {
        reportClientAppError(error);
        return STREAM_DONE;
      });
      if (!current(route, generation)) return;
      const frame: Frame = next.done
        ? { kind: 'end', error: null }
        : frameOf(next.value);
      if (frame.kind === 'item') {
        deliver(route, frame.item);
        if (frame.item.exit === null) continue;
        // Exited: main revokes the grant and relays the exit.
        closeStream(route);
        route.grant = null;
        route.phase = 'relay';
        flushHeld(route);
        if (streaming() === 0) closeWhenIdle();
        return;
      }
      route.stream = null;
      void recover(route, frame.error);
      return;
    }
  };

  /** Opens the stream from `fromOffset`, or answers why it could not. */
  const open = async (
    route: Route,
    fromOffset: number,
  ): Promise<CanopyErrorPayload | 'stale' | null> => {
    closeStream(route);
    const generation = route.generation;
    const target = route.grant;
    if (!target) return 'stale';
    const opened = await terminalWindow.attach({
      scope: target.scope,
      terminalId: route.terminalId,
      fromOffset,
    });
    if (!current(route, generation)) {
      if (opened.ok) void opened.stream.close();
      return 'stale';
    }
    if (!opened.ok) return opened.error;
    route.stream = opened.stream;
    route.offset = fromOffset;
    route.phase = 'direct';
    // The stream covers everything after `fromOffset`; main's replay the rest.
    route.held.length = 0;
    void read(route, generation, opened.stream);
    return null;
  };

  /** Refusals no reattach can change: the relay serves the terminal. */
  const final = (error: CanopyErrorPayload | null): boolean =>
    error !== null &&
    error.kind !== 'unavailable' &&
    error.kind !== 'cancelled' &&
    error.kind !== 'permission_denied';

  const recover = async (
    route: Route,
    error: CanopyErrorPayload | null,
  ): Promise<void> => {
    route.phase = 'recovering';
    let generation = route.generation;
    let last = error;
    for (const delayMs of REATTACH_DELAYS_MS) {
      if (final(last)) break;
      await new Promise<void>((resolve) => schedule(resolve, delayMs));
      if (!current(route, generation)) return;
      // A reconnect gave this window a new instance: main grants it again.
      const ok = await connected(route.terminalId);
      if (!current(route, generation)) return;
      const granted = ok ? await grant(route.terminalId) : null;
      if (!current(route, generation)) {
        releaseLateGrant(route.terminalId, granted);
        return;
      }
      if (!granted) break;
      route.grant = granted;
      const refused = await open(route, route.offset);
      if (refused === null || refused === 'stale') return;
      generation = route.generation;
      last = refused;
    }
    if (current(route, generation)) await toRelay(route);
  };

  /**
   * Moves a relayed terminal onto the window's stream once main grants it.
   * Main stops relaying it from the grant, so the replay read after it,
   * delivered first, covers what the relay no longer sends.
   */
  const upgrade = async (route: Route): Promise<void> => {
    upgrading += 1;
    try {
      await moveToStream(route);
    } finally {
      upgrading -= 1;
      if (streaming() === 0) closeWhenIdle();
    }
  };

  const moveToStream = async (route: Route): Promise<void> => {
    if (!(await connected(route.terminalId))) return;
    if (
      routes.get(route.terminalId) !== route ||
      route.phase !== 'relay' ||
      streaming() >= MAX_WINDOW_TERMINALS
    )
      return;
    route.phase = 'attaching';
    const generation = route.generation;
    const granted = await grant(route.terminalId);
    if (!current(route, generation)) {
      releaseLateGrant(route.terminalId, granted);
      return;
    }
    if (!granted) {
      route.phase = 'relay';
      flushHeld(route);
      return;
    }
    route.grant = granted;
    let replay: TerminalAttachResponse;
    try {
      replay = await relay.command('terminal.attach', {
        terminalId: route.terminalId,
      });
    } catch (error) {
      reportClientAppError(error);
      if (current(route, generation)) await toRelay(route);
      return;
    }
    if (!current(route, generation)) return;
    // The pane trims what it already holds by `seq`.
    emit({
      projectId: replay.session.projectId,
      worktreeId: replay.session.worktreeId,
      terminalId: route.terminalId,
      data: replay.replay,
      seq: replay.seq,
    });
    const refused = await open(route, replay.seq);
    if (refused !== null && refused !== 'stale') void recover(route, refused);
  };

  /**
   * Answers from main's replay at once, as before; a terminal main grants
   * this window then moves to the window's stream in the background.
   */
  const attach = async (
    route: Route,
    args: CommandMap['terminal.attach']['args'],
  ): Promise<TerminalAttachResponse> => {
    const response = await relay.command('terminal.attach', args);
    if (route.phase === 'relay') void upgrade(route);
    // Another view of a streamed terminal: resend what main's replay lacks.
    else if (route.phase === 'direct' && response.seq < route.offset) {
      const refused = await open(route, response.seq);
      if (refused !== null && refused !== 'stale') void recover(route, refused);
    } else if (route.phase === 'recovering')
      route.offset = Math.min(route.offset, response.seq);
    return response;
  };

  const acquire = (terminalId: string): Route => {
    const existing = routes.get(terminalId);
    if (existing) {
      existing.subscribers += 1;
      return existing;
    }
    const route: Route = {
      terminalId,
      subscribers: 1,
      phase: 'relay',
      grant: null,
      stream: null,
      generation: 0,
      offset: 0,
      held: [],
      input: Promise.resolve(),
    };
    routes.set(terminalId, route);
    return route;
  };

  const releaseRoute = (route: Route): void => {
    route.subscribers -= 1;
    if (route.subscribers > 0 || routes.get(route.terminalId) !== route) return;
    routes.delete(route.terminalId);
    closeStream(route);
    route.held.length = 0;
    void releaseGrant(route);
    if (streaming() === 0) closeWhenIdle();
  };

  const subscribeOutput = (
    handler: (event: TerminalOutputEvent) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe => {
    const listener: Listener = { handler, filter };
    listeners.add(listener);
    const route =
      filter?.terminalId === undefined ? null : acquire(filter.terminalId);
    const stopRelay = relay.subscribe(
      'terminal.output',
      (event) => {
        const held = routes.get(event.terminalId);
        if (!held || held.phase === 'relay') {
          handler(event);
          return;
        }
        held.held.push(() => handler(event));
        // Main relays a streamed terminal again: its grant is gone.
        if (held.phase === 'direct') void toRelay(held);
      },
      filter,
    );
    let subscribed = true;
    return (): void => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      stopRelay();
      if (route) releaseRoute(route);
    };
  };

  /** Runs `call` after this terminal's earlier input, in order. */
  const queued = <T>(route: Route, call: () => Promise<T>): Promise<T> => {
    const next = route.input.then(call, call);
    // Only orders the next call; the caller handles `next`'s own failure.
    route.input = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const directRights = (
    route: Route | undefined,
    right: 'write' | 'resize',
  ): TerminalWindowRouteResponse | null =>
    route?.phase === 'direct' && route.grant?.rights.includes(right) === true
      ? route.grant
      : null;

  const notApplied = (error: CanopyErrorPayload): boolean =>
    error.kind === 'permission_denied' ||
    (error.kind === 'unavailable' && error.retry.kind === 'same_request');

  const write = (
    args: CommandMap['terminal.write']['args'],
  ): Promise<CommandMap['terminal.write']['result']> => {
    const route = routes.get(args.terminalId);
    if (!route) return relay.command('terminal.write', args);
    return queued(route, async () => {
      const target = directRights(route, 'write');
      if (
        !target ||
        args.idempotencyKey !== undefined ||
        target.session.chatId !== undefined
      )
        return relay.command('terminal.write', args);
      const reply = await terminalWindow.write({
        scope: target.scope,
        terminalId: args.terminalId,
        input: args.data,
        encoding: 'utf8',
      });
      if (reply.ok) return 'written';
      // Never applied (refused, or never sent): main's IPC writes it once, in
      // order. An unknown outcome (`unavailable`, retry `never`) may have
      // been written, so it is never sent again.
      if (notApplied(reply.error)) return relay.command('terminal.write', args);
      throw new Error(reply.error.message);
    });
  };

  const resize = (
    args: CommandMap['terminal.resize']['args'],
  ): Promise<void> => {
    const route = routes.get(args.terminalId);
    if (!route) return relay.command('terminal.resize', args);
    return queued(route, async () => {
      const target = directRights(route, 'resize');
      if (target) {
        const reply = await terminalWindow.resize({
          scope: target.scope,
          terminalId: args.terminalId,
          cols: args.cols,
          rows: args.rows,
        });
        if (reply.ok) return;
      }
      // A size is safe to send again.
      await relay.command('terminal.resize', args);
    });
  };

  const commands: {
    [K in TerminalCommandName]: (
      args: CommandMap[K]['args'],
    ) => Promise<CommandMap[K]['result']>;
  } = {
    'terminal.spawn': (args) => relay.command('terminal.spawn', args),
    'terminal.attach': (args) => {
      const route = routes.get(args.terminalId);
      return route
        ? attach(route, args)
        : relay.command('terminal.attach', args);
    },
    'terminal.write': write,
    'terminal.resize': resize,
    'terminal.kill': (args) => relay.command('terminal.kill', args),
    'terminal.restore': (args) => relay.command('terminal.restore', args),
    'terminal.worktreeState.save': (args) =>
      relay.command('terminal.worktreeState.save', args),
  };

  const subscriptions: {
    [K in TerminalEventName]: (
      handler: (event: DomainEventMap[K]) => void,
      filter?: SubscriptionFilter,
    ) => Unsubscribe;
  } = {
    'terminal.output': subscribeOutput,
    'terminal.exit': (handler, filter) =>
      relay.subscribe('terminal.exit', handler, filter),
    'terminal.running-changed': (handler, filter) =>
      relay.subscribe('terminal.running-changed', handler, filter),
  };

  return {
    query<K extends TerminalQueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      return relay.query(name, args);
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
      return subscriptions[name](handler, filter);
    },
  };
}
