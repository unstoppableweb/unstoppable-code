import type {
  CommandMap,
  DomainEventMap,
  QueryMap,
  SubscriptionFilter,
  TerminalCommandName,
  TerminalEventName,
  TerminalQueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  LoadWorktreeTerminalStateResponse,
  TerminalOutputEvent,
  TerminalSession,
} from '@canopy/protocol/terminal';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import type { ChannelClient } from './channel-client';
import {
  anyReply,
  arrayReply,
  isTerminalExitEvent,
  isTerminalOutputEvent,
  isTerminalRunningChangedEvent,
  recordReply,
} from './decoders';

export type TerminalQueryHandlers = {
  [K in TerminalQueryName]: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};

export type TerminalCommandHandlers = {
  [K in TerminalCommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

export type TerminalSubscribeHandlers = {
  [K in TerminalEventName]: (
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
};

export interface TerminalSliceOptions {
  /** Timestamp for derived `occurredAt` fields. */
  readonly now: () => string;
  /**
   * Wraps each `terminal.output` delivery, once per subscriber, so a host can
   * measure it (the desktop's renderer diagnostics). Must call `deliver`.
   */
  readonly observeOutput?: (
    event: TerminalOutputEvent,
    deliver: () => void,
  ) => void;
}

interface TerminalScopedPayload {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly terminalId?: string;
}

function matchesTerminalScope(
  payload: TerminalScopedPayload,
  filter?: SubscriptionFilter,
): boolean {
  return (
    (filter?.projectId === undefined ||
      filter.projectId === payload.projectId) &&
    (filter?.worktreeId === undefined ||
      filter.worktreeId === payload.worktreeId) &&
    (filter?.terminalId === undefined ||
      filter.terminalId === payload.terminalId)
  );
}

/** The terminal slice of the adapter: `terminal.*` over the terminal channels. */
export function createTerminalHandlers(
  channels: ChannelClient,
  options: TerminalSliceOptions,
): {
  readonly queries: TerminalQueryHandlers;
  readonly commands: TerminalCommandHandlers;
  readonly subscriptions: TerminalSubscribeHandlers;
} {
  return {
    queries: {
      'terminal.list': async (args): Promise<TerminalSession[]> => {
        const sessions = await channels.invoke(
          C.terminalList,
          arrayReply<TerminalSession[]>(),
        );
        return sessions.filter((session): boolean =>
          matchesTerminalScope(session, args),
        );
      },
      'terminal.worktreeState.get': (args) =>
        channels.invoke(
          C.terminalLoadWorktreeState,
          recordReply<LoadWorktreeTerminalStateResponse>(),
          args,
        ),
    },
    commands: {
      'terminal.spawn': (args) =>
        channels.invoke(
          C.terminalSpawn,
          recordReply<CommandMap['terminal.spawn']['result']>(),
          args,
        ),
      'terminal.attach': (args) =>
        channels.invoke(
          C.terminalAttach,
          anyReply<CommandMap['terminal.attach']['result']>(),
          args,
        ),
      'terminal.write': (args) =>
        channels.invoke(
          C.terminalWrite,
          anyReply<CommandMap['terminal.write']['result']>(),
          args,
        ),
      'terminal.resize': (args) =>
        channels.invoke(
          C.terminalResize,
          anyReply<CommandMap['terminal.resize']['result']>(),
          args,
        ),
      'terminal.kill': (args) =>
        channels.invoke(
          C.terminalKill,
          anyReply<CommandMap['terminal.kill']['result']>(),
          args,
        ),
      'terminal.restore': (args) =>
        channels.invoke(
          C.terminalRestore,
          anyReply<CommandMap['terminal.restore']['result']>(),
          args,
        ),
      'terminal.worktreeState.save': (args) =>
        channels.invoke(
          C.terminalSaveWorktreeState,
          anyReply<CommandMap['terminal.worktreeState.save']['result']>(),
          args,
        ),
    },
    subscriptions: {
      'terminal.output': (handler, filter) =>
        channels.listen(C.terminalOutput, isTerminalOutputEvent, (event) => {
          const deliver = (): void => {
            if (matchesTerminalScope(event, filter)) handler(event);
          };
          if (options.observeOutput) options.observeOutput(event, deliver);
          else deliver();
        }),
      'terminal.exit': (handler, filter) =>
        channels.listen(C.terminalExit, isTerminalExitEvent, (event) => {
          if (!matchesTerminalScope(event, filter)) return;
          handler({ ...event, occurredAt: options.now() });
        }),
      'terminal.running-changed': (handler, filter) =>
        channels.listen(
          C.terminalRunningChanged,
          isTerminalRunningChangedEvent,
          (event) => {
            if (!matchesTerminalScope(event, filter)) return;
            handler({ ...event, occurredAt: options.now() });
          },
        ),
    },
  };
}
