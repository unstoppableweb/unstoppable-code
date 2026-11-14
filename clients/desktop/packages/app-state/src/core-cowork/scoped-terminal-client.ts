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
import type { DurableTerminalClient } from './durable-terminal-client';

/**
 * One terminal client for a host whose work entries live in two places
 * (CAN-6175 R10): cloud chat scopes go to `cloud`, every other scope to
 * `local`. Calls that name only a terminal go to whichever client owns it,
 * and events from both reach every subscriber.
 */
export function createScopedTerminalClient(options: {
  readonly local: TerminalClient;
  readonly cloud: DurableTerminalClient;
  readonly isCloudScope: (worktreeId: string) => boolean;
}): TerminalClient {
  const { local, cloud, isCloudScope } = options;
  const byScope = (worktreeId: string): TerminalClient =>
    isCloudScope(worktreeId) ? cloud : local;
  const byTerminal = (terminalId: string): TerminalClient =>
    cloud.owns(terminalId) ? cloud : local;

  const queries: {
    [K in TerminalQueryName]: (
      args: QueryMap[K]['args'],
    ) => Promise<QueryMap[K]['result']>;
  } = {
    'terminal.list': async (args) => {
      if (args.worktreeId !== undefined)
        return byScope(args.worktreeId).query('terminal.list', args);
      const [locals, clouds] = await Promise.all([
        local.query('terminal.list', args),
        cloud.query('terminal.list', args),
      ]);
      return [...locals, ...clouds];
    },
    'terminal.worktreeState.get': (args) =>
      byScope(args.worktreeId).query('terminal.worktreeState.get', args),
  };

  const commands: {
    [K in TerminalCommandName]: (
      args: CommandMap[K]['args'],
    ) => Promise<CommandMap[K]['result']>;
  } = {
    'terminal.spawn': (args) =>
      byScope(args.worktreeId).command('terminal.spawn', args),
    'terminal.attach': (args) =>
      byTerminal(args.terminalId).command('terminal.attach', args),
    'terminal.write': (args) =>
      byTerminal(args.terminalId).command('terminal.write', args),
    'terminal.resize': (args) =>
      byTerminal(args.terminalId).command('terminal.resize', args),
    'terminal.kill': (args) =>
      (args.scope !== undefined && !cloud.owns(args.terminalId)
        ? byScope(args.scope.worktreeId)
        : byTerminal(args.terminalId)
      ).command('terminal.kill', args),
    'terminal.restore': (args) =>
      byTerminal(args.terminalId).command('terminal.restore', args),
    'terminal.worktreeState.save': (args) =>
      byScope(args.worktreeId).command('terminal.worktreeState.save', args),
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
      const stopLocal = local.subscribe(name, handler, filter);
      const stopCloud = cloud.subscribe(name, handler, filter);
      return (): void => {
        stopLocal();
        stopCloud();
      };
    },
  };
}
