import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CatalogSelectionGetResultSchema,
  CatalogSnapshotGetResultSchema,
  CoreChatLifecycleResultSchema,
  CoreChatSnapshotGetResultSchema,
  collectionEntryId,
  mcpServerEntryId,
  pluginEntryId,
  skillEntryId,
  type CanopyErrorPayload,
  type CatalogEntry,
} from '@canopy/protocol/canopy-core';
import type {
  ModelCatalog,
  ModelCatalogOption,
  ModelCatalogProvider,
} from '@canopy/protocol/models';
import type {
  PortalChatTabPluginSelections,
  PortalPluginCatalog,
  PortalPluginCatalogMcpServer,
  PortalPluginCatalogPlugin,
  PortalPluginCatalogSkill,
} from '@canopy/protocol/portal';
import { isThinkingLevel } from '@canopy/protocol/thinking';
import { CoreCoworkRequestError, type CoreCoworkInvoker } from './invoker';

/** The cloud chat a catalog reads and writes for (web core ids, unprefixed). */
export interface CloudChatCatalogScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export type CloudChatCatalogStatus = 'loading' | 'ready' | 'error';

export interface CloudChatCatalogState {
  status: CloudChatCatalogStatus;
  models: ModelCatalog;
  plugins: PortalPluginCatalog | null;
  selections: PortalChatTabPluginSelections;
  /** The selection revision of the last read (`core.catalog.selection.get`). */
  selectionRevision: number | null;
  /** A write met a newer selection; the store re-read it. */
  selectionConflict: boolean;
  currentModel: string | undefined;
}

export interface CloudChatCatalog {
  readonly store: StoreApi<CloudChatCatalogState>;
  /** Reads the snapshot and the chat's selection. */
  refresh(): Promise<void>;
  /** `core.chat.update` action `chat.set_model` on the web core. */
  setModel(modelId: string): Promise<void>;
  /**
   * `core.chat.update` action `chat.patch_tab_settings` with the selection.
   * The web core serves chat selections there, not through
   * `core.catalog.selection.update`, and takes no expected revision; a
   * `core.chat.revisionConflict` re-reads and flags the conflict.
   */
  setSelections(next: PortalChatTabPluginSelections): Promise<void>;
}

const MODEL_ENTRY_PREFIX = 'model:';
const MODEL_PROVIDERS: readonly ModelCatalogProvider[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
];
const SET_MODEL_PROVIDERS = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
] as const;

const SKILL_SOURCE_LABELS: Readonly<Record<CatalogEntry['source'], string>> = {
  bundled: 'Built-in',
  user: 'Custom skills',
  workspace: 'Project',
  plugin: 'Plugin',
  remote: 'Curated',
};

const emptySelections = (): PortalChatTabPluginSelections => ({
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
});

const providerOf = (value: string): ModelCatalogProvider =>
  MODEL_PROVIDERS.find((provider) => provider === value) ?? 'unknown';

function modelOption(entry: CatalogEntry): ModelCatalogOption | null {
  const { content } = entry;
  if (content.kind !== 'model' || !entry.entryId.startsWith(MODEL_ENTRY_PREFIX))
    return null;
  const thinking = content.thinkingLevels?.filter(isThinkingLevel);
  return {
    id: entry.entryId.slice(MODEL_ENTRY_PREFIX.length),
    label: entry.name,
    ...(entry.description === '' ? {} : { description: entry.description }),
    provider: providerOf(content.providerId),
    ...(content.harness === undefined ? {} : { harness: content.harness }),
    kind: 'model',
    available: true,
    ...(thinking === undefined || thinking === null
      ? {}
      : { supportedThinkingLevels: thinking }),
    ...(content.contextWindow === null
      ? {}
      : { contextWindow: content.contextWindow }),
    ...(content.fastMode === undefined
      ? {}
      : { supportsFastMode: content.fastMode }),
  };
}

interface MappedCatalog {
  readonly models: ModelCatalog;
  readonly plugins: PortalPluginCatalog;
  /** Selection refs by entry id, from the entries' own `selectionRef`. */
  readonly refs: ReadonlyMap<string, Partial<PortalChatTabPluginSelections>>;
  readonly withoutRef: number;
}

/**
 * The snapshot as the shared pickers read it. Only entries the web core will
 * run are offered: a locked model or an unavailable capability is left out of
 * the lists (the cloud composer has no unlock or sign-in flow), while its ref
 * is kept so saving a selection does not drop it. Entries without a ref are
 * left out entirely.
 */
