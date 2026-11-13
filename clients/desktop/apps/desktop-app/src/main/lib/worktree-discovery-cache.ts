import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AgentProviderType,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { isRecord } from './type-guards';

/*
 * Each worktree's provider discovery (slash commands and MCP servers), kept
 * in its own file in the worktree's data directory instead of in its
 * `worktrees.json` row. Every row change rewrote, hashed and journaled the
 * whole list, and discovery was most of its bytes. Archive and delete remove
 * the worktree's data directory, and the file with it. This is derived data:
 * losing it only means the next discovery repopulates it.
 */

/** The discovery file of one worktree, from the trusted path helper. */
export type WorktreeDiscoveryPath = (
  workspaceId: string,
  worktreeId: string,
) => string;

const VERSION = 1;
const loaded = new Map<string, Promise<WorktreeDiscovery | undefined>>();
const writes = new Map<string, Promise<void>>();

const PROVIDERS: readonly AgentProviderType[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
];

function isProvider(value: unknown): value is AgentProviderType {
  return PROVIDERS.some((provider) => provider === value);
}

/** The shape this module writes; entries are kept whole, as written. */
function isDiscovery(value: unknown): value is WorktreeDiscovery {
  return (
    isRecord(value) &&
    typeof value.discoveredAt === 'string' &&
    (value.providerType === undefined || isProvider(value.providerType)) &&
    Array.isArray(value.slashCommands) &&
    value.slashCommands.every(
      (command) =>
        isRecord(command) &&
        typeof command.name === 'string' &&
        typeof command.description === 'string',
    ) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(
      (server) =>
        isRecord(server) &&
        typeof server.name === 'string' &&
        typeof server.status === 'string',
    )
  );
}

function parse(raw: string): WorktreeDiscovery | undefined {
  const file: unknown = JSON.parse(raw);
  return isRecord(file) &&
    file.version === VERSION &&
    isDiscovery(file.discovery)
    ? file.discovery
    : undefined;
}

function load(path: string): Promise<WorktreeDiscovery | undefined> {
  let discovery = loaded.get(path);
  if (!discovery) {
    // Missing or damaged derived data reads as absent; discovery rebuilds it.
    discovery = readFile(path, 'utf8')
      .then(parse)
      .catch((): undefined => undefined);
    loaded.set(path, discovery);
  }
  return discovery;
}

function newer(
  left: WorktreeDiscovery | undefined,
  right: WorktreeDiscovery | undefined,
): WorktreeDiscovery | undefined {
  if (!left || !right) return left ?? right;
  return Date.parse(right.discoveredAt) > Date.parse(left.discoveredAt)
    ? right
    : left;
}

/**
 * `rows` with each one's stored discovery. A row still carrying one in the
 * list (written before this file existed, or by an older build) keeps the
 * newer.
 */
export async function withCachedWorktreeDiscovery<
  Row extends { id: string; discovery?: WorktreeDiscovery },
>(
  workspaceId: string,
  rows: Row[],
  pathOf: WorktreeDiscoveryPath,
): Promise<Row[]> {
  const stored = await Promise.all(
    rows.map((row) => load(pathOf(workspaceId, row.id))),
  );
  return rows.map((row, index) => {
    const discovery = newer(row.discovery, stored[index]);
    return discovery === row.discovery ? row : { ...row, discovery };
  });
}

function warn(action: string, error: unknown): void {
  logMainProcessWarn(`Worktree discovery file ${action} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Writes or removes one worktree's file; serialized per file. */
function storeOne(
  path: string,
  discovery: WorktreeDiscovery | undefined,
): Promise<void> {
  const write = (writes.get(path) ?? Promise.resolve()).then(async () => {
    // Rows read through the overlay carry the stored objects, so an ordinary
    // list write (a watermark, a badge) settles here without serializing.
    if ((await load(path)) === discovery) return;
    if (discovery) {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(
        path,
        JSON.stringify({ version: VERSION, discovery }),
        { encoding: 'utf8' },
      );
    } else {
      await rm(path, { force: true });
    }
    loaded.set(path, Promise.resolve(discovery));
  });
  const settled = write.catch((error: unknown) => warn('write', error));
  writes.set(path, settled);
  return settled;
}

/**
 * Records the discovery of each row of a list just written, as its rows have
 * it: a row without one has none. A row the list no longer holds is left to
 * archive or delete, which remove its data directory. Derived data never
 * fails the list write: a failed write is logged and keeps the previous file.
 */
export async function storeWorktreeDiscovery(
  workspaceId: string,
  rows: readonly { id: string; discovery?: WorktreeDiscovery }[],
  pathOf: WorktreeDiscoveryPath,
): Promise<void> {
  await Promise.all(
    rows.map((row) => storeOne(pathOf(workspaceId, row.id), row.discovery)),
  );
}

/**
 * Forgets what this process read for a removed list. Its files go with the
 * workspace's data directories, which workspace removal deletes.
 */
export async function forgetWorktreeDiscovery(
  workspaceId: string,
  worktreeIds: readonly string[],
  pathOf: WorktreeDiscoveryPath,
): Promise<void> {
  const paths = worktreeIds.map((id) => pathOf(workspaceId, id));
  await Promise.all(paths.map((path) => writes.get(path) ?? Promise.resolve()));
  for (const path of paths) loaded.delete(path);
}
