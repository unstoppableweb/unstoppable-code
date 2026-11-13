import type {
  SharedAutomationAction,
  SharedAutomationDocument,
  SharedAutomationInstallSource,
  SharedAutomationModelConfig,
  SharedAutomationPipelineDependency,
  SharedAutomationTrigger,
} from '@canopy/protocol/automations';
import {
  SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
  SHARED_AUTOMATION_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION,
  canonicalizeSharedAutomationPrompt,
  projectKindToTargetContext,
  validateSharedAutomationDocument,
} from '@canopy/protocol/automations';
import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
} from '@canopy/pipeline-interop/automation-target';
import {
  automationTargetBindingChanged,
  type AutomationSessionTargetKind,
} from './automation-target';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
  resolveAutomationPipelineTarget,
  PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR,
  PIPELINE_TARGET_NEW_WORKTREE_COWORK_ERROR,
} from './automation-pipeline-target';
import {
  buildSharedPipelineId,
  type PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import { CANOPY_CLOUD_SERVER_ID } from '../constants/canopy-cloud';
import type {
  AgentModelConfig,
  AutomationAction,
  AutomationCreateRequest,
  AutomationExistingPipelineInstall,
  AutomationInstalledFromMetadata,
  AutomationInstalledPipelineDependency,
  AutomationTrigger,
  AutomationUpdateRequest,
  ChatTabPluginSelections,
  ScheduledActivity,
} from '../types';

/**
 * Pure rebind mappers for the CAN-1581 shared-Automation install wizard.
 *
 * The portable document deliberately strips every machine binding, so an
 * install is a rebind: the recipient supplies a target workspace (for
 * worktree-scoped actions), input values for the documented `inputKeys`, and
 * locally resolved plugin selections. The mappers turn the document plus
 * those bindings into the automations-service request shapes:
 *
 *  - installs are ALWAYS created disabled with `installedFrom` provenance;
 *    the install review turns the copy on only after everything it needs
 *    (bundled pipeline, capability package) is in place;
 *  - applying a remote update preserves the recipient's bindings, keeps the
 *    enabled state only when the trigger is unchanged, and refreshes the
 *    recorded source contentHash while retaining the analytics dedupe stamps.
 *
 * Pure and timestamp-injected so the wizard, tests, and any future headless
 * caller share identical behavior.
 */

/**
 * Refusal when a pipeline installed from a share was edited on this machine:
 * applying the update would overwrite the recipient's work.
 */
export const AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE =
  'The installed workflow has local changes, so this update was not applied. Your local changes were preserved.';

/** Install copy for a document version this client does not understand. */
export const SHARED_AUTOMATION_NEWER_VERSION_MESSAGE =
  'This share needs a newer version of the app. Update the app and try again.';

const PIPELINES_NOT_INSTALLED_MESSAGE =
  'Install the pipelines this automation uses before installing it.';

export interface InstallSharedAutomationBindings {
  /** Advisory facts; main independently resolves the selected IDs. */
  targetKind?: AutomationSessionTargetKind;
  pipelineResolution?: AutomationPipelineResolution;
  /** Target workspace id for worktree-scoped actions. */
  workspaceId?: string;
  /** Existing task (worktree or Work Entry) for a `task` pipeline destination. */
  taskId?: string;
  /** Stable repository IDs available under the selected workspace. */
  repoIds?: string[];
  /** Target Cowork workspace id for portable standalone prompts. */
  coworkWorkspaceId?: string;
  /** Recipient-selected local pipeline for curated or unresolved refs. */
  pipelineId?: string;
  pipelineSource?: 'user' | 'project' | 'curated' | 'shared';
  projectPipelineFilename?: string;
  /** Pin returned by the shared-pipeline verification service. */
  verifiedSharedPipelineInstallPin?: PipelineShareInstallPin;
  /** Local pipeline created from an inline pipeline definition. */
  bundledPipelineLocalId?: string;
  /**
   * Local pipelines materialized for the share's packaged pipelines (Stage A
   * of the package install), one per key. Key `action` is a
   * `worktree_pipeline` action's own pipeline; the others are prompt
   * dependencies whose prompt mentions are rewritten to these IDs.
   */
  pipelineDependencies?: AutomationInstalledPipelineDependency[];
  /**
   * Current content hash of each recorded local pipeline, keyed by local
   * pipeline ID; `null` when it no longer exists. Update only: a recorded
   * dependency whose hash differs from the one last installed refuses the
   * update with {@link AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE}.
   */
  localPipelineContentHashes?: Readonly<Record<string, string | null>>;
  /**
   * Recipient-confirmed branch for `worktree_prompt` actions. The document's
   * `existingBranch` is only a suggestion — the wizard prefills it, and only
   * the value the recipient confirms (or clears) is persisted.
   */
  existingBranch?: string;
  /** Values for the document's `inputKeys` (worktree_pipeline only). */
  inputs?: Record<string, string>;
  /** Locally resolved plugin selections (prompt actions only). */
  pluginSelections?: ChatTabPluginSelections;
  /**
   * The run-condition command the recipient saw and left on, possibly edited.
   * Undefined means declined or absent. This is the only source of a stored
   * `ifCommand`: the builders never read the document's `runCondition`, so a
   * caller that omits it installs or updates with no gate change.
   */
  approvedRunCondition?: string;
}

export type BuildInstallAutomationRequestResult =
  | { ok: true; request: AutomationCreateRequest }
  | { ok: false; error: string };

export type BuildApplyUpdateRequestResult =
  | {
      ok: true;
      request: AutomationUpdateRequest;
      keptEnabled: boolean;
      /**
       * Recorded pipelines the new share no longer lists. Their local
       * pipelines stay, and callers need not act on them: Stage B unlinks their
       * pipeline-owner records when it releases the previous package
       * (`releaseAutomationPackagePipelineInstalls`), and keeps them while
       * another installed automation still uses that package.
       */
      droppedPipelineDependencies: AutomationInstalledPipelineDependency[];
    }
  | { ok: false; error: string };

type PipelineMappingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function promptPipelineDependencies(
  action: SharedAutomationAction,
): SharedAutomationPipelineDependency[] {
  return action.type === 'worktree_pipeline'
    ? []
    : (action.pipelineDependencies ?? []);
}

/**
 * Every packaged pipeline the document carries, by key, with the hash the
 * capability package must deliver for it.
 */
function packagedPipelineHashes(
  automation: SharedAutomationDocument,
): Map<string, string> {
  const hashes = new Map<string, string>();
  const action = automation.action;
  if (action.type === 'worktree_pipeline') {
    if (action.pipeline.source === 'packaged') {
      hashes.set(action.pipeline.key, action.pipeline.pipelineContentHash);
    }
    return hashes;
  }
  for (const dependency of promptPipelineDependencies(action)) {
    if (dependency.pipeline.source === 'packaged') {
      hashes.set(dependency.key, dependency.pipeline.pipelineContentHash);
    }
  }
  return hashes;
}

/**
 * Resolve the local pipeline for each packaged key from the Stage A
 * bindings. Every packaged pipeline must be installed, and installed at the
 * exact hash the document names.
 */
function packagedPipelineLocalIds(
  automation: SharedAutomationDocument,
  bindings: InstallSharedAutomationBindings,
): PipelineMappingResult<Map<string, string>> {
  const installed = new Map(
    (bindings.pipelineDependencies ?? []).map((entry) => [entry.key, entry]),
  );
  const localIds = new Map<string, string>();
  for (const [key, pipelineContentHash] of Array.from(
    packagedPipelineHashes(automation),
  )) {
    const entry = installed.get(key);
    const localPipelineId =
      entry?.localPipelineId ??
      (key === SHARED_AUTOMATION_ACTION_PIPELINE_KEY
        ? bindings.bundledPipelineLocalId
        : undefined);
    if (localPipelineId === undefined) {
      return { ok: false, error: PIPELINES_NOT_INSTALLED_MESSAGE };
    }
    if (
      entry !== undefined &&
      entry.pipelineContentHash !== pipelineContentHash
    ) {
      return {
        ok: false,
        error:
          'An installed pipeline does not match this share. Refresh and try again.',
      };
    }
    localIds.set(key, localPipelineId);
  }
  return { ok: true, value: localIds };
}

/**
 * Replace each packaged dependency's prompt mentions with the recipient's
 * local pipeline ID. Mentions are UUIDs and local IDs are UUIDs, so every
 * replacement must keep the prompt length and configured prompt reference
 * offsets stay valid; edits are applied from the last offset to the first.
 */
export function rewriteSharedAutomationPromptPipelines(
  prompt: string,
  dependencies: readonly SharedAutomationPipelineDependency[] | undefined,
  localPipelineIds: ReadonlyMap<string, string>,
  promptReferences?: readonly ConfiguredPromptReference[],
): PipelineMappingResult<string> {
  const canonicalPrompt = canonicalizeSharedAutomationPrompt(prompt);
  const edits: Array<{ textStart: number; text: string; replacement: string }> =
    [];
  for (const dependency of dependencies ?? []) {
    if (dependency.promptSpans.length === 0) continue;
    const localPipelineId = localPipelineIds.get(dependency.key);
    if (localPipelineId === undefined) {
      return { ok: false, error: PIPELINES_NOT_INSTALLED_MESSAGE };
    }
    const replacement = localPipelineId.toLowerCase();
    for (const span of dependency.promptSpans) {
      if (replacement.length !== span.text.length) {
        return {
          ok: false,
          error: `The prompt's mention of the "${dependency.pipeline.name ?? dependency.key}" pipeline could not be updated to its local ID.`,
        };
      }
      edits.push({ textStart: span.textStart, text: span.text, replacement });
    }
  }
  edits.sort((left, right) => right.textStart - left.textStart);
  let rewritten = canonicalPrompt;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    const end = edit.textStart + edit.text.length;
    if (
      end > previousStart ||
      rewritten.slice(edit.textStart, end) !== edit.text ||
      (promptReferences ?? []).some(
        (reference) =>
          edit.textStart < reference.textStart + reference.displayText.length &&
          reference.textStart < end,
      )
    ) {
      return {
        ok: false,
        error:
          'The prompt no longer matches its pipeline mentions. Ask the author to share it again.',
      };
    }
    rewritten = `${rewritten.slice(0, edit.textStart)}${edit.replacement}${rewritten.slice(end)}`;
    previousStart = edit.textStart;
  }
  return { ok: true, value: rewritten };
}