export function mapCloudChatCatalog(
  entries: readonly CatalogEntry[],
): MappedCatalog {
  const models: ModelCatalogOption[] = [];
  const skills: PortalPluginCatalogSkill[] = [];
  const plugins: PortalPluginCatalogPlugin[] = [];
  const mcpServers: PortalPluginCatalogMcpServer[] = [];
  const refs = new Map<string, Partial<PortalChatTabPluginSelections>>();
  let withoutRef = 0;
  for (const entry of entries) {
    const { content } = entry;
    switch (content.kind) {
      case 'model': {
        const option = modelOption(entry);
        if (option !== null && entry.availability === 'available')
          models.push(option);
        break;
      }
      case 'skill': {
        const ref = content.selectionRef;
        if (ref === undefined) {
          withoutRef += 1;
          break;
        }
        refs.set(skillEntryId(ref), { skillRefs: [ref] });
        if (entry.availability !== 'available') break;
        skills.push({
          sourceId: ref.sourceId,
          skillName: ref.skillName,
          name: entry.name,
          description: entry.description,
          source: SKILL_SOURCE_LABELS[entry.source],
          ...(entry.source === 'bundled' ? { builtIn: true } : {}),
        });
        break;
      }
      case 'plugin': {
        const ref = content.selectionRef;
        if (ref === undefined) {
          withoutRef += 1;
          break;
        }
        refs.set(pluginEntryId(ref), { pluginRefs: [ref] });
        if (entry.availability !== 'available') break;
        const support = content.manifest.providerSupport;
        plugins.push({
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
          name: entry.name,
          description: entry.description,
          marketplaceName: ref.marketplaceId,
          claudeSupported: support?.claude ?? true,
          codexSupported: support?.codex ?? true,
        });
        break;
      }
      case 'mcp_server': {
        const ref = content.selectionRef;
        if (ref === undefined) {
          withoutRef += 1;
          break;
        }
        refs.set(mcpServerEntryId(ref), { mcpServerRefs: [ref] });
        if (entry.availability !== 'available') break;
        mcpServers.push({
          serverId: ref.serverId,
          configId: ref.configId,
          serverName: entry.name,
          configName: entry.name,
          description: entry.description,
          transport: content.transport === 'stdio' ? 'command' : 'http',
          ...(content.connectionState === undefined
            ? {}
            : { connectionState: content.connectionState }),
          ...(content.authIntegrationId === null
            ? {}
            : { connectionId: content.authIntegrationId }),
          ...(content.enabledTools === undefined
            ? {}
            : { enabledTools: content.enabledTools }),
        });
        break;
      }
      default:
        break;
    }
  }
  return {
    models,
    plugins: { collections: [], skills, plugins, mcpServers },
    refs,
    withoutRef,
  };
}

/** The selection the ids name, through the refs the snapshot carried. */
function selectionsOf(
  ids: readonly string[],
  refs: MappedCatalog['refs'],
): PortalChatTabPluginSelections {
  const selections = emptySelections();
  for (const id of ids) {
    const ref = refs.get(id);
    if (ref === undefined) continue;
    selections.skillRefs.push(...(ref.skillRefs ?? []));
    selections.pluginRefs.push(...(ref.pluginRefs ?? []));
    selections.mcpServerRefs?.push(...(ref.mcpServerRefs ?? []));
  }
  return selections;
}

function unwrap(
  reply:
    | { ok: true; value: unknown }
    | { ok: false; error: CanopyErrorPayload },
): unknown {
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return reply.value;
}

const isRevisionConflict = (error: unknown): boolean =>
  error instanceof CoreCoworkRequestError &&
  error.payload.code === 'core.chat.revisionConflict';

