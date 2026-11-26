import { useRef, useState, type JSX } from 'react';
import type {
  LogFormatHint,
  PipelineScalar,
  Step,
} from '@canopy/execution-engine/types/pipeline';
import {
  Stack,
  Divider,
  Heading,
  Notice,
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { SelectField } from '../shared/SelectField';
import { ToggleField } from '../shared/ToggleField';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { PipelineDetailPanelShell } from './PipelinePanelPrimitives';
import { AutomationSidebarGroupPicker } from '../../automations/AutomationSidebarGroupPicker';
import {
  AutomationSendAs,
  type AutomationSendAsConnector,
} from '@canopy/ui-app/capability';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import {
  buildStepTargetFromForm,
  readStepTargetForm,
  type StepTargetFormState,
  type StepTargetScope,
} from '@/lib/pipelineStepTarget';
import {
  stepSidebarGroupField,
  withStepSidebarGroup,
} from '@/lib/pipelineStepSidebarGroup';
import {
  PIPELINE_SHELL_OPTIONS,
  type PipelineShellOption,
} from '../pipeline-shell-options';

interface StepDetailPanelProps {
  step: Step;
  stepIndex: number;
  jobId: string;
  onChange: (step: Step) => void;
  onClose: () => void;
  readonly?: boolean;
  /**
   * Sets the step's ID through a check, and returns why a new ID was
   * refused, or null once applied. The Designer
   * passes its checked rename (CAN-4224 phase 02), which refuses an ID that
   * another step reads.
   */
  onRenameId?: (id: string | undefined) => string | null;
  /**
   * Keeps the whole step read-only and says why. The Designer sets it on a
   * router step that isn't a split it draws as paths: other jobs'
   * conditions read its routes, and it can't change both together.
   */
  lockedReason?: string;
  /**
   * Values the steps' `inputs.*` stand for, such as a workflow's first
   * schedule's (CAN-5782), to resolve a create step's project.
   */
  inputValues?: Readonly<Record<string, string>>;
  /** A send step's "Send as" (CAN-7186), when the host offers it. */
  sendAs?: StepSendAsField | undefined;
}

/** A send step's "Send as" choice, as the workflow page reads it. */
export interface StepSendAsField {
  readonly connectors: readonly AutomationSendAsConnector[];
  readonly onChange: (serverKey: string, configId: string) => void;
  /** The choice can't be made here yet; `notes` say why. */
  readonly disabled: boolean;
  /** Where the choice applies, or why it can't be made yet. */
  readonly notes: readonly string[];
}

type StepMode = 'action' | 'script';

const STEP_MODE_OPTIONS: readonly SegmentedControlOption<StepMode>[] = [
  { value: 'action', label: 'Action' },
  { value: 'script', label: 'Script' },
];

function buildShellOptions(): PipelineShellOption[] {
  return [
    { value: '', label: pt(uiText.pipelineShell.unsetDefault) },
    ...PIPELINE_SHELL_OPTIONS,
  ];
}

const LOG_FORMAT_HINT_OPTIONS = [
  { value: '', label: 'Plain text log' },
  { value: 'agent', label: 'Agent transcript' },
];

function getMode(step: Step): StepMode {
  if (step.run !== undefined) return 'script';
  return 'action';
}

function parseLogFormatHintValue(value: string): LogFormatHint | undefined {
  if (value === 'agent') {
    return 'agent';
  }

  return undefined;
}

/** The only `uses` value that carries a `target`. */
const RUN_PIPELINE_USES = 'builtin/run-pipeline';

const TARGET_SCOPE_OPTIONS: { value: StepTargetScope; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'global', label: 'Global' },
  { value: 'directory', label: 'Directory' },
  { value: 'worktree', label: 'Worktree' },
];

function parseStepTargetScope(value: string): StepTargetScope | undefined {
  for (const option of TARGET_SCOPE_OPTIONS) {
    if (value === option.value) {
      return option.value;
    }
  }
  return undefined;
}