/**
 * The prompt with packaged pipeline mentions rewritten, for a prompt action.
 */
function mappedPrompt(
  action: Exclude<SharedAutomationAction, { type: 'worktree_pipeline' }>,
  localPipelineIds: ReadonlyMap<string, string>,
): PipelineMappingResult<string> {
  return rewriteSharedAutomationPromptPipelines(
    action.prompt,
    action.pipelineDependencies,
    localPipelineIds,
    action.promptReferences,
  );
}

/** Install provenance for the document's packaged pipelines. */
function packagedPipelineProvenance(
  automation: SharedAutomationDocument,
  localPipelineIds: ReadonlyMap<string, string>,
): Pick<
  AutomationInstalledFromMetadata,
  | 'bundledPipelineLocalId'
  | 'bundledPipelineContentHash'
  | 'pipelineDependencies'
> {
  const action = automation.action;
  if (action.type === 'worktree_pipeline') {
    const localPipelineId =
      action.pipeline.source === 'packaged'
        ? localPipelineIds.get(action.pipeline.key)
        : undefined;
    return action.pipeline.source === 'packaged' &&
      localPipelineId !== undefined
      ? {
          bundledPipelineLocalId: localPipelineId,
          bundledPipelineContentHash: action.pipeline.pipelineContentHash,
        }
      : {};
  }
  const pipelineDependencies: AutomationInstalledPipelineDependency[] = [];
  for (const dependency of promptPipelineDependencies(action)) {
    const localPipelineId = localPipelineIds.get(dependency.key);
    if (
      dependency.pipeline.source !== 'packaged' ||
      localPipelineId === undefined
    )
      continue;
    pipelineDependencies.push({
      key: dependency.key,
      localPipelineId,
      pipelineContentHash: dependency.pipeline.pipelineContentHash,
    });
  }
  return pipelineDependencies.length > 0 ? { pipelineDependencies } : {};
}

