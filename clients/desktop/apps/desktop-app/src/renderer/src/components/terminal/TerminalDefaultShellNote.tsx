import type { JSX } from 'react';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { brandText } from '@/lib/brand';

/** Why a shell is marked Default. */
export const TERMINAL_DEFAULT_SHELL_TOOLTIP = `This shell will be used for interactive scripts invoked by ${brandText.appName}.`;

/**
 * The shared neutral "Default" `Badge` beside the default shell, in the
 * settings row and the add-tab menu, named "Default shell" for assistive tech.
 * `focusable` lets the keyboard reach a tooltip the caller wraps it in.
 */
export function TerminalDefaultShellNote({
  testId,
  focusable = false,
}: {
  testId: string;
  focusable?: boolean;
}): JSX.Element {
  return (
    <span
      role="note"
      aria-label="Default shell"
      tabIndex={focusable ? 0 : undefined}
      data-testid={testId}
      className={`inline-flex shrink-0${focusable ? ' focus-ring' : ''}`}
    >
      <Badge>Default</Badge>
    </span>
  );
}
