import { Stack } from '@canopy/ui-shared/components';
import { type JSX, useId, useMemo, useState } from 'react';
import {
  getProviderForModel,
  isAgentModel,
} from '@canopy/desktop-shared/types';
import {
  AGENT_MODEL_PREFIX,
  agentModelIdFromSlug,
  deriveAgentModelSlug,
  isValidAgentModelSlug,
  type AgentModelDefinition,
  type SaveAgentModelRequest,
} from '@canopy/execution-engine/types/agent-models';
import {
  AGENT_DEFAULT_BASE_MODEL,
  MAX_SHARED_AGENT_INSTRUCTIONS_BYTES,
  isAgentDefaultBaseModel,
} from '@canopy/protocol/agents';
import {
  Button,
  Chip,
  ChoiceList,
  ChoiceListRow,
  FieldError,
  Fieldset,
  FORM_FIELD_DESCRIPTION_CLASS,
  FORM_FIELD_LABEL_CLASS,
  FormField,
  Surface,
  TextArea,
  TextInput,
  Tooltip,
} from '@canopy/ui-shared/components';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { PluginsIcon } from '@canopy/ui-shared/icons';
import { DialogModal } from '../shared/DialogModal';
import { ModelPicker } from '../chat/ModelPicker';
import { ChatPluginsModal } from '../chat/ChatPluginsModal';
import { createEmptySelections } from '@/lib/pluginSelections';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { DesktopErrorBanner } from '../shared/DesktopErrorBanner';

interface AgentModelModalProps {
  /** The Agent being edited, or `null` when creating a new one. */
  agent: AgentModelDefinition | null;
  /** All existing local Agents, used for duplicate-name validation. */
  existingAgents: AgentModelDefinition[];
  onClose: () => void;
  onSave: (request: SaveAgentModelRequest) => Promise<void>;
}

interface FieldErrors {
  name?: string;
  modelIdSlug?: string;
  baseModel?: string;
  instructions?: string;
}

const NAME_REQUIRED = 'Name is required.';
const NAME_DUPLICATE = 'An agent with this name already exists.';
const MODEL_ID_REQUIRED = 'Model ID is required.';
const MODEL_ID_INVALID =
  'Model ID can only contain lowercase letters, numbers, and single underscores.';
const MODEL_ID_DUPLICATE = 'An agent with this model ID already exists.';
const BASE_MODEL_REQUIRED = 'Choose a default model.';
const BASE_MODEL_IS_AGENT = 'Default model cannot be another agent.';
const INSTRUCTIONS_TOO_LONG = 'Instructions are too long.';

function byteLength(value: string): number {
  // UTF-8 byte length computed without `TextEncoder` (which is not present in
  // every jsdom test environment). Matches the byte count the shared-Agent
  // validators use for the instructions limit.
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      // A code point above 0xffff consumed a surrogate pair.
      i += 1;
    }
  }
  return bytes;
}

function slugFromAgentModelId(id: string): string {
  return id.startsWith(AGENT_MODEL_PREFIX)
    ? id.slice(AGENT_MODEL_PREFIX.length)
    : id;
}

function normalizeEditableSlug(value: string): string {
  return value
    .trimStart()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '');
}

/**
 * Create/edit modal for a custom Agent model.
 *
 * The Agent model ID is stable: on create the modal previews the derived
 * `agent_model_*` id (recomputed live from the name) and on edit it shows the
 * existing id read-only — renaming never changes it. The base-model picker
 * (the shared {@link ModelPicker} with `hideAgents`) lists only real provider
 * models (including Cursor) and never another Agent; the validator also
 * rejects an Agent base model that only persisted state could produce.
 */
