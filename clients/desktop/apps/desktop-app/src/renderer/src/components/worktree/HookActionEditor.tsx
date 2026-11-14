import { Badge } from '@canopy/ui-shared/components/Badge';
import { PipelineSourceLabel } from '@canopy/ui-shared/components/EntrySourceLabel';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Stack,
  Button,
  ChoiceField,
  ErrorBanner,
  FormField,
  ListRow,
  SearchField,
  SettingsSelect,
  Surface,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  SUPPORTED_HOOK_TRIGGERS,
  getHookTriggerDisplayName,
  type PipelineHookSource,
} from '@canopy/desktop-shared/hooks';
import {
  isLinuxCommandShell,
  isMacCommandShell,
  isWindowsCommandShell,
  type CommandShellDefinition,
} from '@canopy/desktop-shared/scripts';
import { resolvePipelineModelAliasLenient } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { ConfigurationChatComposer } from '@/components/shared/ConfigurationChatComposer';
import type { ConfigurationComposerContext } from '@/lib/configurationComposerTargets';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { FastModeButton } from '@/components/chat/FastModeButton';
import {
  getTriggerInputDefs,
  type PipelineInputDef,
} from '@canopy/execution-engine/types/pipeline';
import {
  formatPipelineInputDefault,
  shouldShowPipelineInputInUi,
} from '@/lib/pipelineTriggerInputs';
import {
  addEditableHookAction,
  getEditableHookActions,
  isEditableHookDisabled,
  moveEditableHookAction,
  removeEditableHookAction,
  setEditableHookDisabled,
  updateEditableHookAction,
  type EditableHookAction,
  type EditableHookActionDraft,
  type EditableHooks,
} from '@/lib/editableHooks';
import {
  applyPipelineFastModeSelection,
  buildChatAction,
  buildCommandAction,
  buildPipelineAction,
  canAddHookAction,
  createBlankHookAction,
  createHookEnvVarInsertion,
  getHookEnvVarDefinitionsForTrigger,
  insertTextAtSelection,
  parseActionType,
  retainPipelineInputsForSelection,
  trimHookActionDraft,
  updateChatAction,
  updateCommandAction,
  updatePipelineAction,
  type HookTextInsertionMode,
  type HookActionFormAction,
} from '@/lib/hookActionEditor';
import {
  loadHookPipelineOptions,
  resolveHookPipelineOption,
  type HookPipelineOption,
} from '@/lib/hookPipelineOptions';
import {
  getTypedInputInitialValue,
  hasTypedWidget,
  valueFitsTypedWidget,
} from '@/lib/pipelineInputWidget';
import { VariableInsertDropdown } from './VariableInsertDropdown';
import { RuntimeModePicker } from './RuntimeModePicker';
import {
  WorkflowIcon as AppCatalogWorkflowIcon,
  ChevronTopMediumIcon as AppCatalogChevronTopMediumIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { PipelineGlyph } from '@canopy/ui-shared/icons';

interface HookActionEditorProps {
  hooks: EditableHooks;
  onChange: (updater: (current: EditableHooks) => EditableHooks) => void;
  allowDisable: boolean;
  pluginSelectionMode: 'portable' | 'full';
  chatContext?: ConfigurationComposerContext;
  onBlockedChange?: (blocked: boolean) => void;
  /**
   * Repo cwd for project-scope pipeline discovery. When provided, the
   * pipeline picker also lists project pipelines under
   * `<cwd>/.canopy/pipelines/`.
   */
  pipelineDiscoveryCwd?: string;
  /**
   * Shows one part of the editor, for a page that opens each hook on its
   * own: a trigger name shows that trigger's actions, `null` shows only the
   * form that adds a hook. Omitted shows every trigger and the form.
   */
  visibleTrigger?: string | null;
  /**
   * `stack` frames each trigger and the add form as cards. `settings` drops
   * those frames for a page that already titles the hook.
   */
  layout?: 'stack' | 'settings';
  /** Called after the add form adds an action to `trigger`. */
  onActionAdded?: (trigger: string) => void;
}

const PIPELINE_HOOK_SOURCE_LABELS: Record<PipelineHookSource, string> = {
  bundled: 'Bundled',
  curated: 'Curated',
  local: 'Local',
  project: 'Project',
};

type PipelineSourceFilter = PipelineHookSource | 'all';

function getPipelineOptionKey(option: HookPipelineOption): string {
  return `${option.actionSource}:${option.actionId}`;
}

function getPipelineDispatchInputDefs(
  option: HookPipelineOption | undefined,
): Array<[string, PipelineInputDef]> {
  if (!option?.data.content) return [];
  const defs = getTriggerInputDefs(option.data.content.on, 'dispatch');
  if (!defs) return [];
  return Object.entries(defs).filter(([, def]) =>
    shouldShowPipelineInputInUi(def),
  );
}

function shouldKeepPipelineInputValue(
  def: PipelineInputDef,
  value: string,
): boolean {
  return value.length > 0 || def.required === true;
}

function setPipelineInputValue(
  inputs: Record<string, string> | undefined,
  key: string,
  def: PipelineInputDef,
  value: string,
): Record<string, string> | undefined {
  const nextInputs: Record<string, string> = { ...(inputs ?? {}) };
  if (shouldKeepPipelineInputValue(def, value)) {
    nextInputs[key] = value;
  } else {
    delete nextInputs[key];
  }

  return Object.keys(nextInputs).length > 0 ? nextInputs : undefined;
}

function updateShellPlatform(
  shell: CommandShellDefinition | undefined,
  platform: 'windows' | 'mac' | 'linux',
  value: string,
): CommandShellDefinition | undefined {
  const next: CommandShellDefinition = { ...(shell ?? {}) };
  if (platform === 'windows') {
    if (isWindowsCommandShell(value)) {
      next.windows = value;
    } else {
      delete next.windows;
    }
  } else if (platform === 'mac') {
    if (isMacCommandShell(value)) {
      next.mac = value;
    } else {
      delete next.mac;
    }
  } else if (isLinuxCommandShell(value)) {
    next.linux = value;
  } else {
    delete next.linux;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

const COMMAND_SHELL_PLATFORMS: ReadonlyArray<{
  readonly platform: 'windows' | 'mac' | 'linux';
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
  }>;
}> = [
  {
    platform: 'windows',
    label: 'Windows',
    options: [
      { value: '', label: 'Default' },
      { value: 'cmd', label: 'Command Prompt' },
      { value: 'powershell', label: 'PowerShell' },
      { value: 'bash', label: 'Git Bash' },
    ],
  },
  {
    platform: 'mac',
    label: 'Mac',
    options: [
      { value: '', label: 'Default' },
      { value: 'zsh', label: 'zsh' },
      { value: 'bash', label: 'bash' },
    ],
  },
  {
    platform: 'linux',
    label: 'Linux',
    options: [
      { value: '', label: 'Default (Bash)' },
      { value: 'bash', label: 'bash' },
      { value: 'zsh', label: 'zsh' },
    ],
  },
];

function CommandShellFields({
  shell,
  onChange,
}: {
  shell: CommandShellDefinition | undefined;
  onChange: (next: CommandShellDefinition | undefined) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col pt-1 gap-1.5">
      <span className="text-2xs font-medium fg-secondary">Shell</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {COMMAND_SHELL_PLATFORMS.map((entry) => (
          <FormField key={entry.platform} label={entry.label}>
            {(control) => (
              <SettingsSelect
                {...control}
                width="fill"
                aria-label={`Command action ${entry.label} shell`}
                value={shell?.[entry.platform] ?? ''}
                onValueChange={(value) =>
                  onChange(updateShellPlatform(shell, entry.platform, value))
                }
                options={entry.options}
              />
            )}
          </FormField>
        ))}
      </div>
    </div>
  );
}

const HOOK_ACTION_TYPE_OPTIONS = [
  { value: 'command', label: 'command' },
  { value: 'chat', label: 'chat' },
  { value: 'pipeline', label: 'workflow' },
] as const;

const BOOLEAN_INPUT_OPTIONS = [
  { value: 'true', label: 'True' },
  { value: 'false', label: 'False' },
] as const;

interface PipelineActionFieldsProps {
  action: Extract<HookActionFormAction, { type: 'pipeline' }>;
  triggerName: string;
  onChange: (action: HookActionFormAction) => void;
  pipelineOptions: HookPipelineOption[];
  pipelineOptionsLoading: boolean;
}

function PipelineActionFields({
  action,
  triggerName,
  onChange,
  pipelineOptions,
  pipelineOptionsLoading,
}: PipelineActionFieldsProps): JSX.Element {
  const inputValueRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const lastFocusedKeyRef = useRef<string | null>(null);
  const lastSelectionRef = useRef<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<PipelineSourceFilter>('all');
  const [rawOverrides, setRawOverrides] = useState<Record<string, boolean>>({});

  const matchingOption = pipelineOptions.find(
    (option) =>
      option.actionSource === action.source && option.actionId === action.id,
  );
  const [resolvedOption, setResolvedOption] = useState<HookPipelineOption>();
  const [pipelineLoadError, setPipelineLoadError] = useState<string>();
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const selectionSequence = useRef(0);
  const inputDefs = getPipelineDispatchInputDefs(
    resolvedOption?.actionId === action.id &&
      resolvedOption.actionSource === action.source
      ? resolvedOption
      : matchingOption,
  );
  useEffect(() => {
    if (
      !matchingOption ||
      matchingOption.data.content ||
      (resolvedOption?.actionId === matchingOption.actionId &&
        resolvedOption.actionSource === matchingOption.actionSource)
    )
      return;
    let cancelled = false;
    setPipelineLoadError(undefined);
    setPipelineLoading(true);
    void resolveHookPipelineOption(matchingOption)
      .then((resolved) => {
        if (!cancelled) {
          setPipelineLoading(false);
          setResolvedOption(resolved);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setPipelineLoadError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (!cancelled) setPipelineLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [matchingOption, resolvedOption]);
  const showMissingNotice =
    action.id.trim().length > 0 && !pipelineOptionsLoading && !matchingOption;
  const hookVariables = useMemo(
    () => getHookEnvVarDefinitionsForTrigger(triggerName),
    [triggerName],
  );

  useEffect(() => {
    setRawOverrides({});
  }, [action.source, action.id]);

  const isRawForKey = (key: string, def: PipelineInputDef): boolean => {
    if (!hasTypedWidget(def)) {
      return true;
    }
    const overridden = rawOverrides[key];
    if (overridden !== undefined) {
      return overridden;
    }
    const value = action.inputs?.[key] ?? '';
    return !valueFitsTypedWidget(value, def);
  };

  const setInputValueForDef = (
    key: string,
    def: PipelineInputDef,
    nextValue: string,
  ): void => {
    onChange(
      updatePipelineAction(action, {
        inputs: setPipelineInputValue(action.inputs, key, def, nextValue),
      }),
    );
  };

  const toggleRawForKey = (key: string, def: PipelineInputDef): void => {
    const current = isRawForKey(key, def);
    const next = !current;
    if (!next) {
      const currentValue = action.inputs?.[key] ?? '';
      if (!valueFitsTypedWidget(currentValue, def)) {
        setInputValueForDef(key, def, getTypedInputInitialValue(def));
      }
    }
    setRawOverrides((prev) => ({ ...prev, [key]: next }));
    if (next) {
      requestAnimationFrame((): void => {
        const ta = inputValueRefs.current.get(key);
        if (ta) {
          ta.focus();
          const length = ta.value.length;
          ta.selectionStart = length;
          ta.selectionEnd = length;
        }
      });
    }
  };

  const sourceFilterOptions = useMemo<PipelineSourceFilter[]>(() => {
    const sources = new Set<PipelineHookSource>();
    for (const option of pipelineOptions) {
      sources.add(option.actionSource);
    }
    if (sources.size <= 1) return [];
    const options: PipelineSourceFilter[] = ['all'];
    if (sources.has('bundled')) options.push('bundled');
    if (sources.has('curated')) options.push('curated');
    if (sources.has('local')) options.push('local');
    if (sources.has('project')) options.push('project');
    return options;
  }, [pipelineOptions]);

  const filteredOptions = useMemo<HookPipelineOption[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    return pipelineOptions.filter((option) => {
      if (sourceFilter !== 'all' && option.actionSource !== sourceFilter) {
        return false;
      }
      if (!query) return true;
      const name = (option.data.info.name ?? '').toLowerCase();
      const description = (option.data.info.description ?? '').toLowerCase();
      const id = option.actionId.toLowerCase();
      return (
        name.includes(query) ||
        description.includes(query) ||
        id.includes(query)
      );
    });
  }, [pipelineOptions, searchQuery, sourceFilter]);

  const selectPipeline = async (
    candidate: HookPipelineOption,
  ): Promise<void> => {
    const sequence = ++selectionSequence.current;
    setPipelineLoadError(undefined);
    setPipelineLoading(true);
    let option: HookPipelineOption;
    try {
      option = await resolveHookPipelineOption(candidate);
    } catch (error) {
      if (sequence === selectionSequence.current) {
        setPipelineLoadError(
          error instanceof Error ? error.message : String(error),
        );
        setPipelineLoading(false);
      }
      return;
    }
    if (sequence !== selectionSequence.current) return;
    setPipelineLoading(false);
    setResolvedOption(option);
    const nextDefs = getPipelineDispatchInputDefs(option);
    const filteredInputs = retainPipelineInputsForSelection({
      currentInputs: action.inputs,
      nextDefs,
    });
    onChange(
      updatePipelineAction(action, {
        source: option.actionSource,
        id: option.actionId,
        inputs: filteredInputs,
      }),
    );
  };

  const rememberSelection = (key: string): void => {
    const textarea = inputValueRefs.current.get(key);
    if (!textarea) {
      return;
    }
    lastFocusedKeyRef.current = key;
    lastSelectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const insertVariable = (variableName: string): void => {
    if (inputDefs.length === 0) {
      return;
    }
    const insertedText = createHookEnvVarInsertion('prompt', variableName);

    const focusedKey = lastFocusedKeyRef.current;
    const focusedDef = focusedKey
      ? inputDefs.find(([key]) => key === focusedKey)?.[1]
      : undefined;
    const focusedKeyIsRaw =
      focusedKey !== null &&
      focusedDef !== undefined &&
      isRawForKey(focusedKey, focusedDef);
    const fallbackRawEntry = inputDefs.find(([key, def]) =>
      isRawForKey(key, def),
    );
    if (!focusedKeyIsRaw && !fallbackRawEntry) {
      return;
    }
    const targetKey =
      focusedKeyIsRaw && focusedKey !== null
        ? focusedKey
        : (fallbackRawEntry?.[0] ?? inputDefs[0][0]);
    const focusedTextarea = inputValueRefs.current.get(targetKey);
    const currentValue = action.inputs?.[targetKey] ?? '';
    const selection =
      focusedTextarea && document.activeElement === focusedTextarea
        ? {
            start: focusedTextarea.selectionStart,
            end: focusedTextarea.selectionEnd,
          }
        : focusedKey === targetKey
          ? lastSelectionRef.current
          : { start: currentValue.length, end: currentValue.length };
    const insertion = insertTextAtSelection({
      value: currentValue,
      insertedText,
      selectionStart: selection.start,
      selectionEnd: selection.end,
    });

    const targetDef = inputDefs.find(([key]) => key === targetKey)?.[1];
    onChange(
      updatePipelineAction(action, {
        inputs:
          targetDef !== undefined
            ? setPipelineInputValue(
                action.inputs,
                targetKey,
                targetDef,
                insertion.value,
              )
            : action.inputs,
      }),
    );

    requestAnimationFrame((): void => {
      const nextTextarea = inputValueRefs.current.get(targetKey);
      if (!nextTextarea) {
        return;
      }
      nextTextarea.focus();
      nextTextarea.selectionStart = insertion.cursorPosition;
      nextTextarea.selectionEnd = insertion.cursorPosition;
      lastFocusedKeyRef.current = targetKey;
      lastSelectionRef.current = {
        start: insertion.cursorPosition,
        end: insertion.cursorPosition,
      };
    });
  };

  return (
    <Stack gap="item">
      <Stack gap="inline">
        <span className="block text-xs fg-secondary">Workflow</span>

        <SearchField
          value={searchQuery}
          onValueChange={setSearchQuery}
          aria-label="Search workflows"
          placeholder="Search workflows…"
        />

        {pipelineLoading && (
          <div role="status" className="text-xs fg-secondary">
            Loading workflow definition…
          </div>
        )}
        {/* Settings never show a raw exception: our own sentence. */}
        <ErrorBanner
          errorSource="pipeline-action-fields-load"
          className=""
          error={pipelineLoadError ? "Couldn't load this workflow." : undefined}
          details={pipelineLoadError}
        />
        {sourceFilterOptions.length > 0 && (
          <SettingsSelect<PipelineSourceFilter>
            aria-label="Workflow source"
            data-testid="hook-workflow-source-filter"
            value={sourceFilter}
            width="field"
            options={sourceFilterOptions.map((filter) => ({
              value: filter,
              label:
                filter === 'all' ? 'All' : PIPELINE_HOOK_SOURCE_LABELS[filter],
              testId: `hook-workflow-source-${filter}`,
            }))}
            onValueChange={setSourceFilter}
          />
        )}

        <Surface variant="group" className="overflow-hidden">
          <div className="max-h-64 overflow-y-auto">
            {pipelineOptionsLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs fg-secondary">
                <LoadingSpinner />
                <span>Loading workflows…</span>
              </div>
            ) : pipelineOptions.length === 0 ? (
              <div className="py-6 text-center text-xs fg-secondary">
                No dispatch workflows found.
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="py-6 text-center text-xs fg-secondary">
                No workflows match your search.
              </div>
            ) : (
              <div className="flex flex-col p-1 gap-0.5">
                {filteredOptions.map((option) => {
                  const isSelected =
                    option.actionSource === action.source &&
                    option.actionId === action.id;
                  const displayName = option.data.info.name || option.actionId;
                  return (
                    <ListRow
                      key={getPipelineOptionKey(option)}
                      onClick={() => {
                        void selectPipeline(option);
                      }}
                      selected={isSelected}
                      aria-current={isSelected ? 'true' : undefined}
                      icon={<PipelineGlyph icon={option.data.info.icon} />}
                      description={option.data.info.description || undefined}
                      trailing={
                        <PipelineSourceLabel>
                          {PIPELINE_HOOK_SOURCE_LABELS[option.actionSource]}
                        </PipelineSourceLabel>
                      }
                    >
                      {displayName}
                    </ListRow>
                  );
                })}
              </div>
            )}
          </div>
        </Surface>

        {showMissingNotice && (
          <p className="text-2xs fg-warning">
            Missing workflow: {action.id} (
            {PIPELINE_HOOK_SOURCE_LABELS[action.source]})
          </p>
        )}
      </Stack>

      {inputDefs.length > 0 && (
        <Stack gap="inline">
          <span className="block text-xs fg-secondary">Inputs</span>
          <Stack gap="inline">
            {inputDefs.map(([key, def]) => {
              const value = action.inputs?.[key] ?? '';
              const description = def.description;
              const inputType = def.type ?? 'string';
              const typedWidget = hasTypedWidget(def);
              const raw = isRawForKey(key, def);
              // `PipelineInputDef.default` is widened to `PipelineInputValue`
              // for `json` inputs, so structured defaults must be serialized
              // rather than stringified — `String({})` renders
              // `[object Object]`. Scalars are unchanged.
              const defaultPlaceholder = formatPipelineInputDefault(
                def.default,
              );
              return (
                <Surface key={key} variant="group" padding="tight">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                    <Stack gap="inline" className="min-w-0">
                      <Stack gap="tight">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="break-all font-mono text-2xs fg-primary/80">
                            {key}
                          </span>
                          {def.required === true && (
                            <Badge tone="warning">Required</Badge>
                          )}
                          <Badge>{inputType}</Badge>
                        </div>
                        {description && (
                          <span className="text-2xs fg-secondary">
                            {description}
                          </span>
                        )}
                      </Stack>
                      {typedWidget && (
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => toggleRawForKey(key, def)}
                          aria-pressed={raw}
                          className="self-start"
                        >
                          <AppCatalogWorkflowIcon size="sm" />
                          {raw ? 'Use typed input' : 'Raw override'}
                        </Button>
                      )}
                    </Stack>
                    {raw ? (
                      <TextArea
                        mono
                        aria-label={key}
                        className="self-start"
                        ref={(element) => {
                          if (element) {
                            inputValueRefs.current.set(key, element);
                          } else {
                            inputValueRefs.current.delete(key);
                          }
                        }}
                        value={value}
                        onChange={(event) =>
                          setInputValueForDef(key, def, event.target.value)
                        }
                        onFocus={() => rememberSelection(key)}
                        onSelect={() => rememberSelection(key)}
                        onClick={() => rememberSelection(key)}
                        onKeyUp={() => rememberSelection(key)}
                        rows={2}
                        placeholder={defaultPlaceholder}
                      />
                    ) : inputType === 'choice' ? (
                      <div className="self-start">
                        <SettingsSelect
                          width="field"
                          aria-label={key}
                          value={value || getTypedInputInitialValue(def)}
                          onValueChange={(next) =>
                            setInputValueForDef(key, def, next)
                          }
                          options={(def.options ?? []).map((opt) => ({
                            value: opt,
                            label: opt,
                          }))}
                        />
                      </div>
                    ) : inputType === 'boolean' ? (
                      <div className="self-start">
                        <SettingsSelect
                          aria-label={key}
                          value={value || getTypedInputInitialValue(def)}
                          onValueChange={(next) =>
                            setInputValueForDef(key, def, next)
                          }
                          options={BOOLEAN_INPUT_OPTIONS}
                        />
                      </div>
                    ) : (
                      <div className="w-40 self-start">
                        <TextInput
                          density="settings"
                          type="number"
                          aria-label={key}
                          value={value}
                          onChange={(event) =>
                            setInputValueForDef(key, def, event.target.value)
                          }
                          min={def.min}
                          max={def.max}
                          placeholder={defaultPlaceholder}
                        />
                      </div>
                    )}
                  </div>
                </Surface>
              );
            })}
          </Stack>
          <VariableInsertDropdown
            variables={hookVariables}
            onInsert={(variableName) => insertVariable(variableName)}
          />
        </Stack>
      )}

      <ChoiceField
        checked={action.allowPipelineConcurrency === true}
        onChange={(event) =>
          onChange(
            updatePipelineAction(action, {
              allowPipelineConcurrency: event.target.checked ? true : undefined,
            }),
          )
        }
        label="Allow workflow concurrency"
        description="Start this hook workflow immediately even when another workflow is running."
      />

      <FastModeButton
        value={action.modelConfig?.fastMode}
        onChange={(nextFastMode) =>
          onChange(applyPipelineFastModeSelection(action, nextFastMode))
        }
      />
    </Stack>
  );
}

function HookActionFields(props: {
  action: HookActionFormAction;
  triggerName: string;
  onChange: (action: HookActionFormAction) => void;
  pipelineOptions: HookPipelineOption[];
  pipelineOptionsLoading: boolean;
  pluginSelectionMode: 'portable' | 'full';
  chatContext?: ConfigurationComposerContext;
  editorId: string;
  onBlockedChange: (id: string, blocked: boolean) => void;
}): JSX.Element {
  const {
    action,
    triggerName,
    onChange,
    pipelineOptions,
    pipelineOptionsLoading,
    pluginSelectionMode,
    chatContext,
    editorId,
    onBlockedChange,
  } = props;
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const onValidityChange = useCallback(
    (result: { valid: boolean }): void => setInvalid(!result.valid),
    [],
  );
  useEffect(() => {
    onBlockedChange(editorId, action.type === 'chat' && (pending || invalid));
    return (): void => onBlockedChange(editorId, false);
  }, [editorId, action.type, pending, invalid, onBlockedChange]);
  const commandTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const ifCommandTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<
    Record<
      'command' | 'if-command',
      {
        start: number;
        end: number;
      }
    >
  >({
    command: { start: 0, end: 0 },
    'if-command': { start: 0, end: 0 },
  });
  const hookVariables = useMemo(
    () => getHookEnvVarDefinitionsForTrigger(triggerName),
    [triggerName],
  );

  const rememberSelection = (field: 'command' | 'if-command'): void => {
    const textarea =
      field === 'command'
        ? commandTextareaRef.current
        : ifCommandTextareaRef.current;
    if (!textarea) {
      return;
    }

    selectionRef.current[field] = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const insertVariable = (
    mode: HookTextInsertionMode,
    variableName: string,
    field: 'command' | 'if-command',
  ): void => {
    // Pipeline-action editing UI is owned by the frontend phase; the
    // transport layer treats variable insertion as a no-op for pipeline
    // actions since they have no command/prompt textareas.
    if (action.type === 'pipeline') {
      return;
    }

    const textarea =
      field === 'command'
        ? commandTextareaRef.current
        : ifCommandTextareaRef.current;
    const currentValue =
      action.type === 'command' ? action.command : (action['if-command'] ?? '');
    const insertedText = createHookEnvVarInsertion(mode, variableName);
    const nextSelection =
      textarea && textarea.ownerDocument.activeElement === textarea
        ? {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          }
        : selectionRef.current[field];
    const insertion = insertTextAtSelection({
      value: currentValue,
      insertedText,
      selectionStart: nextSelection.start,
      selectionEnd: nextSelection.end,
    });

    if (action.type === 'command') {
      onChange(updateCommandAction(action, { command: insertion.value }));
    } else {
      onChange(updateChatAction(action, { ifCommand: insertion.value }));
    }

    requestAnimationFrame((): void => {
      const nextTextarea =
        field === 'command'
          ? commandTextareaRef.current
          : ifCommandTextareaRef.current;
      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.selectionStart = insertion.cursorPosition;
      nextTextarea.selectionEnd = insertion.cursorPosition;
      selectionRef.current[field] = {
        start: insertion.cursorPosition,
        end: insertion.cursorPosition,
      };
    });
  };

  if (action.type === 'command') {
    return (
      <Stack gap="inline">
        <FormField label="Command">
          {(control) => (
            <TextArea
              {...control}
              mono
              ref={commandTextareaRef}
              value={action.command}
              onChange={(event) =>
                onChange(
                  updateCommandAction(action, { command: event.target.value }),
                )
              }
              onSelect={() => rememberSelection('command')}
              onClick={() => rememberSelection('command')}
              onKeyUp={() => rememberSelection('command')}
              rows={3}
            />
          )}
        </FormField>

        <VariableInsertDropdown
          variables={hookVariables}
          onInsert={(variableName) =>
            insertVariable('command', variableName, 'command')
          }
        />

        <CommandShellFields
          shell={action.shell}
          onChange={(nextShell) =>
            onChange(updateCommandAction(action, { shell: nextShell }))
          }
        />

        <RuntimeModePicker
          mode={action.interactive === true ? 'interactive' : 'background'}
          onChange={(next) =>
            onChange(
              updateCommandAction(action, {
                interactive: next === 'interactive' ? true : undefined,
              }),
            )
          }
          interactiveDescription="Runs this command in a project terminal so it can accept input."
          testId="hook-command-runtime-mode"
          ariaLabel="Command action runtime"
        />
      </Stack>
    );
  }

  if (action.type === 'pipeline') {
    return (
      <PipelineActionFields
        action={action}
        triggerName={triggerName}
        onChange={onChange}
        pipelineOptions={pipelineOptions}
        pipelineOptionsLoading={pipelineOptionsLoading}
      />
    );
  }

  // Hook actions may name a pipeline model alias ($default-codex); resolve it
  // so provider derivation, thinking-level validation, and the model picker
  // all reflect the model the alias targets.
  const resolvedModel = action.model
    ? resolvePipelineModelAliasLenient(action.model)
    : undefined;
  return (
    <Stack gap="item">
      <ConfigurationChatComposer
        editorId={editorId}
        dataTestId={editorId}
        draftGeneration={0}
        context={
          chatContext ?? {
            kind: 'unresolved',
            reason: 'Choose a project to load files and commands.',
          }
        }
        selectionMode={pluginSelectionMode === 'portable' ? 'source' : 'local'}
        value={{
          prompt: action.prompt,
          promptReferences: action.promptReferences,
          model: action.model,
          modelConfig:
            action.modelConfig ??
            (action.thinking ? { thinkingLevel: action.thinking } : undefined),
          planMode: action.planMode,
          approvalMode: action.approvalMode,
          plugins: action.plugins,
          pluginSelections: action.pluginSelections,
        }}
        effectiveModel={resolvedModel}
        onChange={(next) =>
          onChange({ ...action, ...next, thinking: undefined })
        }
        onPendingChange={setPending}
        onValidityChange={onValidityChange}
        variables={hookVariables.map((variable) => ({
          ...variable,
          token: createHookEnvVarInsertion('prompt', variable.name),
        }))}
      />

      <FormField label="If command">
        {(control) => (
          <TextArea
            {...control}
            mono
            ref={ifCommandTextareaRef}
            value={action['if-command'] ?? ''}
            onChange={(event) =>
              onChange(
                updateChatAction(action, { ifCommand: event.target.value }),
              )
            }
            onSelect={() => rememberSelection('if-command')}
            onClick={() => rememberSelection('if-command')}
            onKeyUp={() => rememberSelection('if-command')}
            rows={3}
            placeholder="Optional shell command gate"
          />
        )}
      </FormField>

      <VariableInsertDropdown
        variables={hookVariables}
        onInsert={(variableName) =>
          insertVariable('command', variableName, 'if-command')
        }
      />

      <p className="text-2xs fg-secondary">
        Exit `0` runs the chat action. Exit `2` stops the hook intentionally.
        Any other exit code fails the hook.
      </p>

      <ChoiceField
        checked={action.allowChatConcurrency === true}
        onChange={(event) =>
          onChange(
            updateChatAction(action, {
              allowChatConcurrency: event.target.checked ? true : undefined,
            }),
          )
        }
        label="Allow chat concurrency"
        description="Start this hook chat immediately even when another chat is running in this worktree."
      />

      <ChoiceField
        checked={action.autoArchive === true}
        onChange={(event) =>
          onChange(
            updateChatAction(action, {
              autoArchive: event.target.checked ? true : undefined,
            }),
          )
        }
        label="Auto-archive when finished"
        description="Archive this hook chat automatically as soon as its agent turn finishes (kept retrievable from the archive, unread if unseen)."
      />
    </Stack>
  );
}

/** One trigger's block: a hairline box in the stacked layout. */
function TriggerFrame({
  framed,
  children,
}: {
  readonly framed: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return framed ? (
    <Surface variant="outline" padding="compact" gap="inline">
      {children}
    </Surface>
  ) : (
    <div className="flex flex-col gap-3">{children}</div>
  );
}

/** One action's box, tinted in both layouts. */
function ActionFrame({
  framed,
  children,
}: {
  readonly framed: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface
      variant="group"
      padding={framed ? 'compact' : undefined}
      gap={framed ? 'item' : undefined}
    >
      {framed ? (
        children
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">{children}</div>
      )}
    </Surface>
  );
}

/** The add-action form: a dashed placeholder in the stacked layout. */
function AddFormFrame({
  framed,
  children,
}: {
  readonly framed: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return framed ? (
    <Surface
      variant="dashed"
      padding="compact"
      gap="item"
      data-testid="hook-add-form"
    >
      {children}
    </Surface>
  ) : (
    <div className="flex flex-col gap-3" data-testid="hook-add-form">
      {children}
    </div>
  );
}

export function HookActionEditor(props: HookActionEditorProps): JSX.Element {
  const {
    hooks,
    onChange,
    allowDisable,
    pipelineDiscoveryCwd,
    pluginSelectionMode,
    chatContext,
    onBlockedChange,
    visibleTrigger,
    layout = 'stack',
    onActionAdded,
  } = props;
  const framed = layout === 'stack';
  const [blockedEditors, setBlockedEditors] = useState<Record<string, boolean>>(
    {},
  );
  const reportBlocked = useCallback((id: string, blocked: boolean): void => {
    setBlockedEditors((previous) => {
      if (Boolean(previous[id]) === blocked) return previous;
      const next = { ...previous };
      if (blocked) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);
  const blocked = Object.values(blockedEditors).some(Boolean);
  const blockedCallbackRef = useRef(onBlockedChange);
  blockedCallbackRef.current = onBlockedChange;
  useEffect(() => {
    blockedCallbackRef.current?.(blocked);
  }, [blocked]);
  useEffect(() => (): void => blockedCallbackRef.current?.(false), []);
  const [newHookTrigger, setNewHookTrigger] = useState<string>(
    typeof visibleTrigger === 'string'
      ? visibleTrigger
      : (SUPPORTED_HOOK_TRIGGERS.find((trigger) => trigger === 'pr:create') ??
          SUPPORTED_HOOK_TRIGGERS[0] ??
          'pr:create'),
  );
  // A page for one hook keeps its add form behind "Add another action".
  const [addFormOpen, setAddFormOpen] = useState(
    typeof visibleTrigger !== 'string',
  );
  const [newActionType, setNewActionType] =
    useState<EditableHookAction['type']>('command');
  const [newAction, setNewAction] = useState<EditableHookActionDraft>(
    createBlankHookAction('command'),
  );
  const [newActionGeneration, setNewActionGeneration] = useState(0);
  const canAddNewAction = canAddHookAction(newAction) && !blocked;
  const [pipelineOptions, setPipelineOptions] = useState<HookPipelineOption[]>(
    [],
  );
  const [pipelineOptionsLoading, setPipelineOptionsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPipelineOptionsLoading(true);
    void loadHookPipelineOptions({ cwd: pipelineDiscoveryCwd })
      .then((options) => {
        if (cancelled) return;
        setPipelineOptions(options);
      })
      .catch(() => {
        if (cancelled) return;
        setPipelineOptions([]);
      })
      .finally(() => {
        if (cancelled) return;
        setPipelineOptionsLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [pipelineDiscoveryCwd]);

  const renderTriggerEditor = (triggerName: string): JSX.Element | null => {
    const actions = getEditableHookActions(hooks, triggerName);
    const disabled = allowDisable && isEditableHookDisabled(hooks, triggerName);
    if (actions.length === 0 && !disabled) {
      return null;
    }

    return (
      <TriggerFrame key={triggerName} framed={framed}>
        <div
          className={
            framed
              ? 'flex items-center justify-between'
              : 'flex items-center justify-end'
          }
        >
          {framed && (
            <span className="text-xs font-medium fg-primary">
              {getHookTriggerDisplayName(triggerName)}
            </span>
          )}
          {allowDisable && (
            <Button
              size="compact"
              variant={framed ? 'secondary' : 'ghost'}
              onClick={() =>
                onChange((current) =>
                  setEditableHookDisabled(current, triggerName, !disabled),
                )
              }
            >
              {disabled ? 'Use inherited hook' : 'Disable hook'}
            </Button>
          )}
        </div>

        {disabled ? (
          <p className="text-xs fg-secondary">
            This local override disables the inherited hook for this trigger.
          </p>
        ) : (
          <Stack gap="item">
            {actions.map((action, index) => (
              <ActionFrame key={action.uiId} framed={framed}>
                <div className="flex items-center justify-between gap-3">
                  <FormField label="Action type">
                    {(control) => (
                      <SettingsSelect
                        {...control}
                        value={action.type}
                        options={HOOK_ACTION_TYPE_OPTIONS}
                        onValueChange={(next) => {
                          const nextType = parseActionType(next);
                          onChange((current) =>
                            updateEditableHookAction(
                              current,
                              triggerName,
                              index,
                              nextType === 'chat'
                                ? buildChatAction(
                                    '',
                                    undefined,
                                    undefined,
                                    action.uiId,
                                  )
                                : nextType === 'pipeline'
                                  ? buildPipelineAction(
                                      'bundled',
                                      '',
                                      undefined,
                                      action.uiId,
                                    )
                                  : buildCommandAction('', action.uiId),
                            ),
                          );
                        }}
                      />
                    )}
                  </FormField>

                  <div className="flex items-center gap-1 self-start pt-6">
                    {index > 0 && (
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly
                        onClick={() =>
                          onChange((current) =>
                            moveEditableHookAction(
                              current,
                              triggerName,
                              index,
                              index - 1,
                            ),
                          )
                        }
                        aria-label="Move up"
                      >
                        <AppCatalogChevronTopMediumIcon size="sm" />
                      </Button>
                    )}
                    {index < actions.length - 1 && (
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly
                        onClick={() =>
                          onChange((current) =>
                            moveEditableHookAction(
                              current,
                              triggerName,
                              index,
                              index + 1,
                            ),
                          )
                        }
                        aria-label="Move down"
                      >
                        <AppCatalogChevronDownMediumIcon size="sm" />
                      </Button>
                    )}
                    <Button
                      variant="ghost-destructive"
                      size="compact"
                      iconOnly
                      onClick={() =>
                        onChange((current) =>
                          removeEditableHookAction(current, triggerName, index),
                        )
                      }
                      aria-label="Remove action"
                    >
                      <AppCatalogCloseIcon size="sm" />
                    </Button>
                  </div>
                </div>

                <HookActionFields
                  action={action}
                  editorId={`hook-chat-${action.uiId}`}
                  chatContext={chatContext}
                  onBlockedChange={reportBlocked}
                  triggerName={triggerName}
                  onChange={(nextAction) =>
                    onChange((current) =>
                      updateEditableHookAction(
                        current,
                        triggerName,
                        index,
                        nextAction,
                      ),
                    )
                  }
                  pipelineOptions={pipelineOptions}
                  pipelineOptionsLoading={pipelineOptionsLoading}
                  pluginSelectionMode={pluginSelectionMode}
                />
              </ActionFrame>
            ))}
          </Stack>
        )}
      </TriggerFrame>
    );
  };

  const showTriggers = visibleTrigger !== null;
  const showAddForm = typeof visibleTrigger !== 'string' || addFormOpen;
  return (
    <Stack gap="group">
      {showTriggers &&
        (visibleTrigger === undefined
          ? SUPPORTED_HOOK_TRIGGERS.map(renderTriggerEditor)
          : renderTriggerEditor(visibleTrigger))}

      {visibleTrigger === undefined &&
        Object.entries(hooks)
          .filter(
            (entry): entry is [string, EditableHookAction[]] =>
              Array.isArray(entry[1]) &&
              !SUPPORTED_HOOK_TRIGGERS.some((trigger) => trigger === entry[0]),
          )
          .map(([triggerName]) => renderTriggerEditor(triggerName))}

      {!showAddForm && (
        <Button
          className="self-start"
          size="compact"
          onClick={() => setAddFormOpen(true)}
          data-testid="hook-add-another"
        >
          Add another action
        </Button>
      )}
      {showAddForm && (
        <AddFormFrame framed={framed}>
          <Stack gap="inline">
            {framed && (
              <p className="text-s font-medium fg-primary">Add hook action</p>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Trigger">
                {(control) => (
                  <SettingsSelect
                    {...control}
                    width="fill"
                    data-testid="hook-add-trigger"
                    value={newHookTrigger}
                    onValueChange={setNewHookTrigger}
                    options={SUPPORTED_HOOK_TRIGGERS.map((trigger) => ({
                      value: trigger,
                      label: getHookTriggerDisplayName(trigger),
                    }))}
                  />
                )}
              </FormField>

              <FormField label="Action type">
                {(control) => (
                  <SettingsSelect
                    {...control}
                    width="fill"
                    data-testid="hook-add-action-type"
                    value={newActionType}
                    options={HOOK_ACTION_TYPE_OPTIONS}
                    onValueChange={(next) => {
                      const nextType = parseActionType(next);
                      setNewActionType(nextType);
                      setNewAction(createBlankHookAction(nextType));
                    }}
                  />
                )}
              </FormField>
            </div>
          </Stack>

          <div>
            <HookActionFields
              key={newActionGeneration}
              action={newAction}
              editorId={`hook-chat-draft-${newHookTrigger}`}
              chatContext={chatContext}
              onBlockedChange={reportBlocked}
              triggerName={newHookTrigger}
              onChange={setNewAction}
              pipelineOptions={pipelineOptions}
              pipelineOptionsLoading={pipelineOptionsLoading}
              pluginSelectionMode={pluginSelectionMode}
            />
          </div>

          <div className="flex items-end gap-2">
            {allowDisable && (
              <Button
                size="compact"
                onClick={() =>
                  onChange((current) =>
                    setEditableHookDisabled(current, newHookTrigger, true),
                  )
                }
              >
                Disable trigger
              </Button>
            )}
            <Button
              size="compact"
              variant="primary"
              onClick={() => {
                if (!canAddNewAction) {
                  return;
                }

                onChange((current) =>
                  addEditableHookAction(
                    current,
                    newHookTrigger,
                    trimHookActionDraft(newAction),
                  ),
                );
                setNewAction(createBlankHookAction(newActionType));
                setNewActionGeneration((generation) => generation + 1);
                onActionAdded?.(newHookTrigger);
              }}
              disabled={!canAddNewAction}
            >
              Add action
            </Button>
          </div>
        </AddFormFrame>
      )}
    </Stack>
  );
}
