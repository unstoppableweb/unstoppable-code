import type { JSX } from 'react';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import {
  Button,
  CuratedSourceLabel,
  MarketplaceTypeLabel,
  McpConnectionStatusBadge,
  type McpRowDestination,
  McpRowSettings,
  McpServerCardRow,
  Surface,
} from '@canopy/ui-shared/components';
import {
  McpServersSectionBody,
  type McpServersSectionItem,
} from '@canopy/ui-app';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const KIND_LABELS: readonly { kind: UnifiedEntryKind; label: string }[] = [
  { kind: 'plugin', label: 'Plugin' },
  { kind: 'app', label: 'App' },
  { kind: 'skill', label: 'Skill' },
  { kind: 'pipeline', label: 'Pipeline' },
  { kind: 'automation', label: 'Automation' },
  { kind: 'collection', label: 'Collection' },
  { kind: 'agent', label: 'Model preset' },
  { kind: 'blueprint', label: 'Project template' },
];

/** MarketplaceTypeLabel and CuratedSourceLabel: every kind, long text. */
export function MarketplaceLabelsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="MarketplaceTypeLabel, one per resource kind">
        <SpecimenGrid min={150}>
          {KIND_LABELS.map(({ kind, label }) => (
            <SpecimenCell key={kind} label={kind}>
              <MarketplaceTypeLabel kind={kind} label={label} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Long label" hint="Stays on one line">
        <SpecimenCell label="No wrapping; the host clips it" wide>
          <div className="w-40 overflow-hidden">
            <MarketplaceTypeLabel
              kind="blueprint"
              label="Project template for a monorepo"
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel
        title="CuratedSourceLabel"
        hint="Mark, then Curated; hover for the source"
      >
        <SpecimenCell label="Curated by Unstoppable Domains">
          <CuratedSourceLabel entryId="lab" dataTestId="lab-curated" />
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

/** McpConnectionStatusBadge: every status, with and without the provider suffix. */
export function McpStatusSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Cached connection health">
      <SpecimenGrid min={180}>
        <SpecimenCell label="connected">
          <McpConnectionStatusBadge
            badge={{ status: 'connected', isProvider: false }}
          />
        </SpecimenCell>
        <SpecimenCell label="auth_required">
          <McpConnectionStatusBadge
            badge={{ status: 'auth_required', isProvider: false }}
          />
        </SpecimenCell>
        <SpecimenCell label="unreachable">
          <McpConnectionStatusBadge
            badge={{ status: 'unreachable', isProvider: false }}
          />
        </SpecimenCell>
        <SpecimenCell label="unknown (never claims health)">
          <McpConnectionStatusBadge
            badge={{ status: 'unknown', isProvider: false }}
          />
        </SpecimenCell>
        <SpecimenCell label="connected, provider-managed">
          <McpConnectionStatusBadge
            badge={{ status: 'connected', isProvider: true }}
          />
        </SpecimenCell>
        <SpecimenCell label="unreachable, provider-managed">
          <McpConnectionStatusBadge
            badge={{ status: 'unreachable', isProvider: true }}
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const BUTTON_DESTINATION: McpRowDestination = {
  kind: 'button',
  onActivate: noop,
};
const LINK_DESTINATION: McpRowDestination = {
  kind: 'link',
  href: 'https://example.com/mcp/linear',
};

function Rows({ children }: { readonly children: JSX.Element }): JSX.Element {
  return (
    <Surface variant="group" className="w-full">
      <ul className="divide-y divide-line-base">{children}</ul>
    </Surface>
  );
}

/** McpServerCardRow and McpRowSettings in every layout and destination. */
export function McpServerCardRowSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Name as text, button or link">
        <SpecimenCell label="No destination: plain name" wide>
          <Rows>
            <McpServerCardRow name="Linear" enabled />
          </Rows>
        </SpecimenCell>
        <SpecimenCell label="Button destination (opens the host's detail)" wide>
          <Rows>
            <McpServerCardRow
              name="Linear"
              enabled
              destination={BUTTON_DESTINATION}
            />
          </Rows>
        </SpecimenCell>
        <SpecimenCell label="Link destination (new tab)" wide>
          <Rows>
            <McpServerCardRow
              name="Linear"
              enabled
              destination={LINK_DESTINATION}
            />
          </Rows>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Content and actions">
        <SpecimenCell label="Metadata, status, details and actions" wide>
          <Rows>
            <McpServerCardRow
              name="Linear"
              enabled
              destination={BUTTON_DESTINATION}
              metadata={<span className="text-xs fg-tertiary">Plugin</span>}
              status={
                <McpConnectionStatusBadge
                  badge={{ status: 'connected', isProvider: false }}
                />
              }
              actions={
                <Button variant="secondary" size="sm">
                  Disable
                </Button>
              }
            >
              <p className="mt-0.5 text-xs fg-secondary">
                stdio · npx linear-mcp
              </p>
              <McpRowSettings destination={BUTTON_DESTINATION} name="Linear" />
            </McpServerCardRow>
          </Rows>
        </SpecimenCell>
        <SpecimenCell label="Disabled server (data-enabled=false)" wide>
          <Rows>
            <McpServerCardRow
              name="Sentry"
              enabled={false}
              status={
                <McpConnectionStatusBadge
                  badge={{ status: 'unknown', isProvider: false }}
                />
              }
              actions={
                <Button variant="secondary" size="sm">
                  Enable
                </Button>
              }
            />
          </Rows>
        </SpecimenCell>
        <SpecimenCell label="Actions centered with the name" wide>
          <Rows>
            <McpServerCardRow
              name="GitHub"
              enabled
              alignActions="center"
              actions={
                <Button variant="secondary" size="sm">
                  Reconnect
                </Button>
              }
            />
          </Rows>
        </SpecimenCell>
        <SpecimenCell label="Compact density (activity panel)" wide>
          <Rows>
            <McpServerCardRow
              name="Linear"
              enabled
              compact
              status={
                <McpConnectionStatusBadge
                  badge={{ status: 'auth_required', isProvider: false }}
                />
              }
            />
          </Rows>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Long name">
        <SpecimenCell label="Breaks inside the row; actions wrap under it" wide>
          <div className="w-72">
            <Rows>
              <McpServerCardRow
                name="a-very-long-mcp-server-name-that-has-no-break-opportunities-at-all"
                enabled
                destination={BUTTON_DESTINATION}
                actions={
                  <Button variant="secondary" size="sm">
                    Disable
                  </Button>
                }
              />
            </Rows>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="McpRowSettings">
        <SpecimenCell label="Button">
          <McpRowSettings destination={BUTTON_DESTINATION} name="Linear" />
        </SpecimenCell>
        <SpecimenCell label="Link (new tab)">
          <McpRowSettings destination={LINK_DESTINATION} name="Linear" />
        </SpecimenCell>
        <SpecimenCell label="No destination renders nothing">
          <McpRowSettings destination={undefined} name="Linear" />
          <span className="text-2xs fg-tertiary">(nothing above)</span>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

const SHARED_ROW = {
  source: 'shared',
  enabled: true,
  canConnect: false,
} as const satisfies Partial<McpServersSectionItem>;

/** Shared connection rows: every state, both sharers, a long name. */
const SHARED_CONNECTION_ROWS: readonly McpServersSectionItem[] = [
  {
    ...SHARED_ROW,
    key: 'connected',
    displayName: 'Linear',
    sharedBy: 'project',
    authStatus: 'connected',
    authStatusLabel: 'Connected',
  },
  {
    ...SHARED_ROW,
    key: 'needs-sign-in',
    displayName: 'GitHub',
    sharedBy: 'organization',
    authStatus: 'not_connected',
    authStatusLabel: 'Needs sign-in',
  },
  {
    ...SHARED_ROW,
    key: 'pending',
    displayName: 'Notion',
    sharedBy: 'project',
    authStatus: 'not_connected',
    authStatusLabel: 'Not signed in',
  },
  {
    ...SHARED_ROW,
    key: 'disconnected',
    displayName: 'Atlassian Jira and Confluence for the platform team',
    sharedBy: 'organization',
    authStatus: 'not_configured',
    authStatusLabel: 'Disconnected',
  },
];

/** McpServersSectionBody's shared connection rows (CAN-6246). */
export function McpSharedConnectionRowsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Shared connections">
        <SpecimenCell
          label="Connected, Needs sign-in, Not signed in, Disconnected; no action or destination"
          wide
        >
          <McpServersSectionBody
            servers={SHARED_CONNECTION_ROWS}
            warnings={[]}
            loading={false}
            error={null}
            connectingKey={null}
            // Feeds only the proxy toggle, which shared rows never show. The
            // Storybook catalog builds this file without the renderer alias.
            brandAppName=""
            proxyLogo={null}
            onOpenDetails={noop}
          />
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
