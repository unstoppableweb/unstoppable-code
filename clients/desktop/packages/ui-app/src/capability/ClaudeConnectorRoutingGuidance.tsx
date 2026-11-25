'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

export type ClaudeConnectorSettingsRoute = 'account-proxy' | 'ai-credits';

const ROUTE_COPY = {
  'account-proxy': {
    signIn:
      'Claude chats through the multi-account proxy use a different sign-in.',
    choice:
      'Turn off Use the account proxy in Multi-account proxy settings to stop using the proxy on this device.',
  },
  'ai-credits': {
    signIn: 'Claude chats on AI Credits use a different sign-in.',
    choice: 'Choose Wait to avoid switching to AI Credits automatically.',
  },
} satisfies Record<
  ClaudeConnectorSettingsRoute,
  { signIn: string; choice: string }
>;

export function ClaudeConnectorRoutingGuidance({
  appName,
  route,
  onManageConnections,
}: {
  appName: string;
  route?: ClaudeConnectorSettingsRoute;
  onManageConnections?: () => void;
}): JSX.Element {
  const copy = route ? ROUTE_COPY[route] : undefined;
  return (
    <Notice
      title="Claude account connectors"
      role="none"
      shape={route ? 'settings' : undefined}
      data-testid="claude-connector-routing-guidance"
      actions={
        onManageConnections ? (
          <NoticeButton
            data-testid="claude-connector-manage-connections"
            onClick={onManageConnections}
          >
            Manage connections
          </NoticeButton>
        ) : undefined
      }
    >
      {copy?.signIn ??
        'A connector linked to your Claude account may not be available in a chat.'}{' '}
      Claude Code turns off claude.ai connectors when it uses another sign-in.
      {copy ? ` ${copy.choice}` : null}
      {onManageConnections
        ? ` For supported apps, use a separate connection in ${appName}.`
        : null}
    </Notice>
  );
}
