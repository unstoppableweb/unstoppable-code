'use client';

import { useState, type JSX } from 'react';
import { DisplayAvatar, MenuLabel } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { isDisplayableAvatarUrl } from './SidebarAccountFooter';

export interface SidebarAccountMenuHeaderProps {
  readonly name: string;
  readonly email: string;
  readonly image?: string | null;
}

/**
 * The personal account menu's identity header (CAN-4057): avatar, name, and
 * email of the signed-in person. A label, not a row, so it takes no focus.
 * Renders nothing when there is neither a name nor an email to show.
 */
export function SidebarAccountMenuHeader({
  name,
  email,
  image,
}: SidebarAccountMenuHeaderProps): JSX.Element | null {
  // The URL that failed to load, so a later, different URL still renders.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const shownName = name.trim();
  const shownEmail = email.trim();
  if (shownName === '' && shownEmail === '') return null;
  const showImage =
    !!image && failedImage !== image && isDisplayableAvatarUrl(image);
  return (
    <MenuLabel
      spacing="relaxed"
      data-testid="sidebar-account-menu-header-identity"
    >
      <span className="flex min-w-0 items-center gap-2">
        {/* The person as a 16px avatar, the size of a menu row's icon. */}
        <DisplayAvatar
          name={shownName || shownEmail}
          image={showImage ? image : null}
          size="xs"
          testId={
            showImage
              ? 'sidebar-person-avatar'
              : 'sidebar-person-avatar-initial'
          }
          onImageError={setFailedImage}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          {shownName !== '' ? (
            <span
              className={`${REPLAY_BLOCK_CLASS} truncate text-s font-medium fg-primary`}
              title={shownName}
            >
              {shownName}
            </span>
          ) : null}
          {shownEmail !== '' ? (
            <span
              className={`${REPLAY_BLOCK_CLASS} truncate text-xs fg-secondary`}
              title={shownEmail}
            >
              {shownEmail}
            </span>
          ) : null}
        </span>
      </span>
    </MenuLabel>
  );
}
