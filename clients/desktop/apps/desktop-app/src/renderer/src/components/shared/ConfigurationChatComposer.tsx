import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { Descendant } from 'slate';
import { Transforms } from 'slate';
import {
  createChatEditor,
  focusEditor,
  serializeEditorValue,
  SlateEditor,
} from '@canopy/ui-rich/editor';
import type {
  AgentModelConfig,
  ChatTabPluginSelections,
  RepoFileIndex,
  SlashCommandData,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import { validateConfiguredPromptReferences } from '@canopy/protocol/configured-prompt-references';
import {
  APP_ADVISOR_PROJECT_ID,
  getSupportedThinkingLevelsForModel,
} from '@canopy/desktop-shared/types';
import {
  ChatComposerToolbarChip,
  ChatComposerShell,
  DialogModal,
  Notice,
  ThinkingLevelProviderHint,
  buildCodexSpeedChip,
  nextCodexSpeedSelection,
  type CodexSpeedSelection,
} from '@canopy/ui-shared';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  PlanModeIcon,
  CommandIcon,
  PluginsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import { useContextualCodexSpeedControl } from '@/hooks/useContextualCodexSpeedControl';
import { useComposerInventoryCommands } from '@/hooks/useComposerInventoryCommands';
import { useConfigurationComposerDefaults } from '@/hooks/useConfigurationComposerDefaults';
import {
  buildComposerCommands,
  getComposerAction,
} from '@/lib/composerCommands';
import { searchFileMentions } from '@/lib/fileMentionSearch';
import {
  buildConfiguredEditorValue,
  createConfiguredReferenceNamespace,
  configuredReferenceLocatorMap,
  resolveConfiguredEditorReferences,
  unresolvedConfiguredFiles,
} from '@/lib/configurationComposerReferences';
import { resolveHomeEffectiveProviderType } from '@/stores/homeComposerStore';
import { createEmptySelections } from '@/lib/pluginSelections';
import { getSlashCommandInsertText } from '@/hooks/useSlashCommands';
import {
  ComposerPlusMenu,
  type ComposerPlusMenuItem,
} from './ComposerPlusMenu';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { ThinkingLevelButton } from '@/components/chat/ThinkingLevelButton';
import { ApprovalModePicker } from '@/components/chat/ApprovalModePicker';
import { ConfigurationComposerVoiceControl } from './ConfigurationComposerVoiceControl';
import { ChatPluginsModal } from '@/components/chat/ChatPluginsModal';
import { ShareablePluginSelector } from './ShareablePluginSelector';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import { buildPluginMentionAbsolutePath } from '@canopy/desktop-shared/lib/plugin-mention';
import type {
  ConfigurationChatComposerProps,
  ConfigurationChatComposerValue,
} from './ConfigurationChatComposer.types';

/**
 * Apply a configuration speed choice: an explicit speed is written with its
 * derived boolean; Use default removes both so the action inherits.
 */
function withSpeedSelection(
  config: AgentModelConfig | undefined,
  selection: CodexSpeedSelection,
): AgentModelConfig {
  if (selection !== 'default') return withCodexSpeed(config, selection);
  const next: AgentModelConfig = { ...config };
  delete next.speed;
  delete next.fastMode;
  return next;
}

function combineSelections(
  ...parts: (ChatTabPluginSelections | undefined)[]
): ChatTabPluginSelections {
  const merged = createEmptySelections();
  const appendUnique = <T,>(
    target: T[],
    entries: readonly T[] | undefined,
  ): void => {
    for (const entry of entries ?? []) {
      if (
        !target.some(
          (current) => JSON.stringify(current) === JSON.stringify(entry),
        )
      ) {
        target.push(entry);
      }
    }
  };
  for (const part of parts) {
    if (!part) continue;
    appendUnique(merged.collectionIds, part.collectionIds);
    appendUnique(merged.skillRefs, part.skillRefs);
    appendUnique(merged.pluginRefs, part.pluginRefs);
    merged.mcpServerRefs ??= [];
    merged.mcpHttpAuthPreferences ??= [];
    appendUnique(merged.mcpServerRefs, part.mcpServerRefs);
    appendUnique(merged.mcpHttpAuthPreferences, part.mcpHttpAuthPreferences);
  }
  return merged;
}

/** A form-owned composer. No Home draft, chat, or attachment state is modified. */
export function ConfigurationChatComposer(
  props: ConfigurationChatComposerProps,
): JSX.Element {
  return (
    <ComposerInstance
      key={`${props.editorId}/${props.draftGeneration ?? 0}`}
      {...props}
    />
  );
}

function ComposerInstance({
  value,
  onChange,
  context,
  selectionMode,
  dataTestId,
  effectiveModel,
  effectiveModelConfig,
  effectivePlanMode,
  effectiveApprovalMode,
  inheritedSelections,
  executionHarness,
  speedRouteContext,
  speedRouteModelSelection,
  variables = [],
  disabled = false,
  readOnly = false,
  onPendingChange,
  onValidityChange,
  onOpenPlugins,
  loadAdvisorEnvironment,
}: ConfigurationChatComposerProps): JSX.Element {
  const editor = useMemo(() => createChatEditor(), []);
  const [referenceNamespace] = useState(createConfiguredReferenceNamespace);
  const [editorValue, setEditorValue] = useState<Descendant[]>(() =>
    buildConfiguredEditorValue(
      value.prompt,
      value.promptReferences ?? [],
      referenceNamespace,
    ),
  );
  const [discovery, setDiscovery] = useState<WorktreeDiscovery | null>(null);
  const [repos, setRepos] = useState<RepoFileIndex[]>([]);
  const [loading, setLoading] = useState(false);
  const [indexedScope, setIndexedScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serializationError, setSerializationError] = useState<string | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [voicePending, setVoicePending] = useState(false);
  const [modelPickerSignal, setModelPickerSignal] = useState(0);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [sourceProjection, setSourceProjection] = useState<{
    key: string;
    selections: ChatTabPluginSelections;
    unresolved: boolean;
  } | null>(null);
  const portablePending = useRef<ShareablePluginRef | null>(null);
  const portableMentions = useRef<Map<string, ShareablePluginRef>>(new Map());
  const locatorMap = useRef(
    configuredReferenceLocatorMap(
      value.promptReferences ?? [],
      referenceNamespace,
    ),
  );
  const mounted = useRef(true);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const requestId = useRef(0);
  const contextKey = JSON.stringify(context);
  const defaults = useConfigurationComposerDefaults(
    context,
    value.model?.startsWith('$') ? undefined : value.model,
    value.modelConfig,
    effectiveModel,
    effectiveModelConfig,
    effectiveApprovalMode,
  );
  const effective = defaults.model;
  const provider =
    context.kind === 'unresolved'
      ? undefined
      : context.kind === 'workspace'
        ? resolveHomeEffectiveProviderType(
            context.workspaceId,
            effective,
            executionHarness,
          )
        : resolveHomeEffectiveProviderType(null, effective, executionHarness);
  // Speed availability follows the model this action would run. The billing
  // lane is resolved when the action runs, where admission re-checks it.
  const speedControl = useContextualCodexSpeedControl({
    enabled: provider === 'codex',
    context:
      speedRouteContext ??
      (context.kind === 'unresolved'
        ? null
        : {
            kind: 'home',
            ...(context.kind === 'workspace'
              ? { projectId: context.workspaceId }
              : { projectId: APP_ADVISOR_PROJECT_ID }),
            executionHarness,
          }),
    route: {
      model: effective,
      auto: value.model === undefined && speedRouteModelSelection === 'auto',
      capturedHarness: executionHarness,
      aiCreditsRouted: false,
    },
  });
  const speedSelection: CodexSpeedSelection =
    readCodexSpeedRecord(value.modelConfig) ?? 'default';
  const effectiveSpeed = defaults.modelConfig.speed ?? DEFAULT_CODEX_SPEED;
  const portableKey = `${provider}/${JSON.stringify(value.plugins ?? [])}`;
  useEffect(() => {
    if (selectionMode !== 'source' || !value.plugins?.length || !provider) {
      setSourceProjection(null);
      return;
    }
    let current = true;
    void window.plugins
      .resolvePortableRefs({ refs: value.plugins, providerType: provider })
      .then((result) => {
        if (!current) return;
        setSourceProjection(
          result.success && result.data
            ? {
                key: portableKey,
                selections: result.data.selections,
                unresolved: result.data.unresolved.length > 0,
              }
            : {
                key: portableKey,
                selections: createEmptySelections(),
                unresolved: true,
              },
        );
      })
      .catch(() => {
        if (current)
          setSourceProjection({
            key: portableKey,
            selections: createEmptySelections(),
            unresolved: true,
          });
      });
    return (): void => {
      current = false;
    };
  }, [selectionMode, portableKey, provider, value.plugins]);
  const sourceReady =
    selectionMode !== 'source' ||
    !value.plugins?.length ||
    sourceProjection?.key === portableKey;
  const effectiveSelections = useMemo(
    () =>
      combineSelections(
        inheritedSelections,
        defaults.selections,
        value.pluginSelections,
        sourceProjection?.key === portableKey
          ? sourceProjection.selections
          : undefined,
      ),
    [
      inheritedSelections,
      defaults.selections,
      value.pluginSelections,
      sourceProjection,
      portableKey,
    ],
  );
  const selectionKey = JSON.stringify(effectiveSelections);
  const scopeKey = `${contextKey}/${selectionMode}/${provider}/${portableKey}/${sourceReady}/${selectionKey}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => {
    portablePending.current = null;
    setPending(false);
  }, [scopeKey]);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    setDiscovery(null);
    setRepos([]);
    setIndexedScope(null);
    setError(null);
    if (context.kind === 'unresolved' || !provider || !sourceReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Account harnesses have no Claude/Codex extension discovery (their skills and
    // commands come from the inventory), so only the destination's files
    // are indexed for it; the Home store makes the same distinction.
    const discoveryProvider =
      provider === 'cursor' || provider === 'copilot' || provider === 'opencode'
        ? undefined
        : provider;
    const request =
      context.kind === 'workspace'
        ? Promise.all([
            discoveryProvider
              ? window.api.homeDiscoverEnvironment({
                  workspaceId: context.workspaceId,
                  target: context.target,
                  providerType: discoveryProvider,
                  pluginSelections: effectiveSelections,
                })
              : Promise.resolve({ discovery: null }),
            window.api.homeFileIndex({
              workspaceId: context.workspaceId,
              target: context.target,
            }),
          ]).then(([environment, index]) => ({
            discovery: environment.discovery,
            repos: index.repos,
          }))
        : discoveryProvider
          ? (
              loadAdvisorEnvironment ??
              window.api.configurationComposerAdvisorEnvironment
            )({
              providerType: discoveryProvider,
              pluginSelections: effectiveSelections,
            })
          : Promise.resolve({ discovery: null, repos: [] });
    void request
      .then((result) => {
        if (cancelled || !mounted.current || id !== requestId.current) return;
        setDiscovery(result.discovery);
        setRepos(result.repos);
        setIndexedScope(scopeKey);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled || !mounted.current || id !== requestId.current) return;
        setDiscovery(null);
        setRepos([]);
        setIndexedScope(null);
        setLoading(false);
        setError('Could not load destination files and commands. Try again.');
      });
    return (): void => {
      cancelled = true;
    };
    // Scope identity, not draft keystrokes, controls discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const indexReady = indexedScope === scopeKey;
  const hasFileReferences = (value.promptReferences ?? []).some(
    (reference) => reference.kind === 'file',
  );
  const referenceError = validateConfiguredPromptReferences(
    value.prompt,
    value.promptReferences,
    { portableOnly: selectionMode === 'source' },
  );
  const unresolved = indexReady
    ? unresolvedConfiguredFiles(value.promptReferences ?? [], repos)
    : [];
  const validity = serializationError
    ? { valid: false, reason: serializationError }
    : referenceError
      ? { valid: false, reason: referenceError }
      : context.kind === 'unresolved' && hasFileReferences
        ? { valid: false, reason: context.reason }
        : !sourceReady
          ? { valid: false, reason: 'Checking source capabilities.' }
          : sourceProjection?.key === portableKey && sourceProjection.unresolved
            ? {
                valid: false,
                reason: 'A selected source capability is unavailable here.',
              }
            : hasFileReferences && !indexReady
              ? {
                  valid: false,
                  reason: loading
                    ? 'Checking file references.'
                    : 'Could not verify file references in this destination.',
                }
              : unresolved.length > 0
                ? {
                    valid: false,
                    reason:
                      'Resolve or remove missing file references before saving.',
                  }
                : { valid: true };
  const statusMessage =
    error ??
    (!validity.valid ? validity.reason : undefined) ??
    (context.kind === 'unresolved' ? context.reason : undefined);
  useEffect(
    () =>
      onValidityChange?.({ valid: validity.valid, reason: validity.reason }),
    [onValidityChange, validity.valid, validity.reason],
  );
  useEffect(
    () => onPendingChange?.(pending || voicePending),
    [onPendingChange, pending, voicePending],
  );

  function updateEditor(next: Descendant[]): void {
    setEditorValue(next);
    const serialized = serializeEditorValue(next);
    try {
      const references = resolveConfiguredEditorReferences({
        fileReferences: serialized.fileReferences,
        referenceByLocator: locatorMap.current,
        repos,
        target: context.kind === 'workspace' ? context.target : undefined,
        portablePluginRef: (marketplaceId, pluginName) => {
          const ref = portableMentions.current.get(
            buildPluginMentionAbsolutePath({ marketplaceId, pluginName }),
          );
          return ref ? { kind: 'portable', ref } : null;
        },
      });
      const changed: ConfigurationChatComposerValue = {
        ...valueRef.current,
        prompt: serialized.text,
        promptReferences: references,
      };
      valueRef.current = changed;
      onChangeRef.current(changed);
      setError(null);
      setSerializationError(null);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'Could not save this reference.';
      setError(message);
      setSerializationError(message);
    }
  }

  function changedOutsideEditor(): void {
    updateEditor(structuredClone(editor.children));
    focusEditor(editor);
  }

  const menu = useComposerMenu(editor, {
    enabled: !disabled && !readOnly,
    dollar: provider === 'codex',
    scopeKey,
    onChange: changedOutsideEditor,
  });

  const inventory = useComposerInventoryCommands({
    providerType: provider,
    discoveredCommands: discovery?.slashCommands ?? [],
    discoveryLoading: loading,
    effectiveSelections,
    persistedSelections: value.pluginSelections ?? createEmptySelections(),
    includeInventory: true,
    isCurrent: () => mounted.current && scopeRef.current === scopeKey,
    commit: (selections, text) => {
      const current = valueRef.current;
      const portable = portablePending.current;
      portablePending.current = null;
      // `null`: an inherited Cursor row enabled nothing, so the value keeps
      // its selections and only the text lands.
      if (selections) {
        const changed =
          selectionMode === 'source' && portable
            ? {
                ...current,
                plugins: [
                  ...(current.plugins ?? []).filter(
                    (ref) =>
                      getShareablePluginRefKey(ref) !==
                      getShareablePluginRefKey(portable),
                  ),
                  portable,
                ],
              }
            : { ...current, pluginSelections: selections };
        valueRef.current = changed;
        onChangeRef.current(changed);
      }
      menu.insertCommandText(text);
      changedOutsideEditor();
      setPending(false);
    },
    onError: () => {
      setPending(false);
      setError('Could not enable that item. Try again.');
    },
  });
  const commands = useMemo(
    () =>
      buildComposerCommands(inventory.commands, {
        home: false,
        fast: provider === 'codex',
        supportedActions: [
          'plugins',
          'model',
          'thinking',
          'fast',
          'plan',
          'commands',
          'help',
        ],
      }),
    [inventory.commands, provider],
  );

  function selectCommand(command: SlashCommandData): void {
    if ('disabledReason' in command && command.disabledReason) return;
    const action = getComposerAction(command);
    if (action) {
      if (action === 'plugins') openPlugins();
      else if (action === 'model') setModelPickerSignal((signal) => signal + 1);
      else if (action === 'plan')
        updateValue({
          planMode: !(valueRef.current.planMode ?? effectivePlanMode ?? false),
        });
      else if (action === 'fast') cycleSpeed();
      else if (action === 'thinking') cycleThinking();
      menu.prepareAction();
      return;
    }
    if (command.section === 'available' && command.inventoryEntry) {
      if (pending) return;
      setPending(true);
      const startScope = scopeKey;
      const entry = command.inventoryEntry;
      void (async (): Promise<
        'resolve-failed' | 'inserted' | 'prepare-failed'
      > => {
        if (selectionMode === 'source') {
          if (!provider) return 'resolve-failed';
          const result = await window.plugins.resolvePortableEnableRef({
            enableRef: entry.enableRef,
            providerType: provider,
          });
          if (!mounted.current || scopeRef.current !== startScope)
            return 'resolve-failed';
          if (!result.success || !result.data) {
            setError('This capability is local only. Use a local override.');
            return 'resolve-failed';
          }
          portablePending.current = result.data;
        }
        return inventory.runInventoryCommand(entry);
      })()
        .then((status) => {
          if (status !== 'inserted') portablePending.current = null;
          if (
            mounted.current &&
            scopeRef.current === scopeKey &&
            status !== 'inserted'
          )
            setPending(false);
        })
        .catch(() => {
          portablePending.current = null;
          if (mounted.current && scopeRef.current === scopeKey) {
            setPending(false);
            setError('Could not enable that item. Try again.');
          }
        });
      return;
    }
    menu.insertCommandText(getSlashCommandInsertText(command));
    changedOutsideEditor();
  }

  function updateValue(patch: Partial<ConfigurationChatComposerValue>): void {
    const changed = { ...valueRef.current, ...patch };
    valueRef.current = changed;
    onChangeRef.current(changed);
  }

  function openPlugins(): void {
    if (!provider) {
      setError('Choose a destination before selecting plugins and skills.');
      return;
    }
    if (onOpenPlugins) onOpenPlugins();
    else setPluginsOpen(true);
  }

  /** Quick cycle: Use default → Regular → Fast → Ultra fast (when offered). */
  function cycleSpeed(): void {
    const current = valueRef.current.modelConfig;
    updateValue({
      modelConfig: withSpeedSelection(
        current,
        nextCodexSpeedSelection(
          readCodexSpeedRecord(current) ?? 'default',
          speedControl.states,
          { includeDefault: true },
        ),
      ),
    });
  }

  function cycleThinking(): void {
    const supported = getSupportedThinkingLevelsForModel(effective, provider);
    if (!supported.length) return;
    const choices = [undefined, ...supported];
    const current = valueRef.current.modelConfig?.thinkingLevel;
    const index = choices.findIndex((item) => item === current);
    updateValue({
      modelConfig: {
        ...valueRef.current.modelConfig,
        thinkingLevel: choices[(index + 1) % choices.length],
      },
    });
  }

  const searchFiles = useCallback(
    (query: string) =>
      searchFileMentions(
        query,
        repos.filter((repo) => repo.rootKind !== 'attachments'),
      ).filter((file) => !file.isAttachment && !file.kind),
    [repos],
  );
  const addItems: ComposerPlusMenuItem[] = [
    {
      id: 'plugins',
      label: 'Plugins and skills',
      icon: <PluginsIcon />,
      disabled: !provider,
      disabledTooltip: !provider
        ? {
            title: 'Choose a destination',
            description: 'Choose a destination before selecting capabilities.',
          }
        : undefined,
      onSelect: openPlugins,
    },
    {
      id: 'plan-mode',
      label: 'Plan mode',
      icon: (
        <PlanModeIcon
          size="sm"
          active={value.planMode ?? effectivePlanMode ?? false}
        />
      ),
      onSelect: () =>
        updateValue({
          planMode: !(valueRef.current.planMode ?? effectivePlanMode ?? false),
        }),
      ariaChecked: value.planMode ?? effectivePlanMode ?? false,
    },
    ...variables.map((variable) => ({
      id: `variable:${variable.name}`,
      label: variable.name,
      description: variable.description,
      icon: <CommandIcon />,
      disabled: !!variable.disabledReason,
      onSelect: (): void => {
        menu.consumeTrigger();
        Transforms.insertText(editor, variable.token);
        changedOutsideEditor();
      },
    })),
  ];

  function onPaste(event: ClipboardEvent<HTMLDivElement>): void {
    if (event.clipboardData.files.length) {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (text) Transforms.insertText(editor, text);
    }
  }
  function onDrop(event: DragEvent<HTMLDivElement>): void {
    if (
      event.dataTransfer.files.length > 0 ||
      event.dataTransfer.types.includes('Files')
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    menu.handleKeyDown(event);
    // A closed menu leaves Enter to Slate so configuration never submits here.
  }

  return (
    <ChatComposerShell
      dataTestId={`${dataTestId}-composer`}
      onDropCapture={onDrop}
      onDragOverCapture={onDragOver}
    >
      <span
        ref={menu.anchorRef}
        aria-hidden
        className="pointer-events-none absolute inset-0"
      />
      <SlateEditor
        editor={editor}
        value={editorValue}
        onChange={updateEditor}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder="Write a prompt, @ to mention files, / for skills and commands"
        dataTestId={dataTestId}
        readOnly={readOnly || disabled}
      />
      {statusMessage && (
        <Notice intent="destructive" className="mx-3">
          {statusMessage}
        </Notice>
      )}
      <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 pb-3 pt-2">
        <ComposerPlusMenu
          controller={menu}
          dataTestIdPrefix={dataTestId}
          commands={commands}
          searchFiles={searchFiles}
          onSelectFile={(file) => menu.insertFile(file, repos.length)}
          multiRepo={repos.length > 1}
          onSelectCommand={selectCommand}
          includeCommandsInAddMenu
          additionalItems={addItems}
          isRefreshing={inventory.isRefreshing}
          pluginSelections={effectiveSelections}
          providerScope={provider ?? 'mixed'}
          onSelectPlugin={(ref, { label, enabled }) => {
            if (!provider) {
              setError(
                'Choose a destination before selecting plugins and skills.',
              );
              return;
            }
            if (selectionMode === 'source') {
              menu.beginSelection();
              setPending(true);
              void window.plugins
                .resolvePortableEnableRef({
                  enableRef: { kind: 'plugin', ...ref },
                  providerType: provider,
                })
                .then((result) => {
                  if (!mounted.current || scopeRef.current !== scopeKey) return;
                  if (!result.success || !result.data) {
                    setPending(false);
                    setError(
                      'This plugin is local only. Use a local override.',
                    );
                    return;
                  }
                  const portable = result.data;
                  const current = valueRef.current;
                  portableMentions.current.set(
                    buildPluginMentionAbsolutePath(ref),
                    portable,
                  );
                  updateValue({
                    plugins: [
                      ...(current.plugins ?? []).filter(
                        (existing) =>
                          getShareablePluginRefKey(existing) !==
                          getShareablePluginRefKey(portable),
                      ),
                      portable,
                    ],
                  });
                  menu.insertPlugin({ ...ref, label });
                  setPending(false);
                })
                .catch(() => {
                  if (mounted.current && scopeRef.current === scopeKey) {
                    setPending(false);
                    setError('Could not enable that plugin. Try again.');
                  }
                });
            } else {
              if (!enabled)
                updateValue({
                  pluginSelections: combineSelections(
                    valueRef.current.pluginSelections,
                    { ...createEmptySelections(), pluginRefs: [ref] },
                  ),
                });
              menu.insertPlugin({ ...ref, label });
            }
          }}
          disabled={disabled || readOnly || pending}
          capsuleTrigger
        />
        <ModelPicker
          currentModel={effective}
          allowWorkspaceDefault
          onModelChange={(model) => updateValue({ model })}
          openSignal={modelPickerSignal}
          disabled={disabled || readOnly || pending}
          capsule
          hideAgents
          placeholderLabel="Default model"
          triggerTooltip="Model for this action"
          onRestoreFocus={() => focusEditor(editor)}
        />
        {getSupportedThinkingLevelsForModel(effective, provider).length > 0 && (
          <ThinkingLevelProviderHint providerHint={provider}>
            <ThinkingLevelButton
              value={value.modelConfig?.thinkingLevel}
              supportedLevels={getSupportedThinkingLevelsForModel(
                effective,
                provider,
              )}
              onChange={(thinkingLevel) =>
                updateValue({
                  modelConfig: {
                    ...valueRef.current.modelConfig,
                    thinkingLevel,
                  },
                })
              }
              variant="capsule"
              allowWorkspaceDefault
              includeLow
              ariaLabel={
                value.modelConfig?.thinkingLevel === undefined
                  ? `Thinking: Default; effective ${defaults.modelConfig.thinkingLevel}; click to cycle`
                  : undefined
              }
              disabled={disabled || readOnly || pending}
              testId={`${dataTestId}-thinking`}
            />
          </ThinkingLevelProviderHint>
        )}
        <ChatComposerToolbarChip
          variant="capsule"
          disabled={disabled || readOnly || pending}
          active={value.planMode ?? effectivePlanMode ?? false}
          ariaPressed={value.planMode ?? effectivePlanMode ?? false}
          ariaLabel="Toggle plan mode"
          title="Plan mode"
          icon={
            <PlanModeIcon
              size="sm"
              active={value.planMode ?? effectivePlanMode ?? false}
            />
          }
          label={(value.planMode ?? effectivePlanMode) ? 'Plan' : undefined}
          dataTestId={`${dataTestId}-plan-mode`}
          onClick={() =>
            updateValue({
              planMode: !(
                valueRef.current.planMode ??
                effectivePlanMode ??
                false
              ),
            })
          }
        />
        {provider === 'codex' && (
          <ChatComposerToolbarChip
            {...buildCodexSpeedChip({
              selection: speedSelection,
              effectiveSpeed,
              next: nextCodexSpeedSelection(
                speedSelection,
                speedControl.states,
                { includeDefault: true },
              ),
              blockedReason: speedControl.blockedReason(effectiveSpeed),
              disabled: disabled || readOnly || pending,
              dataTestId: `${dataTestId}-fast-mode`,
              onClick: cycleSpeed,
            })}
          />
        )}
        {(value.approvalMode ?? defaults.approvalMode) && (
          <ApprovalModePicker
            mode={value.approvalMode ?? defaults.approvalMode ?? 'ask'}
            compact
            disabled={disabled || readOnly || pending}
            onChange={(approvalMode) => {
              if (
                selectionMode === 'source' &&
                approvalMode === 'full-access'
              ) {
                setError('Full access requires a local override.');
                return;
              }
              updateValue({ approvalMode });
            }}
          />
        )}
        <ConfigurationComposerVoiceControl
          editor={editor}
          scopeKey={scopeKey}
          disabled={disabled || readOnly || pending}
          onCommitted={changedOutsideEditor}
          onPendingChange={setVoicePending}
        />
      </div>
      {pluginsOpen &&
        (selectionMode === 'local' ? (
          <ChatPluginsModal
            initial={value.pluginSelections ?? createEmptySelections()}
            onSave={(pluginSelections) => {
              updateValue({ pluginSelections });
              setPluginsOpen(false);
            }}
            onClose={() => setPluginsOpen(false)}
          />
        ) : (
          <DialogModal
            inset="flush"
            title="Plugins and skills"
            onClose={() => setPluginsOpen(false)}
            dataTestId={`${dataTestId}-plugins-modal`}
          >
            <ShareablePluginSelector
              selections={value.plugins ?? []}
              onChange={(plugins) => updateValue({ plugins })}
            />
          </DialogModal>
        ))}
    </ChatComposerShell>
  );
}
