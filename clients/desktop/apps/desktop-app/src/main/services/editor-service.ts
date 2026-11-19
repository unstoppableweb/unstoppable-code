import {
  getExecutionHarnessForModel,
  getProviderForModel,
  getAgentModelSelectionId,
  isAgentModel,
  resolvePersistedChatExecutionHarness,
  type ChatTabPluginSelections,
  type HostPortalEditorFileMentionOption,
  type InvocableInventoryEnableRef,
  type InvocableInventoryEntry,
  type InvocableInventoryProvider,
  type ListInvocableInventoryResponse,
  type ModelHarness,
  type PersistedChatTab,
  type PluginSelectionTombstones,
  type PortalEditorInvocableOption,
  type PortalEditorListFileMentionsPayload,
  type PortalEditorListInvocablesResult,
  type PortalEditorListSlashCommandsPayload,
  type PortalEditorSlashCommandOption,
  type SlashCommandData,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  appendEnableRef,
  buildSlashInventoryCommands,
  flattenCollectionRefs,
  inventoryRowNeedsResolution,
  resolveDiscoveryProviderType,
  selectDiscoverySlashCommands,
  type CollectionEnabledRefs,
} from '@canopy/desktop-shared/lib/slash-invocable-inventory';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { validateId } from '../lib/validation';
import { getAgentModel } from '../agents/agent-model-store';
import { readCollectionConfig } from '../collections/collection-store';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import {
  listInvocableInventory,
  resolveInvocableSelection,
} from '../plugins/invocable-inventory-service';
import { prepareCodexCompatibilityPlugin } from '../plugins/plugin-service';
import { fitListResult } from '../remote-projection/result-budget';
import { createPortalCaller } from '../remote-projection/portal-caller';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { PortalServiceError } from './portal-service-error';
import { buildFileIndexes } from './files-service';
import { selectPortalFileReference } from '../remote-projection/portal-file-reference-selection';
import type { PortalFileReferenceScope } from '../remote-projection/portal-file-reference-selection';

const MENTION_DEFAULT_LIMIT = 50;
const MENTION_MAX_LIMIT = 200;

/**
 * Who a worktree read is attributed to: a Portal session, or an IPC caller
 * (a controller reaching this computer without Portal, CAN-5985).
 */
export type EditorReadAttribution =
  | { readonly sessionId: string }
  | { readonly caller: CanopyCallerDescriptor };

function editorReadCaller(
  attribution: EditorReadAttribution,
): CanopyCallerDescriptor {
  return 'caller' in attribution
    ? attribution.caller
    : createPortalCaller(attribution, ['core.worktree.read']);
}

/** The worktree row through `core.worktree.get`; null when it can't be read. */
async function readWorktree(
  projectId: string,
  worktreeId: string,
  session: EditorReadAttribution,
): Promise<WorktreeData | null> {
  try {
    const { legacyResult } =
      await getDesktopCanopyRuntime().queryWorktreeGetForLegacyIpc(
        { worktreeId, scope: { workspaceId: projectId } },
        { caller: editorReadCaller(session) },
      );
    return legacyResult;
  } catch {
    return null;
  }
}

/**
 * Returns the slash-command catalog already discovered for the worktree. The
 * desktop discovery system (`discoverWorktreeEnvironment`) persists results
 * to `worktrees.json`; we never re-run discovery here — the portal pulls a
 * cached snapshot. If the worktree hasn't been discovered yet the list is
 * empty.
 */
export async function listEditorSlashCommands(
  payload: PortalEditorListSlashCommandsPayload,
  session: EditorReadAttribution,
): Promise<PortalEditorSlashCommandOption[]> {
  validateId(payload.projectId, 'projectId');
  validateId(payload.worktreeId, 'worktreeId');

  const worktree = await readWorktree(
    payload.projectId,
    payload.worktreeId,
    session,
  );
  if (!worktree?.discovery) {
    return [];
  }

  const providerType = payload.providerType ?? worktree.discovery.providerType;
  if (
    providerType &&
    worktree.discovery.providerType &&
    worktree.discovery.providerType !== providerType
  ) {
    return [];
  }

  return worktree.discovery.slashCommands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    ...(cmd.displayName ? { displayName: cmd.displayName } : {}),
    ...(cmd.insertText ? { insertText: cmd.insertText } : {}),
  }));
}

