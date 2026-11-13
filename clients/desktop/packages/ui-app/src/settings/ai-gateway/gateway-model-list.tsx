'use client';

import { useId, useState, type JSX } from 'react';
import { useSettingsPrivacy } from '../host';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  FieldError,
  FormField,
  SettingsSelect,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  AI_GATEWAY_THINKING_LEVELS,
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  type AiGatewayThinkingLevel,
  type ModelGatewayModel,
} from '@canopy/protocol';

/** Levels an admin can tick for a model, in the canonical ascending order. */
export const SELECTABLE_THINKING_LEVELS: readonly AiGatewayThinkingLevel[] =
  AI_GATEWAY_THINKING_LEVELS.filter((level) => level !== 'low');

export const DEFAULT_GATEWAY_CONTEXT_WINDOW = 200_000;

/** The label part of a gateway model's selection key. */
export function gatewayModelSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A gateway model's selection key: the owning organization's namespace keeps
 * an ordinary label from colliding with a shipped model ID.
 */
export function gatewayModelId(ownerId: string, slug: string): string {
  return `${ownerId}-${slug}`.slice(0, MODEL_GATEWAY_MAX_ID_LENGTH);
}

export interface GatewayModelListProps {
  models: readonly ModelGatewayModel[];
  busy: boolean;
  canRemove: boolean;
  onRemove: (id: string) => void;
  /** Adds an Edit action beside Remove. */
  onEdit?: (model: ModelGatewayModel) => void;
}

