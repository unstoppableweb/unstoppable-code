import { CodeBlock } from './CodeBlock';
import { Stack } from './Stack';
import type { JSX } from 'react';
import {
  impliedTargetContexts,
  intersectTargetContexts,
  type AutomationPipelineTargetKind,
  type SharedAutomationAction,
  type SharedAutomationDocument,
  type TargetContext,
} from '@canopy/protocol/automations';
import type { ShareablePluginRef } from '@canopy/protocol';
import type { PipelineDistributionMode } from '@canopy/protocol/pipelines';
import {
  CHAT_LABEL,
  ORCHESTRATOR_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import {
  AUTOMATION_PACKAGE_BUNDLED_NOTE,
  AUTOMATION_PACKAGE_DEPENDENCIES_EXCLUDED_NOTE,
  AUTOMATION_PACKAGE_DEPENDENCIES_INCLUDED_NOTE,
  AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE,
} from '../lib/pipeline-package-display';
import { Badge } from './Badge';
import { Heading } from './Heading';
import { Surface } from './Surface';

export interface AutomationDefinitionSummaryProps {
  automation: SharedAutomationDocument;
  /**
   * Distribution mode of the surrounding share, when the host knows it.
   * Optional so the desktop preview (which renders a document with no share
   * behind it) stays unchanged. Deliberately NOT derived from
   * `automation.capabilityPackage`: only the share record knows whether the
   * package actually travelled.
   */
  distributionMode?: PipelineDistributionMode;
  /**
   * Effective target contexts when the host has resolved the pipeline's
   * scopes. Omitted for pipelines means compatibility is still unverified,
   * so only the declared/action constraint is shown.
   */
  resolvedTargetContexts?: readonly TargetContext[];
}

const TARGET_CONTEXT_LABELS: Record<TargetContext, string> = {
  cowork: `a ${CHAT_LABEL} project`,
  worktree: 'a code project',
  app_advisor: ORCHESTRATOR_LABEL,
};

/** Shared "Runs in" wording for automation target contexts (CAN-3734). */
export function formatAutomationTargetContexts(
  contexts: readonly TargetContext[],
): string {
  return contexts.map((context) => TARGET_CONTEXT_LABELS[context]).join(' or ');
}

export const AUTOMATION_TARGET_UNVERIFIED_NOTE =
  'The workflow’s own requirements are checked when you install, and may narrow these choices.';
export const AUTOMATION_TARGET_NONE_LABEL =
  'This scheduled workflow has no compatible place to run.';

export interface AutomationTargetRequirementDisplay {
  contexts: TargetContext[];
  /** False while a pipeline's scopes have not been verified by the host. */
  verified: boolean;
}

/**
 * The contexts an automation document may run in: the declaration and the
 * action-implied set, narrowed by host-resolved pipeline contexts when known.
 * An unresolved pipeline is never labeled as an effective set.
 */
export function describeAutomationTargetRequirement(
  automation: SharedAutomationDocument,
  resolvedTargetContexts?: readonly TargetContext[],
): AutomationTargetRequirementDisplay {
  const implied = impliedTargetContexts(automation.action.type);
  const declared = intersectTargetContexts(
    implied,
    automation.targetRequirement?.contexts ?? implied,
  );
  if (automation.action.type !== 'worktree_pipeline') {
    return { contexts: declared, verified: true };
  }
  return resolvedTargetContexts === undefined
    ? { contexts: declared, verified: false }
    : {
        contexts: intersectTargetContexts(declared, resolvedTargetContexts),
        verified: true,
      };
}

const PIPELINE_DESTINATION_LABELS: Record<
  AutomationPipelineTargetKind,
  string
> = {
  global: 'Runs with no project.',
  new_worktree: `Creates a new ${WORKTREE_UNIT_LABEL.toLowerCase()} each run.`,
  task: 'Runs in an existing task.',
  project: 'Runs in the project folder.',
};

/**
 * Where a pipeline automation runs, for an explicit destination. `undefined`
 * for the portable `workspace` kind and every other action, which keep the
 * "Runs in" contexts.
 */
export function automationPipelineDestinationLabel(
  action: SharedAutomationAction,
): string | undefined {
  if (action.type !== 'worktree_pipeline') return undefined;
  const { kind } = action.target;
  return kind === 'workspace' ? undefined : PIPELINE_DESTINATION_LABELS[kind];
}

/**
 * One "Runs in" line plus the unverified-pipeline note when applicable. An
 * explicit pipeline destination names the destination instead, so a global
 * pipeline's empty context list never reads as "nowhere to run".
 */
export function AutomationTargetRequirementLine({
  automation,
  resolvedTargetContexts,
}: {
  automation: SharedAutomationDocument;
  resolvedTargetContexts?: readonly TargetContext[];
}): JSX.Element {
  const destination = automationPipelineDestinationLabel(automation.action);
  if (destination !== undefined)
    return (
      <div data-testid="automation-summary-runs-in">
        <p
          className="text-xs fg-secondary"
          data-testid="automation-summary-destination"
        >
          {destination}
        </p>
      </div>
    );
  const display = describeAutomationTargetRequirement(
    automation,
    resolvedTargetContexts,
  );
  return (
    <AutomationTargetContextsLine
      contexts={display.contexts}
      verified={display.verified}
    />
  );
}

export function AutomationTargetContextsLine({
  contexts,
  verified,
}: {
  contexts: readonly TargetContext[];
  verified: boolean;
}): JSX.Element {
  return (
    <Stack gap="tight" data-testid="automation-summary-runs-in">
      <p className="text-xs fg-secondary">
        {contexts.length === 0
          ? AUTOMATION_TARGET_NONE_LABEL
          : `Runs in ${formatAutomationTargetContexts(contexts)}`}
      </p>
      {!verified && (
        <p
          className="text-xs fg-secondary"
          data-testid="automation-summary-runs-in-unverified"
        >
          {AUTOMATION_TARGET_UNVERIFIED_NOTE}
        </p>
      )}
    </Stack>
  );
}

function pluginLabel(ref: ShareablePluginRef): string {
  return ref.type === 'skill' ? ref.skill_name : ref.plugin_name;
}

function actionLabel(action: SharedAutomationAction): string {
  switch (action.type) {
    case 'app_advisor_prompt':
      return `Sends a prompt to ${ORCHESTRATOR_LABEL}`;
    case 'standalone_prompt':
      return `Sends a prompt in a ${CHAT_LABEL} project the installer picks`;
    case 'worktree_prompt':
      return 'Sends a prompt in a project the installer picks';
    case 'worktree_pipeline':
      // An unresolved ref carries the author's pipeline name only as a hint —
      // the installer binds one of their own pipelines, so never render it as
      // though the named pipeline travels.
      if (action.pipeline.source === 'unresolved') {
        return action.pipeline.name
          ? `Runs a workflow you choose (the author used "${action.pipeline.name}")`
          : 'Runs a workflow you choose';
      }
      if (action.pipeline.name) {
        return `Runs the ${action.pipeline.name} workflow`;
      }
      switch (action.pipeline.source) {
        case 'bundled':
          return 'Runs a workflow';
        case 'curated':
          return 'Runs a curated workflow';
        // An inline or packaged ref carries the definition itself, so an
        // absent name must never render as an empty workflow name or as "a
        // shared workflow".
        case 'inline':
        case 'packaged':
          return 'Runs the workflow included in this share';
        default:
          return 'Runs a shared workflow';
      }
  }
}

/**
 * Whether the pipeline an automation runs travels with the share. Bundled and
 * curated pipelines ship with every install, and an unresolved ref already
 * says the installer picks their own, so only inline and legacy shared refs
 * need the disclosure.
 */
function pipelineBundlingNote(action: SharedAutomationAction): string | null {
  if (action.type !== 'worktree_pipeline') return null;
  switch (action.pipeline.source) {
    case 'inline':
    case 'packaged':
      return AUTOMATION_PACKAGE_BUNDLED_NOTE;
    case 'shared':
      return AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE;
    default:
      return null;
  }
}

/**
 * Names of the pipelines a prompt automation carries in its package. The
 * guard keeps a document from a newer version (whose action may differ)
 * renderable.
 */
function packagedPipelineNames(action: SharedAutomationAction): string[] {
  if (action.type === 'worktree_pipeline') return [];
  const dependencies = Array.isArray(action.pipelineDependencies)
    ? action.pipelineDependencies
    : [];
  return dependencies.map(
    (dependency) => dependency.pipeline.name ?? dependency.key,
  );
}

/**
 * Pure, portable summary of a shared automation document for public web and
 * desktop preview surfaces. Renders only document fields: never owner ids,
 * workspace ids, input values, or run-condition commands.
 */
export function AutomationDefinitionSummary({
  automation,
  distributionMode,
  resolvedTargetContexts,
}: AutomationDefinitionSummaryProps): JSX.Element {
  // The trigger is deliberately not rendered: the installer picks their own
  // schedule at install time, so the author's cron expression is noise the
  // reader cannot act on.
  const { action } = automation;
  const plugins = action.type === 'worktree_pipeline' ? [] : action.plugins;
  const inputKeys = action.type === 'worktree_pipeline' ? action.inputKeys : [];
  const prompt = action.type === 'worktree_pipeline' ? null : action.prompt;
  const bundlingNote = pipelineBundlingNote(action);
  const pipelineNames = packagedPipelineNames(action);
  // Only real requirements open the block. A known distribution mode is not
  // one: on an automation that needs nothing, "dependencies are (not)
  // included in this share" describes an empty set, and on a definition-only
  // share it just restates the warning already sitting above the CTA.
  const hasNeeds =
    plugins.length > 0 ||
    pipelineNames.length > 0 ||
    inputKeys.length > 0 ||
    automation.hasRunCondition;

  return (
    <Stack gap="section" data-testid="automation-definition-summary">
      <Stack as="section" gap="inline" data-testid="automation-summary-action">
        <Heading level={2} variant="title">
          What it does
        </Heading>
        <Surface variant="card" padding="default">
          <div className="flex flex-col gap-3 text-s">
            <Stack gap="tight">
              <p className="font-medium">{actionLabel(action)}</p>
              <div>
                <AutomationTargetRequirementLine
                  automation={automation}
                  {...(resolvedTargetContexts !== undefined
                    ? { resolvedTargetContexts }
                    : {})}
                />
              </div>
              {action.type === 'worktree_prompt' && action.planMode && (
                <p className="text-xs fg-secondary">Starts in plan mode.</p>
              )}
              {bundlingNote !== null && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="automation-summary-pipeline-bundling"
                >
                  {bundlingNote}
                </p>
              )}
            </Stack>
            {prompt !== null && (
              <CodeBlock
                variant="bare"
                size="s"
                wrap="words"
                tone="inherit"
                replay="inherit"
                font="sans"
                overflow="visible"
              >
                {prompt || 'No prompt text.'}
              </CodeBlock>
            )}
          </div>
        </Surface>
      </Stack>

      {hasNeeds && (
        <Stack as="section" gap="inline" data-testid="automation-summary-needs">
          <Heading level={2} variant="title">
            What it needs
          </Heading>
          <Surface variant="card" padding="default">
            <div className="flex flex-col gap-3 text-s">
              {plugins.length > 0 && (
                <Stack gap="tight">
                  <p className="text-xs font-medium fg-secondary">Plugins</p>
                  <Stack as="ul" gap="tight">
                    {plugins.map(
                      (ref): JSX.Element => (
                        <li key={JSON.stringify(ref)}>{pluginLabel(ref)}</li>
                      ),
                    )}
                  </Stack>
                </Stack>
              )}
              {pipelineNames.length > 0 && (
                <Stack gap="tight" data-testid="automation-summary-pipelines">
                  <p className="text-xs font-medium fg-secondary">
                    Pipelines included
                  </p>
                  <Stack as="ul" gap="tight">
                    {pipelineNames.map(
                      (name, index): JSX.Element => (
                        <li key={`${String(index)}:${name}`}>{name}</li>
                      ),
                    )}
                  </Stack>
                </Stack>
              )}
              {inputKeys.length > 0 && (
                <Stack gap="tight">
                  <p className="text-xs font-medium fg-secondary">
                    Inputs you provide at install
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {inputKeys.map(
                      (key): JSX.Element => (
                        <Badge key={key}>{key}</Badge>
                      ),
                    )}
                  </div>
                </Stack>
              )}
              {automation.hasRunCondition && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="automation-summary-run-condition"
                >
                  {automation.runCondition
                    ? 'The author gated this with a run condition you can review when installing.'
                    : 'The author gated this with a run condition; the command stays on their machine.'}
                </p>
              )}
              {distributionMode !== undefined && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="automation-summary-distribution"
                >
                  {distributionMode === 'package'
                    ? AUTOMATION_PACKAGE_DEPENDENCIES_INCLUDED_NOTE
                    : AUTOMATION_PACKAGE_DEPENDENCIES_EXCLUDED_NOTE}
                </p>
              )}
            </div>
          </Surface>
        </Stack>
      )}
    </Stack>
  );
}
