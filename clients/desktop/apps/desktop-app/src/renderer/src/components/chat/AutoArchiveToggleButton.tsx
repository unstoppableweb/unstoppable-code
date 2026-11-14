import type { JSX } from 'react';
import {
  Button,
  CLEAN_ICON_BUTTON_VARIANT,
  Tooltip,
} from '@canopy/ui-shared/components';
import { ArchiveIcon } from '@canopy/ui-shared/icons';
import {
  selectChatHasLiveDelegates,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';

export interface AutoArchiveToggleButtonProps {
  enabled: boolean;
  onToggle: () => void;
  /**
   * The chat the toggle belongs to. While it has live managed delegates or
   * provider background agents/workflows, the tooltip says archiving waits.
   */
  target?: { projectId: string; worktreeId: string; chatId: string };
}

export function AutoArchiveToggleButton({
  enabled,
  onToggle,
  target,
}: AutoArchiveToggleButtonProps): JSX.Element {
  const hasLiveDelegates = useDelegationActivityStore((state) =>
    target === undefined
      ? false
      : selectChatHasLiveDelegates(
          state,
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
  );

  return (
    <Tooltip
      label={
        enabled
          ? hasLiveDelegates
            ? 'Archives after this turn and its delegates finish'
            : 'Archives after this turn'
          : 'Auto-archive is off'
      }
    >
      <Button
        variant={enabled ? 'ghost-accent' : CLEAN_ICON_BUTTON_VARIANT}
        size="sm"
        iconOnly
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={
          enabled
            ? 'Disable auto-archive for this turn'
            : 'Enable auto-archive for this turn'
        }
        data-testid="auto-archive-toggle"
        data-delegates-live={hasLiveDelegates ? 'true' : undefined}
      >
        <ArchiveIcon aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
