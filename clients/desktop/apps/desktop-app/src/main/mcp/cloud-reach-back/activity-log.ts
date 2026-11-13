import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { isMissingFileError } from '../../lib/fs-utils';
import { logMainProcessWarn } from '../../lib/main-process-logging';

/**
 * Reach-back call log (CAN-6176 PR 7a, Q3): what cloud chats called on this
 * computer, so a person who allowed it can see what reached it.
 *
 * Main-owned and written only here, atomically, to
 * `cloud-reach-back-activity.json` in the data directory. Keyed by the cloud
 * account id, the last {@link ACTIVITY_LIMIT} calls each, dropped when the
 * account signs out. An entry names the chat (its title as it was at the
 * call), the server, the tool and what was decided; never the call's
 * arguments or its result.
 */

export const ACTIVITY_LIMIT = 200;

/** What decided a call, in the order the service checks them. */
export const REACH_BACK_DECISIONS = [
  /** The server or config isn't allowed in cloud chats on this computer. */
  'server_not_allowed',
  /** The tool isn't among those chosen at opt-in. */
  'tool_not_allowed',
  /** The server marks the tool read-only, so it ran without a prompt. */
  'read_only',
  /** Chosen at opt-in to run without a prompt. */
  'allowed_without_asking',
  'asked_allowed',
  'asked_denied',
  /** Nobody answered within 120 seconds. */
  'approval_timeout',
  /** No window could show the prompt. */
  'no_window',
] as const;

export type ReachBackDecision = (typeof REACH_BACK_DECISIONS)[number];

const id = z.string().min(1).max(512);

const entrySchema = z.object({
  at: z.iso.datetime({ offset: true }),
  chat: z.object({ id, title: z.string().max(120) }).nullable(),
  serverId: id,
  configId: id,
  toolName: z.string().min(1).max(256).nullable(),
  decision: z.enum(REACH_BACK_DECISIONS),
  /** The status answered to the cloud; null before an answer. */
  status: z.number().int().min(100).max(599).nullable(),
});

export type ReachBackActivityEntry = z.output<typeof entrySchema>;

const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(id, z.array(z.unknown())),
});

export interface ReachBackActivityLogOptions {
  readonly filePath: () => string;
  /** When given, a call is kept only while its account is signed in. */
  readonly currentAccountId?: () => string | null;
  readonly read?: (path: string) => Promise<string | null>;
  readonly write?: (path: string, data: string) => Promise<void>;
}

export interface ReachBackActivityLog {
  /** Newest first. */
  list(accountId: string): Promise<readonly ReachBackActivityEntry[]>;
  record(accountId: string, entry: ReachBackActivityEntry): Promise<void>;
  forgetAccount(accountId: string): Promise<void>;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

type Accounts = Map<string, readonly ReachBackActivityEntry[]>;

function parse(text: string | null): Accounts {
  const accounts: Accounts = new Map();
  if (text === null) return accounts;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logMainProcessWarn('[cloud-reach-back] The call log is unreadable.');
    return accounts;
  }
  const file = fileSchema.safeParse(json);
  if (!file.success) {
    logMainProcessWarn('[cloud-reach-back] The call log is unreadable.');
    return accounts;
  }
  for (const [accountId, rows] of Object.entries(file.data.accounts)) {
    const entries = rows.flatMap((row) => {
      const entry = entrySchema.safeParse(row);
      return entry.success ? [entry.data] : [];
    });
    if (entries.length > 0)
      accounts.set(accountId, entries.slice(0, ACTIVITY_LIMIT));
  }
  return accounts;
}

/** A title as the log keeps it: one line, at most 120 characters. */
export function logTitle(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

export function createReachBackActivityLog(
  options: ReachBackActivityLogOptions,
): ReachBackActivityLog {
  const read = options.read ?? readText;
  const write =
    options.write ??
    ((path: string, data: string): Promise<void> =>
      writeFileAtomically(path, data, { durable: true, mode: 0o600 }));
  let loaded: Promise<Accounts> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const accounts = (): Promise<Accounts> => {
    loaded ??= read(options.filePath()).then(parse);
    return loaded;
  };

  const mutate = (
    accountId: string,
    change: (
      entries: readonly ReachBackActivityEntry[],
    ) => readonly ReachBackActivityEntry[] | null,
  ): Promise<void> => {
    const run = queue.then(async () => {
      const current = await accounts();
      const next = change(current.get(accountId) ?? []);
      if (next === null) return;
      const updated: Accounts = new Map(current);
      if (next.length === 0) updated.delete(accountId);
      else updated.set(accountId, next);
      await write(
        options.filePath(),
        `${JSON.stringify({ version: 1, accounts: Object.fromEntries(updated) }, null, 2)}\n`,
      );
      loaded = Promise.resolve(updated);
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    async list(accountId) {
      await queue;
      return (await accounts()).get(accountId) ?? [];
    },
    record(accountId, entry) {
      const checked = entrySchema.safeParse({
        ...entry,
        chat:
          entry.chat === null
            ? null
            : { id: entry.chat.id, title: logTitle(entry.chat.title) },
      });
      // An entry the log can't keep fails its promise, never the caller:
      // logging never holds back an answer.
      if (!checked.success) return Promise.reject(checked.error);
      const parsed = checked.data;
      return mutate(accountId, (entries) =>
        // A call that ends after its account signed out isn't kept: sign-out
        // already dropped that account's log, and this would bring it back.
        options.currentAccountId !== undefined &&
        options.currentAccountId() !== accountId
          ? null
          : [parsed, ...entries].slice(0, ACTIVITY_LIMIT),
      );
    },
    forgetAccount(accountId) {
      return mutate(accountId, (entries) => (entries.length > 0 ? [] : null));
    },
  };
}
