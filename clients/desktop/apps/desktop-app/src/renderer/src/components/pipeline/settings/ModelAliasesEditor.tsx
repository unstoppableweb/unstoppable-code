import { type JSX, useEffect, useState } from 'react';
import type {
  PipelineAgentModelAliasDefaults,
  PipelineInlineModelAliasDefaults,
  PipelineModelAlias,
  PipelinePluginCollection,
} from '@canopy/execution-engine/types/pipeline';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { useAgentsStore } from '@/stores/agentsStore';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { SelectField } from '../shared/SelectField';
import { Tooltip } from '@canopy/ui-shared';
import { Stack, Button, Surface } from '@canopy/ui-shared/components';
import {
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

const ALIAS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Net-new alias id generator (mirrors PluginCollectionsEditor's
// `generateCollectionId`; the plugin-collection helper is module-local there
// and not exported, so it is duplicated here rather than shared).
function generateAliasId(name: string, existingIds: string[]): string {
  const base = slugify(name) || 'model-alias';
  let candidate = base;
  let n = 1;
  while (existingIds.includes(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

type AliasMode = 'none' | 'inline' | 'agent';

function getAliasMode(alias: PipelineModelAlias): AliasMode {
  if (!alias.defaults) return 'none';
  if ('agent_id' in alias.defaults) return 'agent';
  return 'inline';
}

function getInlineDefaults(
  alias: PipelineModelAlias,
): PipelineInlineModelAliasDefaults {
  if (alias.defaults && !('agent_id' in alias.defaults)) {
    return alias.defaults;
  }
  return { base: '' };
}

function getAgentDefaults(
  alias: PipelineModelAlias,
): PipelineAgentModelAliasDefaults {
  if (alias.defaults && 'agent_id' in alias.defaults) {
    return alias.defaults;
  }
  return { agent_id: '' };
}

/** Strip empty optional inline fields so saved YAML stays clean. */
function normalizeInlineDefaults(
  defaults: PipelineInlineModelAliasDefaults,
): PipelineInlineModelAliasDefaults {
  const next: PipelineInlineModelAliasDefaults = { base: defaults.base };
  if (defaults.instructions !== undefined && defaults.instructions !== '') {
    next.instructions = defaults.instructions;
  }
  if (
    defaults.plugin_collection_id !== undefined &&
    defaults.plugin_collection_id !== ''
  ) {
    next.plugin_collection_id = defaults.plugin_collection_id;
  }
  return next;
}

function buildAliasSummary(alias: PipelineModelAlias): string {
  const mode = getAliasMode(alias);
  let secondary: string;
  if (mode === 'none') {
    secondary = `${alias.id} · Required at dispatch/setup`;
  } else if (mode === 'agent') {
    secondary = `${alias.id} · ${getAgentDefaults(alias).agent_id || 'Agent'}`;
  } else {
    const base = getInlineDefaults(alias).base;
    secondary = `${alias.id} · ${base ? getModelDisplayName(base) : 'No base model'}`;
  }
  return alias.description ? `${secondary} — ${alias.description}` : secondary;
}

interface ModelAliasItemProps {
  alias: PipelineModelAlias;
  existingIds: string[];
  pluginCollections: PipelinePluginCollection[];
  onChange: (next: PipelineModelAlias) => void;
  onRemove: () => void;
  readonly?: boolean;
}

function ModelAliasItem({
  alias,
  existingIds,
  pluginCollections,
  onChange,
  onRemove,
  readonly = false,
}: ModelAliasItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [idDraft, setIdDraft] = useState(alias.id);
  const agents = useAgentsStore((s) => s.agents);

  const mode = getAliasMode(alias);
  const otherIds = existingIds.filter((id) => id !== alias.id);
  const idError =
    idDraft.trim() === ''
      ? 'ID is required'
      : otherIds.includes(idDraft.trim())
        ? 'ID must be unique'
        : !ALIAS_ID_RE.test(idDraft.trim())
          ? 'Start with a letter or number and use only letters, numbers, underscores, or hyphens'
          : undefined;

  function commitId(): void {
    if (idError) {
      setIdDraft(alias.id);
      return;
    }
    const nextId = idDraft.trim();
    if (nextId !== alias.id) {
      onChange({ ...alias, id: nextId });
    }
  }

  function setMode(nextMode: AliasMode): void {
    if (nextMode === 'none') {
      const { defaults: _omit, ...rest } = alias;
      void _omit;
      onChange(rest);
      return;
    }
    if (nextMode === 'inline') {
      onChange({
        ...alias,
        defaults: normalizeInlineDefaults(getInlineDefaults(alias)),
      });
      return;
    }
    const currentAgent = getAgentDefaults(alias).agent_id;
    onChange({
      ...alias,
      defaults: { agent_id: currentAgent || agents[0]?.id || '' },
    });
  }

  function updateInline(
    patch: Partial<PipelineInlineModelAliasDefaults>,
  ): void {
    const next = { ...getInlineDefaults(alias), ...patch };
    onChange({ ...alias, defaults: normalizeInlineDefaults(next) });
  }

  const summary = buildAliasSummary(alias);

  return (
    <Surface variant="group" size="small">
      {/* The remove action sits beside the toggle, not inside it. */}
      <div className="flex items-start">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-left hover:bg-fg-primary/[0.04]"
        >
          <span className="flex h-5 shrink-0 items-center">
            <AppCatalogChevronRightMediumIcon
              size="sm"
              className={`shrink-0 fg-secondary transition-transform ${
                expanded ? 'rotate-90' : ''
              }`}
              aria-hidden="true"
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-s font-medium fg-primary">
              {alias.name || alias.id}
            </div>
            <div className="truncate text-xs fg-secondary">{summary}</div>
          </div>
        </button>
        {/* The padding centers the 28px action on the title line. */}
        {!readonly && (
          <span className="flex shrink-0 p-1.5">
            <Tooltip label="Remove model alias">
              <Button
                variant="ghost-quiet"
                size="sm"
                iconOnly
                onClick={onRemove}
                aria-label="Remove model alias"
              >
                <AppCatalogCloseIcon size="sm" />
              </Button>
            </Tooltip>
          </span>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col border-t p-3 gap-3">
          <FormField
            label="ID"
            error={idError}
            hint="Referenced by agent steps via with.model"
          >
            <TextField
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={commitId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="reviewer"
              disabled={readonly}
            />
          </FormField>
          <p className="-mt-1 text-xs fg-secondary">
            Changing an ID does not update existing step references.
          </p>
          <FormField label="Name">
            <TextField
              value={alias.name}
              onChange={(e) => onChange({ ...alias, name: e.target.value })}
              placeholder="Display name"
              disabled={readonly}
            />
          </FormField>
          <FormField label="Description">
            <TextAreaField
              value={alias.description ?? ''}
              onChange={(e) =>
                onChange({
                  ...alias,
                  description: e.target.value || undefined,
                })
              }
              rows={2}
              placeholder="Describe this model alias…"
              disabled={readonly}
            />
          </FormField>

          <Stack gap="inline">
            <FormField
              label="Defaults"
              htmlFor={`model-alias-${alias.id}-mode`}
            >
              <SelectField
                id={`model-alias-${alias.id}-mode`}
                value={mode}
                onChange={(e) => setMode(e.target.value as AliasMode)}
                options={[
                  { value: 'none', label: 'No default' },
                  { value: 'inline', label: 'Inline model' },
                  { value: 'agent', label: 'Agent' },
                ]}
                disabled={readonly}
                data-testid={`model-alias-${alias.id}-mode`}
              />
            </FormField>

            {mode === 'none' && (
              <p className="text-xs fg-secondary">
                Dispatch and automation setup must provide this model alias
                before the workflow can run.
              </p>
            )}

            {mode !== 'none' && (
              <p className="text-xs fg-secondary">
                Used as the workflow baseline. Dispatch and automation setup can
                override it per run.
              </p>
            )}

            {mode === 'inline' && (
              <div className="flex flex-col pt-1 gap-3">
                <FormField label="Base model">
                  <Surface variant="inset" size="small">
                    <div className="flex items-center px-2 py-1.5">
                      <ModelPicker
                        currentModel={getInlineDefaults(alias).base || ''}
                        onModelChange={(model) => updateInline({ base: model })}
                        allowWorkspaceDefault={false}
                        hideAgents
                        disabled={readonly}
                        placeholderLabel="Choose a model"
                        triggerTooltip="Model this alias resolves to"
                      />
                    </div>
                  </Surface>
                </FormField>
                <FormField label="Instructions">
                  <TextAreaField
                    value={getInlineDefaults(alias).instructions ?? ''}
                    onChange={(e) =>
                      updateInline({ instructions: e.target.value })
                    }
                    rows={4}
                    placeholder="Instructions appended when this alias is used…"
                    disabled={readonly}
                  />
                </FormField>
                <FormField
                  label="Plugin collection"
                  hint="Enabled in addition to any plugin_collection_id on the step."
                >
                  <SelectField
                    value={getInlineDefaults(alias).plugin_collection_id ?? ''}
                    onChange={(e) =>
                      updateInline({ plugin_collection_id: e.target.value })
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
                </FormField>
              </div>
            )}

            {mode === 'agent' && (
              <div className="flex flex-col pt-1 gap-3">
                <FormField
                  label="Agent"
                  hint="Uses the agent base model, instructions, and plugins at run time."
                >
                  {agents.length === 0 ? (
                    <p className="text-xs fg-secondary italic">
                      No local agents available
                    </p>
                  ) : (
                    <SelectField
                      value={getAgentDefaults(alias).agent_id}
                      onChange={(e) =>
                        onChange({
                          ...alias,
                          defaults: { agent_id: e.target.value },
                        })
                      }
                      options={agents.map((agent) => ({
                        value: agent.id,
                        label: `${agent.name} (${agent.id})`,
                      }))}
                      placeholder="Select an agent"
                      disabled={readonly}
                    />
                  )}
                </FormField>
              </div>
            )}
          </Stack>
        </div>
      )}
    </Surface>
  );
}

interface ModelAliasesEditorProps {
  aliases: PipelineModelAlias[];
  pluginCollections: PipelinePluginCollection[];
  onChange: (aliases: PipelineModelAlias[] | undefined) => void;
  readonly?: boolean;
}

export function ModelAliasesEditor({
  aliases,
  pluginCollections,
  onChange,
  readonly = false,
}: ModelAliasesEditorProps): JSX.Element {
  const existingIds = aliases.map((a) => a.id);
  const agentsLoaded = useAgentsStore((s) => s.loaded);
  const loadAgents = useAgentsStore((s) => s.load);

  useEffect(() => {
    if (aliases.length > 0 && !agentsLoaded) {
      void loadAgents();
    }
  }, [aliases.length, agentsLoaded, loadAgents]);

  function addAlias(): void {
    const id = generateAliasId('model-alias', existingIds);
    const next: PipelineModelAlias = { id, name: 'New model alias' };
    onChange([...aliases, next]);
  }

  function updateAlias(index: number, next: PipelineModelAlias): void {
    const updated = aliases.slice();
    updated[index] = next;
    onChange(updated);
  }

  function removeAlias(index: number): void {
    const updated = aliases.filter((_, i) => i !== index);
    onChange(updated.length > 0 ? updated : undefined);
  }

  return (
    <Stack gap="inline">
      {aliases.length === 0 ? (
        <p className="text-xs fg-secondary italic">
          No model aliases defined. Add one so agent steps can reuse model
          choices.
        </p>
      ) : (
        aliases.map((alias, index) => (
          <ModelAliasItem
            key={alias.id || `model-alias-${index}`}
            alias={alias}
            existingIds={existingIds}
            pluginCollections={pluginCollections}
            onChange={(next) => updateAlias(index, next)}
            onRemove={() => removeAlias(index)}
            readonly={readonly}
          />
        ))
      )}

      {!readonly && (
        <Button className="self-start" size="compact" onClick={addAlias}>
          Add model alias
        </Button>
      )}
    </Stack>
  );
}
