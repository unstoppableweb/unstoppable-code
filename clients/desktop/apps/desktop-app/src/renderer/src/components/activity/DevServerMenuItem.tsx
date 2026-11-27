import type { JSX, ReactNode } from 'react';
import { MenuItem, MenuItemIcon } from '@canopy/ui-shared';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import {
  getDevServerMenuItemText,
  openDevServerHit,
  type DevServerOpenContext,
} from './devServerOpen';
import { HoverCard } from '@canopy/ui-shared/components';

interface DevServerMenuItemProps {
  hit: DevServerHit;
  context: DevServerOpenContext;
  /**
   * The row's leading icon. Every URL row opens a dev server, so only the
   * first row of a group shows it; the rest pass `null` and keep the empty
   * slot so the labels stay aligned.
   */
  icon: ReactNode;
  onSelect: () => void;
}

export function DevServerMenuItem({
  hit,
  context,
  icon,
  onSelect,
}: DevServerMenuItemProps): JSX.Element {
  return (
    <HoverCard
      content={hit.url}
      triggerWrapperClassName="w-full"
      surfaceClassName="w-max max-w-96"
      surfacePadding="compact"
    >
      <MenuItem
        onClick={(): void => {
          openDevServerHit(hit, context);
          onSelect();
        }}
      >
        <MenuItemIcon>{icon}</MenuItemIcon>
        <span className="min-w-0 truncate">
          {getDevServerMenuItemText(hit)}
        </span>
      </MenuItem>
    </HoverCard>
  );
}