/** Locally installed pipelines recorded for a share, by key. */
function recordedPipelineInstalls(
  installedFrom: AutomationInstalledFromMetadata | undefined,
  automation: SharedAutomationDocument,
): AutomationInstalledPipelineDependency[] {
  const recorded = [...(installedFrom?.pipelineDependencies ?? [])];
  if (installedFrom?.bundledPipelineLocalId !== undefined) {
    // An older inline install may lack the hash; like the inline update path,
    // it then updates in place only when its bytes already equal the new ones.
    const incoming = packagedPipelineHashes(automation).get(
      SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
    );
    const pipelineContentHash =
      installedFrom.bundledPipelineContentHash ?? incoming;
    if (pipelineContentHash !== undefined) {
      recorded.push({
        key: SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
        localPipelineId: installedFrom.bundledPipelineLocalId,
        pipelineContentHash,
      });
    }
  }
  return recorded;
}

/** Keys the new document still installs locally, packaged or inline. */
function documentPipelineKeys(
  automation: SharedAutomationDocument,
): Set<string> {
  const keys = new Set(packagedPipelineHashes(automation).keys());
  if (
    automation.action.type === 'worktree_pipeline' &&
    automation.action.pipeline.source === 'inline'
  ) {
    keys.add(SHARED_AUTOMATION_ACTION_PIPELINE_KEY);
  }
  return keys;
}

export interface AutomationPipelineUpdatePlan {
  /** Stage A `existingPipelines` for the packaged keys the share still lists. */
  existingPipelines: AutomationExistingPipelineInstall[];
  /** Recorded pipelines the new share no longer lists. */
  dropped: AutomationInstalledPipelineDependency[];
}

/**
 * Plan how an update reuses the pipelines an earlier install recorded: each
 * still-listed packaged key keeps its local pipeline (Stage A
 * `existingPipelines`), and keys the share no longer lists are dropped.
 * With `localPipelineContentHashes`, a recorded pipeline edited since it was
 * installed refuses the whole update, and one that no longer exists is left
 * for Stage A to create again. Without them, Stage A makes the same check.
 */
export function planAutomationPipelineUpdate(
  installedFrom: AutomationInstalledFromMetadata | undefined,
  automation: SharedAutomationDocument,
  localPipelineContentHashes?: Readonly<Record<string, string | null>>,
): PipelineMappingResult<AutomationPipelineUpdatePlan> {
  const packaged = packagedPipelineHashes(automation);
  const listed = documentPipelineKeys(automation);
  const existingPipelines: AutomationExistingPipelineInstall[] = [];
  const dropped: AutomationInstalledPipelineDependency[] = [];
  for (const record of recordedPipelineInstalls(installedFrom, automation)) {
    if (!listed.has(record.key)) {
      dropped.push(record);
      continue;
    }
    if (!packaged.has(record.key)) continue;
    const current = localPipelineContentHashes?.[record.localPipelineId];
    if (current === null) continue;
    if (current !== undefined && current !== record.pipelineContentHash) {
      return { ok: false, error: AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE };
    }
    existingPipelines.push({
      key: record.key,
      localPipelineId: record.localPipelineId,
      expectedContentHash: record.pipelineContentHash,
    });
  }
  return { ok: true, value: { existingPipelines, dropped } };
}

