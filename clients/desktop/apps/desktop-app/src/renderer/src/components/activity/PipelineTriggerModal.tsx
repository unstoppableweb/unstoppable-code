import {
  PipelineSourceLabel,
  pipelineOriginLabel,
} from '@canopy/ui-shared/components/EntrySourceLabel';
import { pipelineSupportsExecutionScope } from '@/lib/pipelineExecutionScope';
import {
  Stack,
  ErrorBanner,
  ErrorState,
  Notice,
  Surface,
} from '@canopy/ui-shared/components';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DialogModal } from '@/components/shared/DialogModal';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { FormField } from '@/components/pipeline/shared/FormField';
import { PipelineShareLabel } from '@/components/pipeline/PipelineShareLabel';
import { SelectField } from '@/components/pipeline/shared/SelectField';
import { TextField } from '@/components/pipeline/shared/TextField';
import { TextAreaField } from '@/components/pipeline/shared/TextAreaField';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useCollectionList } from '@/hooks/useCollectionList';
import { useMarketplaceList } from '@/hooks/useMarketplaceList';
import { useSkillList } from '@/hooks/useSkillList';
import { useSharedPipelineList } from '@/hooks/useSharedPipelineList';
import { brandText } from '@/lib/brand';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  getAgentModelAvailability,
  WORKSPACE_ROOT_REPO_ID,
  type AgentModelConfig,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CollectionIndexEntry } from '@canopy/desktop-shared/types/collections';
import type {
  PipelineData,
  PipelineExecutionScope,
  PipelineInfo,
  PipelineInputDef,
  PipelineLookupRequest,
  PipelineModelAlias,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
  PipelinePreferenceLocator,
  PipelineTriggerType,
  ResolvePluginCollectionsResponse,
} from '@canopy/execution-engine/types/pipeline';
import { DEFAULT_PIPELINE_SCOPES } from '@canopy/execution-engine/pipelines/scope';
import { isSharedPipelineLocalId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import type { PluginsCache } from '@canopy/execution-engine/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import {
  resolvePipelineTriggerInputs,
  seedInitialInputValues,
  type TriggerInputResolution,
  validateInputs,
  buildSubmitPayload,
  getVisibleTriggerInputDefs,
  JSON_INPUT_HELPER_TEXT,
} from '@/lib/pipelineTriggerInputs';
import { derivePipelinePreferenceLocator } from '@/lib/pipelinePluginCollections';
import { areAliasPreferencesBlocked } from '@/lib/pipelineModelAliases';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  buildCombinedTriggerRows,
  shouldIncludeSharedRows,
  type PipelineTriggerRow,
} from '@/lib/pipelineTriggerRows';
import { CapabilityPackageReadiness } from '@/components/shared/capability-package/CapabilityPackageReadiness';
import {
  isPipelinePackageRunBlocked,
  useCapabilityPackageReadiness,
} from '@/components/shared/capability-package/useCapabilityPackageReadiness';
import { PipelinePluginCollectionsSection } from './PipelinePluginCollectionsSection';
import { PipelineModelAliasesSection } from './PipelineModelAliasesSection';
import { ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PipelineGlyph, WatcherEyeIcon } from '@canopy/ui-shared/icons';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import {
  WatcherRecipientPicker,
  type WatcherRecipientGroup,
} from '@/components/watchers/WatcherRecipientPicker';
import { WatcherFollowUpButton } from '@/components/watchers/WatcherFollowUpButton';
import type { PipelineWatcherSelection } from './usePipelineRunWatcher';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import {
  rebaseDraftOnSaved,
  stableStringify,
} from './pipelineTriggerModalUtils';
import {
  ChoiceField,
  DialogFormField,
  SearchField,
  Tooltip,
} from '@canopy/ui-shared';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import {
  Button,
  ListRow,
  SegmentedControl,
} from '@canopy/ui-shared/components';

export interface PipelineRepoChoice {
  repoId: string;
  repoName: string;
}

type SourceFilter =
  | 'all'
  | 'bundled'
  | 'user'
  | 'project'
  | 'shared'
  | 'curated';

const SHARED_SEARCH_DEBOUNCE_MS = 300;
const SHARED_SCROLL_THRESHOLD_PX = 80;

function filterAliasPreferencesToAliases(
  preferences: Record<string, PipelineModelAliasPreference>,
  aliases: PipelineModelAlias[],
): Record<string, PipelineModelAliasPreference> {
  const aliasIds = new Set(aliases.map((alias) => alias.id));
  return Object.fromEntries(
    Object.entries(preferences).filter(([aliasId]) => aliasIds.has(aliasId)),
  );
}

const UNRESOLVED_REQUIRED_BLOCKING_MESSAGE =
  "This workflow can't run until all required workflow plugins are installed locally.";
const SAVE_DEFAULTS_SUCCESS_MESSAGE = 'Saved as local defaults.';
const NO_PIPELINES_FOR_CONTEXT_MESSAGE =
  'No workflows available for this context.';

interface TriggerLabels {
  title: string;
  selectSubtitle: string;
  emptyMessage: string;
}

/**
 * Plugin-collection draft snapshot carried out of the trigger modal alongside
 * the run payload. The executor receives both fields so a draft (unsaved)
 * collection edit applies to this run only.
 */
export interface PipelinePluginCollectionRunContext {
  preferences: Record<string, PipelinePluginCollectionPreference>;
  /**
   * Draft per-alias model preferences carried alongside the plugin-collection
   * draft. Sent to the executor as `modelAliasPreferences` so an unsaved alias
   * customization applies to this run only. May carry `reset` markers.
   */
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  modelConfig?: AgentModelConfig;
}

