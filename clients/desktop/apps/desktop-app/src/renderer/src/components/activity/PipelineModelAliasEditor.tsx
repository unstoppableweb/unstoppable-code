import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { AgentAliasModelFields } from '@canopy/ui-shared/components';
import { resolvePipelineModelAliasLenient } from '@canopy/pipeline-interop';
// ---------------------------------------------------------------------------
// Per-alias editor used by `PipelineModelAliasesSection`.
//
// Renders a single `PipelineModelAlias` as a collapsible card that lets the
// user customize the model choice for a run (inline model or a local Agent),
// reset to the pipeline defaults, or clear a custom value. Reset/clear always
// write a `{ mode: 'reset' }` marker — never a key deletion — so a stored
// per-pipeline preference can be forced back to the pipeline default (see the
// reset tombstone contract).
// ---------------------------------------------------------------------------

import { useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import type {
  PipelineModelAlias,
  PipelineModelAliasPreference,
  PipelinePluginCollection,
} from '@canopy/execution-engine/types/pipeline';
import {
  getAgentModelAvailability,
  getModelDisplayName,
} from '@canopy/desktop-shared/types';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  Stack,
  DialogFormField,
  FieldError,
  SettingsSelect,
  Surface,
  TextArea,
} from '@canopy/ui-shared/components';
import {
  resolveEffectiveAliasPreference,
  validateEffectiveAliasPreference,
} from '@/lib/pipelineModelAliases';
import {
  Badge,
  Button,
  Disclosure,
  SegmentedControl,
} from '@canopy/ui-shared/components';

interface PipelineModelAliasEditorProps {
  alias: PipelineModelAlias;
  preference: PipelineModelAliasPreference | undefined;
  pluginCollections: PipelinePluginCollection[];
  onChange: (next: PipelineModelAliasPreference | undefined) => void;
  readonly?: boolean;
}

