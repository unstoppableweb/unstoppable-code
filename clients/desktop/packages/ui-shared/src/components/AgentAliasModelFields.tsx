'use client';

import type { JSX, ReactNode } from 'react';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { FormField, type FormFieldControlProps } from './FormField';
import { SettingsSelect } from './SettingsSelect';
import { Stack } from './Stack';
import { Button } from './Button';

export interface AgentAliasModelValue {
  agent_id: string;
  base?: string;
}

interface AgentAliasModelFieldsProps {
  value: AgentAliasModelValue;
  agents: readonly { id: string; name: string }[];
  onChange: (value: AgentAliasModelValue) => void;
  renderModelPicker: (
    props: FormFieldControlProps & {
      value: string;
      onChange: (model: string) => void;
      disabled: boolean;
      placeholderLabel: string;
    },
  ) => ReactNode;
  disabled?: boolean;
  agentError?: string;
  modelError?: string;
}

/** Host supplies catalog data and the concrete-model picker; no Agent store authority here. */
export function AgentAliasModelFields({
  value,
  agents,
  onChange,
  renderModelPicker,
  disabled = false,
  agentError,
  modelError,
}: AgentAliasModelFieldsProps): JSX.Element {
  const embedded = parseAgentRouteModelId(value.agent_id);
  const agentId = embedded?.agentId ?? value.agent_id;
  const base = value.base ?? embedded?.baseModel;
  return (
    <Stack gap="item">
      <FormField
        label="Agent"
        description="Uses the agent's instructions and plugins."
        error={agentError}
      >
        {(control) => (
          <SettingsSelect
            {...control}
            value={agentId}
            onValueChange={(next) =>
              onChange({
                agent_id: next,
                ...(base !== undefined ? { base } : {}),
              })
            }
            options={agents.map((agent) => ({
              value: agent.id,
              label: `${agent.name} (${agent.id})`,
            }))}
            placeholder={
              agents.length === 0
                ? 'No local agents available'
                : 'Select an agent'
            }
            disabled={disabled || agents.length === 0}
          />
        )}
      </FormField>
      <FormField
        label="Model (optional)"
        error={modelError}
        description={base === undefined ? "Uses the agent's model." : undefined}
        trailingAction={
          base !== undefined ? (
            <Button
              variant="ghost"
              size="compact"
              disabled={disabled}
              onClick={() => onChange({ agent_id: agentId })}
            >
              Use agent's model
            </Button>
          ) : undefined
        }
      >
        {(control) =>
          renderModelPicker({
            ...control,
            value: modelError && base !== undefined ? '' : (base ?? ''),
            placeholderLabel:
              modelError && base !== undefined
                ? "Saved model can't be used"
                : "Use agent's model",
            onChange: (model) => onChange({ agent_id: agentId, base: model }),
            disabled,
          })
        }
      </FormField>
    </Stack>
  );
}
