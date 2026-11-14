import { useEffect, useRef, useState, type JSX } from 'react';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import {
  AgentModelPicker,
  SettingsSelect,
  type AgentPickerOption,
} from '@canopy/ui-shared/components';
import { changeSelectedModel, selectedAgentId } from '@canopy/ui-shared/lib';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

interface LabAgentOption extends AgentPickerOption {
  readonly defaultModel?: string;
}

const AGENTS: readonly LabAgentOption[] = [
  {
    id: 'agent_model_reviewer',
    label: 'Reviewer',
    description: 'Reviews code changes',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    id: 'agent_model_coder',
    label: 'Coder',
    defaultModel: 'gpt-5',
  },
  {
    id: 'agent_model_unavailable',
    label: 'Unavailable agent',
    unavailableReason: 'Its default model is unavailable',
    defaultModel: undefined,
  },
  {
    id: 'agent_model_long_name',
    label: 'Reviewer with a long descriptive agent name',
    defaultModel: 'claude-sonnet-4-5',
  },
];
const MODELS = [
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'gpt-5', label: 'GPT-5' },
];

function LiveAgentModelPicker({
  initialSelection,
  agents = AGENTS,
  capsule = false,
  disabled = false,
  agentRoutesSupported = true,
  openOnMount = false,
}: {
  readonly initialSelection?: string;
  readonly agents?: readonly LabAgentOption[];
  readonly capsule?: boolean;
  readonly disabled?: boolean;
  readonly agentRoutesSupported?: boolean;
  readonly openOnMount?: boolean;
}): JSX.Element {
  const [selection, setSelection] = useState(initialSelection);
  const ref = useRef<HTMLDivElement>(null);
  const agentId = selectedAgentId(selection);
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const route = selection ? parseAgentRouteModelId(selection) : null;
  const effectiveModel =
    route?.baseModel ?? (agentId ? selectedAgent?.defaultModel : selection);

  // Open the real menu without adding a lab-only prop to the shared picker.
  useEffect(() => {
    if (openOnMount) {
      ref.current
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="chat-agent-picker"][aria-expanded="false"]',
        )
        ?.click();
    }
  }, [openOnMount]);

  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-2">
      <AgentModelPicker
        agentRoutesSupported={agentRoutesSupported}
        selection={selection}
        effectiveModel={effectiveModel}
        agents={agents}
        onAgentChange={setSelection}
        disabled={disabled}
        capsule={capsule}
      >
        <SettingsSelect
          aria-label="Model"
          options={MODELS}
          value={effectiveModel ?? null}
          placeholder="Choose model"
          width="fit"
          disabled={disabled}
          onValueChange={(model): void =>
            setSelection(
              changeSelectedModel(selectedAgent ? selection : undefined, model),
            )
          }
        />
      </AgentModelPicker>
      <code className="text-2xs fg-tertiary">
        {selection ?? 'No model selected'}
      </code>
    </div>
  );
}

export function AgentModelPickerSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {(['capsule', 'chip'] as const).map((variant) => (
        <SpecimenPanel key={variant} title={`AgentModelPicker: ${variant}`}>
          <SpecimenGrid min={340}>
            <SpecimenCell label="No agent selected">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="claude-sonnet-4-5"
              />
            </SpecimenCell>
            <SpecimenCell label="Bare agent: switching agents applies the new default">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_reviewer"
              />
            </SpecimenCell>
            <SpecimenCell label="Explicit model: switching agents keeps GPT-5">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_reviewer@gpt-5"
              />
            </SpecimenCell>
            <SpecimenCell label="Disabled: no agent selected">
              <LiveAgentModelPicker capsule={variant === 'capsule'} disabled />
            </SpecimenCell>
            <SpecimenCell label="Disabled: agent with explicit model">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_reviewer@gpt-5"
                disabled
              />
            </SpecimenCell>
            <SpecimenCell label="Unavailable agent: open to see the reason; choose a model before removing">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_unavailable"
              />
            </SpecimenCell>
            <SpecimenCell label="Missing saved agent: unavailable label and removal guard">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_reviewer"
                agents={[]}
              />
            </SpecimenCell>
            <SpecimenCell label="Empty agent catalog and no model selected">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                agents={[]}
              />
            </SpecimenCell>
            <SpecimenCell label="Long agent name: truncated trigger, full menu label">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="agent_model_long_name"
              />
            </SpecimenCell>
            <SpecimenCell label="Cloud capability: only the model control remains">
              <LiveAgentModelPicker
                capsule={variant === 'capsule'}
                initialSelection="gpt-5"
                agentRoutesSupported={false}
              />
            </SpecimenCell>
          </SpecimenGrid>
        </SpecimenPanel>
      ))}
      <SpecimenPanel title="Open agent menu">
        <SpecimenCell label="Open on mount: selected agent, No agent, descriptions and an unavailable row">
          <LiveAgentModelPicker
            initialSelection="agent_model_reviewer"
            capsule
            openOnMount
          />
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
