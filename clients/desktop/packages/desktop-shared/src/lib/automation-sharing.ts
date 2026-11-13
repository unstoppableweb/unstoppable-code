import { CHAT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { AGENT_MODEL_ID_PREFIX } from '@canopy/protocol/agents';
import {
  SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
  SHARED_AUTOMATION_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION,
  SHARED_AUTOMATION_REFERENCES_API_VERSION,
  SHARED_AUTOMATION_RUN_CONDITION_API_VERSION,
  SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION,
  impliedTargetContexts,
  validateSharedAutomationTargetRequirement,
  isCodexSpeed,
  canonicalizeSharedAutomationPrompt,
  sharedAutomationPromptSpansError,
  validateSharedAutomationDocument,
} from '@canopy/protocol/automations';
import type {
  SharedAutomationAction,
  SharedAutomationDocument,
  SharedAutomationModelConfig,
  SharedAutomationPipelineDependency,
  SharedAutomationPipelineRef,
  SharedAutomationTrigger,
  TargetContext,
} from '@canopy/protocol/automations';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import {
  validateConfiguredPromptReferences,
  type ConfiguredPromptReference,
} from '@canopy/protocol/configured-prompt-references';
import type {
  PipelinePackagePackagedPipeline,
  PipelinePackageRef,
  PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import {
  LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
  rawPipelineDeclaresLocalOnlyTrigger,
} from '@canopy/pipeline-interop/portability';
import type { AutomationAction, ScheduledActivity } from '../types';
import { hasAnySelections } from '../types';
import { AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES } from './automations';
import {
  sessionSharedActionType,
  type AutomationSessionTargetKind,
} from './automation-target';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
} from '@canopy/pipeline-interop/automation-target';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';

/**
 * Desktop-side snapshot builder for CAN-1581 automation sharing.
 *
 * Converts a local {@link ScheduledActivity} into the portable
 * `SharedAutomationDocument` wire format, enforcing the redaction matrix at
 * the share boundary:
 *
 * - **Blocked** conditions refuse the share outright only when the action is
 *   tied to an existing pipeline execution or the rebuilt document is invalid.
 * - **Stripped** fields are removed with an author-facing notice so the
 *   author can see exactly what will not travel (run-condition command,
 *   pipeline input values, machine bindings, model alias preferences, the
 *   approval mode, plan mode on App Advisor and Cowork prompts).
 * - Runtime state (`id`, `enabled`, timestamps, run history, failure counts)
 *   is silently omitted — it is inherent to snapshotting, not informative.
 *
 * The built document is re-validated through the protocol validator before
 * being returned, so this module can never emit a document the server would
 * reject and the validator's field rebuild acts as defense in depth against
 * fields leaking through the mapping.
 */

/** Typed reasons a share is refused. Rendered via the messages map. */
export const AUTOMATION_SHARE_BLOCK_REASONS = [
  'action_execution_bound',
  'document_invalid',
  'installed_prompt_reference',
  'session_target_unresolved',
  'pipeline_target_unresolved',
  'pipeline_dependencies_stale',
  'installed_pipeline_dependencies',
  'pipeline_local_only_trigger',
] as const;

export type AutomationShareBlockReason =
  (typeof AUTOMATION_SHARE_BLOCK_REASONS)[number];

/** Typed notices for fields stripped from an otherwise shareable snapshot. */
export const AUTOMATION_SHARE_NOTICES = [
  'workspace_binding_stripped',
  'run_condition_stripped',
  'input_values_stripped',
  'model_alias_preferences_stripped',
  'model_config_stripped',
  'session_target_downgraded',
  'attachments_stripped',
  'local_agent_model_stripped',
  'plugin_collection_preferences_stripped',
  'pipeline_reference_unresolved',
  'pipeline_definition_bundled',
  'local_plugins_stripped',
  'cowork_project_binding_stripped',
  'approval_mode_stripped',
  'plan_mode_stripped',
] as const;

export type AutomationShareNotice = (typeof AUTOMATION_SHARE_NOTICES)[number];

/**
 * Soft warnings about an included run-condition command. Heuristic only: false
 * positives are acceptable and false negatives are expected. Declaration order
 * is display order, so `possible_secret` wins a collapsed single-line hint.
 */
export const AUTOMATION_RUN_CONDITION_SHARE_WARNINGS = [
  'possible_secret',
  'local_file',
] as const;

export type AutomationRunConditionShareWarning =
  (typeof AUTOMATION_RUN_CONDITION_SHARE_WARNINGS)[number];

export const AUTOMATION_RUN_CONDITION_SHARE_WARNING_MESSAGES: Record<
  AutomationRunConditionShareWarning,
  string
> = {
  possible_secret:
    'The command may contain a secret. Anyone who can open this share will see it.',
  local_file:
    'The command references a local file; the file itself is not shared.',
};

export const AUTOMATION_RUN_CONDITION_SHARE_WARNING_SHORT_LABELS: Record<
  AutomationRunConditionShareWarning,
  string
> = {
  possible_secret: 'May contain a secret',
  local_file: 'References a local file',
};

// A token starts at the beginning of the command or after whitespace, a quote,
// `=` or `(`. URL paths (`https://host/path`) never qualify.
const TOKEN_START = String.raw`(?:^|[\s"'=(])`;
const RUN_CONDITION_LOCAL_FILE_PATTERNS: readonly RegExp[] = [
  // Absolute paths, except device files such as /dev/null.
  new RegExp(String.raw`${TOKEN_START}\/(?!dev\/)[\w.~-]`),
  new RegExp(String.raw`${TOKEN_START}(?:~|\.\.?|\$HOME|\$\{HOME\})\/`),
  /[^\s"'|;&()<>]\.(?:sh|py|js|mjs|ts|rb)(?=$|[\s"'|;&()<>])/,
];
const RUN_CONDITION_SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`${TOKEN_START}(?:ghp_|github_pat_|sk-|xox[abps]-|lin_api_)[\w-]`,
  ),
  /(?:^|[^A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/,
  /\bBearer\s+[^\s"']+/i,
  /(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+/i,
];
const RUN_CONDITION_LONG_TOKEN = /[\w-]{32,}/g;

function hasLongMixedToken(command: string): boolean {
  return (command.match(RUN_CONDITION_LONG_TOKEN) ?? []).some(
    (token) => /[A-Za-z]/.test(token) && /\d/.test(token),
  );
}

/**
 * Flag a run-condition command that likely embeds a secret or depends on a
 * file on the author's machine. Returns deduplicated warnings in declaration
 * order.
 */
export function detectRunConditionShareWarnings(
  command: string,
): AutomationRunConditionShareWarning[] {
  const found = new Set<AutomationRunConditionShareWarning>();
  if (
    RUN_CONDITION_SECRET_PATTERNS.some((pattern) => pattern.test(command)) ||
    hasLongMixedToken(command)
  ) {
    found.add('possible_secret');
  }
  if (
    RUN_CONDITION_LOCAL_FILE_PATTERNS.some((pattern) => pattern.test(command))
  ) {
    found.add('local_file');
  }
  return AUTOMATION_RUN_CONDITION_SHARE_WARNINGS.filter((warning) =>
    found.has(warning),
  );
}

/**
 * Return the first If Command output variable name that the action's prompt
 * references as a `{{ NAME }}` token, or `null`. Pipeline actions carry no
 * prompt and always return `null`.
 */
export function automationActionUsesIfCommandOutput(
  action: AutomationAction,
): string | null {
  switch (action.type) {
    case 'app_advisor_prompt':
    case 'standalone_prompt':
    case 'worktree_prompt':
    case 'worktree_session_prompt': {
      const referenced = new Set(
        (action.prompt.match(/\{\{\s*[A-Z0-9_]+\s*\}\}/g) ?? []).map((token) =>
          token.slice(2, -2).trim(),
        ),
      );
      return (
        AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES.find((name) =>
          referenced.has(name),
        ) ?? null
      );
    }
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return null;
  }
}

/** User-facing copy for each block reason, keyed for the share modal. */
export const AUTOMATION_SHARE_BLOCK_MESSAGES: Record<
  AutomationShareBlockReason,
  string
> = {
  action_execution_bound:
    'This automation resumes a workflow run on this machine and cannot be shared.',
  document_invalid:
    'This automation could not be converted into a shareable document.',
  installed_prompt_reference:
    'This automation mentions a plugin available only on this machine. Choose a portable plugin before sharing.',
  session_target_unresolved:
    'Choose an accessible chat before sharing this automation.',
  pipeline_target_unresolved:
    'Verify the selected workflow before sharing this automation.',
  pipeline_dependencies_stale:
    'This automation changed after its workflows were checked. Check them again before sharing.',
  installed_pipeline_dependencies:
    'This automation was installed from a share with its workflows, so it cannot be shared again. Share the original instead.',
  pipeline_local_only_trigger: LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
};

/** User-facing copy for each stripped-field notice. */
export const AUTOMATION_SHARE_NOTICE_MESSAGES: Record<
  AutomationShareNotice,
  string
> = {
  workspace_binding_stripped:
    'The project and worktree bindings stay on this machine; recipients pick their own project when installing.',
  run_condition_stripped:
    'The run-condition command stays on this machine; recipients only see that a condition existed.',
  input_values_stripped:
    'Workflow input values stay on this machine; recipients supply their own values when installing.',
  model_alias_preferences_stripped:
    'Per-alias model preferences stay on this machine; recipients get the workflow defaults.',
  model_config_stripped:
    'Model tuning for the workflow run stays on this machine; recipients get the workflow defaults.',
  session_target_downgraded: `Sharing creates new runs in the required project or ${ORCHESTRATOR_LABEL}. The original chat and its history stay on this machine.`,
  attachments_stripped:
    'Attached files and file references stay on this machine.',
  local_agent_model_stripped:
    'The custom Agent this automation uses stays on this machine. Recipients get their default model.',
  plugin_collection_preferences_stripped:
    'Collection preferences stay on this machine; recipients get the workflow defaults.',
  pipeline_reference_unresolved:
    'This workflow only exists on this machine. Recipients pick one of their own workflows when installing.',
  pipeline_definition_bundled:
    'The workflow definition travels with this automation so recipients can install it too.',
  local_plugins_stripped:
    'Some plugins, skills, servers, and collections only exist on this machine and stay behind:',
  cowork_project_binding_stripped: `The ${CHAT_LABEL} project stays on this machine; recipients pick their own when installing.`,
  approval_mode_stripped:
    'The approval mode stays on this machine. Recipients get their own default.',
  plan_mode_stripped:
    'Plan mode stays on this machine. Recipients get a copy that runs without planning first.',
};

export interface ResolvedAutomationPlugins {
  plugins: ShareablePluginRef[];
  dropped: string[];
}

export interface BuildSharedAutomationDocumentOptions {
  sessionTargetKind?: AutomationSessionTargetKind;
  declaredTargetContexts?: TargetContext[];
  /** Scopes from the exact parsed definition selected for publication. */
  pipelineResolution?: AutomationPipelineResolution;
  /** Description authored in the share flow; empty string is allowed. */
  description: string;
  /**
   * Pre-resolved portable plugin refs for the action's local
   * `pluginSelections`. Entries that cannot travel as references are named in
   * `dropped`; packageable entries may instead travel in `capabilityPackage`.
   * When omitted, local plugin selections are stripped with a notice; the
   * deprecated portable `plugins` field is used only when there are none.
   */
  resolvedPlugins?: ShareablePluginRef[] | ResolvedAutomationPlugins;
  curatedPipelineKey?: string;
  sharedPipelineInstallPin?: PipelineShareInstallPin;
  pipelineRawContent?: string;
  pipelineContentHash?: string;
  capabilityPackage?: PipelinePackageRef;
  /**
   * Pipelines the capability package carries as `automation_pipeline`
   * resources, from the analysis summary's `packagedPipelines`. The caller
   * passes only the entries that ship: the required ones plus the optional
   * (name-matched) ones the author selected, and the same package must be
   * passed as `capabilityPackage`. The `isActionPipeline` entry turns a user
   * or project `worktree_pipeline` ref into `{ source: 'packaged', key:
   * 'action' }` instead of an inline copy; the other entries become a prompt
   * action's `pipelineDependencies`. Either makes the document version 5;
   * without them the document keeps its older version.
   */
  packagedPipelines?: PipelinePackagePackagedPipeline[];
  /**
   * Include the source's `ifCommand` as a v4 `runCondition`. Only the desktop
   * share modal sets this, from a checkbox beside the command that the author
   * can uncheck; every other caller (including agent shares) keeps the default
   * and strips it.
   */
  includeRunCondition?: boolean;
}

export type BuildSharedAutomationDocumentResult =
  | {
      ok: true;
      document: SharedAutomationDocument;
      notices: AutomationShareNotice[];
    }
  | {
      ok: false;
      reasons: AutomationShareBlockReason[];
      /**
       * Validator error text with `document_invalid`; the stale span or hash
       * with `pipeline_dependencies_stale`.
       */
      detail?: string;
    };

type PromptAction = Extract<
  AutomationAction,
  {
    type:
      | 'app_advisor_prompt'
      | 'standalone_prompt'
      | 'worktree_prompt'
      | 'worktree_session_prompt';
  }
>;

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

function isNonEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * Merge the local `model` / `modelConfig` / deprecated `thinking` fields into
 * the portable model config. Returns `undefined` when nothing is set so the
 * document omits the key entirely.
 */
function buildSharedModelConfig(
  action: PromptAction,
  stripLocalAgentModel: boolean,
): SharedAutomationModelConfig | undefined {
  const config: SharedAutomationModelConfig = {};
  if (
    !stripLocalAgentModel &&
    typeof action.model === 'string' &&
    action.model.length > 0
  ) {
    config.model = action.model;
  }
  // Session prompts never had the deprecated `thinking` field.
  const thinkingLevel =
    action.modelConfig?.thinkingLevel ??
    ('thinking' in action ? action.thinking : undefined);
  if (thinkingLevel !== undefined) {
    config.thinkingLevel = thinkingLevel;
  }
  const speed: unknown = action.modelConfig?.speed;
  if (isCodexSpeed(speed)) {
    // Share the exact speed; the legacy boolean is its derived projection
    // (never `true` for Ultra fast).
    config.speed = speed;
    config.fastMode = speed === 'fast';
  } else if (action.modelConfig?.fastMode !== undefined) {
    config.fastMode = action.modelConfig.fastMode;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Resolve the portable plugin list for a prompt action. Local
 * `pluginSelections` are only representable through the caller-supplied
 * resolution (the share flow runs the shareable-ref resolver); when
 * selections that do not resolve to portable references are named in a
 * notice rather than silently disappearing.
 */
function resolveSharedPlugins(
  action: PromptAction,
  resolvedPlugins: ShareablePluginRef[] | ResolvedAutomationPlugins | undefined,
): { plugins: ShareablePluginRef[]; stripped: boolean } {
  if (Array.isArray(resolvedPlugins)) {
    return { plugins: resolvedPlugins, stripped: false };
  }
  if (resolvedPlugins !== undefined) {
    return {
      plugins: resolvedPlugins.plugins,
      stripped: resolvedPlugins.dropped.length > 0,
    };
  }
  if (action.pluginSelections && hasAnySelections(action.pluginSelections)) {
    return { plugins: [], stripped: true };
  }
  return { plugins: action.plugins ?? [], stripped: false };
}

function buildSharedTrigger(
  schedule: ScheduledActivity['schedule'],
): SharedAutomationTrigger {
  if (schedule.kind === 'cron') {
    return { kind: 'cron', expression: schedule.expression, timezone: 'local' };
  }
  return { kind: 'one_time', runAt: schedule.runAt, timezone: 'local' };
}

function buildSharedPipelineRef(
  action: PipelineAction,
  options: BuildSharedAutomationDocumentOptions,
): {
  ref: SharedAutomationPipelineRef;
  unresolved: boolean;
  bundledDefinition: boolean;
} {
  if (action.pipelineSource === 'bundled') {
    const ref: SharedAutomationPipelineRef = {
      source: 'bundled',
      pipelineId: action.pipelineId,
    };
    if (action.pipelineName !== undefined) {
      ref.name = action.pipelineName;
    }
    return { ref, unresolved: false, bundledDefinition: false };
  }
  const packagedActionPipeline =
    action.pipelineSource === 'user' || action.pipelineSource === 'project'
      ? options.packagedPipelines?.find((entry) => entry.isActionPipeline)
      : undefined;
  if (packagedActionPipeline !== undefined) {
    const ref: SharedAutomationPipelineRef = {
      source: 'packaged',
      key: packagedActionPipeline.key,
      pipelineContentHash: packagedActionPipeline.pipelineContentHash,
      name: action.pipelineName ?? packagedActionPipeline.name,
    };
    return { ref, unresolved: false, bundledDefinition: true };
  }
  if (
    (action.pipelineSource === 'user' ||
      action.pipelineSource === 'project' ||
      action.pipelineSource === 'shared') &&
    options.pipelineRawContent !== undefined &&
    options.pipelineContentHash !== undefined
  ) {
    const ref: SharedAutomationPipelineRef = {
      source: 'inline',
      rawPipeline: options.pipelineRawContent,
      pipelineContentHash: options.pipelineContentHash,
    };
    if (action.pipelineName !== undefined) {
      ref.name = action.pipelineName;
    }
    if (
      action.pipelineSource === 'shared' &&
      typeof action.sharedPipeline?.remoteId === 'string' &&
      action.sharedPipeline.remoteId.length > 0 &&
      options.sharedPipelineInstallPin !== undefined
    ) {
      ref.origin = {
        remoteId: action.sharedPipeline.remoteId,
        installPin: options.sharedPipelineInstallPin,
      };
    }
    return { ref, unresolved: false, bundledDefinition: true };
  }
  if (
    action.pipelineSource === 'shared' &&
    typeof action.sharedPipeline?.remoteId === 'string' &&
    action.sharedPipeline.remoteId.length > 0 &&
    options.sharedPipelineInstallPin !== undefined
  ) {
    const ref: SharedAutomationPipelineRef = {
      source: 'shared',
      remoteId: action.sharedPipeline.remoteId,
      installPin: options.sharedPipelineInstallPin,
    };
    if (action.pipelineName !== undefined) {
      ref.name = action.pipelineName;
    }
    return { ref, unresolved: false, bundledDefinition: false };
  }
  if (
    action.pipelineSource === 'curated' &&
    options.curatedPipelineKey !== undefined &&
    options.curatedPipelineKey.length > 0
  ) {
    const ref: SharedAutomationPipelineRef = {
      source: 'curated',
      curatedKey: options.curatedPipelineKey,
    };
    if (action.pipelineName !== undefined) {
      ref.name = action.pipelineName;
    }
    return { ref, unresolved: false, bundledDefinition: false };
  }
  const ref: SharedAutomationPipelineRef = { source: 'unresolved' };
  if (action.pipelineName !== undefined) {
    ref.name = action.pipelineName;
  }
  return { ref, unresolved: true, bundledDefinition: false };
}

type PipelineDependenciesResult =
  | { ok: true; dependencies: SharedAutomationPipelineDependency[] }
  | { ok: false; detail: string };

function rangesOverlap(
  start: number,
  end: number,
  references: readonly ConfiguredPromptReference[],
): boolean {
  return references.some(
    (reference) =>
      start < reference.textStart + reference.displayText.length &&
      reference.textStart < end,
  );
}

/**
 * Turn the shipped non-action packaged pipelines into a prompt action's
 * `pipelineDependencies`. Spans are checked against the canonical prompt the
 * document carries; a span that no longer matches means the prompt changed
 * after analysis, so the share is refused rather than shifted. A span inside
 * a configured prompt reference's display text is left out: the reference
 * names a file or plugin, so the installer must not rewrite it.
 */
function buildSharedPipelineDependencies(
  prompt: string,
  promptReferences: readonly ConfiguredPromptReference[] | undefined,
  packagedPipelines: readonly PipelinePackagePackagedPipeline[] | undefined,
): PipelineDependenciesResult {
  const canonicalPrompt = canonicalizeSharedAutomationPrompt(prompt);
  const dependencies: SharedAutomationPipelineDependency[] = [];
  for (const entry of packagedPipelines ?? []) {
    if (entry.isActionPipeline) continue;
    const promptSpans = entry.promptSpans
      .filter(
        (span) =>
          !rangesOverlap(
            span.textStart,
            span.textStart + span.text.length,
            promptReferences ?? [],
          ),
      )
      .map((span) => ({ textStart: span.textStart, text: span.text }));
    dependencies.push({
      key: entry.key,
      pipeline: {
        source: 'packaged',
        key: entry.key,
        pipelineContentHash: entry.pipelineContentHash,
        name: entry.name,
      },
      promptSpans,
    });
  }
  const spansError = sharedAutomationPromptSpansError(
    canonicalPrompt,
    dependencies,
  );
  if (spansError) return { ok: false, detail: spansError };
  return { ok: true, dependencies };
}

/**
 * Build the portable share snapshot for a local automation.
 *
 * Returns `{ ok: true, document, notices }` when every field either travels
 * or strips cleanly, or `{ ok: false, reasons }` with every applicable typed
 * block reason (the modal lists them all at once rather than one per
 * attempt). Machine-bound action types short-circuit with their single
 * reason since no other field of such an action is meaningful to report.
 */
export function buildSharedAutomationDocument(
  activity: ScheduledActivity,
  options: BuildSharedAutomationDocumentOptions,
): BuildSharedAutomationDocumentResult {
  const action = activity.action;

  const sessionType =
    action.type === 'worktree_session_prompt'
      ? sessionSharedActionType(options.sessionTargetKind)
      : undefined;
  if (action.type === 'worktree_session_prompt' && !sessionType) {
    return { ok: false, reasons: ['session_target_unresolved'] };
  }

  if (action.type === 'pipeline_execution_resume') {
    return { ok: false, reasons: ['action_execution_bound'] };
  }
  // An installed copy re-shares its installed package by reference, which
  // carries no prompt spans for the pipelines in it: recipients would get
  // this machine's pipeline IDs in the prompt and never install them.
  if ((activity.installedFrom?.pipelineDependencies?.length ?? 0) > 0) {
    return { ok: false, reasons: ['installed_pipeline_dependencies'] };
  }
  // The targeted pipeline's YAML travels inline; one that declares
  // `workflow` can't leave this machine yet (CAN-5782).
  if (
    options.pipelineRawContent !== undefined &&
    rawPipelineDeclaresLocalOnlyTrigger(options.pipelineRawContent)
  ) {
    return { ok: false, reasons: ['pipeline_local_only_trigger'] };
  }

  const reasons: AutomationShareBlockReason[] = [];
  const notices: AutomationShareNotice[] = [];
  let sharedAction: SharedAutomationAction | null = null;
  const configuredRefs =
    'promptReferences' in action ? action.promptReferences : undefined;
  if (configuredRefs?.length) {
    const error = validateConfiguredPromptReferences(
      'prompt' in action ? action.prompt : '',
      configuredRefs,
      { portableOnly: true },
    );
    if (error) {
      return {
        ok: false,
        reasons: [
          error.includes('installed')
            ? 'installed_prompt_reference'
            : 'document_invalid',
        ],
        detail: error,
      };
    }
  }

  if (
    action.type === 'app_advisor_prompt' ||
    action.type === 'standalone_prompt' ||
    action.type === 'worktree_prompt' ||
    action.type === 'worktree_session_prompt'
  ) {
    if (action.type === 'worktree_session_prompt') {
      notices.push('workspace_binding_stripped', 'session_target_downgraded');
      if (
        (action.attachmentPaths?.length ?? 0) > 0 ||
        (action.attachmentPromptContexts?.length ?? 0) > 0 ||
        (action.fileReferences?.length ?? 0) > 0
      ) {
        notices.push('attachments_stripped');
      }
    }
    const stripLocalAgentModel =
      typeof action.model === 'string' &&
      action.model.startsWith(AGENT_MODEL_ID_PREFIX);
    if (stripLocalAgentModel) {
      notices.push('local_agent_model_stripped');
    }
    const plugins = resolveSharedPlugins(action, options.resolvedPlugins);
    if (plugins.stripped) {
      notices.push('local_plugins_stripped');
    }
    // The approval mode never travels, whichever one it is: a recipient's
    // copy follows their own default instead of a mode someone else picked.
    if (action.approvalMode !== undefined) {
      notices.push('approval_mode_stripped');
    }
    // Only the worktree_prompt wire shape has a planMode field, so a
    // plan-only App Advisor or Cowork prompt reaches recipients as one that
    // acts. The notice tells the publisher; carrying it for recipients needs
    // planMode on those two wire shapes in a new document version.
    if (
      (action.type === 'app_advisor_prompt' ||
        action.type === 'standalone_prompt' ||
        (action.type === 'worktree_session_prompt' &&
          sessionType !== 'worktree_prompt')) &&
      action.planMode === true
    ) {
      notices.push('plan_mode_stripped');
    }
    const modelConfig = buildSharedModelConfig(action, stripLocalAgentModel);
    const pipelineDependencies = buildSharedPipelineDependencies(
      action.prompt,
      action.promptReferences,
      options.packagedPipelines,
    );
    if (!pipelineDependencies.ok) {
      return {
        ok: false,
        reasons: ['pipeline_dependencies_stale'],
        detail: pipelineDependencies.detail,
      };
    }
    const dependencyFields =
      pipelineDependencies.dependencies.length > 0
        ? { pipelineDependencies: pipelineDependencies.dependencies }
        : {};

    if (action.type === 'worktree_session_prompt') {
      const common = {
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...dependencyFields,
        ...(modelConfig !== undefined ? { modelConfig } : {}),
        plugins: plugins.plugins,
      };
      if (sessionType === 'standalone_prompt') {
        notices.push('cowork_project_binding_stripped');
        sharedAction = {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          ...common,
        };
      } else if (sessionType === 'app_advisor_prompt') {
        sharedAction = { type: 'app_advisor_prompt', ...common };
      } else {
        sharedAction = {
          type: 'worktree_prompt',
          target: { kind: 'workspace' },
          prompt: action.prompt,
          ...(action.promptReferences
            ? { promptReferences: action.promptReferences }
            : {}),
          ...dependencyFields,
          ...(modelConfig !== undefined ? { modelConfig } : {}),
          plugins: plugins.plugins,
          ...(action.planMode !== undefined
            ? { planMode: action.planMode }
            : {}),
        };
      }
    } else if (action.type === 'app_advisor_prompt') {
      sharedAction = {
        type: 'app_advisor_prompt',
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...dependencyFields,
        ...(modelConfig !== undefined ? { modelConfig } : {}),
        plugins: plugins.plugins,
      };
    } else if (action.type === 'standalone_prompt') {
      notices.push('cowork_project_binding_stripped');
      sharedAction = {
        type: 'standalone_prompt',
        target: { kind: 'cowork' },
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...dependencyFields,
        ...(modelConfig !== undefined ? { modelConfig } : {}),
        plugins: plugins.plugins,
      };
    } else {
      notices.push('workspace_binding_stripped');
      sharedAction = {
        type: 'worktree_prompt',
        target: { kind: 'workspace' },
        ...(action.existingBranch !== undefined
          ? { existingBranch: action.existingBranch }
          : {}),
        prompt: action.prompt,
        ...(action.promptReferences
          ? { promptReferences: action.promptReferences }
          : {}),
        ...dependencyFields,
        ...(modelConfig !== undefined ? { modelConfig } : {}),
        plugins: plugins.plugins,
        ...(action.planMode !== undefined ? { planMode: action.planMode } : {}),
        ...(action.interfaceMode !== undefined
          ? { interfaceMode: action.interfaceMode }
          : {}),
      };
    }
  } else {
    // Local project and task ids never travel; a destination with no project
    // has none to strip.
    if (action.target?.kind !== 'global')
      notices.push('workspace_binding_stripped');
    const pipelineRef = buildSharedPipelineRef(action, options);
    if (pipelineRef.ref.source === 'packaged') {
      // The analysis packaged one exact pipeline; a different key or newer
      // local bytes mean the package no longer matches what is shared.
      if (pipelineRef.ref.key !== SHARED_AUTOMATION_ACTION_PIPELINE_KEY) {
        return {
          ok: false,
          reasons: ['pipeline_dependencies_stale'],
          detail: `The packaged action pipeline must use the key "${SHARED_AUTOMATION_ACTION_PIPELINE_KEY}".`,
        };
      }
      if (
        options.pipelineContentHash !== undefined &&
        options.pipelineContentHash !== pipelineRef.ref.pipelineContentHash
      ) {
        return {
          ok: false,
          reasons: ['pipeline_dependencies_stale'],
          detail:
            'The pipeline changed after the capability package was built.',
        };
      }
    }
    if (pipelineRef.unresolved) {
      notices.push('pipeline_reference_unresolved');
    }
    if (pipelineRef.bundledDefinition) {
      notices.push('pipeline_definition_bundled');
    }
    if (isNonEmptyRecord(action.pluginCollectionPreferences)) {
      notices.push('plugin_collection_preferences_stripped');
    }
    const inputKeys = Object.keys(action.inputs ?? {}).sort();
    if (inputKeys.length > 0) {
      notices.push('input_values_stripped');
    }
    if (isNonEmptyRecord(action.modelAliasPreferences)) {
      notices.push('model_alias_preferences_stripped');
    }
    if (
      action.modelConfig !== undefined &&
      Object.keys(action.modelConfig).length > 0
    ) {
      notices.push('model_config_stripped');
    }
    sharedAction = {
      type: 'worktree_pipeline',
      target: action.target
        ? { kind: action.target.kind }
        : { kind: 'workspace' },
      pipeline: pipelineRef.ref,
      inputKeys,
    };
  }

  if (reasons.length > 0 || sharedAction === null) {
    return {
      ok: false,
      reasons: reasons.length > 0 ? reasons : ['document_invalid'],
    };
  }

  const runConditionCommand =
    typeof activity.ifCommand === 'string' ? activity.ifCommand.trim() : '';
  const hasRunCondition = runConditionCommand.length > 0;
  const includesRunCondition =
    hasRunCondition && options.includeRunCondition === true;
  if (hasRunCondition && !includesRunCondition) {
    notices.push('run_condition_stripped');
  }

  const declaration =
    options.declaredTargetContexts !== undefined
      ? { contexts: options.declaredTargetContexts }
      : activity.targetRequirement;
  const validatedRequirement =
    declaration === undefined
      ? undefined
      : validateSharedAutomationTargetRequirement(
          declaration,
          sharedAction.type,
        );
  if (validatedRequirement && !validatedRequirement.ok) {
    return {
      ok: false,
      reasons: ['document_invalid'],
      detail: validatedRequirement.error,
    };
  }
  const requirement = validatedRequirement?.ok
    ? validatedRequirement.requirement
    : undefined;
  if (sharedAction.type === 'worktree_pipeline') {
    let pipelineResolution = options.pipelineResolution;
    if (options.pipelineRawContent !== undefined) {
      try {
        pipelineResolution = {
          status: 'resolved',
          scopes: parsePipelineText(options.pipelineRawContent).scope,
        };
      } catch (error) {
        pipelineResolution = {
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Workflow definition could not be read.',
        };
      }
    }
    const destination = sharedAction.target.kind;
    const resolution = resolveAutomationTargetRequirement(
      sharedAction.type,
      requirement,
      pipelineResolution,
      destination === 'workspace' ? undefined : destination,
    );
    if (resolution.status !== 'resolved') {
      return {
        ok: false,
        reasons: ['pipeline_target_unresolved'],
        ...(resolution.status === 'error' ? { detail: resolution.error } : {}),
      };
    }
  }
  const narrows =
    requirement !== undefined &&
    requirement.contexts.length <
      impliedTargetContexts(sharedAction.type).length;
  const sharesPipelineDestination =
    sharedAction.type === 'worktree_pipeline' &&
    sharedAction.target.kind !== 'workspace';
  // Only documents that carry packaged pipelines need version 5, so an
  // automation without them still reaches recipients on older clients.
  const usesPackagedPipelines =
    sharedAction.type === 'worktree_pipeline'
      ? sharedAction.pipeline.source === 'packaged'
      : sharedAction.pipelineDependencies !== undefined;
  const document: SharedAutomationDocument = {
    version: sharesPipelineDestination
      ? SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION
      : usesPackagedPipelines
        ? SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION
        : includesRunCondition
          ? SHARED_AUTOMATION_RUN_CONDITION_API_VERSION
          : narrows
            ? SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION
            : configuredRefs !== undefined
              ? SHARED_AUTOMATION_REFERENCES_API_VERSION
              : SHARED_AUTOMATION_API_VERSION,
    name: activity.name,
    description: options.description,
    trigger: buildSharedTrigger(activity.schedule),
    action: sharedAction,
    ...(narrows ? { targetRequirement: requirement } : {}),
    ...(options.capabilityPackage !== undefined
      ? { capabilityPackage: options.capabilityPackage }
      : {}),
    hasRunCondition,
    ...(includesRunCondition
      ? { runCondition: { command: runConditionCommand } }
      : {}),
  };

  const validated = validateSharedAutomationDocument(document);
  if (!validated.ok) {
    return {
      ok: false,
      reasons: ['document_invalid'],
      detail: validated.error,
    };
  }

  return { ok: true, document: validated.document, notices };
}