export function StepDetailPanel({
  step,
  stepIndex,
  onChange,
  onClose,
  readonly: readonlyProp = false,
  onRenameId,
  lockedReason,
  inputValues,
  sendAs,
}: StepDetailPanelProps): JSX.Element {
  const readonly = readonlyProp || lockedReason !== undefined;
  const [idDraft, setIdDraft] = useState(step.id ?? '');
  const [idError, setIdError] = useState<string | null>(null);
  // An ID changed elsewhere (undo, YAML) shows in the field. Each selection
  // mounts its own panel, so a draft never carries to another step.
  const shownId = useRef(step.id);
  if (shownId.current !== step.id) {
    shownId.current = step.id;
    setIdDraft(step.id ?? '');
    setIdError(null);
  }

  /**
   * Applies each change as it is typed, like the panel's other fields, so
   * the draft always holds the ID shown or says why it was refused.
   */
  function changeId(value: string): void {
    setIdDraft(value);
    if (!onRenameId) return;
    const next = value.trim() || undefined;
    const refused = next === (step.id || undefined) ? null : onRenameId(next);
    setIdError(
      refused === null
        ? null
        : `${refused} The step keeps ${step.id ? `the ID “${step.id}”` : 'no ID'}.`,
    );
  }

  const mode = getMode(step);
  // By number: a step's ID is authored, and its field shows it below.
  const headerLabel = `Step ${String(stepIndex + 1)}`;

  function handleModeSwitch(newMode: StepMode): void {
    if (newMode === mode) return;

    if (newMode === 'script') {
      // Switching to Script: clear action-specific fields. `target` is part of
      // the action contract (it only applies to `builtin/run-pipeline`), so it
      // is cleared alongside `uses`/`with` rather than left orphaned.
      const updated = { ...step };
      delete updated.uses;
      delete updated.with;
      delete updated.log_format_hint;
      delete updated.skip_on_missing_action;
      delete updated.target;
      updated.run = '';
      onChange(updated);
    } else {
      // Switching to Action: clear script-specific fields
      const updated = { ...step };
      delete updated.run;
      delete updated.shell;
      delete updated.working_directory;
      updated.uses = '';
      onChange(updated);
    }
  }

  function handleFieldChange<K extends keyof Step>(
    field: K,
    value: Step[K] | undefined,
  ): void {
    const updated = { ...step };
    if (value === undefined || value === '') {
      delete updated[field];
    } else {
      updated[field] = value;
    }
    onChange(updated);
  }

  function handleUsesChange(value: string): void {
    const uses = value || undefined;
    const updated = { ...step };
    if (uses === undefined) {
      delete updated.uses;
    } else {
      updated.uses = uses;
    }
    if (uses !== RUN_PIPELINE_USES) {
      delete updated.target;
    }
    onChange(updated);
  }

  function handleWithChange(newWith: Record<string, PipelineScalar>): void {
    const updated = { ...step };
    if (Object.keys(newWith).length > 0) {
      updated.with = newWith;
    } else {
      delete updated.with;
    }
    onChange(updated);
  }

  function handleEnvChange(newEnv: Record<string, PipelineScalar>): void {
    const updated = { ...step };
    if (Object.keys(newEnv).length > 0) {
      updated.env = newEnv;
    } else {
      delete updated.env;
    }
    onChange(updated);
  }

  const isRunPipeline = step.uses === RUN_PIPELINE_USES;
  const sidebarGroup = stepSidebarGroupField(step, inputValues);
  const targetForm = readStepTargetForm(step.target);

  // Rebuild and store the whole `target` object on every field change. We never
  // delete `target` here, so editing an unrelated target field cannot drop it.
  function updateTargetForm(patch: Partial<StepTargetFormState>): void {
    const next = buildStepTargetFromForm({ ...targetForm, ...patch });
    onChange({ ...step, target: next });
  }

  return (
    <PipelineDetailPanelShell title={headerLabel} onClose={onClose}>
      {lockedReason !== undefined && (
        <Notice intent="attention" role="none">
          {lockedReason}
        </Notice>
      )}
      {/* Step ID */}
      <FormField
        label="Step ID"
        hint="Optional identifier for this step"
        {...(idError !== null
          ? {
              // It can quote another step's authored name: never recorded.
              error: <span className={REPLAY_BLOCK_CLASS}>{idError}</span>,
            }
          : {})}
      >
        {onRenameId ? (
          <TextField
            value={idDraft}
            onChange={(e): void => changeId(e.target.value)}
            onBlur={(): void => {
              // Refused text never outlives the field's focus: it shows the
              // ID the step has, which is the one a save writes.
              if (idError !== null) {
                setIdDraft(step.id ?? '');
                setIdError(null);
              }
            }}
            placeholder="e.g. build, test, deploy"
            disabled={readonly}
          />
        ) : (
          <TextField
            value={step.id || ''}
            onChange={(e): void =>
              handleFieldChange('id', e.target.value || undefined)
            }
            placeholder="e.g. build, test, deploy"
            disabled={readonly}
          />
        )}
      </FormField>

      {/* Step Name */}
      <FormField label="Step name" hint="Optional display name">
        <TextField
          value={step.name || ''}
          onChange={(e): void =>
            handleFieldChange('name', e.target.value || undefined)
          }
          placeholder="e.g. Build project"
          disabled={readonly}
        />
      </FormField>

      {/* Type toggle */}
      <FormField label="Type">
        <SegmentedControl
          label="Step type"
          value={mode}
          options={STEP_MODE_OPTIONS}
          onChange={handleModeSwitch}
          disabled={readonly}
          width="fill"
        />
      </FormField>

      {/* Mode-specific fields */}
      <div>
        <Divider />
        <div className="flex flex-col pt-2 gap-4">
          {mode === 'action' ? (
            <>
              <FormField label="Uses" hint="Action reference">
                <TextField
                  value={step.uses || ''}
                  onChange={(e): void => handleUsesChange(e.target.value)}
                  placeholder="builtin/action-name or project/action-name"
                  disabled={readonly}
                />
              </FormField>

              {sidebarGroup && (
                <FormField
                  label="Sidebar group"
                  hint="The group the new task joins in the sidebar"
                >
                  {sidebarGroup.kind === 'picker' ? (
                    <AutomationSidebarGroupPicker
                      scope={sidebarGroup.scope}
                      value={sidebarGroup.value}
                      onChange={(name): void =>
                        onChange(withStepSidebarGroup(step, name))
                      }
                      disabled={readonly}
                    />
                  ) : (
                    <TextField
                      value={sidebarGroup.value}
                      onChange={(e): void =>
                        onChange(withStepSidebarGroup(step, e.target.value))
                      }
                      placeholder="No group"
                      disabled={readonly}
                      data-testid="step-sidebar-group-name"
                    />
                  )}
                </FormField>
              )}

              {sendAs &&
                (sendAs.connectors.length > 0 || sendAs.notes.length > 0) && (
                  <Stack gap="inline">
                    {sendAs.connectors.length > 0 && (
                      <AutomationSendAs
                        connectors={sendAs.connectors}
                        onChange={sendAs.onChange}
                        disabled={readonly || sendAs.disabled}
                        subject="step"
                      />
                    )}
                    {sendAs.notes.map((note) => (
                      <p
                        key={note}
                        className="text-xs fg-secondary text-pretty"
                      >
                        {note}
                      </p>
                    ))}
                  </Stack>
                )}

              <Stack gap="inline">
                <Heading level={4} variant="label">
                  Inputs (with)
                </Heading>
                <KeyValueEditor
                  value={step.with || {}}
                  onChange={handleWithChange}
                  readonly={readonly}
                />
              </Stack>

              <FormField
                label="Log format"
                hint="Choose how this action step’s log should be rendered"
              >
                <SelectField
                  value={step.log_format_hint || ''}
                  onChange={(e): void =>
                    handleFieldChange(
                      'log_format_hint',
                      parseLogFormatHintValue(e.target.value),
                    )
                  }
                  options={LOG_FORMAT_HINT_OPTIONS}
                  disabled={readonly}
                />
              </FormField>

              {isRunPipeline && (
                <div
                  className="flex flex-col pt-2 gap-4"
                  data-testid="step-target-editor"
                >
                  <Divider />
                  <div className="pt-2 flex flex-col gap-4">
                    <Heading level={4} variant="label">
                      Target
                    </Heading>

                    <FormField
                      label="Scope"
                      hint="Where the child workflow runs. Inherit reuses this step’s context."
                    >
                      <SelectField
                        value={targetForm.scope}
                        onChange={(e): void => {
                          const scope = parseStepTargetScope(e.target.value);
                          if (!scope) return;
                          updateTargetForm({ scope });
                        }}
                        options={TARGET_SCOPE_OPTIONS}
                        disabled={readonly}
                      />
                    </FormField>

                    {targetForm.scope === 'directory' && (
                      <FormField label="Path">
                        <TextField
                          value={targetForm.path}
                          onChange={(e): void =>
                            updateTargetForm({ path: e.target.value })
                          }
                          placeholder="Path for child workflow"
                          disabled={readonly}
                        />
                      </FormField>
                    )}

                    {targetForm.scope === 'worktree' && (
                      <>
                        <FormField label="Project ID">
                          <TextField
                            value={targetForm.workspaceId}
                            onChange={(e): void =>
                              updateTargetForm({ workspaceId: e.target.value })
                            }
                            placeholder="workspace_id"
                            disabled={readonly}
                          />
                        </FormField>

                        <FormField label="Worktree ID">
                          <TextField
                            value={targetForm.worktreeId}
                            onChange={(e): void =>
                              updateTargetForm({ worktreeId: e.target.value })
                            }
                            placeholder="worktree_id"
                            disabled={readonly}
                          />
                        </FormField>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <FormField label="Run" hint="Inline script to execute">
                <TextAreaField
                  value={step.run || ''}
                  onChange={(e): void =>
                    handleFieldChange('run', e.target.value || undefined)
                  }
                  rows={6}
                  placeholder="echo 'hello world'"
                  disabled={readonly}
                />
              </FormField>

              <FormField label="Shell">
                <SelectField
                  value={step.shell || ''}
                  onChange={(e): void =>
                    handleFieldChange(
                      'shell',
                      (e.target.value as Step['shell']) || undefined,
                    )
                  }
                  options={buildShellOptions()}
                  disabled={readonly}
                />
              </FormField>

              <FormField label="Working directory">
                <TextField
                  value={step.working_directory || ''}
                  onChange={(e): void =>
                    handleFieldChange(
                      'working_directory',
                      e.target.value || undefined,
                    )
                  }
                  placeholder="e.g. ./packages/core"
                  disabled={readonly}
                />
              </FormField>
            </>
          )}
        </div>
      </div>

      {/* Common fields */}
      <div>
        <Divider />
        <div className="flex flex-col pt-2 gap-4">
          <Heading level={4} variant="label">
            Common settings
          </Heading>

          <FormField
            label="Condition (if)"
            hint="Expression that determines if this step runs"
          >
            <TextField
              value={step.if || ''}
              onChange={(e): void =>
                handleFieldChange('if', e.target.value || undefined)
              }
              placeholder="e.g. steps.build.outcome == 'success'"
              disabled={readonly}
            />
          </FormField>

          <Stack gap="inline">
            <Heading level={4} variant="label">
              Environment variables
            </Heading>
            <KeyValueEditor
              value={step.env || {}}
              onChange={handleEnvChange}
              readonly={readonly}
            />
          </Stack>

          <FormField label="Timeout (minutes)">
            <TextField
              type="number"
              value={
                step.timeout_minutes !== undefined
                  ? String(step.timeout_minutes)
                  : ''
              }
              onChange={(e): void => {
                const val = e.target.value;
                if (val === '') {
                  handleFieldChange('timeout_minutes', undefined);
                } else {
                  const num = Number(val);
                  if (!Number.isNaN(num) && num >= 0) {
                    handleFieldChange('timeout_minutes', num);
                  }
                }
              }}
              placeholder="No timeout"
              min="0"
              disabled={readonly}
            />
          </FormField>

          <FormField label="Continue on error">
            <ToggleField
              checked={step.continue_on_error || false}
              onChange={(checked): void =>
                handleFieldChange('continue_on_error', checked || undefined)
              }
              disabled={readonly}
              label="Continue on error"
            />
          </FormField>

          {step.uses !== undefined && (
            <FormField label="Skip on missing action">
              <ToggleField
                checked={step.skip_on_missing_action || false}
                onChange={(checked): void =>
                  handleFieldChange(
                    'skip_on_missing_action',
                    checked || undefined,
                  )
                }
                disabled={readonly}
                label="Skip on missing action"
              />
            </FormField>
          )}
        </div>
      </div>
    </PipelineDetailPanelShell>
  );
}