function approvedIfCommand(
  bindings: InstallSharedAutomationBindings,
): { ifCommand: string } | Record<string, never> {
  const command = bindings.approvedRunCondition?.trim();
  return command ? { ifCommand: command } : {};
}

/**
 * The installed copy's gate when it is still the shared command the recipient
 * approved, or null when there is no gate or the recipient has since changed
 * it locally. Only a share-approved gate follows the author's later revisions.
 */
export function shareApprovedRunCondition(
  existing: Pick<ScheduledActivity, 'ifCommand' | 'installedFrom'>,
): string | null {
  const gate = existing.ifCommand?.trim() ?? '';
  const approved = existing.installedFrom?.approvedRunCondition?.trim() ?? '';
  return gate !== '' && gate === approved ? gate : null;
}

function mapTrigger(trigger: SharedAutomationTrigger): AutomationTrigger {
  return trigger.kind === 'cron'
    ? { kind: 'cron', expression: trigger.expression, timezone: 'local' }
    : { kind: 'one_time', runAt: trigger.runAt, timezone: 'local' };
}

/**
 * Split the portable model config back into the local action fields: `model`
 * lives beside the action, while thinking level and fast mode form the local
 * {@link AgentModelConfig}.
 */
function splitModelConfig(config: SharedAutomationModelConfig | undefined): {
  model?: string;
  modelConfig?: AgentModelConfig;
} {
  if (!config) return {};
  const modelConfig: AgentModelConfig = {
    ...(config.thinkingLevel !== undefined
      ? { thinkingLevel: config.thinkingLevel }
      : {}),
    // The validated document already pairs `speed` with its derived boolean.
    ...(config.speed !== undefined
      ? { speed: config.speed, fastMode: config.speed === 'fast' }
      : config.fastMode !== undefined
        ? { fastMode: config.fastMode }
        : {}),
  };
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(Object.keys(modelConfig).length > 0 ? { modelConfig } : {}),
  };
}

function validateInputs(
  inputs: Record<string, string> | undefined,
  inputKeys: readonly string[],
): string | null {
  if (!inputs) return null;
  for (const key of Object.keys(inputs)) {
    if (!inputKeys.includes(key)) {
      return `Input "${key}" is not part of this shared automation.`;
    }
  }
  return null;
}

function installPinsEqual(
  expected: PipelineShareInstallPin | undefined,
  verified: PipelineShareInstallPin | undefined,
): boolean {
  return (
    expected !== undefined &&
    verified !== undefined &&
    expected.pipelineContentHash === verified.pipelineContentHash &&
    expected.distributionMode === verified.distributionMode &&
    expected.packageDigest === verified.packageDigest
  );
}

function pipelineVerificationError(name: string | undefined): string {
  return `The pinned version of "${name ?? 'this workflow'}" could not be verified. Refresh and try again.`;
}

function mapAction(
  action: SharedAutomationAction,
  bindings: InstallSharedAutomationBindings,
  localPipelineIds: ReadonlyMap<string, string>,
): { ok: true; action: AutomationAction } | { ok: false; error: string } {
  if (
    'promptReferences' in action &&
    action.promptReferences?.some(
      (ref) =>
        ref.kind === 'file' &&
        ref.root.kind === 'repo' &&
        !bindings.repoIds?.includes(ref.root.repoId),
    )
  ) {
    return {
      ok: false,
      error:
        'A referenced repository is unavailable in the selected project. Choose a project with the same repository IDs.',
    };
  }
  if (action.type === 'app_advisor_prompt') {
    const prompt = mappedPrompt(action, localPipelineIds);
    if (!prompt.ok) return prompt;
    return {
      ok: true,
      action: {
        type: 'app_advisor_prompt',
        prompt: prompt.value,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...splitModelConfig(action.modelConfig),
        ...(bindings.pluginSelections
          ? { pluginSelections: bindings.pluginSelections }
          : {}),
      },
    };
  }

  if (action.type === 'standalone_prompt') {
    if (!bindings.coworkWorkspaceId) {
      return {
        ok: false,
        error: 'Choose a Cowork project for this automation before installing.',
      };
    }
    const prompt = mappedPrompt(action, localPipelineIds);
    if (!prompt.ok) return prompt;
    return {
      ok: true,
      action: {
        type: 'standalone_prompt',
        chatProjectId: bindings.coworkWorkspaceId,
        prompt: prompt.value,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...splitModelConfig(action.modelConfig),
        ...(bindings.pluginSelections
          ? { pluginSelections: bindings.pluginSelections }
          : {}),
      },
    };
  }

  if (action.type === 'worktree_pipeline')
    return mapPipelineAction(action, bindings, localPipelineIds);

  if (!bindings.workspaceId) {
    return {
      ok: false,
      error: 'Choose a project for this automation before installing.',
    };
  }

  const prompt = mappedPrompt(action, localPipelineIds);
  if (!prompt.ok) return prompt;
  return {
    ok: true,
    action: {
      type: 'worktree_prompt',
      workspaceId: bindings.workspaceId,
      ...(bindings.existingBranch !== undefined
        ? { existingBranch: bindings.existingBranch }
        : {}),
      prompt: prompt.value,
      ...(action.promptReferences
        ? { promptReferences: action.promptReferences }
        : {}),
      ...splitModelConfig(action.modelConfig),
      ...(action.planMode !== undefined ? { planMode: action.planMode } : {}),
      ...(action.interfaceMode !== undefined
        ? { interfaceMode: action.interfaceMode }
        : {}),
      ...(bindings.pluginSelections
        ? { pluginSelections: bindings.pluginSelections }
        : {}),
    },
  };
}

