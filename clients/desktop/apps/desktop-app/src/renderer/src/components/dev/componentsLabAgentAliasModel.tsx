import { useState, type JSX } from 'react';
import {
  AgentAliasModelFields,
  SettingsSelect,
  type AgentAliasModelValue,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const AGENTS = [
  { id: 'agent_model_reviewer', name: 'Reviewer' },
  { id: 'agent_model_coder', name: 'Coder' },
];
const MODELS = [
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'gpt-5', label: 'GPT-5' },
];

function LiveAgentAliasFields({
  initialValue,
  noAgents = false,
  disabled = false,
}: {
  readonly initialValue: AgentAliasModelValue;
  readonly noAgents?: boolean;
  readonly disabled?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="w-full">
      <AgentAliasModelFields
        value={value}
        agents={noAgents ? [] : AGENTS}
        onChange={setValue}
        disabled={disabled}
        agentError={
          value.agent_id === 'agent_model_missing'
            ? "Saved agent can't be used. Select an agent."
            : undefined
        }
        modelError={
          value.base === 'missing-model'
            ? "Saved model can't be used. Choose a model or use the agent's model."
            : undefined
        }
        renderModelPicker={({ onChange, placeholderLabel, ...control }) => (
          <SettingsSelect
            {...control}
            onValueChange={onChange}
            options={MODELS}
            placeholder={placeholderLabel}
          />
        )}
      />
    </div>
  );
}

export function AgentAliasModelSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="AgentAliasModelFields">
      <SpecimenGrid min={400}>
        <SpecimenCell label="No agent selected">
          <LiveAgentAliasFields initialValue={{ agent_id: '' }} />
        </SpecimenCell>
        <SpecimenCell label="Agent selected: inherits the agent's model">
          <LiveAgentAliasFields
            initialValue={{ agent_id: 'agent_model_reviewer' }}
          />
        </SpecimenCell>
        <SpecimenCell label="Chosen model: clear with Use agent's model">
          <LiveAgentAliasFields
            initialValue={{
              agent_id: 'agent_model_reviewer',
              base: 'gpt-5',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="Embedded agent@model route">
          <LiveAgentAliasFields
            initialValue={{ agent_id: 'agent_model_reviewer@gpt-5' }}
          />
        </SpecimenCell>
        <SpecimenCell label="Invalid saved model: error belongs to Model">
          <LiveAgentAliasFields
            initialValue={{
              agent_id: 'agent_model_reviewer',
              base: 'missing-model',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="Agent error">
          <LiveAgentAliasFields
            initialValue={{ agent_id: 'agent_model_missing' }}
          />
        </SpecimenCell>
        <SpecimenCell label="No local agents: Agent selection disabled">
          <LiveAgentAliasFields initialValue={{ agent_id: '' }} noAgents />
        </SpecimenCell>
        <SpecimenCell label="Read-only: inherited model">
          <LiveAgentAliasFields
            initialValue={{ agent_id: 'agent_model_reviewer' }}
            disabled
          />
        </SpecimenCell>
        <SpecimenCell label="Read-only: chosen model and clear action disabled">
          <LiveAgentAliasFields
            initialValue={{
              agent_id: 'agent_model_reviewer',
              base: 'gpt-5',
            }}
            disabled
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
