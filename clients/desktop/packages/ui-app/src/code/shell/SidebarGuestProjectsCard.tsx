import type { JSX } from 'react';
import { ButtonLink } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export interface SidebarGuestProjectsCardProps {
  /** Where the account action goes. The host builds it, return path included. */
  readonly signInHref: string;
  /**
   * Runs once as the visitor follows the action, before the browser
   * navigates. Hosts use it to keep unsent work across the sign-in.
   */
  readonly onActivate?: () => void;
  readonly testId?: string;
}

/**
 * What an empty Projects list offers a visitor with no account: one line on
 * what an account adds, and the way to get one.
 *
 * The action is a real anchor, so the browser keeps new-tab, middle-click and
 * copy-link. Nothing here knows who the visitor is or where it is hosted.
 */
export function SidebarGuestProjectsCard({
  signInHref,
  onActivate,
  testId = 'remote-control-sidebar-guest-projects-card',
}: SidebarGuestProjectsCardProps): JSX.Element {
  return (
    <div className="px-1 empty:hidden">
      <Surface variant="group" size="small" data-testid={testId}>
        <div className="flex flex-col items-start gap-2 px-3 py-2.5">
          <p className="text-s fg-secondary">
            Run agents on your own repos and keep every chat across your
            devices.
          </p>
          <ButtonLink
            href={signInHref}
            data-testid={`${testId}-action`}
            onClick={onActivate}
            onAuxClick={(event): void => {
              // Middle-click opens the link in a new tab; right-click only opens
              // the context menu and follows nothing.
              if (event.button === 1) onActivate?.();
            }}
            variant="secondary"
            size="sm"
            className="max-w-full"
          >
            Create a free account
          </ButtonLink>
        </div>
      </Surface>
    </div>
  );
}
