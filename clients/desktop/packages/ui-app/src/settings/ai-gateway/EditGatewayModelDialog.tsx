'use client';

import { useState, type JSX } from 'react';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  DialogModal,
  ErrorBanner,
  FormField,
  SettingsSelect,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  AI_GATEWAY_THINKING_LEVELS,
  type AiGatewayThinkingLevel,
  type ModelGatewayModel,
} from '@canopy/protocol';
import type { SettingsFailure } from '../errors';
import { SELECTABLE_THINKING_LEVELS } from './gateway-model-list';

export interface EditGatewayModelDialogProps {
  readonly model: ModelGatewayModel;
  readonly busy: boolean;
  readonly error: SettingsFailure | null;
  readonly onClose: () => void;
  readonly onSave: (model: ModelGatewayModel) => Promise<void>;
}

/** How one model runs. Its ID, gateway ID and name stay as they are. */
export function EditGatewayModelDialog({
  model,
  busy,
  error,
  onClose,
  onSave,
}: EditGatewayModelDialogProps): JSX.Element {
  const [harness, setHarness] = useState(model.harness);
  const [contextWindow, setContextWindow] = useState(
    String(model.contextWindow),
  );
  const [thinking, setThinking] = useState<ReadonlySet<AiGatewayThinkingLevel>>(
    new Set(model.supportedThinkingLevels),
  );
  const [flatSchema, setFlatSchema] = useState(
    model.toolSchemaProfile === 'flat',
  );
  const parsedContext = Number.parseInt(contextWindow, 10);
  const valid =
    Number.isSafeInteger(parsedContext) &&
    parsedContext > 0 &&
    String(parsedContext) === contextWindow.trim();

  return (
    <DialogModal
      title="Edit model"
      subtitle={model.label}
      maxWidth="sm"
      dataTestId="ai-gateway-edit-model-dialog"
      closeOnBackdrop={!busy}
      closeButtonDisabled={busy}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="edit-gateway-model-dialog"
          error={error?.copy}
          details={error?.details}
        />
        <FormField label="Harness">
          {(control) => (
            <SettingsSelect
              {...control}
              value={harness}
              disabled={busy}
              data-testid="ai-gateway-edit-harness"
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
              data-testid="ai-gateway-edit-context-window"
              onChange={(event) => setContextWindow(event.target.value)}
            />
          )}
        </FormField>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium fg-primary">Thinking levels</p>
          <ChoiceList aria-label="Thinking levels">
            {SELECTABLE_THINKING_LEVELS.map((level) => (
              <ChoiceListRow
                key={level}
                selected={thinking.has(level)}
                disabled={busy}
                data-testid={`ai-gateway-edit-thinking-${level}`}
                onClick={() =>
                  setThinking((previous) => {
                    const next = new Set(previous);
                    if (next.has(level)) next.delete(level);
                    else next.add(level);
                    return next;
                  })
                }
              >
                {level}
              </ChoiceListRow>
            ))}
          </ChoiceList>
        </div>
        <ChoiceList aria-label="Tool schemas">
          <ChoiceListRow
            selected={flatSchema}
            disabled={busy}
            data-testid="ai-gateway-edit-flat-schema"
            onClick={() => setFlatSchema((previous) => !previous)}
          >
            Flat tool schema
          </ChoiceListRow>
        </ChoiceList>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            size="compact"
            disabled={busy || !valid}
            data-testid="ai-gateway-edit-save"
            onClick={() =>
              void onSave({
                ...model,
                harness,
                contextWindow: parsedContext,
                // Canonical ascending order, whatever the click order; a
                // level outside the selectable set (`low`) is kept as stored.
                supportedThinkingLevels: AI_GATEWAY_THINKING_LEVELS.filter(
                  (level) =>
                    SELECTABLE_THINKING_LEVELS.includes(level)
                      ? thinking.has(level)
                      : model.supportedThinkingLevels.includes(level),
                ),
                toolSchemaProfile: flatSchema ? 'flat' : 'standard',
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
