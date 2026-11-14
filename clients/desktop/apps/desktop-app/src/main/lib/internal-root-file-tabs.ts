import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootMigrationWorker,
  type InternalRootRepairs,
} from '@canopy/core-runtime/node/internal-root-migration';
import { isWithin } from '@canopy/core-runtime/node/relocation';
import {
  durableMigrationText,
  statIfPresent,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { internalRootMigrationProgress } from '@canopy/desktop-shared/node/internal-root-migration/progress';
import type { InternalRootFilesystemHost } from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import type {
  ChatCoreMutation,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from './chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { isRecord } from './type-guards';
import { isChatJournalRecord } from './chat-state-journal';

function refuse(path: string): never {
  throw new InternalRootMigrationRefused(
    'repair-refused',
    `Unsafe or unreadable file-tab state: ${JSON.stringify(path)}. Preserve both roots and the journal; obtain offline recovery.`,
  );
}

function relocatedPath(
  value: unknown,
  identity: InternalRootIdentity,
): string | undefined {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    !isWithin(identity.source, value)
  )
    return undefined;
  return join(identity.destination, relative(identity.source, value));
}

/** Cold-only: no existence probe of a tab target, and no reads or writes in the predecessor. */
export async function rewriteInternalRootFileTabs(
  identity: InternalRootIdentity,
  workingRoot: string,
  host: InternalRootFilesystemHost,
): Promise<{ canonicalTabs: number; legacyFiles: number }> {
  if (
    isWithin(identity.source, workingRoot) ||
    isWithin(workingRoot, identity.source) ||
    resolve(workingRoot) !== workingRoot ||
    (await realpath(workingRoot)) !== workingRoot
  )
    refuse(workingRoot);
  const result = { canonicalTabs: 0, legacyFiles: 0 };
  async function safe(path: string, tree = false): Promise<boolean> {
    const state = await statIfPresent(path);
    internalRootMigrationProgress('Inspecting file-tab state');
    if (!state) return false;
    if (
      state.isSymbolicLink() ||
      (state.isDirectory() && (await realpath(path)) !== path) ||
      (!state.isDirectory() && (!state.isFile() || state.nlink !== 1))
    )
      refuse(path);
    if (tree && state.isDirectory())
      for (const name of await readdir(path))
        await safe(join(path, name), true);
    return true;
  }
  async function names(path: string): Promise<string[]> {
    if (!(await safe(path))) return [];
    if (!(await lstat(path)).isDirectory()) refuse(path);
    return (await readdir(path)).sort();
  }
  function tab(value: unknown): void {
    if (!isRecord(value) || value.kind !== 'file') return;
    const path = relocatedPath(value.filePath, identity);
    if (path !== undefined) value.filePath = path;
  }
  function mutation(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === 'tab.created') tab(value.tab);
    else if (value.type === 'archive.upserted' && isRecord(value.entry))
      tab(value.entry.tab);
    else if (value.type === 'tab.metadata_patched' && isRecord(value.patch)) {
      const path = relocatedPath(value.patch.filePath, identity);
      if (path !== undefined) value.patch.filePath = path;
    }
  }
  async function legacy(
    path: string,
    journal: boolean,
    singleTab = false,
  ): Promise<void> {
    await safe(path);
    const raw = await readFile(path, 'utf8');
    let changed = false;
    const rewrite = (text: string): string => {
      if (!text.trim()) return text;
      const value: unknown = JSON.parse(text);
      const before = JSON.stringify(value);
      if (journal) {
        if (!isChatJournalRecord(value)) refuse(path);
        for (const entry of value.mutations) mutation(entry);
      } else {
        if (!isRecord(value) || value.version !== 1) refuse(path);
        if (Array.isArray(value.tabs)) {
          for (const entry of value.tabs) tab(entry);
        } else if (Array.isArray(value.archived)) {
          for (const entry of value.archived)
            if (isRecord(entry)) tab(entry.tab);
        } else if (singleTab && isRecord(value.tab)) tab(value.tab);
        else refuse(path);
      }
      const after = JSON.stringify(value);
      if (before === after) return text;
      changed = true;
      return after + text.slice(text.trimEnd().length);
    };
    const contents = journal
      ? raw.split('\n').map(rewrite).join('\n')
      : rewrite(raw);
    if (changed) {
      await durableMigrationText(path, contents, host);
      result.legacyFiles++;
    }
  }
  async function canonical(workspace: string, scopeId: string): Promise<void> {
    const store = new ChatStorageV2(workspace, scopeId);
    await safe(store.manifestPath);
    await safe(store.directory, true);
    const needs = (
      entry: Pick<PersistedChatTab, 'kind' | 'filePath'>,
    ): boolean =>
      entry.kind === 'file' &&
      relocatedPath(entry.filePath, identity) !== undefined;
    // A pending V2 transaction can leave mixed index revisions. Let the backend recover it.
    const pending = await statIfPresent(
      join(store.directory, 'metadata-journal.jsonl'),
    );
    if (!pending?.size) {
      // Clean, repaired scopes stay write-free: even recovery/checkpointing is a write.
      const indexes = await store.indexes();
      if (
        !indexes.live.tabs.some(needs) &&
        !indexes.archive.archived.some((entry) => needs(entry.tab))
      )
        return;
    }
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      format4Promotion: (): boolean => false,
      deltaJournal: {},
    });
    try {
      await backend.transact(
        (state) => {
          const mutations: ChatCoreMutation[] = [];
          for (const entry of state.tabsFile.tabs) {
            const path =
              entry.kind === 'file'
                ? relocatedPath(entry.filePath, identity)
                : undefined;
            if (path !== undefined)
              mutations.push({
                type: 'tab.metadata_patched',
                tabId: entry.id,
                patch: { filePath: path },
              });
          }
          for (const entry of state.archivesFile.archived) {
            const path =
              entry.tab.kind === 'file'
                ? relocatedPath(entry.tab.filePath, identity)
                : undefined;
            if (path !== undefined)
              mutations.push({
                type: 'archive.upserted',
                entry: {
                  ...entry,
                  // An empty reduced view is not a transcript replacement.
                  tab: { ...entry.tab, filePath: path, messages: [] },
                },
              });
          }
          result.canonicalTabs += mutations.length;
          return mutations;
        },
        { source: 'migration', chatIds: [] },
      );
    } finally {
      backend.releaseJournal();
      await backend.disposeArtifactMaintenance();
    }
  }
  async function workspace(root: string): Promise<void> {
    await safe(root);
    for (const name of await names(join(root, 'chat-storage-manifests'))) {
      if (name.endsWith('.json')) await canonical(root, name.slice(0, -5));
    }
    for (const folder of ['chats', 'chat-archives', 'chat-journals']) {
      for (const name of await names(join(root, folder))) {
        const extension = folder === 'chat-journals' ? '.jsonl' : '.json';
        if (
          name !== 'registry.json' &&
          name !== 'registry.json.bak' &&
          (name.endsWith(extension) || name.endsWith(`${extension}.bak`))
        )
          await legacy(join(root, folder, name), folder === 'chat-journals');
      }
    }
  }
  async function history(root: string, folder: string): Promise<void> {
    for (const name of await names(join(root, folder))) {
      const path = join(root, folder, name);
      await safe(path);
      if (!(await lstat(path)).isDirectory()) continue;
      await workspace(path);
      for (const suffix of ['', '.bak']) {
        const target = join(path, `conversation.json${suffix}`);
        if (await safe(target)) await legacy(target, false, true);
      }
    }
  }
  async function workspaceTree(path: string): Promise<void> {
    await workspace(path);
    await history(path, 'chat-history');
    for (const name of await names(path)) {
      if (!name.startsWith('chat-import-')) continue;
      const root = join(path, name);
      await safe(root);
      if (!(await lstat(root)).isDirectory()) continue;
      await workspace(root);
      await history(root, 'chat-history');
    }
    for (const name of await names(join(path, 'split-recovery'))) {
      const root = join(path, 'split-recovery', name);
      await safe(root);
      if ((await lstat(root)).isDirectory()) await workspace(root);
    }
    for (const container of await names(join(path, 'archived-containers'))) {
      const root = join(path, 'archived-containers', container);
      await safe(root);
      if (!(await lstat(root)).isDirectory()) continue;
      await workspace(root);
      for (const file of [
        'chats.json',
        'chat-archives.json',
        'chat-journal.jsonl',
      ])
        for (const suffix of ['', '.bak']) {
          const target = join(root, `${file}${suffix}`);
          if (await safe(target)) await legacy(target, file.endsWith('.jsonl'));
        }
    }
  }
  await workspace(workingRoot);
  for (const folder of ['workspaces', 'app-workspaces']) {
    for (const name of await names(join(workingRoot, folder))) {
      const path = join(workingRoot, folder, name);
      if ((await lstat(path)).isDirectory()) await workspaceTree(path);
    }
  }
  const standalone = join(workingRoot, 'standalone-chat');
  for (const path of [
    join(standalone, 'default'),
    ...(await names(join(standalone, 'projects'))).map((name) =>
      join(standalone, 'projects', name),
    ),
  ]) {
    if (!(await safe(path))) continue;
    if (!(await lstat(path)).isDirectory()) continue;
    await workspace(path);
    for (const suffix of ['', '.bak']) {
      const target = join(path, `chat-tabs.json${suffix}`);
      if (await safe(target)) await legacy(target, false);
    }
    await history(path, 'history');
  }
  for (const folder of ['plan-explore-chats', 'code-review-chats']) {
    const root = join(workingRoot, folder);
    if (!(await safe(root))) continue;
    await workspace(root);
    for (const name of await names(root))
      if (
        (name.endsWith('.json') || name.endsWith('.json.bak')) &&
        name !== 'registry.json' &&
        name !== 'registry.json.bak'
      )
        await legacy(join(root, name), false);
  }
  return result;
}

