import { useCallback, useEffect, useMemo, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  legacyAccountMcpConnectionId,
  projectDefaultsForChat,
  subtractPluginSelections,
  unionPluginSelections,
  withoutAccountsPickedOver,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineInfo,
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import {
  withAutomationSendAs,
  type AutomationSendAsConnector,
} from '@canopy/ui-app/capability';
import type { UsePipelineEditorReturn } from '@/hooks/usePipelineEditor';
import { derivePipelinePreferenceLocator } from '@/lib/pipelinePluginCollections';
import {
  emptyCollectionPreference,
  matchedDefaultPlugins,
  pluginCollectionUsers,
  stepSendAsPlugins,
  stepSendAsSelections,
  stepSendAsSource,
  stepSendAsTarget,
  withStepPluginSelections,
  withStepSendAsCollection,
  type StepSendAsChat,
  type StepSendAsSource,
  type StepSendAsTarget,
} from '@/lib/pipelineStepSendAs';
import { useProjectsStore } from '@/stores/projectsStore';
import { isClaudeTerminalBackedChatTab } from '@/stores/chat/tab-utils';
import {
  useSendAsConnectorLists,
  type SendAsSelections,
} from '../../automations/form/useAutomationSendAs';

/** One send step's "Send as" field. */
export interface WorkflowSendAsStep {
  readonly connectors: readonly AutomationSendAsConnector[];
  readonly onChange: (serverKey: string, configId: string) => void;
  /** The choice can't be made here yet; `notes` say why. */
  readonly disabled: boolean;
  /** What the person should know about where the choice applies. */
  readonly notes: readonly string[];
}

export type WorkflowSendAsSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

interface SendStepLocation {
  readonly jobId: string;
  readonly stepIndex: number;
}

export interface WorkflowSendAs {
  readonly step: (
    jobId: string,
    stepIndex: number,
  ) => WorkflowSendAsStep | undefined;
  /** The send steps that still need a "Send as" choice. */
  readonly unchosenSteps: readonly SendStepLocation[];
  /** Still reading what the send steps use, so Save waits. */
  readonly checking: boolean;
  /** Collection preferences could not be read for the current draft. */
  readonly resolutionFailed: boolean;
  readonly retryResolution: () => void;
  /** Choices not yet written to this machine's preferences. */
  readonly dirty: boolean;
  /** Writes the choices for the pipeline `info` names, once it is saved. */
  readonly save: (
    info: PipelineInfo | null,
  ) => Promise<WorkflowSendAsSaveResult>;
  readonly discard: () => void;
}

interface SendStep extends SendStepLocation {
  readonly source: StepSendAsSource;
  readonly target: StepSendAsTarget;
  /** The synthetic collection that resolves its `plugins` input, if any. */
  readonly pluginsCollectionId?: string;
}

interface ChatTabState {
  readonly selections?: ChatTabPluginSelections;
  readonly disabled?: PluginSelectionTombstones;
  /** Whether the chat inherits its project's defaults at all. */
  readonly inheritedPluginDefaultsVersion?: number;
  /**
   * The chat's turns run in its terminal, which refuses a turn that changes
   * its plugins, so a choice there could only break the step.
   */
  readonly terminal: boolean;
}

type Preferences = Record<string, PipelinePluginCollectionPreference>;

/** One "Send as" choice, re-applied to whatever is stored when it saves. */
interface SendAsChoice {
  readonly configId: string;
  /** Every account of the connector, which the choice replaces. */
  readonly accounts: readonly string[];
  /** Legacy `account:<id>` refs of the connector, which it replaces too. */
  readonly legacyServerIds: readonly string[];
}

/** Choices by collection id, then by connector key. */
type Choices = Record<string, Record<string, SendAsChoice>>;

/** `selections` acting as `choice`'s account alone for `serverKey`. */
function withChoice(
  selections: ChatTabPluginSelections,
  serverKey: string,
  choice: SendAsChoice,
): ChatTabPluginSelections {
  const legacy = new Set(choice.legacyServerIds);
  const refs = selections.mcpServerRefs ?? [];
  const kept = refs.filter((ref) => !legacy.has(ref.serverId));
  return withAutomationSendAs(
    kept.length === refs.length
      ? selections
      : { ...selections, mcpServerRefs: kept },
    serverKey,
    choice.configId,
    choice.accounts,
  );
}

/** A collection preference with its choices applied. */
function withChoices(
  preference: PipelinePluginCollectionPreference | undefined,
  choices: Record<string, SendAsChoice> | undefined,
): PipelinePluginCollectionPreference | undefined {
  if (!choices) return preference;
  const base = preference ?? emptyCollectionPreference();
  return {
    ...base,
    extraSelections: Object.entries(choices).reduce(
      (selections, [serverKey, choice]) =>
        withChoice(selections, serverKey, choice),
      base.extraSelections,
    ),
  };
}

/** A synthetic collection id no declared collection takes. */
const PLUGINS_COLLECTION_PREFIX = '__send_as_plugins_';

const SAVE_FAILED = "The account this workflow sends as wasn't saved.";

const chatKey = (chat: StepSendAsChat): string =>
  `${chat.projectId}/${chat.worktreeId}/${chat.chatId}`;

function sendSteps(
  pipeline: Pipeline | null,
  inputValues: Readonly<Record<string, string>> | undefined,
): SendStep[] {
  if (!pipeline) return [];
  const declared = new Set(
    (pipeline.plugin_collections ?? []).map((collection) =>
      collection.id.trim(),
    ),
  );
  let plugins = 0;
  const pluginsCollectionId = (): string => {
    let id = `${PLUGINS_COLLECTION_PREFIX}${plugins++}`;
    while (declared.has(id)) id = `${PLUGINS_COLLECTION_PREFIX}${plugins++}`;
    return id;
  };
  return Object.entries(pipeline.jobs).flatMap(([jobId, job]) =>
    job.steps.flatMap((step, stepIndex): SendStep[] => {
      const source = stepSendAsSource(step, pipeline);
      if (!source) return [];
      const hasPlugins = stepSendAsPlugins(step, inputValues).length > 0;
      return [
        {
          jobId,
          stepIndex,
          source,
          target: stepSendAsTarget(step, inputValues),
          ...(hasPlugins
            ? {
                pluginsCollectionId: pluginsCollectionId(),
              }
            : {}),
        },
      ];
    }),
  );
}

/**
 * The pipeline to resolve: its own collections, and one synthetic collection
 * per send step's `plugins` input, so main matches those plugins in the
 * catalog the way it matches a collection's defaults.
 */
function resolvablePipeline(
  pipeline: Pipeline,
  steps: readonly SendStep[],
  inputValues: Readonly<Record<string, string>> | undefined,
): Pipeline {
  const synthetic = steps.flatMap((step) => {
    const written = pipeline.jobs[step.jobId]?.steps[step.stepIndex];
    return step.pluginsCollectionId !== undefined && written
      ? [
          {
            id: step.pluginsCollectionId,
            name: step.pluginsCollectionId,
            defaults: stepSendAsPlugins(written, inputValues),
          },
        ]
      : [];
  });
  return synthetic.length === 0
    ? pipeline
    : {
        ...pipeline,
        plugin_collections: [
          ...(pipeline.plugin_collections ?? []),
          ...synthetic,
        ],
      };
}

function tombstoneSelections(
  tombstones: PluginSelectionTombstones,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...tombstones,
  };
}