export function AgentModelModal({
  agent,
  existingAgents,
  onClose,
  onSave,
}: AgentModelModalProps): JSX.Element {
  const isEdit = agent !== null;
  const [name, setName] = useState(agent?.name ?? '');
  const [baseModel, setBaseModel] = useState(agent?.baseModel ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [modelIdSlug, setModelIdSlug] = useState(
    agent ? slugFromAgentModelId(agent.id) : deriveAgentModelSlug(''),
  );
  const [modelIdManuallyEdited, setModelIdManuallyEdited] = useState(false);
  const [pluginSelections, setPluginSelections] =
    useState<ChatTabPluginSelections>(
      agent?.pluginSelections ?? createEmptySelections(),
    );
  const [pluginsModalOpen, setPluginsModalOpen] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<InlineFailure | null>(null);
  const inheritsDefaultModel = isAgentDefaultBaseModel(baseModel);
  const baseProvider = baseModel ? getProviderForModel(baseModel) : undefined;
  const baseModelErrorId = useId();

  const nameFieldId = useId();
  const modelIdFieldId = useId();
  const instructionsFieldId = useId();
  const modelId = useMemo(
    () =>
      isEdit
        ? (agent?.id ?? '')
        : agentModelIdFromSlug(modelIdSlug || deriveAgentModelSlug('')),
    [agent?.id, isEdit, modelIdSlug],
  );

  // Flattened display chips for the selected plugins, mirroring the hook action
  // editor's "selected plugins below the control" pattern. Labels are derived
  // straight from the refs (no catalog lookup) so the list works offline; each
  // chip removes only its own entry.
  const pluginChips = useMemo(() => {
    const chips: {
      key: string;
      title: string;
      subtitle: string;
      remove: () => void;
    }[] = [];
    for (const id of pluginSelections.collectionIds) {
      chips.push({
        key: `collection:${id}`,
        title: id,
        subtitle: 'Collection',
        remove: (): void =>
          setPluginSelections((prev) => ({
            ...prev,
            collectionIds: prev.collectionIds.filter((x) => x !== id),
          })),
      });
    }
    for (const skill of pluginSelections.skillRefs) {
      chips.push({
        key: `skill:${skill.sourceId}/${skill.skillName}`,
        title: skill.skillName,
        subtitle: 'Skill',
        remove: (): void =>
          setPluginSelections((prev) => ({
            ...prev,
            skillRefs: prev.skillRefs.filter(
              (x) =>
                !(
                  x.sourceId === skill.sourceId &&
                  x.skillName === skill.skillName
                ),
            ),
          })),
      });
    }
    for (const plugin of pluginSelections.pluginRefs) {
      chips.push({
        key: `plugin:${plugin.marketplaceId}/${plugin.pluginName}`,
        title: plugin.pluginName,
        subtitle: 'Plugin',
        remove: (): void =>
          setPluginSelections((prev) => ({
            ...prev,
            pluginRefs: prev.pluginRefs.filter(
              (x) =>
                !(
                  x.marketplaceId === plugin.marketplaceId &&
                  x.pluginName === plugin.pluginName
                ),
            ),
          })),
      });
    }
    for (const mcp of pluginSelections.mcpServerRefs ?? []) {
      chips.push({
        key: `mcp:${mcp.serverId}/${mcp.configId}`,
        title: mcp.serverId,
        subtitle: 'MCP server',
        remove: (): void =>
          setPluginSelections((prev) => ({
            ...prev,
            mcpServerRefs: (prev.mcpServerRefs ?? []).filter(
              (x) =>
                !(x.serverId === mcp.serverId && x.configId === mcp.configId),
            ),
          })),
      });
    }
    for (const preference of pluginSelections.mcpHttpAuthPreferences ?? []) {
      const title =
        preference.target.kind === 'standalone'
          ? preference.target.serverId
          : `${preference.target.pluginName}/${preference.target.serverName}`;
      chips.push({
        key:
          preference.target.kind === 'standalone'
            ? `auth:${preference.target.serverId}/${preference.target.configId}`
            : `auth:${preference.target.marketplaceId}/${preference.target.pluginName}/${preference.target.serverName}`,
        title,
        subtitle: `MCP auth: ${preference.handler}`,
        remove: (): void =>
          setPluginSelections((prev) => ({
            ...prev,
            mcpHttpAuthPreferences: (prev.mcpHttpAuthPreferences ?? []).filter(
              (x) => x !== preference,
            ),
          })),
      });
    }
    return chips;
  }, [pluginSelections]);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      next.name = NAME_REQUIRED;
    } else {
      const clash = existingAgents.some(
        (candidate) =>
          candidate.id !== agent?.id &&
          candidate.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (clash) {
        next.name = NAME_DUPLICATE;
      }
    }

    if (!isEdit) {
      if (modelIdSlug.length === 0) {
        next.modelIdSlug = MODEL_ID_REQUIRED;
      } else if (!isValidAgentModelSlug(modelIdSlug)) {
        next.modelIdSlug = MODEL_ID_INVALID;
      } else {
        const candidateId = agentModelIdFromSlug(modelIdSlug);
        const clash = existingAgents.some(
          (candidate) => candidate.id === candidateId,
        );
        if (clash) {
          next.modelIdSlug = MODEL_ID_DUPLICATE;
        }
      }
    }

    if (baseModel.length === 0) {
      next.baseModel = BASE_MODEL_REQUIRED;
    } else if (isAgentModel(baseModel)) {
      next.baseModel = BASE_MODEL_IS_AGENT;
    }

    if (byteLength(instructions) > MAX_SHARED_AGENT_INSTRUCTIONS_BYTES) {
      next.instructions = INSTRUCTIONS_TOO_LONG;
    }
    return next;
  }

  function handleNameChange(nextName: string): void {
    setName(nextName);
    if (!isEdit && !modelIdManuallyEdited) {
      setModelIdSlug(deriveAgentModelSlug(nextName));
    }
  }

  function handleModelIdSlugChange(nextSlug: string): void {
    setModelIdManuallyEdited(true);
    setModelIdSlug(normalizeEditableSlug(nextSlug));
  }

  function handleBaseModelChange(nextModel: string): void {
    const previousProvider = baseModel ? getProviderForModel(baseModel) : null;
    const nextProvider = nextModel ? getProviderForModel(nextModel) : null;
    setBaseModel(nextModel);
    // The default model's provider is unknown until a chat starts, so plugins
    // are kept and judged against the resolved route at run time.
    if (previousProvider && nextProvider && previousProvider !== nextProvider) {
      setPluginSelections(createEmptySelections());
    }
  }

  async function handleSubmit(): Promise<void> {
    const validation = validate();
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const request: SaveAgentModelRequest = {
        ...(agent ? { id: agent.id } : {}),
        name: name.trim(),
        ...(agent ? {} : { modelIdSlug }),
        baseModel,
        instructions,
        pluginSelections,
      };
      await onSave(request);
      onClose();
    } catch (err: unknown) {
      setSubmitting(false);
      const appError = toAppError(resolveClientAppError(err));
      if (!appError) return;
      // The dialog stays open with the entered values.
      setSubmitError(
        inlineFailure(
          appError,
          isEdit ? 'Couldn’t save this agent.' : 'Couldn’t create this agent.',
        ),
      );
    }
  }

  return (
    <DialogModal
      onClose={submitting ? (): void => {} : onClose}
      title={isEdit ? 'Edit agent' : 'New agent'}
      maxWidth="2xl"
      closeOnBackdrop={!submitting}
      dataTestId="agent-model-modal"
    >
      <div className="flex flex-col gap-4">
        {/* Name */}
        <FormField
          id={nameFieldId}
          label="Name"
          description="Shown in model pickers. The model ID is created when the agent is first saved."
          error={errors.name}
          dataTestId="agent-model-name-field"
        >
          {(control) => (
            <TextInput
              {...control}
              type="text"
              value={name}
              disabled={submitting}
              onChange={(e): void => handleNameChange(e.target.value)}
              data-testid="agent-model-name"
            />
          )}
        </FormField>

        {/* Model ID */}
        <FormField
          id={modelIdFieldId}
          label="Model ID"
          description={
            isEdit
              ? 'Model IDs cannot be changed after an agent is created.'
              : 'Used in workflows and model pickers. It must be unique and can only contain lowercase letters, numbers, and underscores.'
          }
          error={errors.modelIdSlug}
          dataTestId="agent-model-id-field"
        >
          {(control) =>
            isEdit ? (
              <TextInput
                {...control}
                type="text"
                mono
                readOnly
                value={modelId}
                data-testid="agent-model-id"
              />
            ) : (
              <TextInput
                {...control}
                type="text"
                mono
                leading={AGENT_MODEL_PREFIX}
                value={modelIdSlug}
                disabled={submitting}
                onChange={(e): void => handleModelIdSlugChange(e.target.value)}
                data-testid="agent-model-id"
              />
            )
          }
        </FormField>

        {/* Default model */}
        <Fieldset
          gap="control"
          legend={<span className={FORM_FIELD_LABEL_CLASS}>Default model</span>}
        >
          <div className="flex flex-col gap-2.5">
            <ChoiceList kind="radio" aria-label="Default model">
              <ChoiceListRow
                kind="radio"
                selected={inheritsDefaultModel}
                disabled={submitting}
                onClick={(): void => {
                  // A radio row: pressing the selected row changes nothing.
                  if (!inheritsDefaultModel) {
                    handleBaseModelChange(AGENT_DEFAULT_BASE_MODEL);
                  }
                }}
                data-testid="agent-model-base-default"
              >
                <span className="block">Use chat default</span>
                <span className="block text-xs fg-secondary">
                  Each chat uses its default model from Settings when it starts.
                </span>
              </ChoiceListRow>
              <ChoiceListRow
                kind="radio"
                selected={!inheritsDefaultModel}
                disabled={submitting}
                onClick={(): void => {
                  if (inheritsDefaultModel) handleBaseModelChange('');
                }}
                data-testid="agent-model-base-specific"
              >
                Specific model
              </ChoiceListRow>
            </ChoiceList>
            {/*
            Only real provider base models are offered. The Agents group is
            hidden (`hideAgents`) because a custom Agent cannot use another
            Agent as its base (isBaseModelSelectableForAgent / the validator
            enforce this).
          */}
            {!inheritsDefaultModel && (
              <div className="flex flex-col gap-1.5">
                <Surface
                  variant="inset"
                  className="inline-flex self-start"
                  data-testid="agent-model-base-model"
                >
                  <div className="inline-flex px-2 py-1">
                    <ModelPicker
                      currentModel={baseModel}
                      disabled={submitting}
                      hideAgents
                      browserLayout="harnesses"
                      allowCursor
                      allowOpenCode
                      allowCopilot
                      placeholderLabel="Select a default model…"
                      onModelChange={handleBaseModelChange}
                      triggerTooltip="Default model for this agent"
                    />
                  </div>
                </Surface>
                <p className={FORM_FIELD_DESCRIPTION_CLASS}>
                  Choose a default model, including Cursor. Each chat can choose
                  a different model for this agent.
                </p>
              </div>
            )}
          </div>
          {errors.baseModel && (
            <FieldError
              id={`${baseModelErrorId}-error`}
              data-testid="agent-model-base-model-error"
            >
              {errors.baseModel}
            </FieldError>
          )}
        </Fieldset>

        {/* Instructions */}
        <FormField
          id={instructionsFieldId}
          label="Instructions"
          error={errors.instructions}
          dataTestId="agent-model-instructions-field"
        >
          {(control) => (
            <TextArea
              {...control}
              value={instructions}
              disabled={submitting}
              rows={5}
              onChange={(e): void => setInstructions(e.target.value)}
              placeholder="Add instructions that should be appended to the system prompt whenever this agent is used."
              data-testid="agent-model-instructions"
            />
          )}
        </FormField>

        {/* Plugins */}
        <Stack gap="inline">
          <Stack gap="tight">
            <span className={`block ${FORM_FIELD_LABEL_CLASS}`}>Plugins</span>
            <p className="text-xs fg-secondary">
              These plugins are enabled automatically in addition to the chat or
              workflow selections.
            </p>
          </Stack>
          <Button
            size="compact"
            disabled={submitting}
            onClick={(): void => setPluginsModalOpen(true)}
            data-testid="agent-model-plugins"
            className="self-start"
            aria-label="Plugins"
          >
            <PluginsIcon size="sm" />
            <span>Plugins</span>
          </Button>

          {pluginChips.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {pluginChips.map((chip) => (
                <Tooltip
                  key={chip.key}
                  label={`${chip.title} — ${chip.subtitle}`}
                  className="max-w-full"
                >
                  <Chip
                    onRemove={chip.remove}
                    removeLabel={`Remove ${chip.title}`}
                    disabled={submitting}
                  >
                    <span className="font-medium">{chip.title}</span>{' '}
                    <span className="fg-secondary">{chip.subtitle}</span>
                  </Chip>
                </Tooltip>
              ))}
            </div>
          ) : (
            <p className="text-2xs fg-secondary">
              No plugins added. This agent uses only the chat or workflow plugin
              selections.
            </p>
          )}
        </Stack>

        <DesktopErrorBanner
          errorSource="agent-model-modal-submit"
          error={submitError?.error}
          {...(submitError?.details === undefined
            ? {}
            : { details: submitError.details })}
          className=""
        />

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <Button size="compact" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={(): void => {
              void handleSubmit();
            }}
            disabled={submitting}
            data-testid="agent-model-submit"
          >
            {isEdit ? 'Save changes' : 'Create agent'}
          </Button>
        </div>
      </div>

      {pluginsModalOpen && (
        <ChatPluginsModal
          initial={pluginSelections}
          onSave={(selections): void => {
            setPluginSelections(selections);
            setPluginsModalOpen(false);
          }}
          onClose={(): void => setPluginsModalOpen(false)}
          effectiveProviderType={baseProvider}
        />
      )}
    </DialogModal>
  );
}
