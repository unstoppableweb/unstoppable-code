import { Stack } from './Stack';
import type { JSX, ReactNode } from 'react';
import { McpServerLogo } from './McpServerLogo';
import { ActivityItemRow } from './ActivityItemRow';
import { ExecutionActionButton } from './ExecutionActionButton';
import { ErrorBanner } from './StatusBlocks';
export interface AddedPluginItem {
  id: string;
  name: string;
  source: string;
  locked?: boolean;
  installedDisabled?: boolean;
}
export function AddedPluginsList({
  items,
  disabled,
  error,
  onDisable,
  renderIcon,
}: {
  items: AddedPluginItem[];
  disabled?: boolean;
  error?: string | null;
  onDisable: (id: string) => void;
  renderIcon?: (item: AddedPluginItem) => ReactNode;
}): JSX.Element {
  return (
    <Stack data-testid="chat-plugins-activity" gap="item">
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <ActivityItemRow
            key={item.id}
            label={item.name}
            labelTitle={item.source}
            icon={
              renderIcon ? (
                renderIcon(item)
              ) : (
                <McpServerLogo
                  size={16}
                  fallback="monogram"
                  name={item.name}
                  fallbackTestId="activity-plugin-icon"
                />
              )
            }
          >
            {item.installedDisabled && (
              <span
                className="text-xs fg-tertiary"
                data-testid="chat-plugin-disabled"
              >
                Disabled
              </span>
            )}
            <ExecutionActionButton
              label={item.locked ? 'Required' : 'Remove'}
              disabled={disabled || item.locked}
              onClick={() => onDisable(item.id)}
              ariaLabel={
                item.locked
                  ? `${item.name} is required by the selected assistant`
                  : `Remove ${item.name} from this chat`
              }
              title={
                item.locked
                  ? 'Required by the selected assistant'
                  : 'Remove from this chat'
              }
            />
          </ActivityItemRow>
        ))}
      </div>
      <ErrorBanner
        errorSource="added-plugins-list"
        className=""
        error={error}
      />
    </Stack>
  );
}