export function PipelineModelAliasEditor({
  alias,
  preference,
  pluginCollections,
  onChange,
  readonly = false,
}: PipelineModelAliasEditorProps): JSX.Element {
  useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const [expanded, setExpanded] = useState(false);
  const agents = useAgentsStore((s) => s.agents);
  const availableAgentIds = useMemo(
    () => new Set(agents.map((agent) => agent.id)),
    [agents],
  );

  const hasDefaults = alias.defaults !== undefined;

  const effective = useMemo(
    () => resolveEffectiveAliasPreference(alias, undefined, preference),
    [alias, preference],
  );

  const validationError = validateEffectiveAliasPreference(effective, {
    pluginCollectionIds: new Set(pluginCollections.map((c) => c.id)),
    availableAgentIds,
    isAgentRouteAvailable: (route: string): boolean =>
      getAgentModelAvailability(route).available,
  });

  const currentMode: 'inline' | 'agent' | null = effective.preference
    ? effective.preference.mode
    : null;

  // The field the validation message is about, so it shows under that field.
  const errorField: 'mode' | 'base' | 'plugin' | 'agent' | null =
    validationError === undefined
      ? null
      : !effective.preference
        ? 'mode'
        : effective.preference.mode === 'agent'
          ? !effective.preference.agent_id ||
            !availableAgentIds.has(
              parseAgentRouteModelId(effective.preference.agent_id)?.agentId ??
                effective.preference.agent_id,
            )
            ? 'agent'
            : 'base'
          : !effective.preference.base ||
              effective.preference.base.trim() === ''
            ? 'base'
            : 'plugin';
  const errorId = `pipeline-model-alias-${alias.id}-error`;
  const instructionsId = `pipeline-model-alias-${alias.id}-instructions`;
  const errorFor = (field: 'base' | 'plugin' | 'agent'): string | undefined =>
    errorField === field ? validationError : undefined;

  const subtitle = useMemo(() => {
    if (!effective.preference) {
      return `${alias.id} · Required`;
    }
    if (effective.preference.mode === 'agent') {
      const embedded = parseAgentRouteModelId(effective.preference.agent_id);
      const base = effective.preference.base ?? embedded?.baseModel;
      return `${alias.id} · ${embedded?.agentId ?? (effective.preference.agent_id || 'Agent')}${base ? ` · ${getModelDisplayName(resolvePipelineModelAliasLenient(base))}` : ''}`;
    }
    const base = effective.preference.base;
    return `${alias.id} · ${base ? getModelDisplayName(base) : 'No base model'}`;
  }, [alias.id, effective.preference]);

  function selectMode(mode: 'inline' | 'agent'): void {
    if (mode === 'inline') {
      const base =
        effective.preference?.mode === 'inline'
          ? effective.preference.base
          : '';
      const instructions =
        effective.preference?.mode === 'inline'
          ? effective.preference.instructions
          : undefined;
      const pluginCollectionId =
        effective.preference?.mode === 'inline'
          ? effective.preference.plugin_collection_id
          : undefined;
      onChange({
        mode: 'inline',
        base,
        ...(instructions !== undefined && instructions !== ''
          ? { instructions }
          : {}),
        ...(pluginCollectionId !== undefined && pluginCollectionId !== ''
          ? { plugin_collection_id: pluginCollectionId }
          : {}),
      });
      return;
    }
    const agentId =
      effective.preference?.mode === 'agent'
        ? effective.preference.agent_id
        : agents.find((agent) => getAgentModelAvailability(agent.id).available)
            ?.id ||
          agents[0]?.id ||
          '';
    onChange({
      mode: 'agent',
      agent_id: agentId,
      ...(effective.preference?.mode === 'agent' &&
      effective.preference.base !== undefined
        ? { base: effective.preference.base }
        : {}),
    });
  }

  function updateInline(patch: {
    base?: string;
    instructions?: string;
    plugin_collection_id?: string;
  }): void {
    const current =
      effective.preference?.mode === 'inline'
        ? effective.preference
        : { mode: 'inline' as const, base: '' };
    const merged = {
      mode: 'inline' as const,
      base: patch.base ?? current.base,
      instructions: patch.instructions ?? current.instructions,
      plugin_collection_id:
        patch.plugin_collection_id ?? current.plugin_collection_id,
    };
    onChange({
      mode: 'inline',
      base: merged.base,
      ...(merged.instructions !== undefined && merged.instructions !== ''
        ? { instructions: merged.instructions }
        : {}),
      ...(merged.plugin_collection_id !== undefined &&
      merged.plugin_collection_id !== ''
        ? { plugin_collection_id: merged.plugin_collection_id }
        : {}),
    });
  }

  function handleResetOrClear(): void {
    // Both reset-to-defaults and clear-custom-value write a reset tombstone so
    // a stored per-pipeline preference cannot silently reapply.
    onChange({ mode: 'reset' });
  }

  return (
    <Disclosure
      variant="box"
      open={expanded}
      onOpenChange={setExpanded}
      dataTestId={`pipeline-model-alias-${alias.id}`}
      label={
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate">{alias.name || alias.id}</span>
            {effective.customized && (
              <Badge
                data-testid={`pipeline-model-alias-${alias.id}-customized`}
              >
                Customized
              </Badge>
            )}
            {!effective.customized && effective.source === 'default' && (
              <Badge muted>Workflow default</Badge>
            )}
            {effective.required && (
              <Badge
                tone="danger"
                data-testid={`pipeline-model-alias-${alias.id}-required`}
              >
                Required
              </Badge>
            )}
          </span>
          <span className="truncate text-xs font-normal fg-secondary">
            {subtitle}
          </span>
        </span>
      }
    >
      <Stack gap="item">
        <SegmentedControl
          label="Alias mode"
          shape="capsule"
          width="content"
          value={currentMode}
          disabled={readonly}
          onChange={selectMode}
          options={(['inline', 'agent'] as const).map((mode) => ({
            value: mode,
            label: mode === 'inline' ? 'Inline model' : 'Agent',
            dataTestId: `pipeline-model-alias-${alias.id}-mode-${mode}`,
          }))}
        />

        {currentMode === 'inline' && (
          <Stack gap="item">
            <DialogFormField
              label="Base model"
              error={errorFor('base')}
              errorId={errorId}
            >
              <Surface variant="inset" size="small" className="w-full">
                <div className="flex items-center px-2 py-1.5">
                  <ModelPicker
                    currentModel={
                      effective.preference?.mode === 'inline'
                        ? effective.preference.base || ''
                        : ''
                    }
                    onModelChange={(model) => updateInline({ base: model })}
                    allowWorkspaceDefault={false}
                    hideAgents
                    disabled={readonly}
                    placeholderLabel="Choose a model"
                    triggerTooltip="Model this alias resolves to"
                  />
                </div>
              </Surface>
            </DialogFormField>
            <DialogFormField label="Instructions" htmlFor={instructionsId}>
              <TextArea
                id={instructionsId}
                mono
                value={
                  effective.preference?.mode === 'inline'
                    ? (effective.preference.instructions ?? '')
                    : ''
                }
                onChange={(e) => updateInline({ instructions: e.target.value })}
                rows={4}
                placeholder="Instructions appended when this alias is used…"
                disabled={readonly}
              />
            </DialogFormField>
            <DialogFormField
              label="Plugin collection"
              description="Enabled in addition to any plugin_collection_id on the step."
              error={errorFor('plugin')}
              errorId={errorId}
            >
              <SettingsSelect
                aria-label="Plugin collection"
                aria-invalid={errorFor('plugin') ? true : undefined}
                aria-describedby={errorFor('plugin') ? errorId : undefined}
                value={
                  effective.preference?.mode === 'inline'
                    ? (effective.preference.plugin_collection_id ?? '')
                    : ''
                }
                onValueChange={(next) =>
                  updateInline({ plugin_collection_id: next })
                }
                options={[
                  { value: '', label: 'None' },
                  ...pluginCollections.map((collection) => ({
                    value: collection.id,
                    label: `${collection.name || collection.id} (${collection.id})`,
                  })),
                ]}
                disabled={readonly}
              />
            </DialogFormField>
          </Stack>
        )}

        {currentMode === 'agent' && effective.preference?.mode === 'agent' && (
          <AgentAliasModelFields
            value={effective.preference}
            agents={agents}
            onChange={(next) => onChange({ mode: 'agent', ...next })}
            disabled={readonly}
            agentError={errorFor('agent')}
            modelError={errorFor('base')}
            renderModelPicker={({
              value,
              onChange: changeModel,
              disabled,
              placeholderLabel,
              ...control
            }) => (
              <ModelPicker
                triggerControlProps={control}
                currentModel={resolvePipelineModelAliasLenient(value)}
                onModelChange={changeModel}
                allowWorkspaceDefault={false}
                hideAgents
                allowCursor
                allowCopilot
                allowOpenCode
                placeholderLabel={placeholderLabel}
                triggerTooltip="Model for this agent alias"
                disabled={disabled}
              />
            )}
          />
        )}

        {currentMode === null && (
          <p className="text-xs fg-secondary">
            Choose an inline model or an agent for this alias.
          </p>
        )}

        {errorField === 'mode' && validationError && (
          <FieldError id={errorId}>{validationError}</FieldError>
        )}

        {!readonly && effective.customized && (
          <Button
            className="self-start"
            size="compact"
            onClick={handleResetOrClear}
            data-testid={`pipeline-model-alias-${alias.id}-reset`}
          >
            {hasDefaults ? 'Reset to defaults' : 'Clear custom value'}
          </Button>
        )}
      </Stack>
    </Disclosure>
  );
}
