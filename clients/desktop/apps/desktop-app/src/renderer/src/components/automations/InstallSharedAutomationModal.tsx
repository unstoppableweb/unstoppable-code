import { Fieldset } from '@canopy/ui-shared/components';
import {
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CHAT_LABEL } from '@canopy/protocol';
import type {
  ScheduledActivity,
  ChatTabPluginSelections,
  InstallAutomationPipelinesRequest,
  InstallAutomationPipelinesResponse,
  PreviewAutomationPipelinesResponse,
} from '@canopy/desktop-shared/types';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  projectKindToTargetContext,
  type SharedAutomationInstallSource,
  type SharedAutomationPipelineRef,
  type TargetContext,
} from '@canopy/protocol/automations';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
} from '@canopy/pipeline-interop/automation-target';
import type { AutomationSessionTargetKind } from '@canopy/desktop-shared/lib/automation-target';
import type { PipelineShareInstallPin } from '@canopy/protocol/pipelines';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import { getShareablePluginRefKey } from '@canopy/protocol/plugins';
import {
  AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE,
  buildApplyUpdateRequest,
  buildInstallAutomationRequest,
  planAutomationPipelineUpdate,
  shareApprovedRunCondition,
  type InstallSharedAutomationBindings,
} from '@canopy/desktop-shared/lib/automation-install';
import { automationActionUsesIfCommandOutput } from '@canopy/desktop-shared/lib/automation-sharing';
import {
  MAX_AUTOMATION_IF_COMMAND_CHARS,
  validateAutomationIfCommand,
} from '@canopy/desktop-shared/lib/automations';
import { ShareCheckbox } from '@canopy/ui-app/sharing';
import { formatAutomationTargetContexts } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import { ShareInstallDialog } from '@canopy/ui-shared/components/ShareInstallDialog';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import {
  shareInstallDefaultDescription,
  shareInstallTypeLabel,
} from '@canopy/ui-app/sharing/share-install-copy';
import { Button } from '@canopy/ui-shared';
import {
  AutomationPipelineTaskField,
  Disclosure,
  FormField,
  isAutomationPipelineTaskStale,
  Select,
  TextArea,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { usePipelineTaskList } from '@/components/automations/usePipelineTaskList';
import { useCapabilityPackageReadiness } from '@/components/shared/capability-package/useCapabilityPackageReadiness';
import {
  PACKAGED_PIPELINE_STATUS_LABELS,
  packagedPipelineFileChangeLines,
  packagedPipelineReviewRows,
  sharedPackagedPipelines,
  stagedActionPipelineId,
} from './packagedPipelineInstall';
import { InlinePipelineYamlPreview } from './InlinePipelineYamlPreview';
import { buildShareablePluginDisplay } from '@canopy/execution-engine/plugin-refs';
import {
  useUnifiedTableData,
  type UnifiedTableRow,
} from '@/hooks/useUnifiedTableData';
import { tryParseAndValidateYaml } from '@/lib/pipeline-yaml';
import {
  hashPipelineDocumentYaml,
  loadPipelineDocument,
  pipelineInfoToDocumentLocator,
  serializePipelineDocument,
  type PipelineDocumentLocator,
} from '@/lib/pipelineDocument';
import {
  pipelineResolutionFromRaw,
  resolveAutomationPipelineScopes,
  resolveAutomationProjectCreationContexts,
} from '@/lib/automationTargets';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

// A fresh install is the one required click: it creates the copy and turns
// it on (CAN-3651).
const INSTALL_LABEL = 'Install and enable';
const UPDATE_LABEL = 'Apply update';
const ENABLE_FAILED_MESSAGE =
  "The automation couldn't be turned on, so it wasn't installed. Try again.";
// Follows main's refusal sentence when turning the new copy on is refused.
const ENABLE_REFUSED_SUFFIX = "The automation wasn't installed.";
const SUBMIT_REASON_PROJECT = 'Choose a project to continue';
const SUBMIT_REASON_COWORK_PROJECT = `Choose a ${CHAT_LABEL} project to continue`;
const SUBMIT_REASON_PIPELINE = 'Choose a workflow to continue';
const SUBMIT_REASON_TASK = 'Pick a task to run the workflow in.';
const SUBMIT_REASON_RUN_CONDITION_EMPTY =
  'Enter a command or turn the run condition off';
const SUBMIT_REASON_RUN_CONDITION_TOO_LONG = `Shorten the command to ${MAX_AUTOMATION_IF_COMMAND_CHARS.toLocaleString('en-US')} characters or turn the run condition off`;
const COPY_PICKER_LABEL = 'Installed copy to update';
const COPY_PICKER_NOTE =
  'Several installed copies of this automation are out of date. Each copy is updated separately.';
const WORKSPACE_LABEL = 'Project';
const WORKSPACE_PLACEHOLDER = 'Choose a project…';
const COWORK_WORKSPACE_LABEL = `${CHAT_LABEL} project`;
const COWORK_WORKSPACE_PLACEHOLDER = `Choose a ${CHAT_LABEL} project…`;
const COWORK_WORKSPACE_NOTE = `The author's ${CHAT_LABEL} project stays on their machine. Pick one of yours for this automation to post into.`;
const PIPELINE_LABEL = 'Workflow';
const PIPELINE_PLACEHOLDER = 'Choose a workflow…';
const PIPELINE_NOTE =
  'This automation runs a workflow that only exists on the author’s machine. Pick one of your own workflows to run instead.';
const PIPELINE_LOADING_LABEL = 'Loading your workflows…';
const PIPELINE_EMPTY_LABEL =
  'You have no workflows yet. Create one, then install this automation.';
const PIN_VERIFYING_LABEL = 'Checking the pinned workflow version…';
const BUNDLED_PIPELINE_MISMATCH =
  'The bundled workflow definition does not match the version the author pinned. Ask them to share it again.';
const PUBLIC_SHARED_PIPELINE_BLOCKED =
  'This automation points at a workflow hosted on the author’s server, which a public link cannot reach. Ask them to share it again from an updated app.';
const TARGET_CHECKING_LABEL = 'Checking where this workflow can run…';
const PIPELINE_STAGE_RUNNING_LABEL = 'Preparing the workflows in this share…';
const PIPELINE_STAGE_FAILED =
  'The workflows in this share could not be installed. Try again.';
const PACKAGED_PIPELINES_HEADING = 'Workflows';
const PACKAGED_PIPELINES_NOTE =
  'Each workflow is saved as your own copy. The prompt points at your copies.';
const PACKAGED_PIPELINE_REVIEW_LABEL = 'Review the updated workflow';
const TARGET_UNCHECKABLE_LABEL =
  'This workflow can’t be checked here, so this automation can’t be installed with it. Choose one of your saved workflows instead.';
const TARGET_CHOOSE_PIPELINE_LABEL =
  'Choose a workflow to see which projects it can run in.';
const PACKAGE_INVALID_LABEL =
  'This automation’s packaged dependencies could not be verified. Ask the author to share it again.';
const REVISION_CHANGED_LABEL =
  'This share changed while you created the project. Check your choices before installing.';
const SHARED_PIPELINE_CHANGED =
  'The shared workflow changed after it was verified. Close this and try again.';

/** Whether the wizard created a new local copy or updated an existing one. */
export type InstallAutomationOutcome = 'installed' | 'updated';

interface InstallWorkspaceOption {
  id: string;
  name: string;
  type: 'single-repo' | 'multi-repo' | 'cowork';
  lacksProjectFolder?: boolean;
}

/** Stage A of the package install: the share's pipelines as local copies. */
/** Stage A's dry run, read by the install and update review. */
type PipelinePreviewState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: PreviewAutomationPipelinesResponse }
  | { status: 'error'; message: string };

/** Pipeline scope resolution for the exact selected definition. */
type PipelineScopeState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | {
      status: 'done';
      key: string;
      resolution: AutomationPipelineResolution;
      projects?: Record<string, AutomationPipelineResolution>;
    };

async function loadPipelineScopes(
  locator: PipelineDocumentLocator,
): Promise<AutomationPipelineResolution> {
  const result = await loadPipelineDocument(locator);
  return result.data
    ? { status: 'resolved', scopes: result.data.content.scope }
    : { status: 'error', error: result.error };
}

/**
 * Where the automation document came from: a team share (the default), an
 * anonymous public share, or the curated Marketplace catalog. It decides the
 * provenance stamped on the local copy and which package endpoints the
 * main-process chain reads.
 */
export type InstallAutomationSource = 'shared' | 'public' | 'curated';

export interface AutomationInstallDraft {
  targetActivityId?: string;
  workspaceId: string;
  coworkWorkspaceId: string;
  existingBranch: string;
  inputs: Record<string, string>;
  chosenPipelineId: string;
  /** Existing task for a `task` pipeline destination. */
  taskId?: string;
  /** The recipient's run-condition choice, kept across project creation. */
  runConditionEnabled?: boolean;
  runConditionCommand?: string;
}

export interface AutomationProjectCreationRequest {
  context: 'cowork' | 'worktree';
  detail: SharedAutomationInstallSource;
  source: InstallAutomationSource;
  staleActivities?: ScheduledActivity[];
  subtitle?: ReactNode;
  draft: AutomationInstallDraft;
  onDone: (activityId?: string, outcome?: InstallAutomationOutcome) => void;
}

interface InstallSharedAutomationModalProps {
  onCreateProject?: (request: AutomationProjectCreationRequest) => void;
  initialDraft?: AutomationInstallDraft;
  createdProjectId?: string;
  revisionChanged?: boolean;
  detail: SharedAutomationInstallSource;
  /** Defaults to `'shared'`, or `'public'` when `publicShare` is set. */
  source?: InstallAutomationSource;
  /**
   * Alias for `source: 'public'`. The main-process package chain branches on
   * the source at exactly two seams — readiness and install — so the wizard
   * never needs an authenticated team-scoped fetch on this path.
   */
  publicShare?: boolean;
  /**
   * Every installed copy of this share whose content is stale. Non-empty
   * puts the wizard in update mode; with more than one copy the user picks
   * which copy to update (each copy is updated separately).
   */
  staleActivities?: ScheduledActivity[];
  workspaces: InstallWorkspaceOption[];
  /** Attribution under the title, for example `Shared by {username}`. */
  subtitle?: ReactNode;
  /**
   * Leaves a new copy off instead of turning it on once installed, so it
   * never runs before it is reviewed (the edit shell's Duplicate, CAN-4072).
   */
  leaveDisabled?: boolean;
  /**
   * Reports when a write starts and settles, so the share install review can
   * hold a newer link until it finishes (CAN-3710).
   */
  onSubmittingChange?: (submitting: boolean) => void;
  onClose: () => void;
  /**
   * Called after the create/update IPC and any required package work
   * succeed, with the local copy's id and whether it was installed or
   * updated. `onClose` follows immediately.
   */
  onDone: (activityId?: string, outcome?: InstallAutomationOutcome) => void;
}

