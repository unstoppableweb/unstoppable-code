import type { JSX } from 'react';
import { ActionTooltip } from './ActionTooltip';
import { ToggleSwitch } from './ToggleSwitch';

export interface DeferredPluginsControlProps {
  allowed: boolean;
  disabled?: boolean;
  onChange: (allowed: boolean) => void;
}

/** One policy control for chats that support deferred capability loading. */
export function DeferredPluginsControl({
  allowed,
  disabled = false,
  onChange,
}: DeferredPluginsControlProps): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ActionTooltip
        title="Deferred plugins"
        description={
          allowed
            ? 'Allow this chat to discover and enable missing skills, plugins, and MCP servers.'
            : 'Prevent this chat from discovering or enabling deferred skills, plugins, and MCP servers.'
        }
      >
        <ToggleSwitch
          size="sm"
          checked={allowed}
          disabled={disabled}
          label="Allow deferred plugins for this chat"
          onChange={onChange}
          dataTestId="chat-plugins-deferred-tools-toggle"
        />
      </ActionTooltip>
      <span
        className="truncate text-2xs fg-secondary"
        data-testid="chat-plugins-deferred-tools-state"
      >
        {allowed ? 'Deferred plugins allowed' : 'Deferred plugins not allowed'}
      </span>
    </div>
  );
}
