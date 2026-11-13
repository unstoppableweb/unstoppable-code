import type { JSX } from 'react';
import { Cloud } from '@canopy/ui-shared/icons/AppIcons';
import { Button, ListRowStatic } from '@canopy/ui-shared/components';

export interface SidebarOfflineRowProps {
  /** The section that is offline, for example `Cloud chats are offline`. */
  readonly label: string;
  /** Absent when the host reconnects on its own. */
  readonly onReconnect?: () => void;
  readonly 'data-testid'?: string;
  readonly reconnectTestId?: string;
}

/**
 * The one row a cloud sidebar section shows while its core is offline. The
 * section lists nothing else: an offline core never shows cached rows.
 */
export function SidebarOfflineRow({
  label,
  onReconnect,
  'data-testid': testId,
  reconnectTestId,
}: SidebarOfflineRowProps): JSX.Element {
  return (
    <ListRowStatic
      data-testid={testId}
      icon={<Cloud />}
      description={
        onReconnect && (
          <Button
            variant="link"
            onClick={onReconnect}
            data-testid={reconnectTestId}
          >
            Reconnect
          </Button>
        )
      }
    >
      {label}
    </ListRowStatic>
  );
}
