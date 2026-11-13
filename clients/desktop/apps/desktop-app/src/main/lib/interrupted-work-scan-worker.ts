import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream, type Dirent } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ParentPort } from 'electron';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from './chat-storage-discovery';

export interface InterruptedWorkScan {
  chatScopes: Array<{ projectId: string; worktreeId: string }>;
  pipelineIds: string[];
  /** Daemon runs with a commit step whose hooks startup catches up on (CAN-6012 D3). */
  daemonCommitHookIds: string[];
  errors: string[];
}
const interruptedStatuses = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function directories(path: string, errors: string[]): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return [];
    errors.push(`Recovery directory ${path}: ${String(error)}`);
    return [];
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
/** Parse histories only in a worker. Return identities, never transcript contents. */
export async function scanInterruptedWork(
  roots: string[],
  executionsDir: string,
): Promise<InterruptedWorkScan> {
  const result: InterruptedWorkScan = {
    chatScopes: [],
    pipelineIds: [],
    daemonCommitHookIds: [],
    errors: [],
  };
  for (const root of roots) {
    for (const workspace of await directories(root, result.errors)) {
      if (!workspace.isDirectory()) continue;
      const dir = join(root, workspace.name);
      const names = new Set<string>();
      let canonicalScopes = new Set<string>();
      try {
        canonicalScopes = new Set(await chatStorageScopeIds(dir));
      } catch (error) {
        result.errors.push(
          `Chat storage discovery ${workspace.name}: ${String(error)}`,
        );
      }
      for (const worktreeId of Array.from(canonicalScopes)) {
        let candidate = false;
        try {
          const index = await readChatStorageDiscoveryIndex(dir, worktreeId);
          candidate =
            Object.values(index.runtimeByChatId).some(
              (runtime) =>
                record(runtime) &&
                (interruptedStatuses.has(String(runtime.status)) ||
                  (Array.isArray(runtime.queuedMessageIds) &&
                    runtime.queuedMessageIds.length > 0) ||
                  // An accepted send left `admitting` (or `dispatching`) has
                  // no queued id and may leave the runtime idle (CAN-4112).
                  (Array.isArray(runtime.queuedMessages) &&
                    runtime.queuedMessages.length > 0)),
            ) ||
            index.tabs.some(
              (tab) =>
                (record(tab.claudeTerminal) &&
                  ['running', 'starting'].includes(
                    String(tab.claudeTerminal.turnState),
                  )) ||
                (record(tab.transcript) &&
                  (tab.transcript.hasOrdinaryActiveRows ??
                    tab.transcript.hasActiveSidecar) === true),
            );
          // Journal records after a delta-journal checkpoint are replayed
          // into the index above, but descriptors of the chats they touched
          // are only projected on load; let the repository replay them.
          if (index.pendingJournal) candidate = true;
          // A pending transaction may contain newer runtime metadata than
          // the published index. Let the repository replay it before admission.
          if (!candidate) {
            try {
              candidate =
                (
                  await stat(
                    join(
                      dir,
                      'chat-storage-v2',
                      worktreeId,
                      'metadata-journal.jsonl',
                    ),
                  )
                ).size > 0;
            } catch (error) {
              if (!(record(error) && error.code === 'ENOENT')) throw error;
            }
          }
        } catch (error) {
          candidate = true;
          result.errors.push(
            `Chat storage ${workspace.name}/${worktreeId}: ${String(error)}`,
          );
        }
        if (candidate)
          result.chatScopes.push({ projectId: workspace.name, worktreeId });
      }
      for (const [folder, suffix] of [
        ['chats', '.json'],
        ['chat-journals', '.jsonl'],
      ]) {
        for (const entry of await directories(
          join(dir, folder),
          result.errors,
        )) {
          if (entry.isFile() && entry.name.endsWith(suffix))
            names.add(entry.name.slice(0, -suffix.length));
        }
      }
      for (const worktreeId of Array.from(names)) {
        if (canonicalScopes.has(worktreeId)) continue;
        try {
          let candidate = false;
          try {
            const snapshot: unknown = JSON.parse(
              await readFile(join(dir, 'chats', `${worktreeId}.json`), 'utf8'),
            );
            if (record(snapshot) && Array.isArray(snapshot.tabs)) {
              candidate = snapshot.tabs.some(
                (tab: unknown) =>
                  record(tab) &&
                  ((record(tab.claudeTerminal) &&
                    ['running', 'starting'].includes(
                      String(tab.claudeTerminal.turnState),
                    )) ||
                    (Array.isArray(tab.messages) &&
                      tab.messages.some(
                        (message: unknown) =>
                          record(message) &&
                          Array.isArray(message.blocks) &&
                          message.blocks.some(
                            (block: unknown) =>
                              record(block) &&
                              block.type === 'turn_timer' &&
                              block.completedAt == null &&
                              (block.pausedAt == null ||
                                block.resumedAt != null),
                          ),
                      ))),
              );
            }
          } catch (error) {
            if (!(record(error) && error.code === 'ENOENT')) {
              candidate = true;
              result.errors.push(
                `Chat snapshot ${workspace.name}/${worktreeId}: ${String(error)}`,
              );
            }
          }
          const statuses = new Map<string, string>();
          try {
            const lines = createInterface({
              input: createReadStream(
                join(dir, 'chat-journals', `${worktreeId}.jsonl`),
              ),
              crlfDelay: Infinity,
            });
            for await (const line of lines) {
              let value: unknown;
              try {
                value = JSON.parse(line);
              } catch {
                continue;
              } // The repository handles a torn final record.
              if (!record(value) || !Array.isArray(value.mutations)) continue;
              for (const mutation of value.mutations as unknown[]) {
                if (!record(mutation)) continue;
                if (
                  mutation.type === 'runtime.patched' &&
                  typeof mutation.chatId === 'string' &&
                  record(mutation.runtime)
                )
                  statuses.set(
                    mutation.chatId,
                    String(mutation.runtime.status),
                  );
                if (
                  mutation.type === 'tab.removed' &&
                  typeof mutation.tabId === 'string'
                )
                  statuses.delete(mutation.tabId);
              }
            }
          } catch (error) {
            if (!(record(error) && error.code === 'ENOENT')) throw error;
          }
          if (
            candidate ||
            Array.from(statuses.values()).some((status) =>
              interruptedStatuses.has(status),
            )
          )
            result.chatScopes.push({ projectId: workspace.name, worktreeId });
        } catch (error) {
          result.errors.push(
            `Chat recovery ${workspace.name}/${worktreeId}: ${String(error)}`,
          );
        }
      }
    }
  }
  for (const entry of await directories(executionsDir, result.errors)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(executionsDir, entry.name), 'utf8');
      const state: unknown = JSON.parse(text);
      const executionId = entry.name.slice(0, -5);
      if (
        record(state) &&
        ['running', 'pending'].includes(String(state.status))
      )
        result.pipelineIds.push(executionId);
      if (
        text.includes('builtin/git-commit-push') &&
        (await exists(
          join(executionsDir, executionId, 'host', 'commit-hooks-pending.json'),
        ))
      )
        result.daemonCommitHookIds.push(executionId);
    } catch (error) {
      result.errors.push(`Pipeline recovery ${entry.name}: ${String(error)}`);
    }
  }
  return result;
}
const parentPort: ParentPort | undefined = process.parentPort;
parentPort?.once(
  'message',
  (event: { data: { roots: string[]; executionsDir: string } }) => {
    void scanInterruptedWork(event.data.roots, event.data.executionsDir).then(
      (result) => parentPort.postMessage({ result }),
      (error: unknown) => parentPort.postMessage({ error: String(error) }),
    );
  },
);