/**
 * What a send step's message inherits, layered as its session layers it:
 * the project's defaults (when its chat inherits them, as a new chat does),
 * less those its chat turned off, under the chat's own selections, whose
 * account picks stand in for the project's other account of a connector.
 */
function inheritedSelections(
  target: StepSendAsTarget,
  projectDefaults: ReadonlyMap<string, ChatTabPluginSelections>,
  chats: ReadonlyMap<string, ChatTabState>,
): ChatTabPluginSelections | undefined {
  const chat = target.chat ? chats.get(chatKey(target.chat)) : undefined;
  const project = projectDefaultsForChat(
    chat,
    target.projectId !== undefined
      ? projectDefaults.get(target.projectId)
      : undefined,
  );
  const layered =
    project && chat?.disabled
      ? subtractPluginSelections(project, tombstoneSelections(chat.disabled))
      : project;
  if (!chat?.selections) return layered;
  const under = withoutAccountsPickedOver(layered, chat.selections);
  return under
    ? unionPluginSelections(under, chat.selections)
    : chat.selections;
}

/**
 * "Send as" on a workflow's send steps (CAN-7186), as the scheduled-prompt
 * editor asks it (CAN-6233): for each connector a send step uses, directly,
 * through its plugins, or through what its chat inherits, that the person
 * holds several accounts of. The choice is an exact account ref kept where
 * the step's own selections are: its plugin collection's preferences on this
 * machine (a converted automation's `chat_plugins`), written after the
 * pipeline saves and only once they have been read, or its
 * `plugin_selections`. A step with neither gets a collection. The host keeps
 * Save unavailable while a step needs a choice or while this still reads.
 */