export interface PipelineTriggerModalProps {
  triggerType: PipelineTriggerType;
  labels: TriggerLabels;
  cwd?: string;
  repoChoices?: PipelineRepoChoice[];
  defaultRepoId?: string;
  /**
   * Reports the selected working directory, initially and on each change, for
   * callers whose discovery `cwd` depends on it.
   */
  onRepoChange?: (repoId: string | undefined) => void;
  /**
   * Execution scope of the surface opening the modal. Worktree surfaces pass
   * `worktree`, directory-only surfaces pass `directory`, global surfaces pass
   * `global`. Selectable pipelines are filtered with the capability relation
   * (`pipelineSupportsExecutionScope`), NOT strict membership — a `worktree`
   * surface still lists `directory`/legacy no-`scope` pipelines. Defaults to
   * `directory` so callers that omit it keep the conservative behavior of
   * hiding `worktree`-only pipelines.
   */
  executionScope?: PipelineExecutionScope;
  /**
   * Every execution scope the surface can run in, when it can run in more
   * than one (Workflows: no project, plus the current task's scope). A row is
   * listed when it supports any of them. Overrides {@link executionScope}.
   */
  executionScopes?: readonly PipelineExecutionScope[];
  /**
   * The surface's folder and scope are still resolving. The list waits, so it
   * loads once for the final surface instead of again when they settle.
   */
  contextPending?: boolean;
  /**
   * Resolves the selected pipeline's destination and owner fields. Omitted on
   * task surfaces, which keep running in their task.
   */
  runContextReview?: (
    pipeline: PipelineData,
  ) => PipelineRunContextReview | null;
  /** Changing it re-reads the pipelines, such as after a refused start. */
  reloadToken?: number;
  /**
   * Preselects this pipeline in the select step once the list loads
   * (CAN-2361 PR2b: the share landing's "Try now" opens the dispatch modal
   * with the saved pipeline highlighted). Preselect ONLY — the modal never
   * auto-advances, because Continue runs immediately for input-less
   * pipelines and nothing on this surface may execute without an explicit
   * click. Ignored when the id is not in the loaded list.
   */
  initialPipelineId?: string;
  /**
   * Seed values for the configure step's inputs, applied only while the
   * selected pipeline is `initialPipelineId` and only for input names that
   * pipeline declares; the user can still change everything before running.
   */
  initialInputs?: Record<string, string>;
  onClose: () => void;
  onRun: (
    pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  onClearError?: () => void;
  runLabel?: string;
  runLoadingLabel?: string;
  ownerDocument?: Document;
  /**
   * When provided (and non-empty), renders a watcher toggle in the footer that
   * lets the user pick a chat to notify when the launched pipeline completes.
   * The selected recipient (or `null` when the toggle is off) is reported via
   * {@link onWatcherSelectionChange}; the caller creates the watcher once the
   * execution has an id.
   */
  watcherRecipientGroups?: WatcherRecipientGroup[];
  /**
   * Reports the current watcher selection (destination chat plus optional
   * follow-up instruction), or `null` when the watcher toggle is off.
   */
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

/**
 * Where and as whom the selected pipeline runs (CAN-4542), as the host
 * resolves it for one pipeline.
 */
export interface PipelineRunContextReview {
  /** Fields the configure step shows above the inputs. */
  fields: ReactNode;
  /** A choice is shown, so Continue opens the configure step even without inputs. */
  needsReview: boolean;
  /** Run stays disabled: owners are loading, failed, or none is chosen. */
  runBlocked: boolean;
  /** Why Run is off when nothing in the dialog can turn it on. */
  blockedReason?: string;
  /** The run targets the current task, so repository and watcher controls apply. */
  targeted: boolean;
  /**
   * The run executes off this computer (Run on: Cloud, CAN-6187), so this
   * computer's model settings, such as Fast mode, don't apply to it.
   */
  executesElsewhere?: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; pipelines: PipelineData[]; curated: PipelineInfo[] };

type ModalStep = 'select' | 'configure';

function arePreferencesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

interface SharedPipelineSelectorProps {
  state: ReturnType<typeof useSharedPipelineList>;
  /**
   * Shared rows already filtered by the surface's execution scope. The
   * selector renders these, while `state` still drives loading/error status
   * and the "are there any rows at all" distinction for the empty state.
   */
  rows: PipelineInfo[];
  onSelect: (remoteId: string, localId: string) => Promise<void>;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onOpenAccountSettings: () => void;
  selectedId: string | null;
  hydrating: string | null;
  hydrateError: string | null;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * Shared-pipeline list rendered inside the trigger modal when the user
 * selects the `Shared` filter. Infinite scroll and live loading/error states
 * are driven by the singleton {@link useSharedPipelineList}. The desktop app
 * is bound to a single Canopy Cloud backend, so the selector renders one
 * list with no server tabs.
 */
function SharedPipelineSelector({
  state,
  rows,
  onSelect,
  onScroll,
  onOpenAccountSettings,
  selectedId,
  hydrating,
  hydrateError,
  containerRef,
}: SharedPipelineSelectorProps): JSX.Element {
  const cloudReady = isCanopyCloudConnected(state.cloudAccount);
  if (!state.cloudLoading && !cloudReady) {
    return (
      <div className="flex flex-col py-6 text-center text-s fg-secondary gap-2">
        <div>No {brandText.appName} Cloud account configured.</div>
        <Button
          className="self-center"
          size="compact"
          onClick={onOpenAccountSettings}
        >
          Open account settings
        </Button>
      </div>
    );
  }
  return (
    <Stack gap="inline" data-testid="pipeline-trigger-modal-shared-selector">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex flex-col max-h-72 overflow-y-auto gap-1 [&>*]:shrink-0"
      >
        {state.loading && state.rows.length === 0 && (
          <div className="py-6 text-center text-s fg-secondary">
            Loading shared workflows…
          </div>
        )}
        <ErrorBanner className="" error={state.error} />
        {state.loaded &&
          rows.length === 0 &&
          !state.error &&
          !state.loadingMore &&
          !state.nextCursor && (
            <div className="py-6 text-center text-s fg-secondary">
              {state.rows.length > 0
                ? NO_PIPELINES_FOR_CONTEXT_MESSAGE
                : 'No shared workflows found.'}
            </div>
          )}
        {state.loaded &&
          rows.length === 0 &&
          !state.error &&
          (state.loadingMore || state.nextCursor) && (
            <div className="py-6 text-center text-s fg-secondary">
              Loading shared workflows…
            </div>
          )}
        {rows.map((info) => {
          const isSelected = info.id === selectedId;
          const isHydrating = info.id === hydrating;
          return (
            <ListRow
              key={info.id}
              disabled={isHydrating}
              selected={isSelected}
              aria-current={isSelected ? 'true' : undefined}
              onClick={() => {
                if (!info.remoteId) return;
                void onSelect(info.remoteId, info.id);
              }}
              icon={<PipelineGlyph icon={info.icon} />}
              description={
                info.description ? (
                  <span title={info.description}>{info.description}</span>
                ) : undefined
              }
              trailing={
                <span className="inline-flex items-center gap-2">
                  <PipelineShareLabel
                    shareScope={info.shareScope}
                    owner={info.owner}
                  />
                  {isHydrating && <LoadingSpinner />}
                </span>
              }
            >
              {info.name}
            </ListRow>
          );
        })}
        {state.loadingMore && (
          <div className="py-2 text-center text-xs fg-secondary">
            Loading more…
          </div>
        )}
      </div>
      <ErrorBanner className="" error={hydrateError} />
    </Stack>
  );
}

function InputField({
  name,
  def,
  value,
  error,
  onChange,
  disabled,
}: {
  name: string;
  def: PipelineInputDef;
  value: string;
  error: string | undefined;
  onChange: (name: string, value: string) => void;
  disabled: boolean;
}): JSX.Element {
  const inputType = def.type ?? 'string';
  const label = def.required ? `${name} *` : name;
  // Structured inputs get an explicit helper line; the declared description
  // still wins when the pipeline author supplied one.
  const hint =
    inputType === 'json'
      ? (def.description ?? JSON_INPUT_HELPER_TEXT)
      : def.description;

  return (
    <FormField
      label={label}
      htmlFor={`trigger-input-${name}`}
      hint={hint}
      error={error}
    >
      {inputType === 'choice' && def.options ? (
        <SelectField
          id={`trigger-input-${name}`}
          value={value}
          onChange={(e) => onChange(name, e.target.value)}
          options={def.options.map((opt) => ({ value: opt, label: opt }))}
          placeholder="Select…"
          disabled={disabled}
        />
      ) : inputType === 'boolean' ? (
        <SelectField
          id={`trigger-input-${name}`}
          value={value}
          onChange={(e) => onChange(name, e.target.value)}
          options={[
            { value: 'true', label: 'True' },
            { value: 'false', label: 'False' },
          ]}
          placeholder={def.required ? 'Select…' : '(unset)'}
          disabled={disabled}
        />
      ) : inputType === 'number' ? (
        <TextField
          id={`trigger-input-${name}`}
          type="number"
          value={value}
          onChange={(e) => onChange(name, e.target.value)}
          min={def.min}
          max={def.max}
          placeholder={def.description ?? ''}
          disabled={disabled}
        />
      ) : inputType === 'json' ? (
        <TextAreaField
          id={`trigger-input-${name}`}
          data-testid={`trigger-input-json-${name}`}
          value={value}
          onChange={(e) => onChange(name, e.target.value)}
          placeholder={JSON_INPUT_HELPER_TEXT}
          spellCheck={false}
          disabled={disabled}
        />
      ) : (
        <TextField
          id={`trigger-input-${name}`}
          value={value}
          onChange={(e) => onChange(name, e.target.value)}
          placeholder={def.description ?? ''}
          disabled={disabled}
        />
      )}
    </FormField>
  );
}

function resolveInitialRepoId(
  choices: PipelineRepoChoice[] | undefined,
  defaultRepoId: string | undefined,
): string | undefined {
  if (!choices || choices.length === 0) return undefined;
  if (defaultRepoId && choices.some((c) => c.repoId === defaultRepoId)) {
    return defaultRepoId;
  }
  const rootChoice = choices.find((c) => c.repoId === WORKSPACE_ROOT_REPO_ID);
  return rootChoice?.repoId ?? choices[0].repoId;
}

function buildCollectionCatalogSignature(args: {
  skills: readonly InstalledSkillInfo[];
  marketplaceCache: PluginsCache | null;
  collections: readonly CollectionIndexEntry[];
}): string {
  const skillParts = args.skills
    .map((skill) =>
      [
        skill.sourceId,
        skill.name,
        skill.updatedAt,
        skill.shareableSource
          ? JSON.stringify(skill.shareableSource)
          : 'local-only',
      ].join('\0'),
    )
    .sort();
  const pluginParts = (args.marketplaceCache?.marketplaces ?? [])
    .flatMap((marketplace) =>
      marketplace.plugins.map((plugin) =>
        [
          marketplace.id,
          marketplace.sourceUrl,
          marketplace.lastUpdated,
          plugin.name,
          plugin.externalSource?.url ?? '',
          plugin.cachePath ?? '',
          plugin.cachedAt ?? '',
        ].join('\0'),
      ),
    )
    .sort();
  const collectionParts = args.collections
    .map((collection) =>
      [
        collection.id,
        collection.updatedAt,
        collection.skillCount,
        collection.pluginCount,
      ].join('\0'),
    )
    .sort();

  return [
    skillParts.join('\n'),
    args.marketplaceCache?.lastRefreshed ?? '',
    pluginParts.join('\n'),
    collectionParts.join('\n'),
  ].join('\n---\n');
}

export function PipelineTriggerModal({
  triggerType,
  labels,
  cwd,
  repoChoices,
  defaultRepoId,
  onRepoChange,
  executionScope = 'directory',
  executionScopes,
  contextPending = false,
  runContextReview,
  reloadToken = 0,
  initialPipelineId,
  initialInputs,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  onClearError,
  runLabel = 'Run',
  runLoadingLabel = 'Running…',
  ownerDocument,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: PipelineTriggerModalProps): JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  // Callers pass a stable `executionScopes`; the list reloads when it changes.
  const surfaceScopes = useMemo(
    () => executionScopes ?? [executionScope],
    [executionScope, executionScopes],
  );
  const supportsSurface = useCallback(
    (info: PipelineInfo): boolean =>
      surfaceScopes.some(
        (scope) =>
          // A project file only runs in its checkout, never with no project.
          (scope !== 'global' || info.source !== 'project') &&
          pipelineSupportsExecutionScope(info, scope),
      ),
    [surfaceScopes],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<ModalStep>('select');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>(() =>
    resolveInitialRepoId(repoChoices, defaultRepoId),
  );
  const [fastMode, setFastMode] = useState(false);

  // Watcher toggle state (only relevant when `watcherRecipientGroups` is set).
  const [watcherEnabled, setWatcherEnabled] = useState(false);
  const [watcherRecipient, setWatcherRecipient] =
    useState<AppAdvisorWatcherDestination | null>(null);
  const [watcherFollowUp, setWatcherFollowUp] = useState('');

  // Plugin-collection state
  const [collectionDraft, setCollectionDraft] = useState<
    Record<string, PipelinePluginCollectionPreference>
  >({});
  // Baseline the draft was seeded from (the persisted/effective defaults), used
  // to detect whether the user has actually changed plugin selections so the
  // Save-plugin-selections-as-defaults button can enable only when there is a
  // change to persist.
  const [collectionDefaultsBaseline, setCollectionDefaultsBaseline] = useState<
    Record<string, PipelinePluginCollectionPreference>
  >({});
  const [collectionPreview, setCollectionPreview] = useState<
    PipelinePluginDefaultPreviewItem[]
  >([]);
  const [collectionValidation, setCollectionValidation] = useState<
    ResolvePluginCollectionsResponse['validation'] | null
  >(null);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionResolving, setCollectionResolving] = useState(false);
  const [collectionDraftSeededFor, setCollectionDraftSeededFor] = useState<
    string | null
  >(null);

  // Model-alias state, parallel to the plugin-collection draft/baseline. The
  // draft is seeded from `loadModelAliasPreferences` and may carry `reset`
  // markers; it is sent to the executor as `modelAliasPreferences`.
  const [aliasDraft, setAliasDraft] = useState<
    Record<string, PipelineModelAliasPreference>
  >({});
  const [aliasDefaultsBaseline, setAliasDefaultsBaseline] = useState<
    Record<string, PipelineModelAliasPreference>
  >({});
  const [aliasDraftSeededFor, setAliasDraftSeededFor] = useState<string | null>(
    null,
  );

  // Local Agents power the Agent-mode alias picker and the run-blocking
  // validation (an Agent preference that is not available locally blocks Run).
  const agents = useAgentsStore((s) => s.agents);
  const agentsLoaded = useAgentsStore((s) => s.loaded);
  const loadAgents = useAgentsStore((s) => s.load);
  useEffect(() => {
    if (!agentsLoaded) {
      void loadAgents();
    }
  }, [agentsLoaded, loadAgents]);

  const [disabledPipelineIds, setDisabledPipelineIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    let cancelled = false;
    window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setFastMode(
          preferences.providerModelConfigDefaults?.codex?.fastMode ??
            preferences.codexFastModeDefaultEnabled ??
            false,
        );
        setDisabledPipelineIds(new Set(preferences.disabledPipelineIds ?? []));
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Shared pipelines: lazy-loaded from the configured Canopy Cloud backend
  // with cursor pagination. We also cache hydrated shared `PipelineData`
  // here so selecting a row never re-fetches the same pipeline twice.
  const sharedList = useSharedPipelineList({ triggerType });
  const {
    loadMoreShared,
    refreshShared,
    setFilters: setSharedFilters,
    cloudAccount: sharedCloudAccount,
    rows: sharedRows,
    loading: sharedLoading,
    loadingMore: sharedLoadingMore,
    loaded: sharedLoaded,
    nextCursor: sharedNextCursor,
  } = sharedList;
  const triggerScopedSharedRows = useMemo(
    () =>
      sharedRows.filter(
        (info) =>
          !disabledPipelineIds.has(info.id) &&
          (!info.triggerTypes || info.triggerTypes.includes(triggerType)),
      ),
    [sharedRows, triggerType, disabledPipelineIds],
  );

  // Shared rows for the dedicated Shared tab are rendered directly (not through
  // `buildCombinedTriggerRows`), so apply the same scope filter to them.
  const scopedSharedRows = useMemo(
    (): PipelineInfo[] => triggerScopedSharedRows.filter(supportsSurface),
    [triggerScopedSharedRows, supportsSurface],
  );

  const triggerScopedSharedList = useMemo(
    () => ({
      ...sharedList,
      rows: triggerScopedSharedRows,
    }),
    [sharedList, triggerScopedSharedRows],
  );
  const cloudReady = isCanopyCloudConnected(sharedCloudAccount);
  const [sharedHydratedById, setSharedHydratedById] = useState<
    Record<string, PipelineData>
  >({});
  const [sharedHydrating, setSharedHydrating] = useState<string | null>(null);
  const [sharedHydrateError, setSharedHydrateError] = useState<string | null>(
    null,
  );
  const selectionGeneration = useRef(0);
  // Bumped when the selected workflow's defaults are reseeded, so a save that
  // finishes afterwards leaves the newly selected workflow's state alone.
  const defaultsGeneration = useRef(0);
  useEffect(() => {
    selectionGeneration.current += 1;
    setSharedHydratedById({});
    setSharedHydrating(null);
    setSharedHydrateError(null);
    setSelectedId((id) =>
      id?.startsWith('curated:') || id?.startsWith('shared:') ? null : id,
    );
    return (): void => {
      selectionGeneration.current += 1;
    };
  }, [sharedCloudAccount]);
  useEffect(() => {
    selectionGeneration.current += 1;
    setSharedHydrating(null);
  }, [searchQuery, sourceFilter]);
  const sharedListContainerRef = useRef<HTMLDivElement | null>(null);
  const debouncedSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Counts defaults saves still waiting for the store. Edits reset
  // `saveDefaultsState`, so this alone keeps a second save (which would
  // send a baseline the first save is about to replace) from starting.
  const [defaultsSavesInFlight, setDefaultsSavesInFlight] = useState(0);
  const [saveDefaultsState, setSaveDefaultsState] = useState<
    | { status: 'idle' }
    | { status: 'saving' }
    | { status: 'saved' }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const { skills: catalogSkills, refresh: refreshSkills } = useSkillList();
  const { cache: catalogMarketplaceCache, refresh: refreshMarketplaces } =
    useMarketplaceList();
  const { collections: catalogCollections, refresh: refreshCollections } =
    useCollectionList();
  const collectionCatalogSignature = useMemo(
    () =>
      buildCollectionCatalogSignature({
        skills: catalogSkills,
        marketplaceCache: catalogMarketplaceCache,
        collections: catalogCollections,
      }),
    [catalogCollections, catalogMarketplaceCache, catalogSkills],
  );

  useEffect(() => {
    setSelectedRepoId((prev) => {
      if (!repoChoices || repoChoices.length === 0) return undefined;
      if (prev && repoChoices.some((c) => c.repoId === prev)) return prev;
      return resolveInitialRepoId(repoChoices, defaultRepoId);
    });
  }, [repoChoices, defaultRepoId]);

  useEffect(() => {
    onRepoChange?.(selectedRepoId);
  }, [onRepoChange, selectedRepoId]);

  const showRepoDropdown = (repoChoices?.length ?? 0) > 1;

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (contextPending) return;
      try {
        const [listResult, projectResult] = await Promise.all([
          window.pipelines.list(),
          cwd
            ? window.pipelines.discoverProject(cwd)
            : Promise.resolve({ success: true, data: [] }),
        ]);
        if (cancelled) return;

        const allInfos = [
          ...(listResult.success && listResult.data ? listResult.data : []),
          ...(projectResult.success && projectResult.data
            ? projectResult.data
            : []),
        ];

        if (allInfos.length === 0 && !listResult.success) {
          setLoadState({
            status: 'error',
            message: listResult.error ?? 'Failed to load workflows',
          });
          return;
        }

        const buildLookup = (info: PipelineInfo): PipelineLookupRequest => {
          if (info.source === 'project' && cwd && info.filePath) {
            return { id: info.id, cwd, filePath: info.filePath };
          }
          return info.id;
        };

        const results = await Promise.all(
          allInfos
            .filter((info) => info.source !== 'curated')
            .map((info) => window.pipelines.get(buildLookup(info))),
        );
        if (cancelled) return;

        const loaded = results
          .flatMap((r) => (r.success && r.data ? [r.data] : []))
          .filter((p) => getTriggerTypes(p.content.on).includes(triggerType));

        setLoadState({
          status: 'loaded',
          pipelines: loaded,
          curated: allInfos.filter((info) => info.source === 'curated'),
        });
        if (
          initialPipelineId &&
          loaded.some((p) => p.info.id === initialPipelineId)
        ) {
          setSelectedId((prev) => prev ?? initialPipelineId);
        } else if (
          initialPipelineId &&
          allInfos.some(
            (info) =>
              info.source === 'curated' &&
              info.id === initialPipelineId &&
              info.triggerTypes?.includes(triggerType) &&
              supportsSurface(info),
          )
        ) {
          const generation = ++selectionGeneration.current;
          setSharedHydrating(initialPipelineId);
          try {
            const result = await window.pipelines.get({
              source: 'curated',
              id: initialPipelineId,
            });
            if (cancelled || generation !== selectionGeneration.current) return;
            if (!result.success || !result.data)
              throw new Error(
                result.error ?? 'Failed to download curated workflow',
              );
            if (
              !getTriggerTypes(result.data.content.on).includes(triggerType) ||
              !supportsSurface(result.data.info)
            ) {
              throw new Error(
                'This workflow no longer supports this trigger or execution scope. Refresh the workflow list.',
              );
            }
            const data = result.data;
            setSharedHydratedById((prev) => ({
              ...prev,
              [initialPipelineId]: data,
            }));
            setSelectedId(initialPipelineId);
          } catch (err) {
            if (cancelled || generation !== selectionGeneration.current) return;
            setSharedHydrateError(
              err instanceof Error
                ? err.message
                : 'Failed to download curated workflow',
            );
          } finally {
            if (!cancelled && generation === selectionGeneration.current)
              setSharedHydrating(null);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Unknown error loading workflows';
          setLoadState({ status: 'error', message });
        }
      }
    }

    void load();
    return (): void => {
      cancelled = true;
    };
  }, [
    triggerType,
    cwd,
    contextPending,
    initialPipelineId,
    sharedCloudAccount,
    supportsSurface,
    reloadToken,
  ]);

  const selectedPipeline = useMemo((): PipelineData | null => {
    if (!selectedId) return null;
    if (
      isSharedPipelineLocalId(selectedId) ||
      selectedId.startsWith('curated:')
    ) {
      return sharedHydratedById[selectedId] ?? null;
    }
    if (loadState.status !== 'loaded') return null;
    return loadState.pipelines.find((p) => p.info.id === selectedId) ?? null;
  }, [loadState, selectedId, sharedHydratedById]);

  const selectedPipelineLocator = useMemo(
    () =>
      selectedPipeline
        ? derivePipelinePreferenceLocator(selectedPipeline.info)
        : null,
    [selectedPipeline],
  );

  // Local readiness of the selected pipeline's packaged content. Resolves to
  // null when the pipeline has no package (or the running build predates the
  // readiness IPC), so Run gating is unchanged for every existing pipeline.
  const readinessLookup = useMemo((): PipelineLookupRequest | null => {
    if (!selectedPipeline) return null;
    if (selectedPipeline.info.source === 'shared') {
      // Only a `package` share carries requirements to probe. Main reports
      // `invalid` for every other share and `runPipeline` never gates them
      // (CAN-3021), so probing one here would block a runnable pipeline.
      return selectedPipeline.info.remoteId &&
        selectedPipeline.info.distributionMode === 'package'
        ? { source: 'shared', remoteId: selectedPipeline.info.remoteId }
        : null;
    }
    if (
      selectedPipeline.info.source !== 'user' &&
      selectedPipeline.info.source !== 'bundled'
    ) {
      return null;
    }
    return {
      id: selectedPipeline.info.id,
      source: selectedPipeline.info.source,
    };
  }, [selectedPipeline]);
  const readinessOwner = useMemo(
    () =>
      readinessLookup
        ? ({ kind: 'pipeline', pipeline: readinessLookup } as const)
        : null,
    [readinessLookup],
  );
  const { readiness: packageReadiness, loading: packageReadinessLoading } =
    useCapabilityPackageReadiness(readinessOwner);
  const packageSetupBlocked = isPipelinePackageRunBlocked(packageReadiness);

  const hasCollections =
    (selectedPipeline?.content.plugin_collections?.length ?? 0) > 0;
  const collectionDraftSeeded =
    !hasCollections ||
    (selectedPipeline !== null &&
      collectionDraftSeededFor === selectedPipeline.info.id);

  const pipelineAliases = useMemo<PipelineModelAlias[]>(
    () => selectedPipeline?.content.model_aliases ?? [],
    [selectedPipeline],
  );
  const hasAliases = pipelineAliases.length > 0;
  const aliasDraftSeeded =
    !hasAliases ||
    (selectedPipeline !== null &&
      aliasDraftSeededFor === selectedPipeline.info.id);
  const aliasReadyToRun = !hasAliases || aliasDraftSeeded;
  const aliasesBlocked = useMemo(() => {
    if (!hasAliases) return false;
    return areAliasPreferencesBlocked(pipelineAliases, aliasDraft, {
      pluginCollectionIds: new Set(
        (selectedPipeline?.content.plugin_collections ?? []).map((c) => c.id),
      ),
      availableAgentIds: new Set(
        agents
          .filter((agent) => getAgentModelAvailability(agent.id).available)
          .map((agent) => agent.id),
      ),
    });
  }, [hasAliases, pipelineAliases, aliasDraft, selectedPipeline, agents]);

  const viewerId = cloudReady
    ? (sharedCloudAccount?.account?.id ?? null)
    : null;
  const combinedRows = useMemo((): PipelineTriggerRow[] => {
    if (loadState.status !== 'loaded') return [];
    return buildCombinedTriggerRows({
      localPipelines: loadState.pipelines,
      curatedRows: loadState.curated,
      sharedRows: triggerScopedSharedRows,
      sourceFilter,
      searchQuery,
      triggerType,
      disabledIds: disabledPipelineIds,
      viewerId,
      isListed: supportsSurface,
    });
  }, [
    loadState,
    searchQuery,
    sourceFilter,
    triggerScopedSharedRows,
    triggerType,
    disabledPipelineIds,
    viewerId,
    supportsSurface,
  ]);

  // Filter the unified list by the surface's execution scope using the
  // capability relation (NOT strict membership): a `worktree` surface still
  // lists `directory`/legacy no-`scope` pipelines, while a `directory`/`global`
  // surface hides `worktree`-only pipelines.
  const scopedRows = useMemo(
    (): PipelineTriggerRow[] =>
      combinedRows.filter((row) => supportsSurface(row.info)),
    [combinedRows, supportsSurface],
  );

  // Distinguish "no rows match the search" from "rows exist but none are valid
  // in this execution context" so the empty state can show the right copy.
  const hiddenOnlyByScope = combinedRows.length > 0 && scopedRows.length === 0;

  // Whether the configured Cloud account still has loaded rows (or is
  // loading them). Used so the All-view empty state doesn't misreport
  // "no pipelines" while shared rows are still streaming in.
  const sharedHasPendingOrRows = useMemo((): boolean => {
    if (!shouldIncludeSharedRows(sourceFilter)) return false;
    if (!cloudReady) return false;
    if (sharedLoading || sharedLoadingMore) return true;
    if (sharedNextCursor) return true;
    return scopedSharedRows.length > 0;
  }, [
    cloudReady,
    sharedNextCursor,
    scopedSharedRows,
    sharedLoading,
    sharedLoadingMore,
    sourceFilter,
  ]);

  // Driven by infinite-scroll: true when the cloud list is paginating
  // beyond its first page. Used to render the inline "Loading more..."
  // indicator below the unified list.
  const anySharedLoadingMore = sharedLoadingMore;

  const sourceFilterOptions = useMemo((): SourceFilter[] => {
    const localSources =
      loadState.status === 'loaded'
        ? new Set([
            ...loadState.pipelines.map((p) => p.info.source),
            ...loadState.curated.map((info) => info.source),
          ])
        : new Set<PipelineInfo['source']>();
    const hasSharedAccount = cloudReady;
    // Always show the bar when the Cloud account is configured (so the
    // user can switch to the Shared tab even before any local pipelines
    // load), or when there's more than one local source available.
    if (localSources.size <= 1 && !hasSharedAccount) return [];
    const options: SourceFilter[] = ['all'];
    if (localSources.has('user')) options.push('user');
    if (localSources.has('project')) options.push('project');
    if (localSources.has('bundled')) options.push('bundled');
    if (localSources.has('curated')) options.push('curated');
    if (hasSharedAccount) options.push('shared');
    return options;
  }, [loadState, cloudReady]);

  // Kick off the first-page fetch for the configured Cloud account as soon
  // as the modal opens — the All view interleaves shared rows alongside
  // locals, so we cannot wait for the user to enter the Shared tab.
  useEffect(() => {
    if (!cloudReady) return;
    if (sharedLoaded || sharedLoading) return;
    void refreshShared();
  }, [cloudReady, refreshShared, sharedLoaded, sharedLoading]);

  // Debounce the search query when feeding it to the shared list (300ms
  // per the plan). Local pipelines continue to filter live in-memory via
  // `combinedRows`. Shared rows are filtered server-side through
  // `sharedList.setFilters({ q })`, which fires whenever shared rows are
  // visible — i.e. on the All filter (blends locals + shared) and on the
  // Shared filter (shared-only).
  useEffect(() => {
    if (!shouldIncludeSharedRows(sourceFilter)) {
      // Clear any pending debounce. We do NOT reset shared filters here
      // because the user may switch back to All and expect the current
      // query to keep applying to shared rows; leaving the filter intact
      // lets the next All-mode search continue without an extra round-trip.
      if (debouncedSearchTimerRef.current) {
        clearTimeout(debouncedSearchTimerRef.current);
        debouncedSearchTimerRef.current = null;
      }
      return;
    }
    if (debouncedSearchTimerRef.current) {
      clearTimeout(debouncedSearchTimerRef.current);
    }
    debouncedSearchTimerRef.current = setTimeout(() => {
      setSharedFilters({
        triggerType,
        q: searchQuery.trim() || undefined,
      });
    }, SHARED_SEARCH_DEBOUNCE_MS);
    return (): void => {
      if (debouncedSearchTimerRef.current) {
        clearTimeout(debouncedSearchTimerRef.current);
        debouncedSearchTimerRef.current = null;
      }
    };
  }, [searchQuery, setSharedFilters, sourceFilter, triggerType]);

  // Bottom-of-list scroll handler. The shared list paginates the singleton
  // Cloud-backed state; `useSharedPipelineList.loadMoreShared` guards against
  // double-firing via the `loading || loadingMore || !nextCursor` check, so
  // calling it eagerly is safe.
  const handleListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      const target = event.currentTarget;
      const distanceFromBottom =
        target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceFromBottom > SHARED_SCROLL_THRESHOLD_PX) return;
      if (sourceFilter !== 'shared' && sourceFilter !== 'all') return;
      void loadMoreShared();
    },
    [loadMoreShared, sourceFilter],
  );

  useEffect(() => {
    if (!shouldIncludeSharedRows(sourceFilter)) return;
    if (!cloudReady || !sharedLoaded) return;
    if (sharedLoading || sharedLoadingMore) return;
    if (!sharedNextCursor || scopedSharedRows.length > 0) return;
    void loadMoreShared();
  }, [
    cloudReady,
    loadMoreShared,
    scopedSharedRows.length,
    sharedLoaded,
    sharedLoading,
    sharedLoadingMore,
    sharedNextCursor,
    sourceFilter,
  ]);

  const handleSelectCurated = async (info: PipelineInfo): Promise<void> => {
    const generation = ++selectionGeneration.current;
    setSelectedId(null);
    setSharedHydrating(info.id);
    setSharedHydrateError(null);
    try {
      const result = await window.pipelines.get({
        source: 'curated',
        id: info.id,
      });
      if (generation !== selectionGeneration.current) return;
      if (!result.success || !result.data) {
        throw new Error(result.error ?? 'Failed to download curated workflow');
      }
      if (
        !getTriggerTypes(result.data.content.on).includes(triggerType) ||
        !supportsSurface(result.data.info)
      ) {
        throw new Error(
          'This workflow no longer supports this trigger or execution scope. Refresh the workflow list.',
        );
      }
      const data = result.data;
      setSharedHydratedById((prev) => ({ ...prev, [info.id]: data }));
      handleSelectPipeline(info.id);
    } catch (error) {
      if (generation !== selectionGeneration.current) return;
      setSharedHydrateError(
        error instanceof Error
          ? error.message
          : 'Failed to download curated workflow',
      );
    } finally {
      if (generation === selectionGeneration.current) setSharedHydrating(null);
    }
  };

  const handleSelectShared = useCallback(
    async (remoteId: string, localId: string): Promise<void> => {
      const generation = ++selectionGeneration.current;
      setSelectedId(null);
      // Hydrate first if we don't already have the parsed pipeline. The
      // executor needs `pipeline.content` available before launching, so
      // this must complete before `handleSelectPipeline` is called.
      if (!sharedHydratedById[localId]) {
        setSharedHydrating(localId);
        setSharedHydrateError(null);
        try {
          const result = await window.pipelines.getShared({ remoteId });
          if (generation !== selectionGeneration.current) return;
          if (!result.success || !result.data) {
            setSharedHydrateError(
              result.error ?? 'Failed to load shared workflow',
            );
            return;
          }
          const detail = result.data;
          const content = parsePipelineText(detail.rawPipeline);
          const info: PipelineInfo = {
            id: localId,
            name: detail.name,
            filename: '',
            description: detail.description,
            icon: detail.icon,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            triggerTypes: detail.triggerTypes,
            scopes: detail.scopes ?? [...DEFAULT_PIPELINE_SCOPES],
            source: 'shared',
            readonly: !detail.canUpdate,
            serverId: CANOPY_CLOUD_SERVER_ID,
            remoteId: detail.id,
            canUpdate: detail.canUpdate,
            canDelete: detail.canDelete,
            shareScope: detail.shareScope ?? 'private',
            distributionMode: detail.distributionMode ?? 'definition_only',
            ...(detail.owner ? { owner: detail.owner } : {}),
          };
          const data: PipelineData = { info, content };
          setSharedHydratedById((prev) => ({ ...prev, [localId]: data }));
        } catch (err: unknown) {
          if (generation !== selectionGeneration.current) return;
          setSharedHydrateError(
            err instanceof Error
              ? err.message
              : 'Failed to load shared workflow',
          );
          return;
        } finally {
          if (generation === selectionGeneration.current)
            setSharedHydrating(null);
        }
      }
      handleSelectPipeline(localId);
    },
    // handleSelectPipeline is declared below; lint-disable to keep the
    // declaration order readable. The handler doesn't capture stale refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sharedHydratedById],
  );

  const selectedInputState = useMemo((): TriggerInputResolution => {
    return resolvePipelineTriggerInputs(
      selectedPipeline?.content ?? null,
      triggerType,
    );
  }, [selectedPipeline, triggerType]);

  const selectedInputDefs = useMemo(
    () => getVisibleTriggerInputDefs(selectedInputState.inputDefs),
    [selectedInputState.inputDefs],
  );
  const selectedPipelineError = selectedInputState.error;
  const hasInputs = Object.keys(selectedInputDefs).length > 0;
  const packageNeedsReview =
    packageReadiness !== null &&
    (packageReadiness.status !== 'ready' ||
      packageReadiness.requirements.some(
        (requirement) => requirement.status !== 'available',
      ));
  const runContext =
    selectedPipeline && runContextReview
      ? runContextReview(selectedPipeline)
      : null;
  // A destination or owner to confirm keeps an input-less pipeline from
  // running on Continue.
  const needsRunContextReview = runContext?.needsReview ?? false;
  const runContextBlocked = runContext?.runBlocked ?? false;
  const runContextBlockedReason = runContextBlocked
    ? runContext?.blockedReason
    : undefined;
  const showTargetControls = runContext?.targeted ?? true;
  // A run off this computer (Run on: Cloud) takes neither this computer's
  // model settings nor its package setup; the cloud checks its own.
  const runsOnThisComputer = runContext?.executesElsewhere !== true;
  const localSetupBlocked = packageSetupBlocked && runsOnThisComputer;
  const hasConfigurationStep =
    hasInputs ||
    hasCollections ||
    hasAliases ||
    packageNeedsReview ||
    needsRunContextReview;

  // ---------------------------------------------------------------------
  // Plugin collection lifecycle
  // ---------------------------------------------------------------------

  // Seed local draft state when a pipeline is selected. Project pipelines
  // (with a locator) seed from stored prefs; inline pipelines start empty.
  useEffect(() => {
    let cancelled = false;
    defaultsGeneration.current += 1;
    setSaveDefaultsState({ status: 'idle' });
    setCollectionError(null);
    setCollectionDraftSeededFor(null);

    if (!selectedPipeline || !hasCollections) {
      setCollectionDraft({});
      setCollectionDefaultsBaseline({});
      setCollectionPreview([]);
      setCollectionValidation(null);
      setCollectionDraftSeededFor(selectedPipeline?.info.id ?? null);
      return (): void => {
        cancelled = true;
      };
    }
    const selectedPipelineContent = selectedPipeline.content;
    const selectedPipelineId = selectedPipeline.info.id;

    async function seed(): Promise<void> {
      setCollectionResolving(true);
      try {
        // Initial resolve: omit `draftPreferences` so the response carries
        // stored prefs (effective merged with stored). Use those as the
        // starting draft so user edits apply on top of the stored defaults.
        const result = await window.pipelines.resolvePluginCollections({
          pipeline: selectedPipelineContent,
          ...(selectedPipelineLocator
            ? { pipelinePreferenceLocator: selectedPipelineLocator }
            : {}),
        });
        if (cancelled) return;
        if (!result.success || !result.data) {
          setCollectionError(
            result.error ?? 'Failed to load workflow plugin collections',
          );
          setCollectionPreview([]);
          setCollectionValidation(null);
          setCollectionDraft({});
          setCollectionDraftSeededFor(selectedPipelineId);
          return;
        }
        setCollectionDraft(result.data.effectivePreferences);
        setCollectionDefaultsBaseline(result.data.effectivePreferences);
        setCollectionPreview(result.data.previewItems);
        setCollectionValidation(result.data.validation);
        setCollectionDraftSeededFor(selectedPipelineId);
      } catch (err: unknown) {
        if (cancelled) return;
        setCollectionError(
          err instanceof Error
            ? err.message
            : 'Failed to load workflow plugin collections',
        );
        setCollectionPreview([]);
        setCollectionValidation(null);
        setCollectionDraft({});
        setCollectionDraftSeededFor(selectedPipelineId);
      } finally {
        if (!cancelled) {
          setCollectionResolving(false);
        }
      }
    }

    void seed();
    return (): void => {
      cancelled = true;
    };
  }, [selectedPipeline, hasCollections, selectedPipelineLocator]);

  // Seed the model-alias draft from stored per-pipeline preferences whenever
  // the selected pipeline (or its locator) changes. Mirrors the plugin-
  // collection seeding above. The pipeline `alias.defaults` are overlaid on top
  // of the stored prefs at render time (inside each alias editor).
  useEffect(() => {
    let cancelled = false;
    setAliasDraftSeededFor(null);

    if (!selectedPipeline || !hasAliases) {
      setAliasDraft({});
      setAliasDefaultsBaseline({});
      setAliasDraftSeededFor(selectedPipeline?.info.id ?? null);
      return (): void => {
        cancelled = true;
      };
    }
    const selectedPipelineId = selectedPipeline.info.id;
    const selectedPipelineAliases =
      selectedPipeline.content.model_aliases ?? [];

    async function seedAliases(): Promise<void> {
      try {
        const result = await window.pipelines.loadModelAliasPreferences({
          ...(selectedPipelineLocator
            ? { pipelinePreferenceLocator: selectedPipelineLocator }
            : {}),
        });
        if (cancelled) return;
        const preferences = filterAliasPreferencesToAliases(
          result.success && result.data ? result.data.preferences : {},
          selectedPipelineAliases,
        );
        setAliasDraft(preferences);
        setAliasDefaultsBaseline(preferences);
        setAliasDraftSeededFor(selectedPipelineId);
      } catch {
        if (cancelled) return;
        setAliasDraft({});
        setAliasDefaultsBaseline({});
        setAliasDraftSeededFor(selectedPipelineId);
      }
    }

    void seedAliases();
    return (): void => {
      cancelled = true;
    };
  }, [selectedPipeline, hasAliases, selectedPipelineLocator]);

  // Re-resolve preview when the user edits the draft.
  // Also re-resolve when local catalogs change; the main process owns matching
  // semantics, so renderer catalog changes must trigger a fresh preview.
  useEffect(() => {
    let cancelled = false;
    if (!selectedPipeline || !hasCollections || !collectionDraftSeeded) return;
    const selectedPipelineContent = selectedPipeline.content;

    async function refresh(): Promise<void> {
      setCollectionResolving(true);
      try {
        const result = await window.pipelines.resolvePluginCollections({
          pipeline: selectedPipelineContent,
          ...(selectedPipelineLocator
            ? { pipelinePreferenceLocator: selectedPipelineLocator }
            : {}),
          draftPreferences: collectionDraft,
        });
        if (cancelled) return;
        if (!result.success || !result.data) {
          setCollectionError(
            result.error ?? 'Failed to refresh workflow plugin collections',
          );
          return;
        }
        setCollectionError(null);
        setCollectionPreview(result.data.previewItems);
        setCollectionValidation(result.data.validation);
      } catch (err: unknown) {
        if (cancelled) return;
        setCollectionError(
          err instanceof Error
            ? err.message
            : 'Failed to refresh workflow plugin collections',
        );
      } finally {
        if (!cancelled) {
          setCollectionResolving(false);
        }
      }
    }

    void refresh();
    return (): void => {
      cancelled = true;
    };
  }, [
    collectionCatalogSignature,
    collectionDraft,
    collectionDraftSeeded,
    hasCollections,
    selectedPipeline,
    selectedPipelineLocator,
  ]);

  useEffect(() => {
    if (!hasCollections) {
      return undefined;
    }

    function refreshCatalogs(): void {
      void Promise.all([
        refreshSkills(),
        refreshMarketplaces(),
        refreshCollections(),
      ]);
    }

    window.addEventListener('focus', refreshCatalogs);
    return (): void => {
      window.removeEventListener('focus', refreshCatalogs);
    };
  }, [hasCollections, refreshCollections, refreshMarketplaces, refreshSkills]);

  const handleCollectionPreferenceChange = useCallback(
    (collectionId: string, next: PipelinePluginCollectionPreference): void => {
      setCollectionDraft((prev) => ({
        ...prev,
        [collectionId]: next,
      }));
      setSaveDefaultsState({ status: 'idle' });
    },
    [],
  );

  const handleAliasPreferenceChange = useCallback(
    (aliasId: string, next: PipelineModelAliasPreference | undefined): void => {
      setAliasDraft((prev) => {
        if (next === undefined) {
          if (!(aliasId in prev)) return prev;
          const copy = { ...prev };
          delete copy[aliasId];
          return copy;
        }
        return { ...prev, [aliasId]: next };
      });
      setSaveDefaultsState({ status: 'idle' });
    },
    [],
  );

  const hasUnresolvedRequiredDefaults = useMemo(() => {
    return collectionPreview.some(
      (item) => item.required && item.matchState !== 'matched',
    );
  }, [collectionPreview]);

  const collectionReadyToRun = !hasCollections || collectionDraftSeeded;

  const canSaveDefaults =
    Boolean(selectedPipelineLocator) &&
    (hasCollections || hasAliases) &&
    collectionDraftSeeded &&
    aliasDraftSeeded &&
    collectionError === null &&
    saveDefaultsState.status !== 'saving' &&
    defaultsSavesInFlight === 0;

  const handleSaveDefaults = useCallback(async (): Promise<void> => {
    if (!selectedPipelineLocator) return;
    // A reseed (another workflow selected, or the list reloaded) only stops
    // this save from updating the view; both writes still complete.
    const generation = defaultsGeneration.current;
    const reseeded = (): boolean => generation !== defaultsGeneration.current;
    setSaveDefaultsState({ status: 'saving' });
    setDefaultsSavesInFlight((count) => count + 1);
    let failure: string | null = null;
    try {
      // Persist plugin-collection and model-alias defaults independently — they
      // live in separate stores. Either store may reject with `missing-locator`
      // for an inline pipeline, in which case "save as defaults" is disabled.
      if (hasCollections) {
        const result = await window.pipelines.savePluginCollectionPreferences({
          pipelinePreferenceLocator: selectedPipelineLocator,
          preferences: collectionDraft,
          basePreferences: collectionDefaultsBaseline,
        });
        if (!result.success || !result.data) {
          failure = result.error ?? 'Failed to save workflow defaults';
        } else if (result.data.ok === false) {
          failure = 'This workflow cannot save defaults locally.';
        } else if (!reseeded()) {
          // Another writer changed the stored defaults since this view loaded
          // them; show what was saved, keeping edits made while it saved.
          const merged = result.data.merged ? result.data.preferences : null;
          if (merged) {
            setCollectionDraft((current) =>
              rebaseDraftOnSaved(current, collectionDraft, merged),
            );
          }
          // The saved value is no longer a pending change.
          setCollectionDefaultsBaseline(merged ?? collectionDraft);
        }
      }
      if (failure === null && hasAliases) {
        // The draft may carry `reset` markers; the backend store strips them on
        // write, which deletes that alias's saved default.
        const submittedAliases = filterAliasPreferencesToAliases(
          aliasDraft,
          pipelineAliases,
        );
        const aliasResult = await window.pipelines.saveModelAliasPreferences({
          pipelinePreferenceLocator: selectedPipelineLocator,
          preferences: submittedAliases,
          aliasIds: pipelineAliases.map((alias) => alias.id),
          basePreferences: aliasDefaultsBaseline,
        });
        if (!aliasResult.success || !aliasResult.data) {
          failure = aliasResult.error ?? 'Failed to save workflow defaults';
        } else if (aliasResult.data.ok === false) {
          failure = 'This workflow cannot save defaults locally.';
        } else if (!reseeded()) {
          // The store's answer has no reset markers and includes any newer
          // values it kept; a draft still holding saved resets would remove
          // those values again on its next save.
          const saved = aliasResult.data.preferences
            ? filterAliasPreferencesToAliases(
                aliasResult.data.preferences,
                pipelineAliases,
              )
            : submittedAliases;
          setAliasDraft((current) =>
            rebaseDraftOnSaved(current, aliasDraft, saved),
          );
          setAliasDefaultsBaseline(saved);
        }
      }
    } catch (err: unknown) {
      failure =
        err instanceof Error ? err.message : 'Failed to save workflow defaults';
    }
    setDefaultsSavesInFlight((count) => count - 1);
    if (reseeded()) return;
    setSaveDefaultsState(
      failure === null
        ? { status: 'saved' }
        : { status: 'error', message: failure },
    );
  }, [
    aliasDefaultsBaseline,
    aliasDraft,
    collectionDefaultsBaseline,
    collectionDraft,
    hasAliases,
    hasCollections,
    pipelineAliases,
    selectedPipelineLocator,
  ]);

  // Whether the user's plugin-collection selections differ from the saved
  // defaults. Drives whether the Save button is enabled.
  const collectionDefaultsDirty = useMemo(
    () => !arePreferencesEqual(collectionDraft, collectionDefaultsBaseline),
    [collectionDraft, collectionDefaultsBaseline],
  );

  // Whether the model-alias draft differs from the saved defaults.
  const aliasDefaultsDirty = useMemo(
    () => !arePreferencesEqual(aliasDraft, aliasDefaultsBaseline),
    [aliasDraft, aliasDefaultsBaseline],
  );

  const watcherSupported =
    showTargetControls &&
    watcherRecipientGroups !== undefined &&
    watcherRecipientGroups.some((group) => group.options.length > 0);

  // Preferred default recipient when the watcher toggle is first enabled: the
  // active chat in the relevant worktree, falling back to the first worktree
  // chat, then the first available recipient overall.
  const defaultWatcherRecipient =
    useMemo<AppAdvisorWatcherDestination | null>(() => {
      if (!watcherRecipientGroups) return null;
      const allOptions = watcherRecipientGroups.flatMap(
        (group) => group.options,
      );
      const preferred = allOptions.find((option) => option.preferredDefault);
      if (preferred) return preferred.destination;
      const worktreeGroup = watcherRecipientGroups.find(
        (group) => group.key === 'worktree',
      );
      const firstWorktreeOption = worktreeGroup?.options[0];
      if (firstWorktreeOption) return firstWorktreeOption.destination;
      return allOptions[0]?.destination ?? null;
    }, [watcherRecipientGroups]);

  // Report the effective watcher selection — destination plus optional
  // follow-up instruction — (null when the toggle is off or no recipient is
  // chosen) so the caller can create the watcher after launch.
  useEffect(() => {
    if (!onWatcherSelectionChange) return;
    if (watcherEnabled && watcherRecipient) {
      const trimmed = watcherFollowUp.trim();
      onWatcherSelectionChange({
        destination: watcherRecipient,
        ...(trimmed.length > 0 ? { followUpInstruction: trimmed } : {}),
      });
    } else {
      onWatcherSelectionChange(null);
    }
  }, [
    watcherEnabled,
    watcherRecipient,
    watcherFollowUp,
    onWatcherSelectionChange,
  ]);

  // ---------------------------------------------------------------------
  // Run handlers
  // ---------------------------------------------------------------------

  const buildCollectionContext =
    useCallback((): PipelinePluginCollectionRunContext => {
      return {
        preferences: collectionDraft,
        modelAliasPreferences: filterAliasPreferencesToAliases(
          aliasDraft,
          pipelineAliases,
        ),
        modelConfig: { fastMode },
        ...(selectedPipelineLocator
          ? { pipelinePreferenceLocator: selectedPipelineLocator }
          : {}),
      };
    }, [
      aliasDraft,
      collectionDraft,
      fastMode,
      pipelineAliases,
      selectedPipelineLocator,
    ]);

  const saveModelAliasPreferencesAfterRun = useCallback(
    async (
      preferences: Record<string, PipelineModelAliasPreference> | undefined,
      generation: number,
    ): Promise<void> => {
      if (!hasAliases || !selectedPipelineLocator) return;

      const filteredAliasDraft = filterAliasPreferencesToAliases(
        preferences ?? {},
        pipelineAliases,
      );
      const reseeded = (): boolean => generation !== defaultsGeneration.current;
      setDefaultsSavesInFlight((count) => count + 1);
      try {
        const aliasResult = await window.pipelines.saveModelAliasPreferences({
          pipelinePreferenceLocator: selectedPipelineLocator,
          preferences: filteredAliasDraft,
          aliasIds: pipelineAliases.map((alias) => alias.id),
          basePreferences: aliasDefaultsBaseline,
        });
        if (reseeded()) return;

        if (!aliasResult.success || !aliasResult.data) {
          setSaveDefaultsState({
            status: 'error',
            message: aliasResult.error ?? 'Failed to save workflow defaults',
          });
          return;
        }
        if (aliasResult.data.ok === false) {
          setSaveDefaultsState({
            status: 'error',
            message: 'This workflow cannot save defaults locally.',
          });
          return;
        }

        const saved = aliasResult.data.preferences
          ? filterAliasPreferencesToAliases(
              aliasResult.data.preferences,
              pipelineAliases,
            )
          : filteredAliasDraft;
        setAliasDraft((current) =>
          rebaseDraftOnSaved(current, filteredAliasDraft, saved),
        );
        setAliasDefaultsBaseline(saved);
        setSaveDefaultsState({ status: 'saved' });
      } catch (err: unknown) {
        if (reseeded()) return;
        setSaveDefaultsState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to save workflow defaults',
        });
      } finally {
        setDefaultsSavesInFlight((count) => count - 1);
      }
    },
    [
      aliasDefaultsBaseline,
      hasAliases,
      pipelineAliases,
      selectedPipelineLocator,
    ],
  );

  const handleSelectPipeline = (id: string): void => {
    selectionGeneration.current += 1;
    setSharedHydrating(null);
    setSharedHydrateError(null);
    setSelectedId(id);
    onClearError?.();
  };

  const handleContinue = (): void => {
    if (!selectedPipeline || selectedPipelineError || isRunning) return;
    if (packageReadinessLoading) return;
    if (!collectionReadyToRun || !aliasReadyToRun) return;
    // With no configure step, Run starts right away, so a blocked run waits.
    if (!hasConfigurationStep && runContextBlocked) return;

    if (!hasConfigurationStep) {
      void onRun(
        selectedPipeline.info.id,
        selectedPipeline,
        undefined,
        selectedRepoId,
        buildCollectionContext(),
      );
      return;
    }

    if (hasInputs) {
      // Caller-provided seeds apply only to the pipeline they were staged
      // for, and only to inputs it declares — everything stays editable.
      setInputValues(
        seedInitialInputValues(
          selectedInputDefs,
          selectedPipeline.info.id === initialPipelineId
            ? initialInputs
            : undefined,
        ),
      );
      setInputErrors({});
    }
    setStep('configure');
  };

  const handleBack = (): void => {
    if (isRunning) return;
    setStep('select');
    setInputValues({});
    setInputErrors({});
    onClearError?.();
  };

  const handleInputChange = (name: string, value: string): void => {
    setInputValues((prev) => ({ ...prev, [name]: value }));
    setInputErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = (): void => {
    if (!selectedPipeline) return;
    if (packageReadinessLoading) return;
    if (!collectionReadyToRun || !aliasReadyToRun) return;
    if (hasUnresolvedRequiredDefaults || aliasesBlocked) return;
    if (runContextBlocked) return;

    const errors = validateInputs(selectedInputDefs, inputValues);
    if (Object.keys(errors).length > 0) {
      setInputErrors(errors);
      return;
    }

    const payload = buildSubmitPayload(selectedInputDefs, inputValues);
    const collectionContext = buildCollectionContext();
    const generation = defaultsGeneration.current;
    void (async (): Promise<void> => {
      await onRun(
        selectedPipeline.info.id,
        selectedPipeline,
        payload,
        selectedRepoId,
        collectionContext,
      );
      await saveModelAliasPreferencesAfterRun(
        collectionContext.modelAliasPreferences,
        generation,
      );
    })();
  };

  const subtitle =
    step === 'select'
      ? labels.selectSubtitle
      : selectedPipeline
        ? `Configure inputs for ${selectedPipeline.info.name}`
        : '';

  return (
    <DialogModal
      inset="flush"
      onClose={isRunning ? (): void => {} : onClose}
      title={labels.title}
      subtitle={subtitle}
      maxWidth="2xl"
      closeOnBackdrop={!isRunning}
      dataTestId="pipeline-trigger-modal"
      ownerDocument={ownerDocument}
    >
      <div
        className="flex-1 overflow-y-auto px-6 py-3"
        style={{ minHeight: 120 }}
        data-testid="pipeline-trigger-modal-body"
      >
        {step === 'select' && (
          <>
            {loadState.status === 'loading' && (
              <div className="flex items-center justify-center gap-2 py-8 text-s fg-secondary">
                <LoadingSpinner />
                <span>Loading workflows…</span>
              </div>
            )}

            {loadState.status === 'error' && (
              <ErrorState space="panel" message={loadState.message} />
            )}

            {loadState.status === 'loaded' &&
              loadState.pipelines.length === 0 &&
              loadState.curated.length === 0 &&
              !cloudReady && (
                <div className="py-8 text-center text-s fg-secondary">
                  {labels.emptyMessage}
                </div>
              )}

            {loadState.status === 'loaded' &&
              (loadState.pipelines.length > 0 ||
                loadState.curated.length > 0 ||
                cloudReady) && (
                <Stack gap="item">
                  {showRepoDropdown && showTargetControls && repoChoices && (
                    <div data-testid="pipeline-trigger-modal-repo-select">
                      <DialogFormField
                        label="Working directory"
                        htmlFor="pipeline-trigger-modal-repo"
                      >
                        <SelectField
                          id="pipeline-trigger-modal-repo"
                          value={selectedRepoId ?? ''}
                          onChange={(e) => setSelectedRepoId(e.target.value)}
                          options={repoChoices.map((choice) => ({
                            value: choice.repoId,
                            label: choice.repoName,
                          }))}
                          disabled={isRunning}
                        />
                      </DialogFormField>
                    </div>
                  )}

                  <Stack gap="item">
                    <Stack gap="inline">
                      <SearchField
                        className=""
                        value={searchQuery}
                        onValueChange={setSearchQuery}
                        aria-label="Search workflows"
                        placeholder="Search workflows…"
                        autoFocus
                      />

                      {sourceFilterOptions.length > 0 && (
                        <div className="flex">
                          <SegmentedControl
                            label="Workflow source"
                            shape="capsule"
                            width="content"
                            value={sourceFilter}
                            onChange={setSourceFilter}
                            options={sourceFilterOptions.map((filter) => ({
                              value: filter,
                              label:
                                filter === 'all'
                                  ? 'All'
                                  : pipelineOriginLabel(filter),
                            }))}
                          />
                        </div>
                      )}

                      {sourceFilter === 'shared' ? (
                        <SharedPipelineSelector
                          state={triggerScopedSharedList}
                          rows={scopedSharedRows}
                          onSelect={handleSelectShared}
                          onScroll={handleListScroll}
                          onOpenAccountSettings={() =>
                            openCloudAccountSettings()
                          }
                          selectedId={selectedId}
                          hydrating={sharedHydrating}
                          hydrateError={sharedHydrateError}
                          containerRef={sharedListContainerRef}
                        />
                      ) : (
                        <Stack
                          gap="inline"
                          data-testid="pipeline-trigger-modal-selector"
                        >
                          {scopedRows.length === 0 &&
                          !sharedHasPendingOrRows ? (
                            <div className="py-6 text-center text-s fg-secondary">
                              {hiddenOnlyByScope
                                ? NO_PIPELINES_FOR_CONTEXT_MESSAGE
                                : 'No workflows match your search'}
                            </div>
                          ) : (
                            <div
                              ref={sharedListContainerRef}
                              onScroll={handleListScroll}
                              className="flex flex-col max-h-72 overflow-y-auto gap-1 [&>*]:shrink-0"
                            >
                              {scopedRows.map((row) => {
                                const isSelected = row.info.id === selectedId;
                                const isHydrating =
                                  row.kind !== 'local' &&
                                  sharedHydrating === row.info.id;
                                const onClick = (): void => {
                                  if (row.kind === 'local') {
                                    handleSelectPipeline(row.info.id);
                                    return;
                                  }
                                  if (row.kind === 'curated') {
                                    void handleSelectCurated(row.info);
                                    return;
                                  }
                                  void handleSelectShared(
                                    row.remoteId,
                                    row.info.id,
                                  );
                                };
                                return (
                                  <ListRow
                                    key={row.info.id}
                                    disabled={isHydrating}
                                    selected={isSelected}
                                    aria-current={
                                      isSelected ? 'true' : undefined
                                    }
                                    onClick={onClick}
                                    icon={
                                      <PipelineGlyph icon={row.info.icon} />
                                    }
                                    description={
                                      row.info.description ? (
                                        <span title={row.info.description}>
                                          {row.info.description}
                                        </span>
                                      ) : undefined
                                    }
                                    trailing={
                                      <span className="inline-flex items-center gap-2">
                                        {row.info.source === 'shared' ? (
                                          <PipelineShareLabel
                                            shareScope={row.info.shareScope}
                                            owner={row.info.owner}
                                          />
                                        ) : (
                                          <PipelineSourceLabel
                                            audience={
                                              row.info.remote?.shareScope
                                            }
                                          >
                                            {pipelineOriginLabel(
                                              row.info.source,
                                            )}
                                          </PipelineSourceLabel>
                                        )}
                                        {isHydrating && <LoadingSpinner />}
                                      </span>
                                    }
                                  >
                                    {row.info.name}
                                  </ListRow>
                                );
                              })}
                              {shouldIncludeSharedRows(sourceFilter) &&
                                sharedHasPendingOrRows &&
                                scopedRows.length === 0 && (
                                  <div className="py-6 text-center text-s fg-secondary">
                                    Loading shared workflows…
                                  </div>
                                )}
                              {shouldIncludeSharedRows(sourceFilter) &&
                                scopedRows.length > 0 &&
                                anySharedLoadingMore && (
                                  <div className="py-2 text-center text-xs fg-secondary">
                                    Loading more…
                                  </div>
                                )}
                            </div>
                          )}
                          <ErrorBanner
                            className=""
                            error={sharedHydrateError}
                          />
                        </Stack>
                      )}
                    </Stack>
                    {selectedPipeline && selectedPipelineError && (
                      <ErrorBanner
                        className=""
                        error={`This workflow can’t run: ${selectedPipelineError}`}
                        testId="pipeline-trigger-modal-selection-error"
                      />
                    )}
                  </Stack>
                </Stack>
              )}
          </>
        )}

        {step === 'configure' && selectedPipeline && (
          <Stack gap="group">
            {runsOnThisComputer && (
              <CapabilityPackageReadiness
                readiness={packageReadiness}
                definitionOnly={
                  selectedPipeline.info.source === 'shared' &&
                  selectedPipeline.info.distributionMode !== 'package'
                }
              />
            )}
            <Button
              variant="ghost"
              size="compact"
              onClick={handleBack}
              disabled={isRunning}
              className="self-start"
            >
              <AppCatalogChevronLeftMediumIcon size="sm" />
              Back to workflow list
            </Button>

            <Surface variant="group" className="">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <PipelineGlyph icon={selectedPipeline.info.icon} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-s font-medium fg-primary">
                    {selectedPipeline.info.name}
                  </div>
                  {selectedPipeline.info.description && (
                    <div
                      className="truncate text-xs fg-secondary"
                      title={selectedPipeline.info.description}
                    >
                      {selectedPipeline.info.description}
                    </div>
                  )}
                </div>
              </div>
            </Surface>

            {runContext?.fields ? <div>{runContext.fields}</div> : null}

            {(hasInputs || hasAliases || hasCollections) && (
              <Stack gap="item">
                <Stack gap="group">
                  {hasInputs && (
                    <Stack
                      gap="group"
                      data-testid="pipeline-trigger-modal-inputs"
                    >
                      {Object.entries(selectedInputDefs).map(([name, def]) => (
                        <InputField
                          key={name}
                          name={name}
                          def={def}
                          value={inputValues[name] ?? ''}
                          error={inputErrors[name]}
                          onChange={handleInputChange}
                          disabled={isRunning}
                        />
                      ))}
                    </Stack>
                  )}
                  {hasAliases && (
                    <div>
                      <PipelineModelAliasesSection
                        aliases={pipelineAliases}
                        preferences={aliasDraft}
                        pluginCollections={
                          selectedPipeline.content.plugin_collections ?? []
                        }
                        onPreferenceChange={handleAliasPreferenceChange}
                      />
                    </div>
                  )}

                  {hasCollections && (
                    <div className="flex flex-col gap-2">
                      <ErrorBanner className="" error={collectionError} />
                      <PipelinePluginCollectionsSection
                        pipeline={selectedPipeline.content}
                        previewItems={collectionPreview}
                        preferences={collectionDraft}
                        onPreferencesChange={handleCollectionPreferenceChange}
                      />
                    </div>
                  )}
                </Stack>
                {(hasCollections || hasAliases) && !collectionError && (
                  <div className="flex items-center gap-3">
                    <Tooltip
                      label="Change a selection to enable saving it as the default."
                      suppressed={collectionDefaultsDirty || aliasDefaultsDirty}
                    >
                      <Button
                        size="compact"
                        onClick={handleSaveDefaults}
                        disabled={
                          !canSaveDefaults ||
                          !(collectionDefaultsDirty || aliasDefaultsDirty) ||
                          collectionResolving
                        }
                        data-testid="pipeline-trigger-modal-save-defaults"
                      >
                        {saveDefaultsState.status === 'saving'
                          ? 'Saving…'
                          : hasCollections
                            ? 'Save plugin selections as defaults'
                            : 'Save model aliases as defaults'}
                      </Button>
                    </Tooltip>
                    {saveDefaultsState.status === 'saved' && (
                      <span
                        className="text-xs fg-success-strong"
                        data-testid="pipeline-trigger-modal-save-defaults-success"
                      >
                        {SAVE_DEFAULTS_SUCCESS_MESSAGE}
                      </span>
                    )}
                    {saveDefaultsState.status === 'error' && (
                      <ErrorBanner
                        className=""
                        error={saveDefaultsState.message}
                      />
                    )}
                  </div>
                )}
              </Stack>
            )}
            {runsOnThisComputer && (
              <Tooltip label="Fast mode consumes 2x usage." className="w-full">
                <ChoiceField
                  checked={fastMode}
                  onChange={(event) => setFastMode(event.target.checked)}
                  disabled={isRunning}
                  label="Fast mode"
                  description="Runs supported model providers in fast mode."
                />
              </Tooltip>
            )}
          </Stack>
        )}
      </div>

      {/* Footer */}
      <div className="flex flex-col gap-2 border-t px-6 py-3">
        {step === 'configure' && (
          <ErrorBanner className="" error={selectedPipelineError} />
        )}
        {selectedPipeline && runContextBlockedReason && (
          <div
            className="text-xs fg-tertiary"
            data-testid="pipeline-trigger-modal-run-blocked"
          >
            {runContextBlockedReason}
          </div>
        )}
        {step === 'configure' &&
          hasCollections &&
          hasUnresolvedRequiredDefaults && (
            <Notice
              intent="attention"
              data-testid="pipeline-trigger-modal-required-blocking"
            >
              {UNRESOLVED_REQUIRED_BLOCKING_MESSAGE}
            </Notice>
          )}
        {step === 'configure' &&
        hasCollections &&
        !hasUnresolvedRequiredDefaults &&
        collectionValidation?.messages?.length ? (
          <ul className="flex flex-col text-xs gap-0.5">
            {collectionValidation.messages.map((m, idx) => (
              <li
                key={`validation-${idx}`}
                className={
                  m.severity === 'error' ? 'fg-destructive' : 'fg-warning'
                }
              >
                {m.text}
              </li>
            ))}
          </ul>
        ) : null}
        {step === 'configure' && hasAliases && aliasesBlocked && (
          <Notice
            intent="attention"
            data-testid="pipeline-trigger-modal-alias-blocking"
          >
            Configure every required model alias before running this workflow.
          </Notice>
        )}
        {localSetupBlocked && (
          <Notice
            intent="attention"
            data-testid="pipeline-trigger-modal-setup-blocking"
          >
            Complete the required setup above before running this workflow.
          </Notice>
        )}
        <ErrorBanner className="" error={runError} />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {watcherSupported && watcherRecipientGroups && (
              <>
                <ActionTooltip
                  title="Notify a chat"
                  description={
                    watcherEnabled
                      ? 'Pick a chat to notify when this workflow completes.'
                      : 'Notify a chat when this workflow completes.'
                  }
                >
                  <Button
                    variant={watcherEnabled ? 'ghost-accent' : 'ghost'}
                    size="sm"
                    iconOnly
                    role="switch"
                    aria-checked={watcherEnabled}
                    aria-label="Notify a chat when this workflow completes"
                    onClick={(): void => {
                      setWatcherEnabled((prev) => {
                        const next = !prev;
                        if (
                          next &&
                          !watcherRecipient &&
                          defaultWatcherRecipient
                        ) {
                          // Default to the active chat in the relevant worktree
                          // so enabling the toggle immediately has an effect.
                          setWatcherRecipient(defaultWatcherRecipient);
                        }
                        return next;
                      });
                    }}
                    data-testid="pipeline-trigger-modal-watcher-toggle"
                    data-active={watcherEnabled ? 'true' : 'false'}
                  >
                    <WatcherEyeIcon size="sm" aria-hidden="true" />
                  </Button>
                </ActionTooltip>
                {watcherEnabled && (
                  <WatcherRecipientPicker
                    groups={watcherRecipientGroups}
                    value={watcherRecipient}
                    onChange={setWatcherRecipient}
                    placement="top"
                    dataTestId="pipeline-trigger-modal-watcher-recipient"
                  />
                )}
                {watcherEnabled && watcherRecipient && (
                  <WatcherFollowUpButton
                    value={watcherFollowUp}
                    onChange={setWatcherFollowUp}
                    placement="top"
                    dataTestId="pipeline-trigger-modal-watcher-followup"
                  />
                )}
              </>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="compact"
              onClick={onClose}
              disabled={isRunning}
              data-testid="pipeline-trigger-modal-cancel"
            >
              Cancel
            </Button>

            {step === 'select' && (
              <Button
                variant={hasConfigurationStep ? 'primary' : 'warning'}
                size="compact"
                disabled={
                  !selectedPipeline ||
                  Boolean(selectedPipelineError) ||
                  isRunning ||
                  packageReadinessLoading ||
                  !collectionReadyToRun ||
                  !aliasReadyToRun ||
                  (!hasConfigurationStep && runContextBlocked)
                }
                onClick={handleContinue}
                data-testid="pipeline-trigger-modal-run"
              >
                {isRunning
                  ? runLoadingLabel
                  : hasConfigurationStep
                    ? 'Continue'
                    : runLabel}
              </Button>
            )}

            {step === 'configure' && (
              <Button
                variant="primary"
                size="compact"
                disabled={
                  !selectedPipeline ||
                  Boolean(selectedPipelineError) ||
                  isRunning ||
                  packageReadinessLoading ||
                  !collectionReadyToRun ||
                  !aliasReadyToRun ||
                  hasUnresolvedRequiredDefaults ||
                  aliasesBlocked ||
                  localSetupBlocked ||
                  runContextBlocked
                }
                onClick={handleSubmit}
                data-testid="pipeline-trigger-modal-run"
              >
                {isRunning ? runLoadingLabel : runLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