export function withInternalRootFileTabRepairs(
  repairs: InternalRootRepairs,
  host: InternalRootFilesystemHost,
): InternalRootRepairs {
  return {
    ...repairs,
    repair: async (context) => {
      const result = await repairs.repair(context);
      if (result.kind === 'ok')
        await rewriteInternalRootFileTabs(
          context.identity,
          context.workingRoot,
          host,
        );
      return result;
    },
  };
}

export async function repairCompletedInternalRootFileTabs(options: {
  identity: InternalRootIdentity;
  worker: InternalRootMigrationWorker;
  host: InternalRootFilesystemHost;
}): Promise<{ canonicalTabs: number; legacyFiles: number }> {
  const { identity, worker, host } = options;
  const release = await worker.coordinate(identity);
  try {
    const journal = await worker.readJournal(identity);
    if (
      journal?.phase !== 'complete' ||
      journal.secureRelocation !== 'complete'
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'File-tab repair requires a completed migration, including secure relocation. Preserve both roots and resume the migration first.',
      );
    // Do not use the retained predecessor as live membership for cold proof.
    await worker.proveCold({ ...identity, source: identity.destination });
    await worker.validateSecureResume(journal);
    return await rewriteInternalRootFileTabs(
      journal.identity,
      identity.destination,
      host,
    );
  } finally {
    await release();
  }
}
