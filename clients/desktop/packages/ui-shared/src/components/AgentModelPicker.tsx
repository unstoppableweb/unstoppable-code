'use client';

import { useRef, useState, type JSX, type ReactNode } from 'react';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import {
  changeSelectedAgent,
  isConcreteSelectedModel,
  selectedAgentId,
} from '../lib/agent-model-selection';
import {
  FloatingPickerMenu,
  PickerMenuList,
  PickerTrigger,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
} from './PickerMenu';

export interface AgentPickerOption {
  id: string;
  label: string;
  unavailableReason?: string;
  description?: string;
}

export interface AgentModelPickerProps {
  /** Capability supplied by the host, never inferred from a model label. */
  agentRoutesSupported: boolean;
  selection: string | undefined;
  effectiveModel: string | undefined;
  agents: readonly AgentPickerOption[];
  onAgentChange: (selection: string | undefined) => void;
  disabled?: boolean;
  capsule?: boolean;
  children: ReactNode;
}

/** Hosts retain catalog, admission, recovery and commit authority. */
export function AgentModelPicker({
  agentRoutesSupported,
  selection,
  effectiveModel,
  agents,
  onAgentChange,
  disabled,
  capsule,
  children,
}: AgentModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const agentId = selectedAgentId(selection);
  const selected = agents.find((agent) => agent.id === agentId);
  const select = (next: string | undefined): void => {
    setOpen(false);
    onAgentChange(changeSelectedAgent(selection, next, effectiveModel));
  };
  if (!agentRoutesSupported) return <>{children}</>;
  const removalModel =
    (selection && parseAgentRouteModelId(selection)?.baseModel) ||
    effectiveModel;
  const removalUnavailable = Boolean(
    agentId && !isConcreteSelectedModel(removalModel),
  );
  return (
    <div className="flex min-w-0 items-center gap-1">
      <PickerTrigger
        ref={triggerRef}
        variant="capsule"
        size={capsule ? 'default' : 'compact'}
        textLead
        textTrail
        className="max-w-40"
        aria-label={selected?.label ? `${selected.label}, agent` : 'Agent'}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-testid="chat-agent-picker"
        onClick={(): void => setOpen(!open)}
      >
        <span className="truncate">
          {selected?.label ?? (agentId ? 'Unavailable agent' : 'Agent')}
        </span>
      </PickerTrigger>
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        aria-label="Agent"
        placement="top-left"
        interaction="menu"
      >
        <PickerMenuList role="presentation">
          <PickerMenuOption
            role="menuitemradio"
            aria-checked={!agentId}
            selected={!agentId}
            disabled={removalUnavailable}
            onClick={(): void => select(undefined)}
          >
            <div className="min-w-0 flex-1">
              <PickerMenuOptionLabel>No agent</PickerMenuOptionLabel>
              {removalUnavailable && (
                <PickerMenuOptionDescription>
                  Choose an available model first
                </PickerMenuOptionDescription>
              )}
            </div>
            <PickerMenuOptionCheck selected={!agentId} />
          </PickerMenuOption>
          {agents.map((agent) => (
            <PickerMenuOption
              key={agent.id}
              role="menuitemradio"
              aria-checked={agent.id === agentId}
              selected={agent.id === agentId}
              disabled={Boolean(agent.unavailableReason)}
              onClick={(): void => select(agent.id)}
            >
              <div className="min-w-0 flex-1">
                <PickerMenuOptionLabel>{agent.label}</PickerMenuOptionLabel>
                {(agent.unavailableReason || agent.description) && (
                  <PickerMenuOptionDescription>
                    {agent.unavailableReason || agent.description}
                  </PickerMenuOptionDescription>
                )}
              </div>
              <PickerMenuOptionCheck selected={agent.id === agentId} />
            </PickerMenuOption>
          ))}
        </PickerMenuList>
      </FloatingPickerMenu>
      {children}
    </div>
  );
}
