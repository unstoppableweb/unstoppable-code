'use client';

import { Fragment, type JSX, type ReactNode } from 'react';
import {
  DetailEntityType,
  Stack,
  Fact,
  FactList,
  Heading,
} from '@canopy/ui-shared/components';
import type { PortalMcpServerDetail } from '@canopy/protocol/portal';
import {
  Button,
  StatusLabel,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export interface McpServerReadDetailProps {
  statusSection?: ReactNode;
  /** The management card, beneath Status. */
  managementSection?: ReactNode;
  /** Credential-free portal projection. Raw MCP definitions are forbidden. */
  server: PortalMcpServerDetail;
  /** Host-owned label for app-managed HTTP auth. */
  appAuthHandlerLabel?: string;
  onConfigure?: () => void;
  onToggleConfig?: (configId: string, enabled: boolean) => void;
  configToggleFeedback?: Readonly<
    Record<
      string,
      { pending?: boolean; message?: string; tone?: 'error' | 'muted' }
    >
  >;
}

/**
 * The extra-headers part of a config's summary line, with its leading
 * separator. Account servers report presence only (names stay in the
 * cloud); with no presence reported, it makes no claim at all.
 */
function extraHeadersSummary(
  server: PortalMcpServerDetail,
  config: PortalMcpServerDetail['configs'][number],
): string {
  if (config.hasExtraHeaders === true) return ' · Extra headers configured';
  if (server.scope === 'account' && config.hasExtraHeaders === undefined)
    return '';
  return ` · Extra headers: ${
    config.extraHeaderNames.length > 0
      ? config.extraHeaderNames.join(', ')
      : 'none'
  }`;
}

export function McpServerReadDetail({
  server,
  appAuthHandlerLabel = 'App',
  onConfigure,
  onToggleConfig,
  configToggleFeedback,
  statusSection,
  managementSection,
}: McpServerReadDetailProps): JSX.Element {
  const endpoint = server.type === 'http' ? server.url : server.command;
  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5"
      data-testid="mcp-server-read-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <Stack gap="tight" className="min-w-0">
          <Heading level={3} variant="section">
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              {server.name}
              <DetailEntityType />
            </span>
          </Heading>
          {server.description && (
            <p className="text-s fg-secondary">{server.description}</p>
          )}
          <p className="text-xs fg-secondary">
            {server.type === 'http' ? 'HTTP' : 'Command (stdio)'}
            {server.updatedAt ? ` · Updated ${server.updatedAt}` : null}
          </p>
        </Stack>
        {onConfigure && (
          <Button
            type="button"
            size="compact"
            onClick={onConfigure}
            data-testid="mcp-server-read-configure"
          >
            Configure
          </Button>
        )}
      </div>

      {/* Facts stay one list: Status, Health, Placement. */}
      <div className="flex flex-col gap-1 empty:hidden">
        {statusSection}
        {managementSection}
      </div>
      <FactList labelWidth="9rem" size="s" rowGap="2" labelTone="secondary">
        <Fact label="Transport">
          {server.type === 'http' ? 'HTTP' : 'Command (stdio)'}
        </Fact>
        {endpoint && (
          <>
            <Fact
              label="Endpoint"
              fit="break-all"
              mono
              dataTestId="mcp-server-read-endpoint"
            >
              {endpoint}
            </Fact>
          </>
        )}
        {server.argCount !== undefined && (
          <>
            <Fact label="Arguments">{server.argCount}</Fact>
          </>
        )}
        {server.headerNames && server.headerNames.length > 0 && (
          <>
            <Fact label="Headers">{server.headerNames.join(', ')}</Fact>
          </>
        )}
        {server.httpAuthHandler !== undefined && (
          <>
            <Fact label="Auth handling">
              {server.httpAuthHandler === 'canopy'
                ? appAuthHandlerLabel
                : 'Provider'}
            </Fact>
          </>
        )}
        {server.oauth && (
          <>
            <Fact
              label={<span className="font-medium fg-primary">OAuth</span>}
              labelTestId="mcp-server-read-oauth"
            />
            <Fact label="Client ID">
              {server.oauth.hasClientId ? 'configured' : 'not configured'}
            </Fact>
            <Fact label="Client secret">
              {server.oauth.hasClientSecret ? 'configured' : 'not configured'}
            </Fact>
            {server.oauth.authorizationUrl !== undefined && (
              <>
                <Fact label="Authorization URL" fit="break-all" mono>
                  {server.oauth.authorizationUrl}
                </Fact>
              </>
            )}
            {server.oauth.tokenUrl !== undefined && (
              <>
                <Fact label="Token URL" fit="break-all" mono>
                  {server.oauth.tokenUrl}
                </Fact>
              </>
            )}
            {server.oauth.scopes !== undefined &&
              server.oauth.scopes.length > 0 && (
                <>
                  <Fact label="Scopes">{server.oauth.scopes.join(', ')}</Fact>
                </>
              )}
            {server.oauth.audience !== undefined && (
              <>
                <Fact label="Audience">{server.oauth.audience}</Fact>
              </>
            )}
          </>
        )}
      </FactList>

      {server.curated !== undefined && (
        <Stack as="section" gap="inline" data-testid="mcp-server-read-curated">
          <Heading level={4} variant="label">
            Curated catalog
          </Heading>
          <FactList rowGap="2" labelTone="secondary">
            <Fact label="Catalog key">{server.curated.key}</Fact>
            {server.curated.authorName !== undefined && (
              <>
                <Fact label="Author">
                  {server.curated.authorUrl !== undefined ? (
                    <a
                      href={server.curated.authorUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {server.curated.authorName}
                    </a>
                  ) : (
                    server.curated.authorName
                  )}
                </Fact>
              </>
            )}
            {[
              ['Docs', server.curated.docsUrl],
              ['Support', server.curated.supportUrl],
              ['Privacy policy', server.curated.privacyPolicyUrl],
            ].map(([label, href]) =>
              href === undefined ? null : (
                <Fragment key={label}>
                  <Fact label={label}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="fg-accent hover:underline"
                    >
                      {href}
                    </a>
                  </Fact>
                </Fragment>
              ),
            )}
            {server.curated.requiresProviderAuth === true && (
              <>
                <Fact label="Provider auth">Required</Fact>
              </>
            )}
          </FactList>
        </Stack>
      )}

      <Stack
        as="section"
        gap="inline"
        aria-labelledby="mcp-server-configs-heading"
      >
        <Heading level={4} variant="label" id="mcp-server-configs-heading">
          Configurations
        </Heading>
        {server.configs.length === 0 ? (
          <p className="text-xs fg-secondary">No configurations.</p>
        ) : (
          <Stack gap="inline">
            {server.configs.map((config) => {
              const feedback = configToggleFeedback?.[config.id];
              return (
                <Surface
                  variant="group"
                  padding="compact"
                  key={config.id}
                  data-testid="mcp-server-read-config"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex flex-col gap-1">
                      <p className="text-s font-medium fg-primary">
                        {config.name}
                      </p>
                      {config.description && (
                        <p className="mt-0.5 text-xs fg-secondary">
                          {config.description}
                        </p>
                      )}
                      <p className="text-2xs fg-secondary">
                        Environment variables:{' '}
                        {config.envVarNames.length > 0
                          ? config.envVarNames.join(', ')
                          : 'none'}{' '}
                        · {config.extraArgCount} extra arguments
                        {extraHeadersSummary(server, config)}
                        {' · '}token{' '}
                        {config.hasAuthToken ? 'configured' : 'not configured'}
                      </p>
                    </div>
                    {statusSection ? null : onToggleConfig ? (
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <ToggleSwitch
                          checked={config.enabled}
                          label={`${config.enabled ? 'Disable' : 'Enable'} ${config.name}`}
                          onChange={(next) => onToggleConfig(config.id, next)}
                          disabled={feedback?.pending === true}
                          busy={feedback?.pending === true}
                          dataTestId="mcp-server-read-config-toggle"
                        />
                        {/* The switch only marks itself busy, so the pending
                          change is named in text the user can see. */}
                        {feedback?.pending === true && (
                          <span className="text-3xs fg-secondary">Saving…</span>
                        )}
                        {feedback?.message && (
                          <span
                            role="status"
                            data-testid="mcp-server-read-config-feedback"
                            className={`max-w-52 text-right text-3xs ${
                              feedback.tone === 'error' ? '' : 'fg-secondary'
                            }`}
                          >
                            {feedback.tone === 'error' ? (
                              <StatusLabel>{feedback.message}</StatusLabel>
                            ) : (
                              feedback.message
                            )}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="shrink-0 text-xs fg-secondary">
                        {config.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    )}
                  </div>
                </Surface>
              );
            })}
          </Stack>
        )}
      </Stack>
    </div>
  );
}
