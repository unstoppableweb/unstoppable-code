import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { isMissingFileError } from '../../lib/fs-utils';
import { logMainProcessWarn } from '../../lib/main-process-logging';

/**
 * Reach-back allow list (CAN-6176 PR 7a): the MCP servers each account let
 * its cloud chats call on this computer, with the tools chosen at opt-in.
 *
 * Main-owned and written only here, atomically, to `cloud-reach-back.json`
 * in the data directory; never part of MCP config. Keyed by the cloud account
 * id, so another account signed in on this computer serves nothing of it,
 * and an account's servers are dropped when it signs out. Turning a server
 * off removes it here first, so serving stops before the cloud row changes.
 */

const id = z.string().min(1).max(512);

const serverSchema = z.object({
  serverId: id,
  configId: id,
  /** The cloud `DESKTOP` connection created at opt-in. */
  connectionId: id,
  displayName: z.string().min(1).max(200),
  /** The tools cloud chats may list and call; null allows every tool. */
  enabledTools: z.array(z.string().min(1).max(256)).max(500).nullable(),
  /** Tools called without a prompt on this computer (Q3), chosen at opt-in. */
  allowWithoutAsking: z.array(z.string().min(1).max(256)).max(500),
  allowedAt: z.iso.datetime({ offset: true }),
});

export type ReachBackServer = z.output<typeof serverSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(id, z.array(z.unknown())),
});

type Accounts = Map<string, readonly ReachBackServer[]>;

export interface ReachBackAllowListOptions {
  readonly filePath: () => string;
  /** Defaults to the file system; tests inject a fake. */
  readonly read?: (path: string) => Promise<string | null>;
  readonly write?: (path: string, data: string) => Promise<void>;
}

export interface ReachBackAllowList {
  /** The servers `accountId` allowed, in opt-in order. */
  list(accountId: string): Promise<readonly ReachBackServer[]>;
  /** The allowed server a request names, or null: all three ids must match. */
  find(
    accountId: string,
    target: {
      readonly connectionId: string;
      readonly serverId: string;
      readonly configId: string;
    },
  ): Promise<ReachBackServer | null>;
  /** Adds or replaces the server and config. */
  allow(accountId: string, server: ReachBackServer): Promise<void>;
  /** Stops serving the server and config; true when it was allowed. */
  disallow(
    accountId: string,
    serverId: string,
    configId: string,
  ): Promise<boolean>;
  /** Drops every server of an account that signed out. */
  forgetAccount(accountId: string): Promise<void>;
  /** Called after every change, with the account it changed. */
  onChange(listener: (accountId: string) => void): () => void;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/** Unreadable files and invalid rows are dropped: nothing is served from them. */
function parse(text: string | null): Accounts {
  const accounts: Accounts = new Map();
  if (text === null) return accounts;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logMainProcessWarn('[cloud-reach-back] The allow list is unreadable.');
    return accounts;
  }
  const file = fileSchema.safeParse(json);
  if (!file.success) {
    logMainProcessWarn('[cloud-reach-back] The allow list is unreadable.');
    return accounts;
  }
  for (const [accountId, rows] of Object.entries(file.data.accounts)) {
    const servers = rows.flatMap((row) => {
      const server = serverSchema.safeParse(row);
      return server.success ? [server.data] : [];
    });
    if (servers.length > 0) accounts.set(accountId, servers);
  }
  return accounts;
}

export function createReachBackAllowList(
  options: ReachBackAllowListOptions,
): ReachBackAllowList {
  const read = options.read ?? readText;
  const write =
    options.write ??
    ((path: string, data: string): Promise<void> =>
      writeFileAtomically(path, data, { durable: true, mode: 0o600 }));
  const listeners = new Set<(accountId: string) => void>();
  let loaded: Promise<Accounts> | null = null;
  /** Writes run one at a time, each from the state the last one left. */
  let queue: Promise<unknown> = Promise.resolve();

  const accounts = (): Promise<Accounts> => {
    loaded ??= read(options.filePath()).then(parse);
    return loaded;
  };

  const mutate = <T>(
    accountId: string,
    change: (servers: readonly ReachBackServer[]) => {
      readonly servers: readonly ReachBackServer[];
      readonly result: T;
      readonly changed: boolean;
    },
  ): Promise<T> => {
    const run = queue.then(async () => {
      const current = await accounts();
      const next = change(current.get(accountId) ?? []);
      if (!next.changed) return next.result;
      const updated: Accounts = new Map(current);
      if (next.servers.length === 0) updated.delete(accountId);
      else updated.set(accountId, next.servers);
      await write(
        options.filePath(),
        `${JSON.stringify({ version: 1, accounts: Object.fromEntries(updated) }, null, 2)}\n`,
      );
      // Only a written change is served.
      loaded = Promise.resolve(updated);
      for (const listener of listeners) {
        try {
          listener(accountId);
        } catch (error) {
          logMainProcessWarn(
            '[cloud-reach-back] An allow list listener failed.',
            error,
          );
        }
      }
      return next.result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const same = (
    server: ReachBackServer,
    serverId: string,
    configId: string,
  ): boolean => server.serverId === serverId && server.configId === configId;

  return {
    async list(accountId) {
      // After any queued write, so a turned-off server is never listed.
      await queue;
      return (await accounts()).get(accountId) ?? [];
    },
    async find(accountId, target) {
      await queue;
      const servers = (await accounts()).get(accountId) ?? [];
      return (
        servers.find(
          (server) =>
            server.connectionId === target.connectionId &&
            same(server, target.serverId, target.configId),
        ) ?? null
      );
    },
    allow(accountId, server) {
      const parsed = serverSchema.parse(server);
      return mutate(accountId, (servers) => ({
        servers: [
          ...servers.filter(
            (row) => !same(row, parsed.serverId, parsed.configId),
          ),
          parsed,
        ],
        result: undefined,
        changed: true,
      }));
    },
    disallow(accountId, serverId, configId) {
      return mutate(accountId, (servers) => {
        const kept = servers.filter((row) => !same(row, serverId, configId));
        const changed = kept.length !== servers.length;
        return { servers: kept, result: changed, changed };
      });
    },
    forgetAccount(accountId) {
      return mutate(accountId, (servers) => ({
        servers: [],
        result: undefined,
        changed: servers.length > 0,
      }));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Drops an account's allow list and call log once it signs out, or another
 * account replaces it: one account is signed in on this computer at a time.
 */
export function forgetSignedOutAccounts(
  stores: readonly {
    forgetAccount(accountId: string): Promise<void>;
  }[],
  options: {
    readonly currentAccountId: () => string | null;
    readonly onAccountChange: (
      listener: (accountId: string | null) => void,
    ) => () => void;
  },
): () => void {
  let current = options.currentAccountId();
  return options.onAccountChange((accountId) => {
    const previous = current;
    current = accountId;
    if (previous === null || previous === accountId) return;
    for (const store of stores)
      void store
        .forgetAccount(previous)
        .catch((error: unknown) =>
          logMainProcessWarn(
            '[cloud-reach-back] Could not drop a signed-out account.',
            error,
          ),
        );
  });
}
