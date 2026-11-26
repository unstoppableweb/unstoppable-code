import { useState, type JSX } from 'react';
import type {
  Pipeline,
  PipelineDefaults,
  PipelineExecutionScope,
  PipelineInfo,
  PipelineInputDef,
  PipelineModelAlias,
  PipelinePluginCollection,
  PipelineScalar,
  PipelineTriggerType,
  RunDefaults,
  ShellType,
} from '@canopy/execution-engine/types/pipeline';
import {
  Surface,
  Stack,
  ChoiceList,
  ChoiceField,
  ConfirmDialog,
  Heading,
} from '@canopy/ui-shared/components';
import { PipelineRelatedSections } from './PipelineRelatedSections';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  setTriggerInputDefs,
  setTriggerTypes,
} from '@canopy/execution-engine/types/pipeline';
import {
  readPipelineScopeSelection,
  toPipelineScopeValue,
} from '@/lib/pipelineExecutionScope';
import { FormField } from './shared/FormField';
import { TextField } from './shared/TextField';
import { TextAreaField } from './shared/TextAreaField';
import { SelectField } from './shared/SelectField';
import { KeyValueEditor } from './shared/KeyValueEditor';
import { TriggerInputsEditor } from './settings/TriggerInputsEditor';
import { PluginCollectionsEditor } from './settings/PluginCollectionsEditor';
import { ModelAliasesEditor } from './settings/ModelAliasesEditor';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import type {
  EntryDetailReturnContext,
  PipelineReturnTarget,
} from '@/stores/navigationStore';
import {
  PIPELINE_SHELL_OPTIONS,
  type PipelineShellOption,
} from './pipeline-shell-options';
import { brand } from '@/lib/brand';
import { Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * What Settings' trigger list needs beyond the document (CAN-5782): whether
 * a package installed it, and how many workflow pages run it as a step. The
 * editor's document projection carries neither.
 */
export interface PipelineSettingsTriggerFacts {
  readonly packageInstalled: boolean;
  readonly workflowCallers: number;
}

interface PipelineSettingsPanelProps {
  /** The pipeline list's facts for the trigger list (CAN-5782). */
  triggerFacts?: PipelineSettingsTriggerFacts;
  pipeline: Pipeline;
  onUpdateField: (field: keyof Pipeline, value: unknown) => void;
  onUpdateDefaults: (defaults: PipelineDefaults) => void;
  onUpdateEnv: (env: Record<string, PipelineScalar>) => void;
  onClose?: () => void;
  readonly?: boolean;
  /** Saved identity of the open pipeline; null for unsaved drafts. */
  pipelineInfo?: PipelineInfo | null;
  /** Project directory when editing a project pipeline. */
  cwd?: string;
  relatedDataRevision: number;
  returnToEntryId?: string;
  returnToEntryContext?: EntryDetailReturnContext;
  returnToPipeline?: PipelineReturnTarget;
  returnToMarketplace?: PipelineReturnTarget['returnToMarketplace'];
  onRelatedNavigate: (
    navigate: (savedPipelineInfo?: PipelineInfo) => void,
  ) => void;
}

interface TriggerOption {
  type: PipelineTriggerType;
  label: string;
  hint: string;
}

interface ExecutionScopeOption {
  scope: PipelineExecutionScope;
  label: string;
  hint: string;
}

// NOTE: This is the *execution* scope (where a pipeline can be shown/run), not
// the Cloud *sharing* scope (Private/Team/Organization). The label is
// deliberately "Execution Scope" so it never collides with the sharing-scope
// UI.
const EXECUTION_SCOPE_OPTIONS: ExecutionScopeOption[] = [
  {
    scope: 'global',
    label: 'Global',
    hint: 'Run anywhere, independent of a directory or worktree',
  },
  {
    scope: 'directory',
    label: 'Directory',
    hint: 'Run against a plain directory (also available in worktrees)',
  },
  {
    scope: 'worktree',
    label: 'Worktree',
    hint: 'Run only inside a managed worktree',
  },
];

const TRIGGER_OPTIONS: TriggerOption[] = [
  {
    type: 'dispatch',
    label: 'Dispatch',
    hint: 'Manually triggered via the UI or API',
  },
  {
    type: 'plan_ready',
    label: 'Plan ready',
    hint: 'Triggered when an agent plan is ready to run through a workflow',
  },
  {
    type: 'task_ready',
    label: 'Task ready',
    hint: 'Triggered when a task definition is ready to be planned',
  },
  {
    type: 'workflow',
    label: 'Workflow',
    hint: 'Started from the Workflows page and its schedules',
  },
];

/**
 * Whether the panel offers a trigger. A package-installed pipeline isn't
 * offered `workflow`, since its package checks the YAML it installed
 * (CAN-5782); one that declares it can still remove it.
 */
function isOfferedTrigger(
  type: PipelineTriggerType,
  activeTriggerTypes: readonly PipelineTriggerType[],
  packageInstalled: boolean,
): boolean {
  return (
    type !== 'workflow' ||
    !packageInstalled ||
    activeTriggerTypes.includes('workflow')
  );
}

/**
 * The triggers after a row's toggle (CAN-5782). Turning Workflow or Manual
 * on starts its inputs from the other's, so schedules keep resolving their
 * saved inputs whichever trigger they run as.
 */
export function toggledTriggers(
  on: Pipeline['on'],
  type: PipelineTriggerType,
): Pipeline['on'] {
  const active = getTriggerTypes(on);
  if (active.includes(type)) {
    const remaining = active.filter((t) => t !== type);
    // A pipeline keeps at least one trigger; removing the last would leave
    // a bare Manual without its inputs.
    return remaining.length === 0 ? on : setTriggerTypes(on, remaining);
  }
  const next = setTriggerTypes(on, [...active, type]);
  const source =
    type === 'workflow' ? 'dispatch' : type === 'dispatch' ? 'workflow' : null;
  const inputs =
    source !== null && active.includes(source)
      ? getTriggerInputDefs(on, source)
      : undefined;
  return inputs && Object.keys(inputs).length > 0
    ? setTriggerInputDefs(next, type, structuredClone(inputs))
    : next;
}

function buildShellOptions(): PipelineShellOption[] {
  return [
    { value: '', label: pt(uiText.pipelineShell.unsetDefault) },
    ...PIPELINE_SHELL_OPTIONS,
  ];
}

export function PipelineSettingsPanel({
  pipeline,
  onUpdateField,
  onUpdateDefaults,
  onUpdateEnv,
  onClose,
  readonly = false,
  pipelineInfo = null,
  cwd,
  relatedDataRevision,
  returnToEntryId,
  returnToEntryContext,
  returnToPipeline,
  returnToMarketplace,
  onRelatedNavigate,
  triggerFacts,
}: PipelineSettingsPanelProps): JSX.Element {
  const run: RunDefaults = pipeline.defaults?.run ?? {};
  const activeTriggerTypes = getTriggerTypes(pipeline.on);
  const packageInstalled =
    triggerFacts?.packageInstalled === true ||
    pipelineInfo?.distributionMode === 'package';
  // CAN-5782: turning Workflow on for a pipeline other workflows run as a
  // child asks first: their runs started from a schedule or the Workflows
  // page then run it as Workflow too.
  const workflowCallers =
    triggerFacts?.workflowCallers ?? pipelineInfo?.workflowCallers ?? 0;
  const [confirmWorkflow, setConfirmWorkflow] = useState(false);
  function toggleTrigger(type: PipelineTriggerType): void {
    if (
      type === 'workflow' &&
      !activeTriggerTypes.includes('workflow') &&
      workflowCallers > 0
    ) {
      setConfirmWorkflow(true);
      return;
    }
    onUpdateField('on', toggledTriggers(pipeline.on, type));
  }
  const selectedScopes = readPipelineScopeSelection(pipeline.scope);

  function toggleExecutionScope(
    scope: PipelineExecutionScope,
    checked: boolean,
  ): void {
    const next = checked
      ? [...selectedScopes, scope]
      : selectedScopes.filter((s) => s !== scope);
    // Enforce at least one scope selected: refuse to clear the final scope.
    if (next.length === 0) return;
    onUpdateField('scope', toPipelineScopeValue(next));
  }

  function updateRunDefault<K extends keyof RunDefaults>(
    key: K,
    value: RunDefaults[K],
  ): void {
    const updatedRun: RunDefaults = { ...run, [key]: value };
    const hasShell: boolean = Boolean(updatedRun.shell);
    const hasWorkDir: boolean = Boolean(updatedRun.working_directory);
    if (!hasShell && !hasWorkDir) {
      onUpdateDefaults({});
    } else {
      onUpdateDefaults({ run: updatedRun });
    }
  }

  function updateTriggerInputs(
    type: PipelineTriggerType,
    inputs: Record<string, PipelineInputDef>,
  ): void {
    onUpdateField('on', setTriggerInputDefs(pipeline.on, type, inputs));
  }

  function updatePluginCollections(
    next: PipelinePluginCollection[] | undefined,
  ): void {
    onUpdateField('plugin_collections', next);
  }

  function updateModelAliases(next: PipelineModelAlias[] | undefined): void {
    onUpdateField('model_aliases', next);
  }

  return (
    <Surface variant="panel" extent="parent" className="flex flex-col">
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <Heading level={2} variant="title">
            Workflow settings
          </Heading>
          {onClose && (
            <Tooltip label="Close settings">
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                onClick={onClose}
                aria-label="Close settings"
              >
                <AppCatalogCloseIcon size="sm" />
              </Button>
            </Tooltip>
          )}
        </div>
      </Surface>

      <div className="flex-1 overflow-auto">
        <div className="flex flex-col px-4 py-5 gap-8">
          {/* General */}
          <section className="flex flex-col gap-4">
            <Heading className="" level={3} variant="title">
              General
            </Heading>
            <Stack gap="group">
              <FormField label="Name">
                <TextField
                  value={pipeline.name}
                  onChange={(e) => onUpdateField('name', e.target.value)}
                  placeholder="Workflow name"
                  disabled={readonly}
                />
              </FormField>
              <FormField label="Version" hint="Semantic version string">
                <TextField
                  value={pipeline.version || ''}
                  onChange={(e) => onUpdateField('version', e.target.value)}
                  placeholder="2.0"
                  disabled={readonly}
                />
              </FormField>
              <FormField label="Description">
                <TextAreaField
                  value={pipeline.description || ''}
                  onChange={(e) => onUpdateField('description', e.target.value)}
                  placeholder="Describe what this workflow does…"
                  rows={3}
                  disabled={readonly}
                />
              </FormField>
              <FormField label="Icon" hint="Emoji or icon name">
                <TextField
                  value={pipeline.icon || ''}
                  onChange={(e) => onUpdateField('icon', e.target.value)}
                  placeholder="⚡"
                  disabled={readonly}
                />
              </FormField>
            </Stack>
          </section>

          {/* Triggers */}
          <section className="flex flex-col gap-4">
            <Heading className="" level={3} variant="title">
              Triggers
            </Heading>
            <ChoiceList aria-label="Triggers">
              {TRIGGER_OPTIONS.filter((trigger) =>
                isOfferedTrigger(
                  trigger.type,
                  activeTriggerTypes,
                  packageInstalled,
                ),
              ).map((trigger) => {
                const isActive = activeTriggerTypes.includes(trigger.type);
                return (
                  <ChoiceField
                    key={trigger.type}
                    layout="row"
                    data-testid={`pipeline-trigger-row-${trigger.type}`}
                    checked={isActive}
                    disabled={readonly}
                    onChange={(): void => toggleTrigger(trigger.type)}
                    label={
                      <>
                        <span className="block font-medium">
                          {trigger.label}
                        </span>
                        <span className="block text-xs fg-secondary">
                          {trigger.hint}
                        </span>
                      </>
                    }
                  />
                );
              })}
            </ChoiceList>
            {packageInstalled ? (
              <p
                className="text-xs fg-secondary"
                data-testid="pipeline-trigger-workflow-package"
              >
                This workflow comes from a package, so its Workflow trigger
                changes when the package is updated.
              </p>
            ) : null}
            {confirmWorkflow ? (
              <ConfirmDialog
                title="Turn on the Workflow trigger?"
                message={`${String(workflowCallers)} ${workflowCallers === 1 ? 'workflow runs' : 'workflows run'} this one as a step. When ${workflowCallers === 1 ? 'that workflow runs' : 'one of them runs'} as Workflow, this step will run as Workflow too.`}
                confirmLabel="Turn on"
                onConfirm={(): void => {
                  setConfirmWorkflow(false);
                  onUpdateField('on', toggledTriggers(pipeline.on, 'workflow'));
                }}
                onCancel={(): void => setConfirmWorkflow(false)}
                dataTestId="pipeline-trigger-workflow-confirm"
              />
            ) : null}
          </section>

          {/* Execution Scope */}
          <section
            className="flex flex-col gap-4"
            data-testid="pipeline-execution-scope"
          >
            <Stack gap="tight">
              <Heading className="" level={3} variant="title">
                Execution scope
              </Heading>
              <p className="text-xs fg-secondary">
                Controls where this workflow can be shown and run.
              </p>
            </Stack>
            <ChoiceList aria-label="Execution scope">
              {EXECUTION_SCOPE_OPTIONS.map((option) => {
                const isSelected = selectedScopes.includes(option.scope);
                // Prevent unchecking the final scope so at least one always
                // remains selected.
                const isLastSelected =
                  isSelected && selectedScopes.length === 1;
                const disabled = readonly || isLastSelected;
                return (
                  <ChoiceField
                    key={option.scope}
                    layout="row"
                    data-testid={`pipeline-execution-scope-row-${option.scope}`}
                    checked={isSelected}
                    disabled={disabled}
                    onChange={(): void =>
                      toggleExecutionScope(option.scope, !isSelected)
                    }
                    label={
                      <>
                        <span className="block font-medium">
                          {option.label}
                        </span>
                        <span className="block text-xs fg-secondary">
                          {option.hint}
                        </span>
                      </>
                    }
                  />
                );
              })}
            </ChoiceList>
          </section>

          {/* Trigger Inputs */}
          {activeTriggerTypes.length > 0 && (
            <section className="flex flex-col gap-4">
              <Stack gap="tight">
                <Heading className="" level={3} variant="title">
                  Trigger inputs
                </Heading>
                <p className="text-xs fg-secondary">
                  Inputs are collected from the user when the workflow is
                  triggered and made available to steps as{' '}
                  <code>{brand.internalName}.inputs.&lt;name&gt;</code>.
                </p>
              </Stack>
              <Stack gap="block">
                {activeTriggerTypes.map((triggerType) => (
                  <TriggerInputsEditor
                    key={triggerType}
                    triggerType={triggerType}
                    inputs={getTriggerInputDefs(pipeline.on, triggerType) ?? {}}
                    onChange={(next) => updateTriggerInputs(triggerType, next)}
                    readonly={readonly}
                  />
                ))}
              </Stack>
            </section>
          )}

          {/* Plugin Collections */}
          <section className="flex flex-col gap-4">
            <Stack gap="tight">
              <Heading className="" level={3} variant="title">
                Plugin collections
              </Heading>
              <p className="text-xs fg-secondary">
                Named sets of shareable skills and marketplace plugins that
                agent steps can opt into via{' '}
                <code>with.plugin_collection_id</code>.
              </p>
            </Stack>
            <PluginCollectionsEditor
              collections={pipeline.plugin_collections ?? []}
              onChange={updatePluginCollections}
              readonly={readonly}
            />
          </section>

          {/* Model Aliases */}
          <section className="flex flex-col gap-4">
            <Stack gap="tight">
              <Heading className="" level={3} variant="title">
                Model aliases
              </Heading>
              <p className="text-xs fg-secondary">
                Named model choices that agent steps can use via{' '}
                <code>with.model</code>. Aliases can provide workflow defaults,
                point to a local model preset, or require configuration at
                dispatch.
              </p>
            </Stack>
            <ModelAliasesEditor
              aliases={pipeline.model_aliases ?? []}
              pluginCollections={pipeline.plugin_collections ?? []}
              onChange={updateModelAliases}
              readonly={readonly}
            />
          </section>

          {/* Environment Variables */}
          <section className="flex flex-col gap-4">
            <Heading className="" level={3} variant="title">
              Environment variables
            </Heading>
            <KeyValueEditor
              value={pipeline.env || {}}
              onChange={onUpdateEnv}
              readonly={readonly}
            />
          </section>

          {/* Run Defaults */}
          <section className="flex flex-col gap-4">
            <Heading className="" level={3} variant="title">
              Run defaults
            </Heading>
            <Stack gap="group">
              <FormField label="Shell" hint="Default shell for run steps">
                <SelectField
                  value={run.shell || ''}
                  onChange={(e) =>
                    updateRunDefault(
                      'shell',
                      (e.target.value || undefined) as ShellType | undefined,
                    )
                  }
                  options={buildShellOptions()}
                  disabled={readonly}
                />
              </FormField>
              <FormField
                label="Working directory"
                hint="Default working directory for run steps"
              >
                <TextField
                  value={run.working_directory || ''}
                  onChange={(e) =>
                    updateRunDefault(
                      'working_directory',
                      e.target.value || undefined,
                    )
                  }
                  placeholder="./"
                  disabled={readonly}
                />
              </FormField>
            </Stack>
          </section>

          <PipelineRelatedSections
            pipeline={pipeline}
            pipelineInfo={pipelineInfo}
            cwd={cwd}
            refreshKey={relatedDataRevision}
            returnToEntryId={returnToEntryId}
            returnToEntryContext={returnToEntryContext}
            returnToPipeline={returnToPipeline}
            returnToMarketplace={returnToMarketplace}
            onNavigate={onRelatedNavigate}
          />
        </div>
      </div>
    </Surface>
  );
}