interface InstallSharedAutomationFormProps {
  onCreateProject?: (
    context: 'cowork' | 'worktree',
    draft: AutomationInstallDraft,
  ) => void;
  initialDraft?: AutomationInstallDraft;
  createdProjectId?: string;
  revisionChanged?: boolean;
  detail: SharedAutomationInstallSource;
  source: InstallAutomationSource;
  /** Present when applying a remote update to an installed copy. */
  existingActivity?: ScheduledActivity;
  /** Copy-disambiguation control rendered when several copies are stale. */
  copyPicker: JSX.Element | null;
  workspaces: InstallWorkspaceOption[];
  subtitle?: ReactNode;
  leaveDisabled?: boolean;
  onSubmittingChange?: (submitting: boolean) => void;
  onClose: () => void;
  onDone: (activityId?: string, outcome?: InstallAutomationOutcome) => void;
}

/**
 * Return the ref key for the discriminator-equivalent marketplace-plugin
 * form, mirroring the main-process `matchShareablePluginRef` fallback: a
 * provider-neutral `plugin` ref resolves through the Claude plugin path, so
 * `plugin` and `claude_plugin` refs with the same marketplace and name
 * identify the same installed plugin. Skill and Codex refs have no
 * equivalent form.
 */
function equivalentDiscriminatorKey(ref: ShareablePluginRef): string | null {
  if (ref.type === 'plugin') {
    return getShareablePluginRefKey({
      type: 'claude_plugin',
      marketplace: ref.marketplace,
      plugin_name: ref.plugin_name,
    });
  }
  if (ref.type === 'claude_plugin') {
    return getShareablePluginRefKey({
      type: 'plugin',
      marketplace: ref.marketplace,
      plugin_name: ref.plugin_name,
    });
  }
  return null;
}

/**
 * Reverse-resolve the document's portable plugin refs against the local
 * catalog rows. A ref is matched by structural equality with a row's
 * `shareableRef` (accepting the equivalent `plugin`/`claude_plugin`
 * discriminator on a miss); the row's own name is used to split its
 * selection key so identifiers containing separators survive intact.
 * Unmatched refs block the install (mirrors the shared-Agent import
 * doctrine: never silently drop).
 */
function resolveLocalSelections(
  refs: ShareablePluginRef[],
  rows: readonly UnifiedTableRow[],
):
  | { ok: true; selections: ChatTabPluginSelections | undefined }
  | { ok: false; missing: string[] } {
  if (refs.length === 0) {
    return { ok: true, selections: undefined };
  }
  const byRef = new Map<string, UnifiedTableRow>();
  for (const row of rows) {
    if ((row.kind === 'skill' || row.kind === 'plugin') && row.shareableRef) {
      byRef.set(getShareablePluginRefKey(row.shareableRef), row);
    }
  }
  const selections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
  const missing: string[] = [];
  for (const ref of refs) {
    const fallbackKey = equivalentDiscriminatorKey(ref);
    const row =
      byRef.get(getShareablePluginRefKey(ref)) ??
      (fallbackKey !== null ? byRef.get(fallbackKey) : undefined);
    if (!row) {
      missing.push(buildShareablePluginDisplay(ref).title);
      continue;
    }
    const prefix = row.key.slice(0, row.key.length - row.name.length - 1);
    if (row.kind === 'skill') {
      selections.skillRefs.push({ sourceId: prefix, skillName: row.name });
    } else {
      selections.pluginRefs.push({
        marketplaceId: prefix,
        pluginName: row.name,
      });
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, selections };
}

/**
 * The install review for a shared Automation (or a remote update to an
 * installed copy), drawn in the same `ShareInstallDialog` chrome as every
 * other shared resource (CAN-3710): name, publisher, a short description, the
 * bindings the install needs, and one primary. All mapping/enable semantics
 * live in the pure `automation-install` helpers; this component only collects
 * the bindings and drives the automations IPC.
 */
export function InstallSharedAutomationModal({
  detail,
  source,
  publicShare,
  staleActivities,
  workspaces,
  subtitle,
  leaveDisabled = false,
  onSubmittingChange,
  onClose,
  onDone,
  onCreateProject,
  initialDraft,
  createdProjectId,
  revisionChanged,
}: InstallSharedAutomationModalProps): JSX.Element {
  const staleList = staleActivities ?? [];
  const [targetActivityId, setTargetActivityId] = useState<string | undefined>(
    initialDraft?.targetActivityId ?? staleList[0]?.id,
  );
  const existingActivity = staleList.find(
    (activity) => activity.id === targetActivityId,
  );
  const workspaceNameById = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.name]),
  );
  const copyPicker =
    staleList.length > 1 ? (
      <FormField label={COPY_PICKER_LABEL} description={COPY_PICKER_NOTE}>
        {(control) => (
          <Select
            {...control}
            value={targetActivityId ?? null}
            onValueChange={setTargetActivityId}
            data-testid="install-automation-copy"
            options={staleList.map((activity) => {
              // A global action's inert `workspaceId` names no project.
              const workspaceId =
                activity.action.type === 'worktree_pipeline'
                  ? pipelineAutomationWorkspaceId(activity.action)
                  : 'workspaceId' in activity.action
                    ? activity.action.workspaceId
                    : undefined;
              const activityWorkspace = workspaceId
                ? workspaceNameById.get(workspaceId)
                : undefined;
              return {
                value: activity.id,
                label: `${activity.name}${activityWorkspace ? ` — ${activityWorkspace}` : ''}${activity.enabled ? '' : ' (disabled)'}`,
              };
            })}
          />
        )}
      </FormField>
    ) : null;
  // Remount the form when the target copy changes so binding state re-seeds
  // from the newly selected copy.
  return (
    <InstallSharedAutomationForm
      key={existingActivity?.id ?? 'install'}
      detail={detail}
      source={source ?? (publicShare ? 'public' : 'shared')}
      existingActivity={existingActivity}
      copyPicker={copyPicker}
      workspaces={workspaces}
      {...(subtitle !== undefined ? { subtitle } : {})}
      leaveDisabled={leaveDisabled}
      {...(onSubmittingChange !== undefined ? { onSubmittingChange } : {})}
      onClose={onClose}
      onDone={onDone}
      initialDraft={initialDraft}
      createdProjectId={createdProjectId}
      revisionChanged={revisionChanged}
      {...(onCreateProject
        ? {
            onCreateProject: (
              context: 'cowork' | 'worktree',
              draft: AutomationInstallDraft,
            ): void => {
              onClose();
              onCreateProject({
                context,
                detail,
                source: source ?? (publicShare ? 'public' : 'shared'),
                staleActivities,
                subtitle,
                draft: { ...draft, targetActivityId },
                onDone,
              });
            },
          }
        : {})}
    />
  );
}

