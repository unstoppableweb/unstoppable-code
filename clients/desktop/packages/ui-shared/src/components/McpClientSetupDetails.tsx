import { TextLink } from '../primitives/TextLink';
import type { JSX } from 'react';
import {
  mcpClientSetupCollectsClient,
  mcpClientSetupExplanation,
} from '../lib/mcp-connect-errors';
import { CopyButton } from '../primitives/CopyButton';

export interface McpClientSetupDetailsProps {
  /** Catalog or connection name, used in the explanation. */
  serverName: string;
  /** Redirect URI the user registers with their OAuth app, exactly. */
  redirectUri: string;
  /** Vendor instructions for creating the app, when the catalog has them. */
  docsUrl?: string;
  clientSecretRequired: boolean;
  clientSecretAccepted: boolean;
  /** The server refused registration by policy: it takes approved apps only. */
  registrationRefused?: boolean;
  /** Prefix for the block's test IDs. */
  dataTestId?: string;
}

/**
 * Why a server needs the user's own OAuth app, the redirect URI to register
 * (with a copy action), and the vendor's docs. Hosts render the client ID and
 * secret fields beneath it with their own form controls.
 */
export function McpClientSetupDetails({
  serverName,
  redirectUri,
  docsUrl,
  clientSecretRequired,
  clientSecretAccepted,
  registrationRefused = false,
  dataTestId = 'mcp-client-setup',
}: McpClientSetupDetailsProps): JSX.Element {
  const setup = {
    clientSecretRequired,
    clientSecretAccepted,
    registrationRefused,
  };
  return (
    <div className="flex flex-col gap-2" data-testid={dataTestId}>
      <p className="text-s fg-secondary" data-testid={`${dataTestId}-intro`}>
        {mcpClientSetupExplanation(serverName, setup)}
      </p>
      {mcpClientSetupCollectsClient(setup) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs fg-secondary">Redirect URI</span>
          <div className="flex items-center gap-1">
            <code
              className="min-w-0 flex-1 break-all font-mono text-xs fg-primary"
              data-testid={`${dataTestId}-redirect-uri`}
            >
              {redirectUri}
            </code>
            <CopyButton
              value={redirectUri}
              ariaLabel="Copy redirect URI"
              title="Copy redirect URI"
              dataTestId={`${dataTestId}-copy-redirect-uri`}
            />
          </div>
        </div>
      )}
      {docsUrl && (
        <TextLink
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
          className="relative pointer-coarse:before:absolute pointer-coarse:before:-inset-y-3.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-[''] self-start"
          data-testid={`${dataTestId}-docs`}
        >
          {serverName} docs
        </TextLink>
      )}
    </div>
  );
}