type PipelineAutomationLocation = Pick<
  Extract<AutomationAction, { type: 'worktree_pipeline' }>,
  'workspaceId' | 'target'
>;

/**
 * The recipient's binding for a portable pipeline destination, resolved
 * before the pipeline source. Portable `workspace` installs as a legacy
 * action with no `target`; no destination needs a project.
 */
function mapPipelineLocation(
  kind: Extract<
    SharedAutomationAction,
    { type: 'worktree_pipeline' }
  >['target']['kind'],
  bindings: InstallSharedAutomationBindings,
):
  | { ok: true; location: PipelineAutomationLocation }
  | { ok: false; error: string } {
  if (kind === 'global')
    return { ok: true, location: { target: { kind: 'global' } } };
  const workspaceId = bindings.workspaceId;
  if (!workspaceId)
    return {
      ok: false,
      error: 'Choose a project for this automation before installing.',
    };
  switch (kind) {
    case 'workspace':
      return { ok: true, location: { workspaceId } };
    case 'new_worktree':
      return bindings.targetKind === 'cowork'
        ? { ok: false, error: PIPELINE_TARGET_NEW_WORKTREE_COWORK_ERROR }
        : {
            ok: true,
            location: { workspaceId, target: { kind: 'new_worktree' } },
          };
    case 'task':
      return bindings.taskId
        ? {
            ok: true,
            location: {
              workspaceId,
              target: { kind: 'task', taskId: bindings.taskId },
            },
          }
        : { ok: false, error: 'Pick a task to run the workflow in.' };
    case 'project':
      return {
        ok: true,
        location: { workspaceId, target: { kind: 'project' } },
      };
  }
}