export function useWorkflowSendAs({
  editor,
  pipeline,
  info,
  inputValues,
  scheduleOverrides,
  agentGranted = false,
  active,
}: {
  readonly editor: UsePipelineEditorReturn;
  readonly pipeline: Pipeline | null;
  readonly info: PipelineInfo | null;
  readonly inputValues?: Readonly<Record<string, string>>;
  /**
   * The schedules that keep their own preferences for a collection, by
   * collection id; their runs use those, not the workflow's.
   */
  readonly scheduleOverrides?: ReadonlyMap<string, readonly string[]>;
  /**
   * An agent's grant covers the workflow's local plugin choices as they
   * are, so a choice kept on this machine would void its next run.
   */
  readonly agentGranted?: boolean;
  readonly active: boolean;
}): WorkflowSendAs {
  const steps = useMemo(
    () => (active ? sendSteps(pipeline, inputValues) : []),
    [active, pipeline, inputValues],
  );
  const live = steps.length > 0;
  // A saved pipeline has a place to keep preferences on this machine.
  const locator = useMemo(
    (): PipelinePreferenceLocator | undefined =>
      info ? derivePipelinePreferenceLocator(info) : undefined,
    [info],
  );

  // The collections' stored preferences and the defaults they (and the
  // steps' plugins) matched, once read for this pipeline.
  // A bare step reads them too, so its new collection never takes the id
  // of a removed one whose preferences are still stored.
  const needsResolve = steps.some(
    (entry) =>
      entry.source.kind !== 'selections' ||
      entry.pluginsCollectionId !== undefined,
  );
  const resolveKey = JSON.stringify([
    locator ?? null,
    pipeline?.plugin_collections ?? [],
    steps.map((entry) => {
      const written = pipeline?.jobs[entry.jobId]?.steps[entry.stepIndex];
      return entry.pluginsCollectionId !== undefined && written
        ? stepSendAsPlugins(written, inputValues)
        : null;
    }),
  ]);
  const [resolveInput, setResolveInput] = useState({
    key: resolveKey,
    pipeline,
    steps,
    locator,
    inputValues,
  });
  const [resolved, setResolved] = useState<{
    readonly input: typeof resolveInput;
    readonly status: 'ready' | 'failed';
    readonly stored: Preferences;
    readonly previewItems: readonly PipelinePluginDefaultPreviewItem[];
  } | null>(null);
  const resolution = resolved?.input === resolveInput ? resolved : null;
  // The resolver normalizes the entire workflow. Retry a failed read when
  // the draft changes, even if the collections and plugins are the same.
  if (
    resolveInput.key !== resolveKey ||
    (resolution?.status === 'failed' && resolveInput.pipeline !== pipeline)
  ) {
    setResolveInput({ key: resolveKey, pipeline, steps, locator, inputValues });
  }
  const retryResolution = useCallback((): void => {
    setResolveInput({ key: resolveKey, pipeline, steps, locator, inputValues });
  }, [resolveKey, pipeline, steps, locator, inputValues]);
  useEffect(() => {
    if (!live || !needsResolve || !resolveInput.pipeline) return;
    let isCurrent = true;
    const failed = (): void => {
      if (isCurrent)
        setResolved({
          input: resolveInput,
          status: 'failed',
          stored: {},
          previewItems: [],
        });
    };
    window.pipelines
      .resolvePluginCollections({
        pipeline: resolvablePipeline(
          resolveInput.pipeline,
          resolveInput.steps,
          resolveInput.inputValues,
        ),
        ...(resolveInput.locator
          ? { pipelinePreferenceLocator: resolveInput.locator }
          : {}),
      })
      .then((result): void => {
        if (!result.success || !result.data) {
          reportClientAppError(
            new Error(result.error ?? 'Plugin collections did not resolve'),
          );
          failed();
          return;
        }
        if (!isCurrent) return;
        setResolved({
          input: resolveInput,
          status: 'ready',
          stored: result.data.effectivePreferences,
          previewItems: result.data.previewItems,
        });
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        failed();
      });
    return (): void => {
      isCurrent = false;
    };
  }, [live, needsResolve, resolveInput]);
  const resolving = needsResolve && resolution === null;
  // Stored preferences are known only once read; a draft has none to read.
  const storedKnown = locator !== undefined && resolution?.status === 'ready';
  const stored = useMemo(
    (): Preferences => (storedKnown && resolution ? resolution.stored : {}),
    [storedKnown, resolution],
  );
  const previewItems = useMemo(
    () => resolution?.previewItems ?? [],
    [resolution],
  );
  const [draft, setDraft] = useState<Choices>({});
  // A write in flight: a choice made meanwhile would race it.
  const [writing, setWriting] = useState(false);

  // What the projects the steps send into have as defaults.
  const projects = useProjectsStore((state) => state.projects);
  const projectDefaults = useMemo(
    () =>
      new Map(
        projects.flatMap((project): [string, ChatTabPluginSelections][] =>
          project.defaultPluginSelections
            ? [[project.id, project.defaultPluginSelections]]
            : [],
        ),
      ),
    [projects],
  );

  // What the existing chats the steps send to have selected.
  const chatKeys = JSON.stringify(
    Array.from(
      new Set(
        steps.flatMap((entry) =>
          entry.target.chat ? [chatKey(entry.target.chat)] : [],
        ),
      ),
    ).sort(),
  );
  const [chats, setChats] = useState<{
    readonly key: string;
    readonly tabs: ReadonlyMap<string, ChatTabState>;
  }>({ key: '[]', tabs: new Map() });
  const [chatsInput, setChatsInput] = useState({ key: chatKeys, steps });
  if (chatsInput.key !== chatKeys) setChatsInput({ key: chatKeys, steps });
  useEffect(() => {
    const worktrees = new Map<string, StepSendAsChat>();
    for (const entry of chatsInput.steps)
      if (entry.target.chat)
        worktrees.set(
          `${entry.target.chat.projectId}/${entry.target.chat.worktreeId}`,
          entry.target.chat,
        );
    if (worktrees.size === 0 || !window.api?.chat?.loadTabs) return;
    let isCurrent = true;
    void Promise.all(
      Array.from(worktrees.values(), (chat) =>
        window.api.chat
          .loadTabs({ projectId: chat.projectId, worktreeId: chat.worktreeId })
          .then(({ tabs }) =>
            tabs.flatMap((tab): [string, ChatTabState][] =>
              (tab.kind ?? 'chat') === 'chat' && !tab.readOnly
                ? [
                    [
                      `${chat.projectId}/${chat.worktreeId}/${tab.id}`,
                      {
                        ...(tab.pluginSelections
                          ? { selections: tab.pluginSelections }
                          : {}),
                        ...(tab.disabledGlobalPluginSelections
                          ? { disabled: tab.disabledGlobalPluginSelections }
                          : {}),
                        ...(tab.inheritedPluginDefaultsVersion !== undefined
                          ? {
                              inheritedPluginDefaultsVersion:
                                tab.inheritedPluginDefaultsVersion,
                            }
                          : {}),
                        terminal: isClaudeTerminalBackedChatTab(tab),
                      },
                    ],
                  ]
                : [],
            ),
          )
          .catch((error: unknown): [string, ChatTabState][] => {
            reportClientAppError(error);
            return [];
          }),
      ),
    ).then((loaded): void => {
      if (isCurrent)
        setChats({ key: chatsInput.key, tabs: new Map(loaded.flat()) });
    });
    return (): void => {
      isCurrent = false;
    };
  }, [chatsInput]);
  const chatsRead = chats.key === chatKeys;
  /** A step whose existing chat can't take a turn that changes its plugins. */
  const refusesChoice = useCallback(
    (entry: SendStep): boolean =>
      entry.target.chat !== undefined &&
      chats.tabs.get(chatKey(entry.target.chat))?.terminal === true,
    [chats],
  );

  const preferenceOf = useCallback(
    (collectionId: string): PipelinePluginCollectionPreference | undefined =>
      withChoices(stored[collectionId], draft[collectionId]),
    [draft, stored],
  );

  const entries = useMemo(
    (): SendAsSelections[] =>
      steps.map((entry) => {
        const base = stepSendAsSelections(
          entry.source,
          entry.source.kind === 'collection'
            ? preferenceOf(entry.source.collectionId)
            : undefined,
          previewItems,
        );
        const own =
          entry.pluginsCollectionId !== undefined
            ? {
                ...base,
                pluginRefs: [
                  ...base.pluginRefs,
                  ...matchedDefaultPlugins(
                    entry.pluginsCollectionId,
                    previewItems,
                  ),
                ],
              }
            : base;
        const inherited = inheritedSelections(
          entry.target,
          projectDefaults,
          chatsRead ? chats.tabs : new Map(),
        );
        return { own, ...(inherited ? { inherited } : {}) };
      }),
    [steps, preferenceOf, previewItems, projectDefaults, chats, chatsRead],
  );
  const {
    lists: connectorLists,
    ready,
    connections,
  } = useSendAsConnectorLists(entries, live, {
    canonicalizeLegacyRefs: true,
  });

  // A step's own legacy `account:<connectionId>` refs whose connection is
  // gone: the run stops on them, and a legacy ref doesn't say which connector
  // it was, so the editor never drops one; it says so instead.
  const goneLegacyRefs = useMemo((): string[][] => {
    if (!ready) return entries.map(() => []);
    const ids = new Set(connections.map((row) => row.id));
    return entries.map((entry) =>
      (entry.own.mcpServerRefs ?? []).flatMap((ref) => {
        const id = legacyAccountMcpConnectionId(ref.serverId);
        return id !== undefined && !ids.has(id) ? [ref.serverId] : [];
      }),
    );
  }, [entries, connections, ready]);

  /** Why a step's choice can't be made here yet, if it can't. */
  const unavailable = useCallback(
    (entry: SendStep): string | undefined => {
      if (writing) return 'Saving the account this step sends as…';
      if (entry.source.kind === 'selections') return undefined;
      if (agentGranted)
        return 'An agent set up this workflow, so its account can’t be changed here. Duplicate it to choose another account.';
      // A collection's choice, or a new collection's, is kept on this
      // machine for the saved pipeline, so a new workflow is saved first.
      if (!locator)
        return 'Save this workflow first to choose the account this step sends as.';
      if (resolution?.status === 'failed')
        return "This step's plugin choices couldn't be read, so its account can't be changed here.";
      if (!storedKnown) return 'Reading this step’s plugin choices…';
      return undefined;
    },
    [writing, agentGranted, locator, resolution, storedKnown],
  );

  const choose = useCallback(
    (
      entry: SendStep,
      connector: AutomationSendAsConnector,
      configId: string,
    ): void => {
      if (unavailable(entry) !== undefined) return;
      const ids = new Set(
        connections.flatMap((row) =>
          row.serverKey === connector.serverKey ? [row.id] : [],
        ),
      );
      const choice: SendAsChoice = {
        configId,
        accounts: connector.accounts.map((account) => account.configId),
        legacyServerIds: Array.from(
          new Set([
            ...[
              ...(entry.source.kind === 'selections'
                ? (entry.source.selections.mcpServerRefs ?? [])
                : []),
              ...((entry.source.kind === 'collection'
                ? preferenceOf(entry.source.collectionId)?.extraSelections
                    .mcpServerRefs
                : undefined) ?? []),
            ].flatMap((ref) => {
              const id = legacyAccountMcpConnectionId(ref.serverId);
              return id !== undefined && ids.has(id) ? [ref.serverId] : [];
            }),
          ]),
        ),
      };
      const choose = (collectionId: string, fresh = false): void =>
        setDraft((drafts) => ({
          ...drafts,
          [collectionId]: {
            ...(fresh ? {} : drafts[collectionId]),
            [connector.serverKey]: choice,
          },
        }));
      const { source } = entry;
      if (source.kind === 'collection') {
        choose(source.collectionId);
        return;
      }
      const written =
        editor.pipeline?.jobs[entry.jobId]?.steps[entry.stepIndex];
      if (!editor.pipeline || !written) return;
      if (source.kind === 'selections') {
        editor.updateStep(
          entry.jobId,
          entry.stepIndex,
          withStepPluginSelections(
            written,
            withChoice(source.selections, connector.serverKey, choice),
          ),
        );
        return;
      }
      // A new collection never takes an id a pending choice still names,
      // which an undo can leave behind.
      const given = withStepSendAsCollection(
        editor.pipeline,
        entry.jobId,
        entry.stepIndex,
        [...Object.keys(draft), ...Object.keys(stored)],
      );
      if (!given) return;
      editor.replaceEntirePipeline(given.pipeline);
      choose(given.collectionId, true);
    },
    [editor, preferenceOf, unavailable, connections, draft, stored],
  );

  const step = useCallback(
    (jobId: string, stepIndex: number): WorkflowSendAsStep | undefined => {
      const index = steps.findIndex(
        (entry) => entry.jobId === jobId && entry.stepIndex === stepIndex,
      );
      const found = steps[index];
      if (!found || refusesChoice(found)) return undefined;
      const connectors = connectorLists[index] ?? [];
      const reason = unavailable(found);
      const notes: string[] = reason ? [reason] : [];
      const goneNote =
        (goneLegacyRefs[index]?.length ?? 0) > 0
          ? 'This step names an account that is gone, so its runs stop. Remove it from the step’s plugin choices.'
          : undefined;
      if (goneNote) notes.push(goneNote);
      if (found.source.kind === 'none')
        notes.push(
          'Choosing an account gives this step a plugin collection, so the workflow runs on This computer only.',
        );
      if (found.source.kind === 'collection' && pipeline) {
        const { collectionId } = found.source;
        const name =
          pipeline.plugin_collections?.find(
            (collection) => collection.id === collectionId,
          )?.name ?? collectionId;
        if (pluginCollectionUsers(pipeline, collectionId) > 1)
          notes.push(
            `This choice applies to every step that uses the “${name}” plugin collection.`,
          );
        const overrides = scheduleOverrides?.get(collectionId) ?? [];
        if (overrides.length > 0)
          notes.push(
            overrides.length === 1
              ? `“${overrides[0]}” keeps its own plugin choices for this step, so its runs don't use this choice.`
              : `${overrides.map((name) => `“${name}”`).join(', ')} keep their own plugin choices for this step, so their runs don't use this choice.`,
          );
      }
      return {
        connectors,
        disabled: reason !== undefined,
        // With no connector to choose for, only the gone account is worth
        // saying: it stops every run, whatever the step selects otherwise.
        notes: connectors.length > 0 ? notes : goneNote ? [goneNote] : [],
        onChange: (serverKey, configId): void => {
          const connector = connectors.find(
            (entry) => entry.serverKey === serverKey,
          );
          if (connector) choose(found, connector, configId);
        },
      };
    },
    [
      steps,
      connectorLists,
      goneLegacyRefs,
      unavailable,
      refusesChoice,
      choose,
      pipeline,
      scheduleOverrides,
    ],
  );

  // Only a choice that can be made holds Save up; a new workflow's
  // collection-kept choice waits for its first save instead.
  const unchosenSteps = useMemo(
    () =>
      steps.filter(
        (entry, index) =>
          unavailable(entry) === undefined &&
          !refusesChoice(entry) &&
          (connectorLists[index] ?? []).some(
            (connector) => connector.value === null,
          ),
      ),
    [steps, connectorLists, unavailable, refusesChoice],
  );
  const checking =
    live && (resolving || !ready || (chatKeys !== '[]' && !chatsRead));

  const save = useCallback(
    async (saved: PipelineInfo | null): Promise<WorkflowSendAsSaveResult> => {
      // Only collections a send step still uses keep a choice: one an undo
      // took out of the workflow, or whose send step was removed, is dropped.
      const used = new Set(
        steps.flatMap((entry) =>
          entry.source.kind === 'collection' ? [entry.source.collectionId] : [],
        ),
      );
      const changed = Object.fromEntries(
        Object.entries(draft).filter(([id]) => used.has(id)),
      );
      // What this save carried is clean afterwards; a newer choice stays.
      const unwritten = (drafts: Choices): Choices =>
        Object.fromEntries(
          Object.entries(drafts).filter(
            ([id, choices]) => used.has(id) && changed[id] !== choices,
          ),
        );
      if (Object.keys(changed).length === 0) {
        setDraft(unwritten);
        return { ok: true };
      }
      if (!saved || !pipeline) return { ok: false, message: SAVE_FAILED };
      setWriting(true);
      try {
        // The choices go onto what is stored now, read again here, so a
        // collection another dialog changed since keeps those changes.
        const pipelinePreferenceLocator =
          derivePipelinePreferenceLocator(saved);
        const read = await window.pipelines.resolvePluginCollections({
          pipeline,
          pipelinePreferenceLocator,
        });
        if (!read.success || !read.data)
          return { ok: false, message: SAVE_FAILED };
        const fresh = read.data.effectivePreferences;
        const next: Preferences = {};
        for (const [id, choices] of Object.entries(changed)) {
          const applied = withChoices(fresh[id], choices);
          if (applied) next[id] = applied;
        }
        const result = await window.pipelines.savePluginCollectionPreferences({
          pipelinePreferenceLocator,
          preferences: { ...fresh, ...next },
          basePreferences: fresh,
        });
        if (!result.success || !result.data || !result.data.ok)
          return { ok: false, message: SAVE_FAILED };
        const now = result.data.preferences ?? { ...fresh, ...next };
        setResolved((previous) =>
          previous ? { ...previous, stored: now } : previous,
        );
        setDraft(unwritten);
        return { ok: true };
      } catch (error: unknown) {
        reportClientAppError(error);
        return { ok: false, message: SAVE_FAILED };
      } finally {
        setWriting(false);
      }
    },
    [draft, pipeline, steps],
  );

  const discard = useCallback((): void => setDraft({}), []);

  return {
    step,
    unchosenSteps,
    checking,
    resolutionFailed: needsResolve && resolution?.status === 'failed',
    retryResolution,
    dirty: Object.keys(draft).length > 0,
    save,
    discard,
  };
}
