import { Stack } from './Stack';
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
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
  const listRef = useRef<HTMLDivElement>(null);
  const removed = useRef<{ id: string; index: number } | null>(null);
  // A removed row drops focus to the body; move it to the next row's action.
  useEffect(() => {
    const pending = removed.current;
    if (pending === null || items.some((item) => item.id === pending.id))
      return;
    removed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const actions = listRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-activity-item-row] button:not(:disabled)',
    );
    if (!actions || actions.length === 0) return;
    actions[Math.min(Math.max(pending.index, 0), actions.length - 1)].focus();
  }, [items]);
  return (
    <Stack data-testid="chat-plugins-activity" gap="item">
      <div ref={listRef} className="flex flex-col gap-1.5">
        {items.map((item, index) => (
          <ActivityItemRow
            key={item.id}
            label={item.name}
            labelTitle={item.name}
            secondaryContent={
              <span
                className="block truncate text-xs fg-tertiary"
                title={item.source}
              >
                {item.source}
              </span>
            }
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
              onClick={() => {
                removed.current = { id: item.id, index };
                onDisable(item.id);
              }}
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