function mapPipelineAction(
  action: Extract<SharedAutomationAction, { type: 'worktree_pipeline' }>,
  bindings: InstallSharedAutomationBindings,
  localPipelineIds: ReadonlyMap<string, string>,
): { ok: true; action: AutomationAction } | { ok: false; error: string } {
  const mappedLocation = mapPipelineLocation(action.target.kind, bindings);
  if (!mappedLocation.ok) return mappedLocation;
  const location = mappedLocation.location;
  const global = location.target?.kind === 'global';

  const inputsError = validateInputs(bindings.inputs, action.inputKeys);
  if (inputsError) {
    return { ok: false, error: inputsError };
  }
  const inputs =
    bindings.inputs && Object.keys(bindings.inputs).length > 0
      ? bindings.inputs
      : undefined;

  if (action.pipeline.source === 'bundled') {
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        ...location,
        pipelineId: action.pipeline.pipelineId,
        pipelineSource: 'bundled',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (action.pipeline.source === 'inline') {
    if (!bindings.bundledPipelineLocalId) {
      return {
        ok: false,
        error:
          'Install the bundled workflow definition before installing this automation.',
      };
    }
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        ...location,
        pipelineId: bindings.bundledPipelineLocalId,
        pipelineSource: 'user',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (action.pipeline.source === 'packaged') {
    const localPipelineId = localPipelineIds.get(action.pipeline.key);
    if (localPipelineId === undefined) {
      return { ok: false, error: PIPELINES_NOT_INSTALLED_MESSAGE };
    }
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        ...location,
        pipelineId: localPipelineId,
        pipelineSource: 'user',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (action.pipeline.source === 'shared') {
    if (
      action.pipeline.installPin === undefined ||
      !installPinsEqual(
        action.pipeline.installPin,
        bindings.verifiedSharedPipelineInstallPin,
      )
    ) {
      return {
        ok: false,
        error: pipelineVerificationError(action.pipeline.name),
      };
    }
    return {
      ok: true,
      action: {
        type: 'worktree_pipeline',
        ...location,
        pipelineId: buildSharedPipelineId(
          CANOPY_CLOUD_SERVER_ID,
          action.pipeline.remoteId,
        ),
        pipelineSource: 'shared',
        ...(action.pipeline.name !== undefined
          ? { pipelineName: action.pipeline.name }
          : {}),
        sharedPipeline: {
          serverId: CANOPY_CLOUD_SERVER_ID,
          remoteId: action.pipeline.remoteId,
          installPin: action.pipeline.installPin,
        },
        ...(inputs ? { inputs } : {}),
      },
    };
  }

  if (!bindings.pipelineId) {
    const subject = action.pipeline.name ?? action.pipeline.source;
    return {
      ok: false,
      error:
        action.pipeline.source === 'curated'
          ? `Import or choose the "${subject}" workflow before installing.`
          : 'Choose a workflow for this automation before installing.',
    };
  }

  const pipelineSource =
    action.pipeline.source === 'curated' ? 'curated' : bindings.pipelineSource;
  if (
    pipelineSource !== 'user' &&
    pipelineSource !== 'project' &&
    pipelineSource !== 'curated'
  ) {
    return {
      ok: false,
      error: 'Choose a workflow for this automation before installing.',
    };
  }
  if (global && pipelineSource === 'project')
    return { ok: false, error: PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR };
  return {
    ok: true,
    action: {
      type: 'worktree_pipeline',
      ...location,
      pipelineId: bindings.pipelineId,
      pipelineSource,
      ...(pipelineSource === 'project' && bindings.projectPipelineFilename
        ? { projectPipelineFilename: bindings.projectPipelineFilename }
        : {}),
      ...(action.pipeline.name !== undefined
        ? { pipelineName: action.pipeline.name }
        : {}),
      ...(inputs ? { inputs } : {}),
    },
  };
}

/**
 * Build the disabled create request for installing a shared Automation.
 * `installedAt` is injected so callers control the provenance timestamp.
 */
export function buildInstallAutomationRequest(
  detail: SharedAutomationInstallSource,
  bindings: InstallSharedAutomationBindings,
  installedAt: string,
  origin?: { sourceKind: 'public' | 'curated' },
): BuildInstallAutomationRequestResult {
  const versionError = unsupportedVersionError(detail);
  if (versionError) return { ok: false, error: versionError };
  const localPipelineIds = packagedPipelineLocalIds(
    detail.automation,
    bindings,
  );
  if (!localPipelineIds.ok) return localPipelineIds;
  const mapped = mapAction(
    detail.automation.action,
    bindings,
    localPipelineIds.value,
  );
  if (!mapped.ok) return mapped;
  const compatibilityError = validateInstallCompatibility(detail, bindings);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  const approved = approvedIfCommand(bindings).ifCommand;
  return {
    ok: true,
    request: {
      name: detail.automation.name,
      schedule: mapTrigger(detail.automation.trigger),
      action: mapped.action,
      ...(detail.automation.targetRequirement
        ? { targetRequirement: detail.automation.targetRequirement }
        : {}),
      ...(approved !== undefined ? { ifCommand: approved } : {}),
      enabled: false,
      installedFrom: {
        remoteId: detail.id,
        contentHash: detail.contentHash,
        installedAt,
        ...(origin !== undefined ? { sourceKind: origin.sourceKind } : {}),
        ...(approved !== undefined ? { approvedRunCondition: approved } : {}),
        ...(detail.automation.action.type === 'worktree_pipeline' &&
        detail.automation.action.pipeline.source === 'inline' &&
        bindings.bundledPipelineLocalId !== undefined
          ? {
              bundledPipelineLocalId: bindings.bundledPipelineLocalId,
              bundledPipelineContentHash:
                detail.automation.action.pipeline.pipelineContentHash,
            }
          : {}),
        ...packagedPipelineProvenance(
          detail.automation,
          localPipelineIds.value,
        ),
        ...(detail.automation.capabilityPackage
          ? { capabilityPackage: detail.automation.capabilityPackage }
          : {}),
      },
    },
  };
}

/**
 * {@link SHARED_AUTOMATION_NEWER_VERSION_MESSAGE} for a document version this
 * client cannot read, so a share from a newer author client reads as an
 * update prompt instead of validator text.
 */
function unsupportedVersionError(
  detail: SharedAutomationInstallSource,
): string | null {
  const version: unknown = detail.automation.version;
  return typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= SHARED_AUTOMATION_API_VERSION &&
    version <= SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION
    ? null
    : SHARED_AUTOMATION_NEWER_VERSION_MESSAGE;
}

function validateInstallCompatibility(
  detail: SharedAutomationInstallSource,
  bindings: InstallSharedAutomationBindings,
): string | null {
  const validated = validateSharedAutomationDocument(detail.automation);
  if (!validated.ok) return validated.error;
  const action = detail.automation.action;
  const requirement = detail.automation.targetRequirement;
  const destination =
    action.type === 'worktree_pipeline' && action.target.kind !== 'workspace'
      ? action.target.kind
      : undefined;
  const resolved = resolveAutomationTargetRequirement(
    action.type,
    requirement,
    bindings.pipelineResolution,
    destination,
  );
  if (resolved.status === 'error') return resolved.error;
  if (resolved.status !== 'resolved')
    return 'Verify the selected workflow before installing this automation.';
  // A destination with no project resolves without project contexts.
  if (destination === 'global') return null;
  const context =
    action.type === 'app_advisor_prompt'
      ? 'app_advisor'
      : projectKindToTargetContext(bindings.targetKind);
  if (!context || !resolved.contexts.includes(context))
    return 'Choose a compatible target before installing this automation.';

  return null;
}

function triggersEqual(
  local: ScheduledActivity['schedule'],
  shared: SharedAutomationTrigger,
): boolean {
  if (local.kind === 'cron' && shared.kind === 'cron') {
    return local.expression === shared.expression;
  }
  if (local.kind === 'one_time' && shared.kind === 'one_time') {
    return local.runAt === shared.runAt;
  }
  return false;
}

/**
 * Re-apply the recipient's machine-local action customizations after mapping
 * an updated document. The portable document never carries `baseWorktreeId`
 * or `repoId` (they are machine bindings the wizard does not collect), so a
 * hand-edited value must survive an update whenever it stays type-compatible:
 * same action type and an unchanged workspace binding. An explicit rebind to
 * a different workspace clears them, as does an action-type change. For
 * Prompt actions may also keep `sidebarGroupName` only when their target stays
 * the same; it remains a recipient-local setting. For `worktree_prompt` the
 * preserved `baseWorktreeId` yields to a recipient-confirmed branch or
 * existing-worktree target (these choices are mutually exclusive).
 */
function preserveLocalCustomizations(
  mapped: AutomationAction,
  existing: AutomationAction,
): AutomationAction {
  if (
    mapped.type === 'worktree_prompt' &&
    existing.type === 'worktree_prompt' &&
    mapped.workspaceId === existing.workspaceId &&
    mapped.existingWorktreeId === existing.existingWorktreeId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
      ...(mapped.existingBranch === undefined &&
      mapped.baseBranch === undefined &&
      mapped.existingWorktreeId === undefined &&
      existing.baseWorktreeId !== undefined
        ? { baseWorktreeId: existing.baseWorktreeId }
        : {}),
    };
  }
  if (
    mapped.type === 'app_advisor_prompt' &&
    existing.type === 'app_advisor_prompt' &&
    mapped.workEntryId === existing.workEntryId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
    };
  }
  if (
    mapped.type === 'standalone_prompt' &&
    existing.type === 'standalone_prompt' &&
    mapped.chatProjectId === existing.chatProjectId &&
    mapped.workEntryId === existing.workEntryId
  ) {
    return {
      ...mapped,
      ...(existing.sidebarGroupName?.trim()
        ? { sidebarGroupName: existing.sidebarGroupName.trim() }
        : {}),
    };
  }
  if (
    mapped.type === 'worktree_pipeline' &&
    existing.type === 'worktree_pipeline' &&
    pipelineAutomationWorkspaceId(mapped) ===
      pipelineAutomationWorkspaceId(existing)
  ) {
    // Only bindings the mapped destination admits survive: a base worktree
    // for a new worktree each run, a repository for any project destination.
    const destination = resolveAutomationPipelineTarget(mapped);
    const keepsBaseWorktree = destination?.kind === 'new_worktree';
    const keepsRepo = destination !== null && destination.kind !== 'global';
    return {
      ...mapped,
      ...(keepsBaseWorktree && existing.baseWorktreeId !== undefined
        ? { baseWorktreeId: existing.baseWorktreeId }
        : {}),
      ...(keepsRepo && existing.repoId !== undefined
        ? { repoId: existing.repoId }
        : {}),
      ...(existing.modelAliasPreferences !== undefined
        ? { modelAliasPreferences: existing.modelAliasPreferences }
        : {}),
      ...(existing.pluginCollectionPreferences !== undefined
        ? { pluginCollectionPreferences: existing.pluginCollectionPreferences }
        : {}),
      ...(existing.modelConfig !== undefined
        ? { modelConfig: existing.modelConfig }
        : {}),
    };
  }
  return mapped;
}

/**
 * Fill keys the caller's Stage A bindings omit from the earlier install's
 * records, but only where the recorded bytes equal the new document's, so an
 * unchanged pipeline keeps its local ID without a fresh Stage A result.
 */
function withRecordedPipelineBindings(
  bindings: InstallSharedAutomationBindings,
  recorded: readonly AutomationInstalledPipelineDependency[],
  automation: SharedAutomationDocument,
): InstallSharedAutomationBindings {
  const hashes = packagedPipelineHashes(automation);
  const bound = new Set(
    (bindings.pipelineDependencies ?? []).map((entry) => entry.key),
  );
  const filled = recorded.filter(
    (record) =>
      !bound.has(record.key) &&
      hashes.get(record.key) === record.pipelineContentHash &&
      bindings.localPipelineContentHashes?.[record.localPipelineId] !== null,
  );
  return filled.length === 0
    ? bindings
    : {
        ...bindings,
        pipelineDependencies: [
          ...(bindings.pipelineDependencies ?? []),
          ...filled,
        ],
      };
}

/**
 * Build the update request that re-applies a remote change to an installed
 * copy. The caller prefills `bindings` from the existing activity (dropping
 * input values whose keys no longer exist in the new document); the enabled
 * state survives only when the trigger is unchanged, otherwise the copy
 * drops to disabled pending re-confirmation. Machine-local customizations
 * the document cannot express (`baseWorktreeId`, pipeline `repoId`) are
 * preserved from the existing action when type-compatible — see
 * {@link preserveLocalCustomizations}.
 */
export function buildApplyUpdateRequest(
  detail: SharedAutomationInstallSource,
  existing: ScheduledActivity,
  bindings: InstallSharedAutomationBindings,
  appliedAt: string,
  origin?: { sourceKind: 'public' | 'curated' },
): BuildApplyUpdateRequestResult {
  const versionError = unsupportedVersionError(detail);
  if (versionError) return { ok: false, error: versionError };
  const pipelinePlan = planAutomationPipelineUpdate(
    existing.installedFrom,
    detail.automation,
    bindings.localPipelineContentHashes,
  );
  if (!pipelinePlan.ok) return pipelinePlan;
  const sharedAction = detail.automation.action;
  const withBundledPipeline =
    sharedAction.type === 'worktree_pipeline' &&
    sharedAction.pipeline.source === 'inline' &&
    bindings.bundledPipelineLocalId === undefined &&
    existing.installedFrom?.bundledPipelineLocalId !== undefined
      ? {
          ...bindings,
          bundledPipelineLocalId: existing.installedFrom.bundledPipelineLocalId,
        }
      : bindings;
  // A task binding survives an update that keeps the task kind in the same
  // project; any other kind change needs an explicit rebind.
  const existingTaskId =
    existing.action.type === 'worktree_pipeline'
      ? pipelineAutomationTaskId(existing.action)
      : undefined;
  const effectiveBindings =
    sharedAction.type === 'worktree_pipeline' &&
    sharedAction.target.kind === 'task' &&
    withBundledPipeline.taskId === undefined &&
    existingTaskId !== undefined &&
    existing.action.type === 'worktree_pipeline' &&
    withBundledPipeline.workspaceId ===
      pipelineAutomationWorkspaceId(existing.action)
      ? { ...withBundledPipeline, taskId: existingTaskId }
      : withBundledPipeline;
  const localPipelineIds = packagedPipelineLocalIds(
    detail.automation,
    withRecordedPipelineBindings(
      effectiveBindings,
      recordedPipelineInstalls(existing.installedFrom, detail.automation),
      detail.automation,
    ),
  );
  if (!localPipelineIds.ok) return localPipelineIds;
  const mapped = mapAction(
    sharedAction,
    effectiveBindings,
    localPipelineIds.value,
  );
  if (!mapped.ok) {
    return mapped;
  }
  const compatibilityError = validateInstallCompatibility(detail, bindings);
  if (compatibilityError) return { ok: false, error: compatibilityError };
  const appliedAction = preserveLocalCustomizations(
    mapped.action,
    existing.action,
  );
  // A newly approved command that differs from the current gate is a new
  // author command on this machine, so the copy lands disabled for review.
  // When the author removes the gate (`hasRunCondition: false`), a gate that
  // is still the one shared earlier is cleared to match. A gated revision that
  // keeps its command private, and a gate the recipient changed, both stay.
  const approved = approvedIfCommand(bindings).ifCommand;
  const currentGate = existing.ifCommand?.trim() ?? '';
  const sharedGate = shareApprovedRunCondition(existing);
  const clearsSharedGate =
    approved === undefined &&
    sharedGate !== null &&
    !detail.automation.hasRunCondition;
  const keptEnabled =
    triggersEqual(existing.schedule, detail.automation.trigger) &&
    !automationTargetBindingChanged(existing.action, appliedAction) &&
    (approved === undefined || approved === currentGate) &&
    existing.enabled;
  // Pipeline provenance describes only the currently installed inline ref.
  // Remove the previous pair before preserving the rest of the metadata so an
  // update to another action/ref shape cannot retain a stale local pipeline.
  const preservedInstalledFrom = { ...existing.installedFrom };
  delete preservedInstalledFrom.bundledPipelineLocalId;
  delete preservedInstalledFrom.bundledPipelineContentHash;
  delete preservedInstalledFrom.pipelineDependencies;
  delete preservedInstalledFrom.approvedRunCondition;
  const approvedRunCondition =
    approved ?? (clearsSharedGate ? undefined : (sharedGate ?? undefined));
  return {
    ok: true,
    keptEnabled,
    droppedPipelineDependencies: pipelinePlan.value.dropped,
    request: {
      id: existing.id,
      name: detail.automation.name,
      schedule: mapTrigger(detail.automation.trigger),
      action: appliedAction,
      targetRequirement: detail.automation.targetRequirement ?? null,
      // Omitted when declined, so the recipient's current local gate stays,
      // unless it is a shared gate the author has since dropped.
      ...(approved !== undefined
        ? { ifCommand: approved }
        : clearsSharedGate
          ? { ifCommand: '' }
          : {}),
      enabled: keptEnabled,
      installedFrom: {
        ...preservedInstalledFrom,
        remoteId: detail.id,
        contentHash: detail.contentHash,
        installedAt: existing.installedFrom?.installedAt ?? appliedAt,
        ...(origin !== undefined ? { sourceKind: origin.sourceKind } : {}),
        ...(approvedRunCondition !== undefined ? { approvedRunCondition } : {}),
        ...(detail.automation.action.type === 'worktree_pipeline' &&
        detail.automation.action.pipeline.source === 'inline' &&
        effectiveBindings.bundledPipelineLocalId !== undefined
          ? {
              bundledPipelineLocalId: effectiveBindings.bundledPipelineLocalId,
              bundledPipelineContentHash:
                detail.automation.action.pipeline.pipelineContentHash,
            }
          : {}),
        ...packagedPipelineProvenance(
          detail.automation,
          localPipelineIds.value,
        ),
        capabilityPackage: detail.automation.capabilityPackage,
      },
    },
  };
}