/** The catalog of one cloud chat over the web core (CAN-5972). */
export function createCloudChatCatalog(
  invoker: CoreCoworkInvoker,
  scope: CloudChatCatalogScope,
  options: {
    /** Development diagnostics only; never user copy. */
    readonly logDev?: (message: string) => void;
  } = {},
): CloudChatCatalog {
  const store = createStore<CloudChatCatalogState>(() => ({
    status: 'loading',
    models: [],
    plugins: null,
    selections: emptySelections(),
    selectionRevision: null,
    selectionConflict: false,
    currentModel: undefined,
  }));
  let refs: MappedCatalog['refs'] = new Map();
  let reads = 0;
  // Model writes run one at a time, in the order chosen. Only the latest
  // choice may roll the display back, and only to the last saved model.
  let savedModel: string | undefined;
  let modelChoice = 0;
  let modelWrites: Promise<void> = Promise.resolve();
  let pendingModels = 0;
  // Moves when a model write starts or settles, so a read that overlapped one
  // never projects its model.
  let modelEpoch = 0;
  // Capability writes run one at a time; a write a newer choice superseded
  // while it waited is never sent, so the newest choice is the last applied.
  let selectionChoice = 0;
  let selectionWrites: Promise<void> = Promise.resolve();

  const envelope = (): {
    projectId: string;
    worktreeId: string;
    commandId: string;
    _meta: { idempotencyKey: string };
  } => {
    const commandId = globalThis.crypto.randomUUID();
    return {
      projectId: scope.workspaceId,
      worktreeId: scope.worktreeId,
      commandId,
      _meta: { idempotencyKey: commandId },
    };
  };

  async function refresh(conflict = false): Promise<void> {
    const read = ++reads;
    const epochAtRead = modelEpoch;
    try {
      const [snapshot, selection, chat] = await Promise.all([
        invoker.request('core.catalog.snapshot.get', {
          scope: { workspaceId: scope.workspaceId },
          kinds: [],
          includeUnavailable: true,
        }),
        invoker.request('core.catalog.selection.get', {
          scope: { chatId: scope.chatId },
        }),
        invoker.request('core.chat.snapshot.get', {
          scope: {
            workspaceId: scope.workspaceId,
            worktreeId: scope.worktreeId,
          },
          chatId: scope.chatId,
        }),
      ]);
      const entries = CatalogSnapshotGetResultSchema.parse(
        unwrap(snapshot),
      ).entries;
      const selected = CatalogSelectionGetResultSchema.parse(unwrap(selection));
      const tab = CoreChatSnapshotGetResultSchema.parse(
        unwrap(chat),
      ).tabs.items.find((item) => item.chatId === scope.chatId);
      const model = tab?.settings?.model ?? tab?.modelId ?? undefined;
      if (read !== reads) return;
      // A choice made or still saving since the read began wins over it.
      const readModel =
        epochAtRead === modelEpoch && pendingModels === 0 ? model : undefined;
      if (readModel !== undefined) savedModel = readModel;
      const mapped = mapCloudChatCatalog(entries);
      if (mapped.withoutRef > 0)
        options.logDev?.(
          `[cloud-chat-catalog] ${mapped.withoutRef} catalog entries carry no selection ref and are left out of the picker`,
        );
      refs = mapped.refs;
      store.setState({
        status: 'ready',
        models: mapped.models,
        plugins: mapped.plugins,
        selections: selectionsOf(selected.selectedItemIds, mapped.refs),
        selectionRevision: selected.revision,
        selectionConflict: conflict,
        ...(readModel === undefined ? {} : { currentModel: readModel }),
      });
    } catch (error) {
      if (read === reads) store.setState({ status: 'error' });
      throw error;
    }
  }

  return {
    store,
    refresh: () => refresh(),

    setModel: async (modelId) => {
      const option = store
        .getState()
        .models.find((model) => model.id === modelId);
      // The web core derives the provider from the model; the wire still
      // requires one, so send the row's own provider or harness.
      const providerType =
        SET_MODEL_PROVIDERS.find(
          (provider) =>
            provider === option?.provider || provider === option?.harness,
        ) ?? 'claude';
      const choice = ++modelChoice;
      if (savedModel === undefined) savedModel = store.getState().currentModel;
      store.setState({ currentModel: modelId });
      const write = modelWrites.then(async () => {
        CoreChatLifecycleResultSchema.parse(
          unwrap(
            await invoker.request('core.chat.update', {
              ...envelope(),
              action: {
                type: 'chat.set_model',
                tabId: scope.chatId,
                model: modelId,
                providerType,
              },
            }),
          ),
        );
      });
      modelWrites = write.catch(() => undefined);
      pendingModels += 1;
      modelEpoch += 1;
      try {
        await write;
        savedModel = modelId;
      } catch (error) {
        if (choice === modelChoice)
          store.setState({ currentModel: savedModel });
        throw error;
      } finally {
        pendingModels -= 1;
        modelEpoch += 1;
      }
    },

    setSelections: async (next) => {
      const pluginSelections = {
        collectionIds: next.collectionIds.filter((id) =>
          refs.has(collectionEntryId(id)),
        ),
        skillRefs: next.skillRefs.filter((ref) => refs.has(skillEntryId(ref))),
        pluginRefs: next.pluginRefs.filter((ref) =>
          refs.has(pluginEntryId(ref)),
        ),
        mcpServerRefs: (next.mcpServerRefs ?? []).filter((ref) =>
          refs.has(mcpServerEntryId(ref)),
        ),
      };
      store.setState({ selectionConflict: false });
      const choice = ++selectionChoice;
      const write = selectionWrites.then(async () => {
        if (choice !== selectionChoice) return;
        CoreChatLifecycleResultSchema.parse(
          unwrap(
            await invoker.request('core.chat.update', {
              ...envelope(),
              action: {
                type: 'chat.patch_tab_settings',
                tabId: scope.chatId,
                patch: { pluginSelections },
              },
            }),
          ),
        );
      });
      selectionWrites = write.catch(() => undefined);
      try {
        await write;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        if (choice === selectionChoice) await refresh(true);
        return;
      }
      if (choice === selectionChoice) await refresh();
    },
  };
}