function fuzzyContains(query: string, target: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t.charCodeAt(ti) === q.charCodeAt(qi)) {
      qi += 1;
    }
  }
  return qi === q.length;
}

/**
 * Returns a flat list of files across the worktree's roots suitable for the
 * `@`-mention typeahead. The list is bounded by `limit` (cap of 200) and
 * pre-filtered by `query` with a simple fuzzy-contains predicate so the
 * payload stays small over the wire.
 */
export async function listEditorFileMentions(
  payload: PortalEditorListFileMentionsPayload,
  referenceScope?: PortalFileReferenceScope,
): Promise<HostPortalEditorFileMentionOption[]> {
  validateId(payload.projectId, 'projectId');
  validateId(payload.worktreeId, 'worktreeId');

  const limit = Math.min(
    payload.limit ?? MENTION_DEFAULT_LIMIT,
    MENTION_MAX_LIMIT,
  );
  if (limit <= 0) {
    return [];
  }

  let response: Awaited<ReturnType<typeof buildFileIndexes>>;
  try {
    response = await buildFileIndexes({
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
  } catch (error) {
    if (error instanceof PortalServiceError) {
      throw error;
    }
    throw new PortalServiceError(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  const query = payload.query?.trim() ?? '';
  if (payload.selector) {
    const repos = response.repos.filter(
      (repo) => repo.repoId === payload.selector?.repoId,
    );
    const repo = repos[0];
    if (repos.length !== 1 || !repo)
      throw new PortalServiceError(
        'invalid_target',
        'The selector root is not in the authorized file catalog.',
      );
    if (!referenceScope)
      throw new PortalServiceError(
        'invalid_target',
        'The selector requires an authorized Portal session.',
      );
    return [
      await selectPortalFileReference({
        scope: referenceScope,
        repo,
        relativePath: payload.selector.relativePath,
        kind: payload.selector.kind,
      }),
    ];
  }
  const results: HostPortalEditorFileMentionOption[] = [];
  for (const repo of response.repos) {
    for (const file of repo.files) {
      if (file.isIgnored) continue;
      if (query && !fuzzyContains(query, file.relativePath)) continue;
      results.push({
        repoId: repo.repoId,
        repoName: repo.repoName,
        relativePath: file.relativePath,
        filename: file.filename,
        absolutePath: file.absolutePath,
        ...(repo.rootKind === 'attachments' ? { isAttachment: true } : {}),
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }
  return results;
}

/**
 * The canonical scope that owns a chat. Standalone chats live in a Work Entry
 * and have no code worktree, so they never read worktree discovery.
 */
export interface InvocableChatScope {
  projectId: string;
  worktreeId: string;
  standalone: boolean;
}

interface ChatInvocableContext {
  provider: ModelHarness;
  /** What the chat runs: inherited defaults and Agent selections included. */
  effective: ChatTabPluginSelections;
  chatTombstones?: PluginSelectionTombstones;
}

/** The harness the desktop composer lists inventory for (`useThinkingHarness`). */
function inventoryProviderForTab(tab: PersistedChatTab): ModelHarness {
  const started =
    Boolean(tab.sdkSessionId) ||
    (tab.transcript?.messageCount ?? tab.messages.length) > 0;
  if (started) return resolvePersistedChatExecutionHarness(tab);
  const provider =
    tab.providerType ??
    (tab.model ? getProviderForModel(tab.model) : undefined);
  return (
    tab.executionHarness ??
    (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
    (provider === 'claude' || provider === undefined ? 'claude' : 'codex')
  );
}

/** The chat's inventory provider; a client-named provider must match it. */
function chatInventoryProvider(
  tab: PersistedChatTab,
  requestedProvider: InvocableInventoryProvider | undefined,
): ModelHarness {
  const provider = inventoryProviderForTab(tab);
  if (requestedProvider !== undefined && requestedProvider !== provider) {
    throw new PortalServiceError(
      'invalid_payload',
      'providerType does not match the chat.',
    );
  }
  return provider;
}

/**
 * The selections a turn of this chat runs, in the turn's order: the Agent
 * runtime merges its Agent's selections into the chat's own picks
 * (`resolveAgentModelRuntime`), then the session adds the inherited defaults
 * the chat has not turned off. `localSelections` replaces the tab's own picks.
 * The canonical tab supplies tombstones and the layering stamp, so the
 * overlay never rereads the chat file.
 */
async function resolveChatInvocableContext(
  scope: InvocableChatScope,
  tab: PersistedChatTab,
  requestedProvider: InvocableInventoryProvider | undefined,
  localSelections: ChatTabPluginSelections | undefined = tab.pluginSelections,
): Promise<ChatInvocableContext> {
  const provider = chatInventoryProvider(tab, requestedProvider);
  const agent = isAgentModel(tab.model)
    ? await getAgentModel(getAgentModelSelectionId(tab.model), scope.projectId)
    : null;
  const overlay = await resolveEffectiveChatPluginContext(
    agent
      ? mergePluginSelections(localSelections, agent.pluginSelections)
      : localSelections,
    {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: tab.id,
    },
    chatSurfaceUsesGlobalPluginDefaults(scope.projectId)
      ? {
          chatTombstones: tab.disabledGlobalPluginSelections ?? {},
          inheritsProjectDefaults: chatInheritsProjectDefaults(tab),
        }
      : false,
  );
  return {
    provider,
    effective: overlay.selections,
    ...(tab.disabledGlobalPluginSelections
      ? { chatTombstones: tab.disabledGlobalPluginSelections }
      : {}),
  };
}

async function listProviderInventory(
  provider: ModelHarness,
): Promise<ListInvocableInventoryResponse> {
  const listed = await listInvocableInventory({ providerType: provider });
  if (!listed.success || !listed.data) {
    throw new PortalServiceError(
      'execution_failed',
      listed.error ?? 'The invocable inventory is unavailable.',
    );
  }
  return listed.data;
}

async function collectionRefsFor(
  collectionIds: readonly string[],
): Promise<CollectionEnabledRefs> {
  const configs = await Promise.all(
    collectionIds.map((id) =>
      readCollectionConfig(id).then(
        (file) => file?.collection ?? null,
        () => null,
      ),
    ),
  );
  return flattenCollectionRefs(configs);
}

/** A local skill source names a host folder; it never crosses the wire. */
function portableCategory(label: string | undefined): string | undefined {
  return label && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(label)
    ? label
    : undefined;
}

function toInvocableOption(
  command: SlashCommandData & { category?: string },
): PortalEditorInvocableOption {
  const entry = command.inventoryEntry;
  const category = portableCategory(command.category);
  const pluginName =
    entry?.enableRef.kind === 'plugin'
      ? entry.enableRef.pluginName.trim()
      : undefined;
  const memberName = pluginName
    ? entry?.sourceName?.trim() ||
      command.name.slice(command.name.indexOf(':') + 1).trim()
    : undefined;
  return {
    name: command.name,
    ...(pluginName ? { pluginName } : {}),
    ...(memberName ? { memberName } : {}),
    ...(command.displayName !== undefined
      ? { displayName: command.displayName }
      : {}),
    ...(command.description !== undefined
      ? { description: command.description }
      : {}),
    ...(command.insertText !== undefined
      ? { insertText: command.insertText }
      : {}),
    ...(category ? { category } : {}),
    section: command.section === 'available' ? 'available' : 'discovered',
    ...(entry ? { entryId: entry.id } : {}),
    ...(inventoryRowNeedsResolution(command)
      ? { requiresResolution: true }
      : {}),
  };
}

/**
 * The rows the desktop composer's `/` menu shows for this chat, in menu
 * order: agent discovery, then enabled inventory rows it did not report, then
 * "Available to enable" rows. Served from the cached inventory; a missing or
 * stale cache is reported, never rebuilt on the request path.
 */
export async function listChatInvocables(input: {
  scope: InvocableChatScope;
  tab: PersistedChatTab;
  providerType?: InvocableInventoryProvider;
  /** Who the worktree read is attributed to. */
  session: EditorReadAttribution;
}): Promise<PortalEditorListInvocablesResult> {
  const { scope, tab } = input;
  const context = await resolveChatInvocableContext(
    scope,
    tab,
    input.providerType,
  );
  const [inventory, collectionRefs, worktree] = await Promise.all([
    listProviderInventory(context.provider),
    collectionRefsFor(context.effective.collectionIds),
    scope.standalone
      ? Promise.resolve(null)
      : readWorktree(scope.projectId, scope.worktreeId, input.session),
  ]);
  const discovered = [
    ...selectDiscoverySlashCommands({
      providerType: resolveDiscoveryProviderType(tab),
      tabDiscovery: tab.discovery,
      worktreeDiscovery: worktree?.discovery,
    }),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const lists = buildSlashInventoryCommands({
    entries: inventory.entries,
    discoveredCommands: discovered,
    selections: context.effective,
    collectionRefs,
    isDiscovering: false,
  });
  const commands = [
    ...lists.discoveredCommands,
    ...lists.promotedInventoryCommands,
    ...lists.availableInventoryCommands,
  ].map(toInvocableOption);
  return fitListResult(commands, (rows, truncated) => ({
    commands: rows,
    stale: inventory.stale,
    rebuilding: inventory.rebuilding,
    ...(inventory.builtAt ? { builtAt: inventory.builtAt } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  }));
}

/**
 * Look up and prepare one inventory row for this chat, as the desktop
 * composer does before inserting it. The row is looked up on the host by id;
 * no client-supplied ref or text is trusted.
 */
export async function prepareChatInvocable(input: {
  tab: PersistedChatTab;
  entryId: string;
  providerType?: InvocableInventoryProvider;
}): Promise<InvocableInventoryEntry> {
  const inventory = await listProviderInventory(
    chatInventoryProvider(input.tab, input.providerType),
  );
  const entry = inventory.entries.find(
    (candidate) => candidate.id === input.entryId,
  );
  if (!entry) {
    throw new PortalServiceError(
      'not_found',
      'The selected item is no longer available.',
    );
  }
  if (entry.requiresCodexCompatPrepare && entry.enableRef.kind === 'plugin') {
    const prepared = await prepareCodexCompatibilityPlugin(
      entry.enableRef.marketplaceId,
      entry.enableRef.pluginName,
    ).catch(() => null);
    if (!prepared?.success) {
      throw new PortalServiceError(
        'execution_failed',
        'Could not enable the selected item.',
      );
    }
  }
  return entry;
}

/**
 * Resolve a prepared row's insert text against the selections this tab's
 * turns run once the row is enabled. Some providers name an item by its place
 * in the selection order, so the text is valid only for these selections.
 * Returns the row's enable ref when the chat does not run its item yet; the
 * caller appends it to the tab's own selections, as resolved here.
 */
export async function resolveChatInvocable(input: {
  scope: InvocableChatScope;
  tab: PersistedChatTab;
  entry: InvocableInventoryEntry;
}): Promise<{
  insertText: string;
  invocationKey: string;
  enableRef?: InvocableInventoryEnableRef;
}> {
  const { scope, tab, entry } = input;
  const context = await resolveChatInvocableContext(scope, tab, entry.provider);
  // Nothing is written when the chat already runs the item, so inherited
  // defaults stay live instead of being pinned.
  const withRow = appendEnableRef(context.effective, entry.enableRef);
  const enables =
    withRow.skillRefs.length !== context.effective.skillRefs.length ||
    withRow.pluginRefs.length !== context.effective.pluginRefs.length;
  const effective = enables
    ? (
        await resolveChatInvocableContext(
          scope,
          tab,
          entry.provider,
          appendEnableRef(
            normalizePluginSelections(tab.pluginSelections),
            entry.enableRef,
          ),
        )
      ).effective
    : context.effective;
  let projectPath: string | undefined;
  try {
    projectPath = resolveWorktreeCwd(
      scope.projectId,
      scope.worktreeId,
      tab.selectedRepoId,
    );
  } catch {
    projectPath = undefined;
  }
  const resolved = await resolveInvocableSelection({
    providerType: context.provider,
    entry,
    selections: effective,
    ...(context.chatTombstones
      ? { chatTombstones: context.chatTombstones }
      : {}),
    ...(projectPath ? { projectPath } : {}),
  });
  if (!resolved.success || !resolved.data) {
    throw new PortalServiceError(
      'not_found',
      resolved.error ?? 'The selected item is no longer available.',
    );
  }
  return {
    insertText: resolved.data.insertText,
    invocationKey: resolved.data.invocationKey,
    ...(enables ? { enableRef: entry.enableRef } : {}),
  };
}