export function GatewayModelList({
  models,
  busy,
  canRemove,
  onRemove,
  onEdit,
}: GatewayModelListProps): JSX.Element {
  const { maskClassName } = useSettingsPrivacy();
  return (
    <ul className="divide-y" data-testid="model-gateway-model-list">
      {models.map((model) => (
        <li
          key={model.id}
          className="flex items-start justify-between gap-4 px-4 py-3"
          data-testid={`model-gateway-row-${model.id}`}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="min-w-0">
              <p
                className={`truncate text-s font-medium fg-primary ${maskClassName}`}
              >
                {model.label}
              </p>
              <p
                className={`mt-0.5 truncate text-xs font-mono fg-secondary ${maskClassName}`}
              >
                {model.gatewayId}
              </p>
            </div>
            <p className="text-xs fg-secondary/80">
              {[
                model.harness === 'claude' ? 'Claude harness' : 'Codex harness',
                `${model.contextWindow.toLocaleString()} tokens`,
                ...(model.supportedThinkingLevels.length > 0
                  ? [model.supportedThinkingLevels.join(', ')]
                  : []),
              ].join(' · ')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onEdit ? (
              <Button
                type="button"
                variant="secondary"
                size="compact"
                disabled={busy}
                data-testid={`model-gateway-edit-${model.id}`}
                onClick={() => onEdit(model)}
              >
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={busy || !canRemove}
              data-testid={`model-gateway-remove-${model.id}`}
              onClick={() => onRemove(model.id)}
            >
              Remove
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface AddGatewayModelFormProps {
  busy: boolean;
  /** Every row the new model must not duplicate, on or off. */
  existing: readonly ModelGatewayModel[];
  /**
   * The gateway already has as many enabled models as it can hold. Defaults
   * to `existing` reaching the limit, for a caller whose rows are all saved.
   */
  atCapacity?: boolean;
  /** Prefills the gateway ID: a search that found nothing. */
  initialGatewayId?: string;
  organizationId: string;
  onAdd: (model: ModelGatewayModel) => void;
  onCancel: () => void;
}

/**
 * The authoring form for one row.
 *
 * `id` is derived from the organization and label rather than asked for: it is
 * an internal selection key, and the organization namespace keeps an ordinary
 * label from colliding with a shipped model id in the merged desktop catalog.
 */
export function AddGatewayModelForm({
  busy,
  existing,
  atCapacity = existing.length >= MODEL_GATEWAY_MAX_MODELS,
  initialGatewayId = '',
  organizationId,
  onAdd,
  onCancel,
}: AddGatewayModelFormProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [gatewayId, setGatewayId] = useState(initialGatewayId);
  const [harness, setHarness] = useState<ModelGatewayModel['harness']>('codex');
  const [contextWindow, setContextWindow] = useState(
    String(DEFAULT_GATEWAY_CONTEXT_WINDOW),
  );
  const [thinking, setThinking] = useState<ReadonlySet<AiGatewayThinkingLevel>>(
    new Set(),
  );
  const [flatSchema, setFlatSchema] = useState(false);

  const trimmedLabel = label.trim();
  const trimmedGatewayId = gatewayId.trim();
  const parsedContext = Number.parseInt(contextWindow, 10);
  const slug = gatewayModelSlug(trimmedLabel);
  const modelId = gatewayModelId(organizationId, slug);
  const duplicateLabel = existing.some(
    (model) => model.label.toLowerCase() === trimmedLabel.toLowerCase(),
  );
  const duplicateId = existing.some((model) => model.id === modelId);
  const duplicateNoticeId = useId();
  const valid =
    trimmedLabel.length > 0 &&
    trimmedLabel.length <= MODEL_GATEWAY_MAX_LABEL_LENGTH &&
    trimmedGatewayId.length > 0 &&
    trimmedGatewayId.length <= MODEL_GATEWAY_MAX_ID_LENGTH &&
    !atCapacity &&
    slug.length > 0 &&
    Number.isSafeInteger(parsedContext) &&
    String(parsedContext) === contextWindow.trim() &&
    parsedContext > 0 &&
    !duplicateLabel &&
    !duplicateId;

  const submit = (): void => {
    if (!valid) return;
    onAdd({
      id: modelId,
      gatewayId: trimmedGatewayId,
      label: trimmedLabel,
      harness,
      contextWindow: parsedContext,
      // Emitted in canonical ascending order regardless of click order —
      // desktop rejects a set that is not ascending.
      supportedThinkingLevels: SELECTABLE_THINKING_LEVELS.filter((level) =>
        thinking.has(level),
      ),
      toolSchemaProfile: flatSchema ? 'flat' : 'standard',
    });
    setLabel('');
    setGatewayId('');
    setThinking(new Set());
  };

  return (
    <div
      className="flex flex-col gap-4 p-4"
      data-testid="model-gateway-add-model"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-s font-medium fg-primary">Add a model</p>
          <p className="text-xs fg-secondary">
            Use a name your members will recognize. Names have to be unique,
            because that&apos;s all the composer shows.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Name">
            {(control) => (
              <TextInput
                {...control}
                density="settings"
                type="text"
                value={label}
                maxLength={MODEL_GATEWAY_MAX_LABEL_LENGTH}
                disabled={busy}
                placeholder="Acme Qwen3 Coder"
                data-testid="model-gateway-add-label"
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Gateway model ID">
            {(control) => (
              <TextInput
                {...control}
                density="settings"
                mono
                type="text"
                value={gatewayId}
                maxLength={MODEL_GATEWAY_MAX_ID_LENGTH}
                disabled={busy}
                placeholder="vertex/qwen3-coder"
                data-testid="model-gateway-add-gateway-id"
                onChange={(event) => setGatewayId(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Harness">
            {(control) => (
              <SettingsSelect
                {...control}
                value={harness}
                disabled={busy}
                data-testid="model-gateway-add-harness"
                onValueChange={(value) =>
                  setHarness(value === 'claude' ? 'claude' : 'codex')
                }
                width="fill"
                options={[
                  { value: 'codex', label: 'Codex' },
                  { value: 'claude', label: 'Claude' },
                ]}
              />
            )}
          </FormField>
          <FormField label="Context window">
            {(control) => (
              <TextInput
                {...control}
                density="settings"
                type="number"
                min={1}
                value={contextWindow}
                disabled={busy}
                data-testid="model-gateway-add-context-window"
                onChange={(event) => setContextWindow(event.target.value)}
              />
            )}
          </FormField>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium fg-primary">Thinking levels</p>
        <ChoiceList aria-label="Thinking levels">
          {SELECTABLE_THINKING_LEVELS.map((level) => (
            <ChoiceListRow
              key={level}
              selected={thinking.has(level)}
              disabled={busy}
              data-testid={`model-gateway-add-thinking-${level}`}
              onClick={() =>
                setThinking((prev) => {
                  const next = new Set(prev);
                  if (next.has(level)) {
                    next.delete(level);
                  } else {
                    next.add(level);
                  }
                  return next;
                })
              }
            >
              {level}
            </ChoiceListRow>
          ))}
        </ChoiceList>
      </div>

      <div className="flex flex-col gap-3">
        <ChoiceList aria-label="Tool schemas">
          <ChoiceListRow
            selected={flatSchema}
            disabled={busy}
            data-testid="model-gateway-add-flat-schema"
            onClick={() => setFlatSchema((prev) => !prev)}
          >
            Send simplified tool schemas. Try this if the model errors on tool
            calls.
          </ChoiceListRow>
        </ChoiceList>

        {duplicateLabel && trimmedLabel.length > 0 ? (
          <FieldError
            id={duplicateNoticeId}
            data-testid="model-gateway-add-duplicate"
          >
            You already have a model with this name. Pick another so members can
            tell them apart.
          </FieldError>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={busy}
          data-testid="model-gateway-add-cancel"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={busy || !valid}
          data-testid="model-gateway-add-submit"
          onClick={submit}
        >
          Add model
        </Button>
      </div>
    </div>
  );
}