function InstallSharedAutomationForm({
  detail,
  source,
  existingActivity,
  copyPicker,
  workspaces,
  subtitle,
  leaveDisabled = false,
  onSubmittingChange,
  onClose,
  onDone,
  onCreateProject,
  initialDraft,
  createdProjectId,
  revisionChanged,
}: InstallSharedAutomationFormProps): JSX.Element {
  const action = detail.automation.action;
  const publicShare = source === 'public';
  const existingAction = existingActivity?.action;
  const targetRequirement = detail.automation.targetRequirement;
  // A portable Cowork prompt binds a cowork workspace, never a code project,
  // so it takes its own picker instead of the code-workspace one.
  const needsCoworkWorkspace = action.type === 'standalone_prompt';
  // An explicit pipeline destination; the portable `workspace` kind keeps
  // the legacy rules. A pipeline with no project binds no project.
  const destination =
    action.type === 'worktree_pipeline' && action.target.kind !== 'workspace'
      ? action.target.kind
      : undefined;
  const needsWorkspace =
    action.type !== 'app_advisor_prompt' &&
    !needsCoworkWorkspace &&
    destination !== 'global';
  const pipelineRef: SharedAutomationPipelineRef | null =
    action.type === 'worktree_pipeline' ? action.pipeline : null;
  const inputKeys = action.type === 'worktree_pipeline' ? action.inputKeys : [];
  const documentPlugins = useMemo(
    () => (action.type === 'worktree_pipeline' ? [] : action.plugins),
    [action],
  );

  // A global action's inert `workspaceId` names no project to prefill.
  const [workspaceId, setWorkspaceId] = useState<string>(
    initialDraft?.workspaceId ??
      (existingAction?.type === 'worktree_pipeline'
        ? (pipelineAutomationWorkspaceId(existingAction) ?? '')
        : existingAction && 'workspaceId' in existingAction
          ? (existingAction.workspaceId ?? '')
          : ''),
  );
  // The author's branch is a suggestion the recipient confirms or clears —
  // it is repo-scoped, not machine-scoped, but never applied silently.
  // A task binding survives an update only for the same project; any change
  // of project asks the recipient to pick again.
  const [taskId, setTaskId] = useState<string>(
    initialDraft?.taskId ??
      (existingAction?.type === 'worktree_pipeline'
        ? (pipelineAutomationTaskId(existingAction) ?? '')
        : ''),
  );
  const taskWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (taskWorkspaceRef.current === workspaceId) return;
    taskWorkspaceRef.current = workspaceId;
    setTaskId('');
  }, [workspaceId]);
  const taskList = usePipelineTaskList(
    destination === 'task' && workspaceId !== '' ? workspaceId : undefined,
  );
  const [existingBranch, setExistingBranch] = useState<string>(
    initialDraft?.existingBranch ??
      (existingAction?.type === 'worktree_prompt'
        ? (existingAction.existingBranch ?? '')
        : action.type === 'worktree_prompt'
          ? (action.existingBranch ?? '')
          : ''),
  );
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const existingInputs =
      initialDraft?.inputs ??
      (existingAction?.type === 'worktree_pipeline'
        ? (existingAction.inputs ?? {})
        : {});
    const seeded: Record<string, string> = {};
    for (const key of inputKeys) {
      // Bindings survive an update only where the key still exists.
      if (existingInputs[key] !== undefined) seeded[key] = existingInputs[key];
    }
    return seeded;
  });
  const [coworkWorkspaceId, setCoworkWorkspaceId] = useState<string>(
    initialDraft?.coworkWorkspaceId ??
      (existingAction?.type === 'standalone_prompt'
        ? existingAction.chatProjectId
        : ''),
  );
  // CAN-3959: an author-included run condition is shown but off by default.
  // It is stored only when the recipient turns it on and installs; the
  // builders never read the document's command themselves.
  const sharedRunCondition = detail.automation.runCondition?.command ?? null;
  const [runConditionEnabled, setRunConditionEnabled] = useState<boolean>(
    initialDraft?.runConditionEnabled ?? false,
  );
  const [runConditionCommand, setRunConditionCommand] = useState<string>(
    initialDraft?.runConditionCommand ?? sharedRunCondition ?? '',
  );
  const runConditionApproved =
    sharedRunCondition !== null && runConditionEnabled;
  const approvedRunCondition = runConditionCommand.trim();
  const runConditionReason = !runConditionApproved
    ? null
    : approvedRunCondition === ''
      ? SUBMIT_REASON_RUN_CONDITION_EMPTY
      : validateAutomationIfCommand(approvedRunCondition) !== null
        ? SUBMIT_REASON_RUN_CONDITION_TOO_LONG
        : null;
  // The output placeholders only read from the prompt text, so the shared
  // prompt stands in for the action it maps to.
  const runConditionOutputName =
    sharedRunCondition === null || action.type === 'worktree_pipeline'
      ? null
      : automationActionUsesIfCommandOutput({
          type: 'app_advisor_prompt',
          prompt: action.prompt,
        });
  const existingRunCondition = existingActivity?.ifCommand?.trim() ?? '';
  const runConditionReplacesExisting =
    sharedRunCondition !== null &&
    existingRunCondition !== '' &&
    existingRunCondition !== sharedRunCondition.trim();
  // Off by default, so say a matching gate stays either way.
  const runConditionAlreadyCurrent =
    sharedRunCondition !== null &&
    existingRunCondition !== '' &&
    existingRunCondition === sharedRunCondition.trim();
  // An update with a new command lands disabled so it can be checked first.
  const runConditionTurnsOff =
    existingActivity?.enabled === true &&
    runConditionApproved &&
    approvedRunCondition !== '' &&
    approvedRunCondition !== existingRunCondition;
  // The author removed the gate this copy approved earlier, so the update
  // removes it too. A gated revision that keeps its command private doesn't.
  const runConditionRemoved =
    !detail.automation.hasRunCondition &&
    existingActivity !== undefined &&
    shareApprovedRunCondition(existingActivity) !== null;
  const [submitting, setSubmitting] = useState(false);
  // React state updates are asynchronous, so a second click delivered before
  // the `submitting` render would pass the `submitDisabled` check. The ref is
  // the synchronous guard against a duplicate create or package install.
  const submitInFlightRef = useRef(false);
  // Read through a ref so a new callback identity never ends a write early.
  const onSubmittingChangeRef = useRef(onSubmittingChange);
  onSubmittingChangeRef.current = onSubmittingChange;
  useEffect(() => {
    if (!submitting) return undefined;
    const notify = onSubmittingChangeRef.current;
    notify?.(true);
    return (): void => {
      notify?.(false);
    };
  }, [submitting]);
  const [error, setError] = useState<string | null>(null);

  // The recipient's local pipeline catalog backs curated and unresolved
  // rebinds. Shared refs are installed from their verified immutable pin.
  const needsPipelineCatalog =
    pipelineRef?.source === 'curated' ||
    pipelineRef?.source === 'unresolved' ||
    pipelineRef?.source === 'inline';
  const [pipelines, setPipelines] = useState<PipelineInfo[] | null>(null);
  const [pipelineCatalogError, setPipelineCatalogError] = useState<
    string | null
  >(null);
  const [pipelinesLoading, setPipelinesLoading] =
    useState(needsPipelineCatalog);

  useEffect(() => {
    if (!needsPipelineCatalog) {
      setPipelinesLoading(false);
      return undefined;
    }
    const listPipelines = window.pipelines?.list?.bind(window.pipelines);
    if (!listPipelines) {
      setPipelines(null);
      setPipelineCatalogError('The local workflow catalog is unavailable.');
      setPipelinesLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPipelinesLoading(true);
    setPipelineCatalogError(null);
    void listPipelines()
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setPipelines(null);
          setPipelineCatalogError(
            result.error ?? 'The local workflow catalog could not be read.',
          );
          return;
        }
        setPipelines(result.data ?? []);
      })
      .catch((catalogError: unknown) => {
        if (!cancelled) {
          setPipelines(null);
          setPipelineCatalogError(
            catalogError instanceof Error
              ? catalogError.message
              : 'The local workflow catalog could not be read.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPipelinesLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsPipelineCatalog]);

  const localPipelines = useMemo(
    () =>
      (pipelines ?? []).filter(
        (pipeline) =>
          pipeline.source !== 'shared' &&
          (!pipeline.readonly || pipeline.source === 'project'),
      ),
    [pipelines],
  );

  // An `unresolved` ref is the only one the recipient picks by hand; the
  // other sources resolve deterministically against their own identity.
  const [chosenPipelineId, setChosenPipelineId] = useState<string>(
    initialDraft?.chosenPipelineId ??
      (existingAction?.type === 'worktree_pipeline'
        ? (existingAction.pipelineId ?? '')
        : ''),
  );

  const curatedMatch = useMemo(() => {
    if (pipelineRef?.source !== 'curated' || pipelines === null) return null;
    return (
      pipelines.find(
        (pipeline) =>
          pipeline.curatedOrigin?.key === pipelineRef.curatedKey ||
          pipeline.curatedKey === pipelineRef.curatedKey,
      ) ?? null
    );
  }, [pipelineRef, pipelines]);

  // A `shared` pipeline is the one source a publisher can still change after
  // the recipient installs, so the pinned version is verified against the
  // server before Install unlocks — surfaced up front, never at submit.
  const [verifiedPin, setVerifiedPin] =
    useState<PipelineShareInstallPin | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinVerifying, setPinVerifying] = useState(false);

  // A bundled (`inline`) pipeline carries its own bytes, so it is verified
  // locally against the author's pinned hash. `verifySharedPipelineInstallPin`
  // calls the authenticated `getSharedPipeline`, which an anonymous visitor
  // and a member of another org both fail — the bundled bytes remove that
  // dependency entirely, and the local check is strictly stronger than the
  // round-trip because it also works offline.
  const [inlinePipelineVerified, setInlinePipelineVerified] = useState(false);
  useEffect(() => {
    if (pipelineRef?.source !== 'inline') {
      setInlinePipelineVerified(false);
      return undefined;
    }
    let cancelled = false;
    setInlinePipelineVerified(false);
    setPinError(null);
    void hashPipelineDocumentYaml(pipelineRef.rawPipeline)
      .then((hash) => {
        if (cancelled) return;
        const matches =
          hash !== null &&
          hash === pipelineRef.pipelineContentHash &&
          (pipelineRef.origin === undefined ||
            hash === pipelineRef.origin.installPin.pipelineContentHash);
        setInlinePipelineVerified(matches);
        if (!matches) setPinError(BUNDLED_PIPELINE_MISMATCH);
      })
      .catch(() => {
        if (!cancelled) setPinError(BUNDLED_PIPELINE_MISMATCH);
      });
    return (): void => {
      cancelled = true;
    };
  }, [pipelineRef]);

  // Packaged pipelines install through main (Stage A), and only on Submit, so
  // cancelling writes nothing. Until then the review reads Stage A's dry run:
  // what is new, what an update rewrites, and the shared YAML a fresh
  // install's action pipeline scopes are read from.
  const packagedPipelines = useMemo(
    () => sharedPackagedPipelines(detail.automation),
    [detail.automation],
  );
  const needsPipelineStage =
    detail.automation.capabilityPackage !== undefined &&
    packagedPipelines.length > 0;
  const pipelineUpdatePlan = useMemo(
    () =>
      needsPipelineStage && existingActivity
        ? planAutomationPipelineUpdate(
            existingActivity.installedFrom,
            detail.automation,
          )
        : null,
    [detail.automation, existingActivity, needsPipelineStage],
  );
  const [pipelinePreview, setPipelinePreview] = useState<PipelinePreviewState>({
    status: 'idle',
  });
  const packagedActionLocalId =
    pipelineRef?.source === 'packaged' && existingActivity
      ? existingActivity.installedFrom?.bundledPipelineLocalId
      : undefined;
  const packagedActionRawPipeline =
    pipelineRef?.source === 'packaged' &&
    !existingActivity &&
    pipelinePreview.status === 'done'
      ? pipelinePreview.result.pipelines.find(
          (entry) => entry.key === pipelineRef.key,
        )?.rawPipeline
      : undefined;

  useEffect(() => {
    if (pipelineRef?.source !== 'shared') {
      setVerifiedPin(null);
      if (pipelineRef?.source !== 'inline') setPinError(null);
      return undefined;
    }
    if (publicShare) {
      // An anonymous retry can never succeed against a team-scoped endpoint,
      // so this is terminal rather than a transient failure to retry.
      setVerifiedPin(null);
      setPinError(PUBLIC_SHARED_PIPELINE_BLOCKED);
      return undefined;
    }
    if (pipelineRef.installPin === undefined) {
      setVerifiedPin(null);
      setPinError(
        `The pinned version of "${pipelineRef.name ?? 'this workflow'}" could not be verified. Refresh and try again.`,
      );
      return undefined;
    }
    const verifyPin =
      window.api.automations.verifySharedPipelineInstallPin?.bind(
        window.api.automations,
      );
    if (!verifyPin) {
      setVerifiedPin(null);
      setPinError(null);
      return undefined;
    }
    let cancelled = false;
    setPinVerifying(true);
    setPinError(null);
    void verifyPin({
      remoteId: pipelineRef.remoteId,
      installPin: pipelineRef.installPin,
    })
      .then((pin) => {
        if (cancelled) return;
        setVerifiedPin(pin);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setVerifiedPin(null);
        setPinError(
          err instanceof Error
            ? err.message
            : `The pinned version of "${pipelineRef.name ?? 'this workflow'}" could not be verified. Refresh and try again.`,
        );
      })
      .finally(() => {
        if (!cancelled) setPinVerifying(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [pipelineRef, publicShare]);

  // CAN-3734: compatible targets come from one policy — the declaration, the
  // action and the scopes of the exact pipeline that will run. Results are
  // advisory; main re-resolves the target and pipeline before any write.
  const chosenPipeline = useMemo(
    () =>
      pipelineRef?.source === 'unresolved'
        ? (localPipelines.find(
            (pipeline) => pipeline.id === chosenPipelineId,
          ) ?? null)
        : null,
    [chosenPipelineId, localPipelines, pipelineRef],
  );
  const pipelineScopeKey = JSON.stringify([
    detail.contentHash,
    pipelineRef,
    chosenPipeline,
    curatedMatch,
    verifiedPin,
    packagedActionLocalId ?? null,
    packagedActionRawPipeline !== undefined,
    workspaces,
  ]);
  const scopeLoaderRef = useRef<
    (() => Promise<AutomationPipelineResolution>) | null
  >(null);
  const [pipelineScopeState, setPipelineScopeState] =
    useState<PipelineScopeState>({ status: 'idle' });
  useEffect(() => {
    let key: string | null = null;
    let projectResolutions:
      | Record<string, AutomationPipelineResolution>
      | undefined;
    let load: (() => Promise<AutomationPipelineResolution>) | null = null;
    if (pipelineRef?.source === 'inline' && inlinePipelineVerified) {
      const raw = pipelineRef.rawPipeline;
      key = `inline:${pipelineRef.pipelineContentHash}`;
      load = (): Promise<AutomationPipelineResolution> =>
        Promise.resolve(pipelineResolutionFromRaw(raw));
    } else if (
      pipelineRef?.source === 'packaged' &&
      packagedActionLocalId !== undefined
    ) {
      const pipelineId = packagedActionLocalId;
      key = `packaged:${pipelineRef.pipelineContentHash}:${pipelineId}`;
      load = (): Promise<AutomationPipelineResolution> =>
        loadPipelineScopes({ pipelineId, pipelineSource: 'user' });
    } else if (
      pipelineRef?.source === 'packaged' &&
      packagedActionRawPipeline !== undefined
    ) {
      const raw = packagedActionRawPipeline;
      key = `packaged:${pipelineRef.pipelineContentHash}:preview`;
      load = (): Promise<AutomationPipelineResolution> =>
        Promise.resolve(pipelineResolutionFromRaw(raw));
    } else if (pipelineRef?.source === 'bundled') {
      const pipelineId = pipelineRef.pipelineId;
      key = `bundled:${pipelineId}`;
      load = (): Promise<AutomationPipelineResolution> =>
        loadPipelineScopes({ pipelineId, pipelineSource: 'bundled' });
    } else if (pipelineRef?.source === 'curated' && curatedMatch) {
      const locator = pipelineInfoToDocumentLocator(curatedMatch);
      key = `curated:${curatedMatch.id}`;
      load = (): Promise<AutomationPipelineResolution> =>
        loadPipelineScopes(locator);
    } else if (chosenPipeline?.source === 'project') {
      key = pipelineScopeKey;
      load = async (): Promise<AutomationPipelineResolution> => {
        const entries = await Promise.all(
          workspaces.map(async (workspace) => {
            const resolution = await resolveAutomationPipelineScopes({
              type: 'worktree_pipeline',
              workspaceId: workspace.id,
              pipelineId: chosenPipeline.id,
              pipelineSource: 'project',
              projectPipelineFilename: chosenPipeline.filename,
              ...(existingAction?.type === 'worktree_pipeline' &&
              existingAction.workspaceId === workspace.id
                ? {
                    baseWorktreeId: existingAction.baseWorktreeId,
                    repoId: existingAction.repoId,
                  }
                : {}),
            });
            return [workspace.id, resolution] as const;
          }),
        );
        projectResolutions = Object.fromEntries(entries);
        const scopes = entries.flatMap(([, resolution]) =>
          resolution.status === 'resolved'
            ? resolveAutomationTargetRequirement(
                'worktree_pipeline',
                targetRequirement,
                resolution,
              ).contexts
            : [],
        );
        return scopes.length > 0
          ? {
              status: 'resolved',
              scopes: scopes.includes('cowork') ? 'directory' : 'worktree',
            }
          : {
              status: 'error',
              error:
                'This project workflow could not be verified for an accessible project. Choose another workflow.',
            };
      };
    } else if (chosenPipeline) {
      const locator = pipelineInfoToDocumentLocator(chosenPipeline);
      key = `local:${chosenPipeline.source}:${chosenPipeline.id}`;
      load = (): Promise<AutomationPipelineResolution> =>
        loadPipelineScopes(locator);
    } else if (pipelineRef?.source === 'shared' && verifiedPin) {
      const resolvePin =
        window.api.automations.resolveSharedPipelineInstallPin?.bind(
          window.api.automations,
        );
      if (resolvePin) {
        const remoteId = pipelineRef.remoteId;
        const expectedHash = verifiedPin.pipelineContentHash;
        key = `shared:${remoteId}:${expectedHash}`;
        load = async (): Promise<AutomationPipelineResolution> => {
          const resolved = await resolvePin({ remoteId });
          const hash = await hashPipelineDocumentYaml(resolved.rawPipeline);
          return hash === expectedHash
            ? pipelineResolutionFromRaw(resolved.rawPipeline)
            : { status: 'error', error: SHARED_PIPELINE_CHANGED };
        };
      }
    }
    scopeLoaderRef.current = load;
    if (key === null || load === null) {
      setPipelineScopeState({ status: 'idle' });
      return undefined;
    }
    const loadKey = pipelineScopeKey;
    let cancelled = false;
    setPipelineScopeState({ status: 'loading', key: loadKey });
    void load()
      .catch(
        (scopeError: unknown): AutomationPipelineResolution => ({
          status: 'error',
          error:
            scopeError instanceof Error
              ? scopeError.message
              : 'The selected workflow could not be read.',
        }),
      )
      .then((resolution) => {
        // A late response for an obsolete selection is discarded.
        if (!cancelled)
          setPipelineScopeState({
            status: 'done',
            key: loadKey,
            resolution,
            projects: projectResolutions,
          });
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    chosenPipeline,
    curatedMatch,
    inlinePipelineVerified,
    packagedActionLocalId,
    packagedActionRawPipeline,
    pipelineRef,
    verifiedPin,
    pipelineScopeKey,
    workspaces,
    existingAction,
    targetRequirement,
  ]);

  const pipelineResolution = useMemo(
    (): AutomationPipelineResolution | undefined =>
      pipelineScopeState.status === 'done' &&
      pipelineScopeState.key === pipelineScopeKey
        ? pipelineScopeState.resolution
        : action.type === 'worktree_pipeline'
          ? { status: 'pending' }
          : undefined,
    [action.type, pipelineScopeState, pipelineScopeKey],
  );
  const targetResolution = useMemo(
    () =>
      resolveAutomationTargetRequirement(
        action.type,
        targetRequirement,
        pipelineResolution,
        destination,
      ),
    [action.type, destination, pipelineResolution, targetRequirement],
  );
  const targetsLoading =
    action.type === 'worktree_pipeline' &&
    (pipelineScopeState.status === 'loading' ||
      (pipelineScopeState.status !== 'idle' &&
        pipelineScopeState.key !== pipelineScopeKey));
  const targetError =
    targetResolution.status === 'error' ? targetResolution.error : null;
  const targetPendingBlocked =
    !targetsLoading && targetResolution.status === 'pending';
  const allowedContexts: readonly TargetContext[] =
    targetResolution.status === 'resolved' ? targetResolution.contexts : [];
  const isCompatibleWorkspace = (
    workspace: InstallWorkspaceOption,
  ): boolean => {
    const context = projectKindToTargetContext(workspace.type);
    if (!context || !allowedContexts.includes(context)) return false;
    if (destination === 'project' && workspace.lacksProjectFolder) return false;
    if (chosenPipeline?.source !== 'project') return true;
    const facts =
      pipelineScopeState.status === 'done' &&
      pipelineScopeState.key === pipelineScopeKey
        ? pipelineScopeState.projects?.[workspace.id]
        : undefined;
    const resolved = resolveAutomationTargetRequirement(
      action.type,
      targetRequirement,
      facts,
      destination,
    );
    return (
      resolved.status === 'resolved' && resolved.contexts.includes(context)
    );
  };
  const eligibleWorkspaces = workspaces.filter(isCompatibleWorkspace);
  const coworkWorkspaces = eligibleWorkspaces.filter(
    (workspace) => workspace.type === 'cowork',
  );
  const pickerWorkspaces = needsCoworkWorkspace
    ? coworkWorkspaces
    : eligibleWorkspaces;
  const targetsSettled =
    !targetsLoading && targetError === null && !targetPendingBlocked;
  // Before an unresolved ref is rebound there is nothing to check yet; any
  // other unverifiable pipeline blocks a declared requirement outright.
  const awaitingPipelineChoice =
    targetPendingBlocked &&
    pipelineRef?.source === 'unresolved' &&
    chosenPipelineId === '';
  const pipelineUncheckable = targetPendingBlocked && !awaitingPipelineChoice;
  // Only an accessible-project shortage can be fixed by creating a project.
  const noCompatibleProjects =
    (needsWorkspace || needsCoworkWorkspace) &&
    targetsSettled &&
    allowedContexts.length > 0 &&
    pickerWorkspaces.length === 0;

  const selectedContext = useWorkspaceContextStore(
    (state) => state.state.context,
  );
  const creationKey = JSON.stringify([
    selectedContext,
    allowedContexts,
    noCompatibleProjects,
  ]);
  const [creation, setCreation] = useState<{
    key: string;
    contexts: Array<'cowork' | 'worktree'>;
  }>();
  useEffect(() => {
    if (!noCompatibleProjects || !onCreateProject) return;
    let active = true;
    void resolveAutomationProjectCreationContexts()
      .catch(() => [])
      .then((contexts) => {
        if (active) setCreation({ key: creationKey, contexts });
      });
    return (): void => {
      active = false;
    };
    // The key covers both selected navigation context and current target facts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creationKey, onCreateProject]);
  const creationChecked = creation?.key === creationKey;
  const creationContexts = creationChecked
    ? creation.contexts.filter((context) => allowedContexts.includes(context))
    : [];

  // Clear a selection that is no longer compatible (pipeline replaced,
  // requirement narrowed, project removed) so it cannot be submitted.
  const eligibleIdsKey = eligibleWorkspaces.map((w) => w.id).join('\n');
  useEffect(() => {
    if (!targetsSettled) return;
    const eligible = new Set(eligibleIdsKey.split('\n'));
    if (workspaceId !== '' && !eligible.has(workspaceId)) setWorkspaceId('');
    if (coworkWorkspaceId !== '' && !eligible.has(coworkWorkspaceId))
      setCoworkWorkspaceId('');
  }, [
    coworkWorkspaceId,
    eligibleIdsKey,
    targetsSettled,
    workspaceId,
    workspaces.length,
  ]);

  // CAN-3710: an obvious choice needs no input. With exactly one compatible
  // project and nothing chosen yet, a fresh install preselects it. An update
  // that has to move the copy stays an explicit choice (CAN-3734).
  const onlyPickerWorkspaceId =
    existingActivity === undefined && pickerWorkspaces.length === 1
      ? (pickerWorkspaces[0]?.id ?? '')
      : '';
  useEffect(() => {
    if (!targetsSettled || onlyPickerWorkspaceId === '') return;
    if (needsCoworkWorkspace) {
      if (coworkWorkspaceId === '') setCoworkWorkspaceId(onlyPickerWorkspaceId);
    } else if (needsWorkspace && workspaceId === '') {
      setWorkspaceId(onlyPickerWorkspaceId);
    }
  }, [
    coworkWorkspaceId,
    needsCoworkWorkspace,
    needsWorkspace,
    onlyPickerWorkspaceId,
    targetsSettled,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      !createdProjectId ||
      !targetsSettled ||
      eligibleIdsKey !== createdProjectId
    )
      return;
    if (needsCoworkWorkspace) setCoworkWorkspaceId(createdProjectId);
    else if (needsWorkspace) setWorkspaceId(createdProjectId);
  }, [
    createdProjectId,
    targetsSettled,
    eligibleIdsKey,
    needsCoworkWorkspace,
    needsWorkspace,
  ]);

  const selectedTargetId = needsCoworkWorkspace
    ? coworkWorkspaceId
    : needsWorkspace
      ? workspaceId
      : '';
  const selectedTargetKind = ((): AutomationSessionTargetKind | undefined => {
    if (action.type === 'app_advisor_prompt') return 'app_advisor';
    return workspaces.find((workspace) => workspace.id === selectedTargetId)
      ?.type;
  })();

  // Packaged local capabilities travel with the document; the recipient sees
  // what they are getting before anything is materialized on disk.
  const capabilityPackage = detail.automation.capabilityPackage;
  const packageReadinessOwner = useMemo(
    () =>
      capabilityPackage
        ? {
            kind: 'automation' as const,
            remoteId: detail.id,
            packageRef: capabilityPackage,
            ...(source !== 'shared' ? { source } : {}),
            ...(publicShare ? { publicShare: true } : {}),
          }
        : null,
    [capabilityPackage, detail.id, publicShare, source],
  );
  const { readiness: packageReadiness, loading: packageReadinessLoading } =
    useCapabilityPackageReadiness(packageReadinessOwner);

  const pipelineStageRequest = (): Omit<
    InstallAutomationPipelinesRequest,
    'stage'
  > => {
    if (!capabilityPackage) throw new Error(PIPELINE_STAGE_FAILED);
    if (pipelineUpdatePlan && !pipelineUpdatePlan.ok) {
      throw new Error(pipelineUpdatePlan.error);
    }
    const existingPipelines =
      pipelineUpdatePlan?.ok === true
        ? pipelineUpdatePlan.value.existingPipelines
        : [];
    return {
      remoteId: detail.id,
      packageRef: capabilityPackage,
      ...(source !== 'shared' ? { source } : {}),
      ...(publicShare ? { publicShare: true } : {}),
      ...(existingPipelines.length > 0 ? { existingPipelines } : {}),
    };
  };
  const runPipelineStage =
    async (): Promise<InstallAutomationPipelinesResponse> => {
      const install = window.api.automations.installCapabilityPackage?.bind(
        window.api.automations,
      );
      if (!install) throw new Error(PIPELINE_STAGE_FAILED);
      return install({ stage: 'pipelines', ...pipelineStageRequest() });
    };
  // The review reads Stage A's dry run: what each pipeline and its files
  // would become, and whether a local edit refuses an update.
  const runPipelinePreview =
    async (): Promise<PreviewAutomationPipelinesResponse> => {
      const install = window.api.automations.installCapabilityPackage?.bind(
        window.api.automations,
      );
      if (!install) throw new Error(PIPELINE_STAGE_FAILED);
      return install({
        stage: 'pipelines-preview',
        ...pipelineStageRequest(),
      });
    };
  const runPipelinePreviewRef = useRef(runPipelinePreview);
  runPipelinePreviewRef.current = runPipelinePreview;
  const pipelinePreviewPackageDigest =
    needsPipelineStage &&
    (pipelineUpdatePlan === null || pipelineUpdatePlan.ok) &&
    !packageReadinessLoading &&
    packageReadiness !== null &&
    packageReadiness.status !== 'invalid'
      ? (capabilityPackage?.digest ?? null)
      : null;
  useEffect(() => {
    if (pipelinePreviewPackageDigest === null) return undefined;
    let cancelled = false;
    setPipelinePreview({ status: 'running' });
    void runPipelinePreviewRef
      .current()
      .then((result) => {
        if (!cancelled) setPipelinePreview({ status: 'done', result });
      })
      .catch((previewError: unknown) => {
        if (cancelled) return;
        setPipelinePreview({
          status: 'error',
          message:
            previewError instanceof Error && previewError.message.trim()
              ? previewError.message
              : PIPELINE_STAGE_FAILED,
        });
      });
    return (): void => {
      cancelled = true;
    };
  }, [pipelinePreviewPackageDigest]);
  const pipelineStageBlocking =
    needsPipelineStage &&
    (pipelinePreview.status === 'error' ||
      (!existingActivity && pipelinePreview.status === 'running'));
  const packagedPipelineRows = useMemo(
    () =>
      needsPipelineStage
        ? packagedPipelineReviewRows({
            pipelines: packagedPipelines,
            updatePlan:
              pipelineUpdatePlan?.ok === true ? pipelineUpdatePlan.value : null,
            preview:
              pipelinePreview.status === 'done' ? pipelinePreview.result : null,
            localPipelineName: (id) =>
              localPipelines.find((pipeline) => pipeline.id === id)?.name,
          })
        : [],
    [
      localPipelines,
      needsPipelineStage,
      packagedPipelines,
      pipelinePreview,
      pipelineUpdatePlan,
    ],
  );

  const pipelineBindingError = ((): string | null => {
    if (pipelineRef === null || pipelinesLoading) return null;
    if (pipelineRef.source === 'curated' && curatedMatch === null) {
      return `Import the "${pipelineRef.name ?? pipelineRef.curatedKey}" curated workflow before installing.`;
    }
    return null;
  })();

  const pipelineBindingValid =
    pipelineRef === null ||
    pipelineRef.source === 'bundled' ||
    (pipelineRef.source === 'packaged' && capabilityPackage !== undefined) ||
    (pipelineRef.source === 'curated' && curatedMatch !== null) ||
    (pipelineRef.source === 'shared' && verifiedPin !== null) ||
    (pipelineRef.source === 'inline' && inlinePipelineVerified) ||
    // Deliberately no rebind picker for an `inline` ref: substituting a
    // different pipeline would run something other than what the author sent.
    (pipelineRef.source === 'unresolved' && chosenPipelineId !== '');

  const { rows, loading: catalogLoading } = useUnifiedTableData({
    includeCollections: false,
    includeMcp: false,
  });
  const pluginResolution = useMemo(
    () => resolveLocalSelections(documentPlugins, rows),
    [documentPlugins, rows],
  );
  const pluginsBlocked =
    !catalogLoading && documentPlugins.length > 0 && !pluginResolution.ok;

  const isUpdate = existingActivity !== undefined;

  // A retained binding can point at a deleted workspace (or one that became
  // ineligible for this action type); submission requires an id that is
  // actually selectable right now.
  const workspaceBindingValid =
    !needsWorkspace ||
    eligibleWorkspaces.some((workspace) => workspace.id === workspaceId);
  const coworkBindingValid =
    !needsCoworkWorkspace ||
    coworkWorkspaces.some((workspace) => workspace.id === coworkWorkspaceId);
  const taskBindingValid =
    destination !== 'task' ||
    (taskId !== '' &&
      taskList.tasks.status === 'ready' &&
      !isAutomationPipelineTaskStale(taskId, taskList.tasks));
  const submitDisabled =
    submitting ||
    catalogLoading ||
    pipelinesLoading ||
    pinVerifying ||
    targetsLoading ||
    targetError !== null ||
    targetPendingBlocked ||
    (capabilityPackage !== undefined &&
      (packageReadinessLoading ||
        packageReadiness === null ||
        packageReadiness.status === 'invalid')) ||
    pipelineStageBlocking ||
    (pipelineUpdatePlan !== null && !pipelineUpdatePlan.ok) ||
    pinError !== null ||
    pluginsBlocked ||
    !workspaceBindingValid ||
    !coworkBindingValid ||
    !taskBindingValid ||
    !pipelineBindingValid ||
    runConditionReason !== null;

  // One quiet line naming the first missing input, in the same order the
  // gates above apply. It only appears when that missing input is the sole
  // reason Install is unavailable: a loading check or an inline alert is
  // never mislabeled as missing input.
  const blockedByOtherCondition =
    submitting ||
    catalogLoading ||
    pipelinesLoading ||
    pinVerifying ||
    targetsLoading ||
    targetError !== null ||
    pipelineUncheckable ||
    noCompatibleProjects ||
    (capabilityPackage !== undefined &&
      (packageReadinessLoading ||
        packageReadiness === null ||
        packageReadiness.status === 'invalid')) ||
    pipelineStageBlocking ||
    (pipelineUpdatePlan !== null && !pipelineUpdatePlan.ok) ||
    pinError !== null ||
    pipelineBindingError !== null ||
    pluginsBlocked ||
    (pipelineRef !== null &&
      pipelineRef.source !== 'unresolved' &&
      !pipelineBindingValid);
  const submitReason = ((): string | null => {
    if (blockedByOtherCondition) return null;
    if (awaitingPipelineChoice) return SUBMIT_REASON_PIPELINE;
    if (!workspaceBindingValid) return SUBMIT_REASON_PROJECT;
    if (!coworkBindingValid) return SUBMIT_REASON_COWORK_PROJECT;
    if (!taskBindingValid && taskId === '') return SUBMIT_REASON_TASK;
    if (pipelineRef?.source === 'unresolved' && chosenPipelineId === '') {
      // The empty-catalog note already says there is nothing to choose.
      return localPipelines.length === 0 ? null : SUBMIT_REASON_PIPELINE;
    }
    return runConditionReason;
  })();

  const resolvedPipelineBinding = ((): Pick<
    InstallSharedAutomationBindings,
    | 'pipelineId'
    | 'pipelineSource'
    | 'projectPipelineFilename'
    | 'verifiedSharedPipelineInstallPin'
  > => {
    if (pipelineRef === null) return {};
    if (pipelineRef.source === 'curated' && curatedMatch) {
      return { pipelineId: curatedMatch.id, pipelineSource: 'curated' };
    }
    if (pipelineRef.source === 'shared' && verifiedPin) {
      return {
        verifiedSharedPipelineInstallPin: verifiedPin,
      };
    }
    if (pipelineRef.source === 'unresolved' && chosenPipelineId) {
      const chosen = localPipelines.find(
        (pipeline) => pipeline.id === chosenPipelineId,
      );
      if (!chosen) return {};
      return {
        pipelineId: chosen.id,
        ...(chosen.source === 'project'
          ? { projectPipelineFilename: chosen.filename }
          : {}),
        pipelineSource:
          chosen.source === 'project' || chosen.source === 'curated'
            ? chosen.source
            : 'user',
      };
    }
    return {};
  })();

  const selectedBindings: InstallSharedAutomationBindings = {
    ...(selectedTargetKind ? { targetKind: selectedTargetKind } : {}),
    ...(chosenPipeline?.source === 'project' &&
    pipelineScopeState.status === 'done'
      ? { pipelineResolution: pipelineScopeState.projects?.[selectedTargetId] }
      : pipelineResolution && pipelineResolution.status !== 'pending'
        ? { pipelineResolution }
        : {}),
    ...(workspaceId && destination !== 'global' ? { workspaceId } : {}),
    ...(destination === 'task' && taskId ? { taskId } : {}),
    ...(coworkWorkspaceId ? { coworkWorkspaceId } : {}),
    ...resolvedPipelineBinding,
    ...(action.type === 'worktree_prompt' && existingBranch.trim()
      ? { existingBranch: existingBranch.trim() }
      : {}),
    ...(inputKeys.length > 0 ? { inputs } : {}),
    ...(pluginResolution.ok && pluginResolution.selections
      ? { pluginSelections: pluginResolution.selections }
      : {}),
    ...(runConditionApproved && approvedRunCondition
      ? { approvedRunCondition }
      : {}),
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitDisabled || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const bindings: InstallSharedAutomationBindings = { ...selectedBindings };
    const now = new Date().toISOString();
    setSubmitting(true);
    setError(null);
    let createdAutomationId: string | null = null;
    let createdPipelineId: string | null = null;
    let overwrittenPipeline: PipelineData | null = null;
    let updatedExistingActivity = false;
    try {
      if (selectedTargetId) {
        const inventory = await window.api.loadProjects();
        const current = inventory.items.find(
          (project) => project.id === selectedTargetId,
        );
        if (!current || current.type !== selectedTargetKind) {
          setWorkspaceId('');
          setCoworkWorkspaceId('');
          throw new Error(
            'The selected project changed or is no longer accessible. Choose a compatible project again.',
          );
        }
      }
      // Stage A runs once the recipient confirms. The automation request maps
      // onto its local IDs.
      let stagedPipelines: InstallAutomationPipelinesResponse | null = null;
      if (needsPipelineStage) {
        stagedPipelines = await runPipelineStage();
        bindings.pipelineDependencies = stagedPipelines.pipelines.map(
          ({ key, localPipelineId, pipelineContentHash }) => ({
            key,
            localPipelineId,
            pipelineContentHash,
          }),
        );
      }
      const stagedActionId =
        pipelineRef?.source === 'packaged' && stagedPipelines
          ? stagedActionPipelineId(stagedPipelines)
          : undefined;
      if (pipelineRef?.source === 'packaged' && stagedActionId === undefined) {
        throw new Error(PIPELINE_STAGE_FAILED);
      }
      if (action.type === 'worktree_pipeline') {
        const facts =
          stagedActionId !== undefined
            ? await loadPipelineScopes({
                pipelineId: stagedActionId,
                pipelineSource: 'user',
              })
            : chosenPipeline?.source === 'project'
              ? await resolveAutomationPipelineScopes({
                  type: 'worktree_pipeline',
                  workspaceId: selectedTargetId,
                  pipelineId: chosenPipeline.id,
                  pipelineSource: 'project',
                  projectPipelineFilename: chosenPipeline.filename,
                  ...(existingAction?.type === 'worktree_pipeline' &&
                  existingAction.workspaceId === selectedTargetId
                    ? {
                        baseWorktreeId: existingAction.baseWorktreeId,
                        repoId: existingAction.repoId,
                      }
                    : {}),
                })
              : await scopeLoaderRef.current?.();
        const resolved = resolveAutomationTargetRequirement(
          action.type,
          targetRequirement,
          facts,
          destination,
        );
        const context = projectKindToTargetContext(selectedTargetKind);
        // A pipeline with no project resolves without project contexts.
        if (
          resolved.status !== 'resolved' ||
          (destination !== 'global' &&
            (!context || !resolved.contexts.includes(context)))
        ) {
          throw new Error(
            resolved.status === 'error'
              ? resolved.error
              : 'The workflow changed. Choose a compatible project or workflow again.',
          );
        }
        bindings.pipelineResolution = facts;
      }
      if (
        'promptReferences' in action &&
        action.promptReferences?.some(
          (ref) => ref.kind === 'file' && ref.root.kind === 'repo',
        )
      ) {
        if (!workspaceId)
          throw new Error('Choose a project for the referenced repositories.');
        const settings = await window.api.getWorkspaceSettingsData({
          workspaceId,
        });
        bindings.repoIds = settings.effectiveRepos.map((repo) => repo.id);
      }
      // The bundled pipeline becomes a local `user` pipeline before the
      // automation request is built — the pure mappers cannot touch the
      // filesystem, so materializing it is the wizard's job. A recorded
      // `bundledPipelineLocalId` is reused on update so an edit rewrites the
      // same pipeline instead of orphaning it.
      if (pipelineRef?.source === 'inline') {
        const parsed = tryParseAndValidateYaml(pipelineRef.rawPipeline);
        if (!parsed.success) {
          setError(`The bundled workflow could not be parsed: ${parsed.error}`);
          setSubmitting(false);
          submitInFlightRef.current = false;
          return;
        }
        const recordedId =
          existingActivity?.installedFrom?.bundledPipelineLocalId;
        if (recordedId !== undefined && pipelines === null) {
          throw new Error(
            pipelineCatalogError ??
              'The local workflow catalog could not be read. Try again.',
          );
        }
        const stillExists =
          recordedId !== undefined &&
          localPipelines.some((pipeline) => pipeline.id === recordedId);
        if (stillExists && recordedId !== undefined) {
          const existingPipeline = await loadPipelineDocument({
            pipelineId: recordedId,
            pipelineSource: 'user',
          });
          if (!existingPipeline.data) {
            throw new Error(
              existingPipeline.error ??
                'The previous bundled workflow could not be read.',
            );
          }
          const currentPipelineHash = await hashPipelineDocumentYaml(
            existingPipeline.data.rawContent ??
              serializePipelineDocument(existingPipeline.data.content),
          );
          const recordedPipelineHash =
            existingActivity?.installedFrom?.bundledPipelineContentHash;
          // New installs record the previous bundled hash. For an older local
          // record without it, overwrite only when the local bytes already
          // equal the incoming bytes; otherwise the update cannot distinguish
          // a remote change from recipient edits and must preserve user work.
          if (
            currentPipelineHash === null ||
            (recordedPipelineHash !== undefined
              ? currentPipelineHash !== recordedPipelineHash
              : currentPipelineHash !== pipelineRef.pipelineContentHash)
          ) {
            throw new Error(AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE);
          }
          overwrittenPipeline = existingPipeline.data;
        }
        const saved = await window.pipelines.save({
          ...(stillExists && recordedId !== undefined
            ? { id: recordedId }
            : {}),
          name: pipelineRef.name ?? parsed.pipeline.name,
          description: parsed.pipeline.description ?? '',
          icon: parsed.pipeline.icon ?? '',
          content: parsed.pipeline,
          rawContent: pipelineRef.rawPipeline,
        });
        if (!saved.success || !saved.data) {
          setError(saved.error ?? 'The bundled workflow could not be saved.');
          setSubmitting(false);
          submitInFlightRef.current = false;
          return;
        }
        if (!stillExists) createdPipelineId = saved.data.id;
        bindings.bundledPipelineLocalId = saved.data.id;
      }
      // Provenance is the key `findInstalledAutomationByOrigin` reads:
      // `installedFrom.remoteId` holds a public-share id or a curated catalog
      // key here, each a different namespace from a team-share id, so without
      // `sourceKind` neither surface can recognize its own install.
      const origin = source === 'shared' ? undefined : { sourceKind: source };
      let response: Awaited<ReturnType<typeof window.api.automations.create>>;
      if (existingActivity) {
        const built = buildApplyUpdateRequest(
          detail,
          existingActivity,
          bindings,
          now,
          origin,
        );
        if (!built.ok) {
          throw new Error(built.error);
        }
        response = await window.api.automations.update(built.request);
      } else {
        const built = buildInstallAutomationRequest(
          detail,
          bindings,
          now,
          origin,
        );
        if (!built.ok) {
          throw new Error(built.error);
        }
        response = await window.api.automations.create(built.request);
        if (response.ok && response.activity) {
          createdAutomationId = response.activity.id;
        }
      }
      if (!response.ok) {
        throw new Error(response.error);
      }
      updatedExistingActivity = existingActivity !== undefined;
      // Materialize the packaged capabilities against the local copy that was
      // just created. Verification failure must leave the user with a visible
      // error rather than an automation that silently falls back to whatever
      // happens to be installed locally.
      const localAutomationId = response.activity?.id;
      const installPackage =
        window.api.automations.installCapabilityPackage?.bind(
          window.api.automations,
        );
      if (capabilityPackage && (!localAutomationId || !installPackage)) {
        throw new Error(
          'The capability package could not be installed. Try again.',
        );
      }
      if (capabilityPackage && localAutomationId && installPackage) {
        const localContentHash =
          pipelineRef?.source === 'inline' || pipelineRef?.source === 'packaged'
            ? pipelineRef.pipelineContentHash
            : response.activity
              ? await hashPipelineDocumentYaml(
                  JSON.stringify({
                    name: response.activity.name,
                    action: response.activity.action,
                  }),
                )
              : null;
        if (localContentHash === null) {
          throw new Error(
            'The capability package could not be installed. Try again.',
          );
        }
        await installPackage({
          remoteId: detail.id,
          localAutomationId,
          packageRef: capabilityPackage,
          localContentHash,
          ...(source !== 'shared' ? { source } : {}),
          ...(publicShare ? { publicShare: true } : {}),
        });
      } else if (
        existingActivity?.installedFrom?.capabilityPackage !== undefined
      ) {
        if (!localAutomationId || !installPackage) {
          throw new Error(
            'The capability package could not be removed. Try again.',
          );
        }
        await installPackage({ localAutomationId, remove: true });
      }
      // Turn a fresh copy on only after everything it needs is in place, so
      // a schedule can never fire against a half-installed automation. A
      // failure here rolls the new copy back like any other install error.
      if (!existingActivity && localAutomationId && !leaveDisabled) {
        const enabled = await window.api.automations.update({
          id: localAutomationId,
          enabled: true,
        });
        if (!enabled.ok) {
          const refusal = enabled.error.trim();
          if (refusal.length === 0) {
            throw new Error(ENABLE_FAILED_MESSAGE);
          }
          const sentence = /[.!?]$/.test(refusal) ? refusal : `${refusal}.`;
          throw new Error(`${sentence} ${ENABLE_REFUSED_SUFFIX}`);
        }
      }
      onDone(
        localAutomationId ?? existingActivity?.id,
        existingActivity ? 'updated' : 'installed',
      );
      onClose();
    } catch (err: unknown) {
      let errorMessage =
        err instanceof Error ? err.message : 'Installation failed.';
      if (createdPipelineId) {
        await window.pipelines.delete(createdPipelineId).catch(() => undefined);
      } else if (overwrittenPipeline) {
        try {
          const restored = await window.pipelines.save({
            id: overwrittenPipeline.info.id,
            name: overwrittenPipeline.info.name,
            description: overwrittenPipeline.info.description,
            icon: overwrittenPipeline.info.icon,
            content: overwrittenPipeline.content,
            ...(overwrittenPipeline.rawContent !== undefined
              ? { rawContent: overwrittenPipeline.rawContent }
              : {}),
          });
          if (!restored.success) {
            throw new Error(
              restored.error ?? 'The previous bundled workflow was not saved.',
            );
          }
        } catch (rollbackError: unknown) {
          const rollbackMessage =
            rollbackError instanceof Error
              ? rollbackError.message
              : 'Unknown rollback error.';
          errorMessage = `${errorMessage} The previous bundled workflow could not be restored: ${rollbackMessage}`;
        }
      }
      if (createdAutomationId) {
        await window.api.automations
          .delete({ id: createdAutomationId })
          .catch(() => undefined);
      } else if (updatedExistingActivity && existingActivity) {
        try {
          const rollbackResponse = await window.api.automations.update({
            id: existingActivity.id,
            name: existingActivity.name,
            schedule: existingActivity.schedule,
            action: existingActivity.action,
            enabled: existingActivity.enabled,
            // An approved gate replaced the local one, or a dropped shared
            // gate cleared it, so restore it; an empty string clears a gate
            // the copy never had.
            ...(existingActivity.ifCommand !== undefined ||
            bindings.approvedRunCondition !== undefined
              ? { ifCommand: existingActivity.ifCommand ?? '' }
              : {}),
            // The update replaced the declaration, so restore it too.
            ...(existingActivity.targetRequirement !== undefined ||
            detail.automation.targetRequirement !== undefined
              ? {
                  targetRequirement: existingActivity.targetRequirement ?? null,
                }
              : {}),
            installedFrom: existingActivity.installedFrom,
          });
          if (!rollbackResponse.ok) {
            throw new Error(rollbackResponse.error);
          }
          // Main lands a binding-changing shared update disabled, including
          // this restore; re-enable through the ordinary validated path.
          if (
            existingActivity.enabled &&
            rollbackResponse.activity?.enabled === false
          ) {
            const reenabled = await window.api.automations.update({
              id: existingActivity.id,
              enabled: true,
            });
            if (!reenabled.ok) throw new Error(reenabled.error);
          }
        } catch (rollbackError: unknown) {
          const rollbackMessage =
            rollbackError instanceof Error
              ? rollbackError.message
              : 'Unknown rollback error.';
          errorMessage = `${errorMessage} The previous automation could not be restored: ${rollbackMessage}`;
        }
      }
      setError(errorMessage);
      submitInFlightRef.current = false;
    } finally {
      // Success closes the modal, but a host that keeps it mounted must not
      // be left with a busy button and a spinning indicator. The in-flight
      // guard stays set after success so a late click can't install twice.
      setSubmitting(false);
    }
  };

  // The one line under the inputs: the first genuine blocker, else the check
  // that is still running. Each keeps its own test id so a flow can tell them
  // apart.
  const blocker = ((): JSX.Element | null => {
    if (error) {
      return <span data-testid="install-automation-error">{error}</span>;
    }
    if (pipelineUpdatePlan !== null && !pipelineUpdatePlan.ok) {
      return (
        <span data-testid="install-automation-pipelines-blocked">
          {pipelineUpdatePlan.error}
        </span>
      );
    }
    if (pipelinePreview.status === 'error') {
      return (
        <span data-testid="install-automation-pipelines-blocked">
          {pipelinePreview.message}
        </span>
      );
    }
    if (pinError !== null) {
      return (
        <span data-testid="install-automation-shared-pipeline-blocked">
          {pinError}
        </span>
      );
    }
    if (pipelineBindingError !== null) {
      return (
        <span data-testid="install-automation-pipeline-blocked">
          {pipelineBindingError}
        </span>
      );
    }
    if (targetError !== null || pipelineUncheckable) {
      return (
        <span data-testid="install-automation-target-blocked">
          {targetError ?? TARGET_UNCHECKABLE_LABEL}
        </span>
      );
    }
    if (pluginsBlocked && !pluginResolution.ok) {
      return (
        <span data-testid="install-automation-plugins-blocked">
          {`Install these before continuing: ${pluginResolution.missing.join(', ')}. This automation references plugins that are not available on this machine.`}
        </span>
      );
    }
    if (
      capabilityPackage !== undefined &&
      packageReadiness?.status === 'invalid'
    ) {
      return (
        <span data-testid="install-automation-package-invalid">
          {PACKAGE_INVALID_LABEL}
        </span>
      );
    }
    if (revisionChanged) {
      return (
        <span data-testid="install-automation-revision-changed">
          {REVISION_CHANGED_LABEL}
        </span>
      );
    }
    if (pipelineRef?.source === 'shared' && pinVerifying) {
      return (
        <span data-testid="install-automation-pin-verifying">
          {PIN_VERIFYING_LABEL}
        </span>
      );
    }
    if (pipelinePreview.status === 'running' && !existingActivity) {
      return (
        <span data-testid="install-automation-pipelines-preparing">
          {PIPELINE_STAGE_RUNNING_LABEL}
        </span>
      );
    }
    if (targetsLoading) {
      return (
        <span data-testid="install-automation-target-checking">
          {TARGET_CHECKING_LABEL}
        </span>
      );
    }
    return null;
  })();

  const description =
    markdownDescriptionToPlainText(detail.automation.description) ||
    shareInstallDefaultDescription('automation');

  // CAN-3710: the same light review as every other shared resource. Only the
  // choices the install cannot proceed without are inputs; packaged
  // resources, the bundled pipeline and update notes stay on the detail page
  // and the landed result.
  const inputFields = (
    <>
      {copyPicker}

      {awaitingPipelineChoice && (
        <p
          className="text-s fg-secondary"
          data-testid="install-automation-target-checking"
        >
          {TARGET_CHOOSE_PIPELINE_LABEL}
        </p>
      )}

      {noCompatibleProjects && (
        <p
          className="text-s fg-secondary"
          data-testid="install-automation-target-empty"
        >
          {`This automation runs in ${formatAutomationTargetContexts(allowedContexts)}. ${onCreateProject ? (creationChecked ? (creationContexts.length > 0 ? 'Create a compatible project to continue.' : 'Choose a context that supports compatible project creation.') : 'Checking project creation availability…') : 'Create a compatible project from the sidebar, then open this installation again.'}`}
        </p>
      )}

      {noCompatibleProjects &&
        onCreateProject &&
        creationContexts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {creationContexts.map((context) => (
              <Button
                key={context}
                variant="secondary"
                data-testid={`install-automation-create-${context}`}
                onClick={(): void =>
                  onCreateProject(context, {
                    workspaceId,
                    coworkWorkspaceId,
                    existingBranch,
                    inputs,
                    chosenPipelineId,
                    taskId,
                    runConditionEnabled,
                    runConditionCommand,
                  })
                }
              >
                {context === 'cowork'
                  ? `Create a ${CHAT_LABEL} project`
                  : 'Create a code project'}
              </Button>
            ))}
          </div>
        )}

      {noCompatibleProjects &&
        onCreateProject &&
        creationChecked &&
        creationContexts.length === 0 && (
          <p
            className="text-s fg-secondary"
            data-testid="install-automation-creation-unavailable"
          >
            Compatible project creation isn’t available here. Choose another
            organization or Personal from the sidebar, then open this
            installation again.
          </p>
        )}

      {packagedPipelineRows.length > 0 && (
        <section
          className="flex flex-col gap-1.5"
          data-testid="install-automation-packaged-pipelines"
        >
          <Heading level={3} variant="title">
            {PACKAGED_PIPELINES_HEADING}
          </Heading>
          <p className="text-xs fg-secondary">{PACKAGED_PIPELINES_NOTE}</p>
          <ul className="divide-y divide-line-base">
            {packagedPipelineRows.map((row) => (
              <li
                key={`${row.status}:${row.key}`}
                className="flex flex-col py-1.5 text-s gap-1"
                data-testid={`install-automation-packaged-pipeline-${row.key}`}
                data-status={row.status}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate fg-primary">
                    {row.name}
                  </span>
                  <span className="shrink-0 text-xs fg-secondary">
                    {PACKAGED_PIPELINE_STATUS_LABELS[row.status]}
                  </span>
                </div>
                {row.fileChanges && (
                  <ul
                    className="flex flex-col text-xs gap-0.5"
                    data-testid={`install-automation-packaged-pipeline-${row.key}-files`}
                  >
                    {packagedPipelineFileChangeLines(row.fileChanges).map(
                      (line) => (
                        <li
                          key={line.text}
                          className={
                            line.tone === 'warning'
                              ? 'fg-warning'
                              : 'fg-secondary'
                          }
                        >
                          {line.text}
                        </li>
                      ),
                    )}
                  </ul>
                )}
                {row.rawPipeline !== undefined && (
                  <Disclosure
                    className=""
                    label={PACKAGED_PIPELINE_REVIEW_LABEL}
                    dataTestId={`install-automation-packaged-pipeline-${row.key}-review-disclosure`}
                    toggleTestId={`install-automation-packaged-pipeline-${row.key}-review`}
                  >
                    <InlinePipelineYamlPreview
                      rawPipeline={row.rawPipeline}
                      testId={`install-automation-packaged-pipeline-${row.key}-yaml`}
                    />
                  </Disclosure>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {needsWorkspace && !noCompatibleProjects && (
        <FormField label={WORKSPACE_LABEL}>
          {(control) => (
            <Select
              {...control}
              value={workspaceId === '' ? null : workspaceId}
              onValueChange={setWorkspaceId}
              placeholder={WORKSPACE_PLACEHOLDER}
              disabled={submitting || !targetsSettled}
              data-testid="install-automation-workspace"
              options={eligibleWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
          )}
        </FormField>
      )}

      {destination === 'task' &&
        needsWorkspace &&
        !noCompatibleProjects &&
        workspaceId !== '' && (
          <AutomationPipelineTaskField
            projectKind={selectedTargetKind === 'cowork' ? 'cowork' : 'code'}
            taskId={taskId}
            tasks={taskList.tasks}
            onTaskChange={setTaskId}
            onRetryTasks={taskList.retry}
            disabled={submitting}
            testIdPrefix="install-automation"
          />
        )}

      {needsCoworkWorkspace && !noCompatibleProjects && (
        <FormField
          label={COWORK_WORKSPACE_LABEL}
          description={COWORK_WORKSPACE_NOTE}
        >
          {(control) => (
            <Select
              {...control}
              value={coworkWorkspaceId === '' ? null : coworkWorkspaceId}
              onValueChange={setCoworkWorkspaceId}
              placeholder={COWORK_WORKSPACE_PLACEHOLDER}
              disabled={submitting || !targetsSettled}
              data-testid="install-automation-cowork-project"
              options={coworkWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
          )}
        </FormField>
      )}

      {pipelineRef?.source === 'unresolved' && (
        <FormField
          label={PIPELINE_LABEL}
          description={
            !pipelinesLoading && localPipelines.length === 0
              ? PIPELINE_EMPTY_LABEL
              : PIPELINE_NOTE
          }
        >
          {(control) => (
            <Select
              {...control}
              value={chosenPipelineId === '' ? null : chosenPipelineId}
              onValueChange={setChosenPipelineId}
              placeholder={
                pipelinesLoading ? PIPELINE_LOADING_LABEL : PIPELINE_PLACEHOLDER
              }
              disabled={submitting || pipelinesLoading}
              data-testid="install-automation-pipeline"
              options={localPipelines.map((pipeline) => ({
                value: pipeline.id,
                label: pipeline.name,
              }))}
            />
          )}
        </FormField>
      )}

      {action.type === 'worktree_prompt' && (
        <FormField label="Branch (optional, suggested by the author)">
          {(control) => (
            <TextInput
              {...control}
              type="text"
              value={existingBranch}
              onChange={(e) => setExistingBranch(e.target.value)}
              disabled={submitting}
              data-testid="install-automation-branch"
            />
          )}
        </FormField>
      )}

      {inputKeys.length > 0 && (
        <Fieldset
          gap="inline"
          legend={<span className="text-s fg-secondary">Workflow inputs</span>}
          data-testid="install-automation-inputs"
        >
          {inputKeys.map((key) => (
            <FormField key={key} label={key}>
              {(control) => (
                <TextInput
                  {...control}
                  type="text"
                  value={inputs[key] ?? ''}
                  onChange={(e) =>
                    setInputs((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  disabled={submitting}
                  data-testid={`install-automation-input-${key}`}
                />
              )}
            </FormField>
          ))}
        </Fieldset>
      )}

      {sharedRunCondition !== null && (
        <div
          className="flex flex-col gap-1.5"
          data-testid="install-automation-run-condition"
        >
          <ShareCheckbox
            checked={runConditionEnabled}
            onChange={setRunConditionEnabled}
            disabled={submitting}
            inputTestId="install-automation-run-condition-toggle"
          >
            Check a command before each run
          </ShareCheckbox>
          {/* Shown even while off, so the command can be read before it's
              turned on. */}
          <TextArea
            mono
            value={runConditionCommand}
            onChange={(e) => setRunConditionCommand(e.target.value)}
            disabled={submitting}
            readOnly={!runConditionEnabled}
            aria-label="Run condition command"
            spellCheck={false}
            rows={2}
            data-testid="install-automation-run-condition-command"
            // Grows with the command, uncapped, so the whole of it shows
            // before install and padding can't push a payload out of view.
            className="field-sizing-content"
          />
          {/* Declining an update keeps a local gate, which still fills it. */}
          {!runConditionEnabled &&
            runConditionOutputName !== null &&
            existingRunCondition === '' && (
              <p
                className="text-xs fg-secondary"
                data-testid="install-automation-run-condition-output-note"
              >
                {`{{${runConditionOutputName}}} won't be filled in without the run condition.`}
              </p>
            )}
          {runConditionReplacesExisting && (
            <p
              className="text-xs fg-secondary"
              data-testid="install-automation-run-condition-keeps-current"
            >
              Leaving this off keeps your current command.
            </p>
          )}
          {runConditionAlreadyCurrent && (
            <p
              className="text-xs fg-secondary"
              data-testid="install-automation-run-condition-already-current"
            >
              Your copy already uses this command.
            </p>
          )}
          {runConditionTurnsOff && (
            <p
              className="text-xs fg-secondary"
              data-testid="install-automation-run-condition-turns-off"
            >
              The automation turns off after this update so you can check it
              first.
            </p>
          )}
        </div>
      )}

      {runConditionRemoved && (
        <p
          className="text-xs fg-secondary"
          data-testid="install-automation-run-condition-removed"
        >
          The author removed the run condition, so this update removes yours
          too.
        </p>
      )}

      {submitReason !== null && (
        <p
          className="text-xs fg-secondary"
          data-testid="install-automation-submit-reason"
        >
          {submitReason}
        </p>
      )}
    </>
  );
  const hasInputs =
    copyPicker !== null ||
    packagedPipelineRows.length > 0 ||
    awaitingPipelineChoice ||
    noCompatibleProjects ||
    (needsWorkspace && !noCompatibleProjects) ||
    (needsCoworkWorkspace && !noCompatibleProjects) ||
    pipelineRef?.source === 'unresolved' ||
    action.type === 'worktree_prompt' ||
    inputKeys.length > 0 ||
    sharedRunCondition !== null ||
    runConditionRemoved ||
    submitReason !== null;

  return (
    <ShareInstallDialog
      title={detail.automation.name}
      typeLabel={shareInstallTypeLabel('automation')}
      publisher={subtitle}
      description={description}
      {...(hasInputs ? { inputs: inputFields } : {})}
      blocker={blocker}
      primary={{
        label: isUpdate ? UPDATE_LABEL : INSTALL_LABEL,
        testId: 'install-automation-submit',
        spinnerTestId: 'install-automation-submit-spinner',
        busy: submitting,
        disabled: submitDisabled,
        onClick: (): void => {
          void handleSubmit();
        },
      }}
      busy={submitting}
      onClose={onClose}
      titleId="install-shared-automation-title"
      dataTestId="install-shared-automation-modal"
    />
  );
}
