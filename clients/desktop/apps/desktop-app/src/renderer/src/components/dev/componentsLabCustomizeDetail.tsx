import type { JSX } from 'react';
import {
  CustomizeRelatedSection,
  CollectionReadDetail,
  CustomizeDiscoveryProvider,
  CuratedMcpDetail,
  McpServerConfigurationSection,
  PluginCatalogAddButton,
  PluginCatalogDetail,
  SkillReadDetail,
  mcpServerDetailEntry,
} from '@canopy/ui-app/capability';
import {
  AgentReadDetail,
  AutomationReadDetail,
  Button,
  CapabilityDetailLayout,
  CustomizePublisher,
  CustomizeRowSplitButton,
  CustomizeEntryLogo,
  DetailActionBar,
  DetailEntityTypeProvider,
  DetailFact,
  DetailFactError,
  DetailVersionUpdateFact,
  DetailWebsiteFact,
  PluginDetailContent,
  PluginDetailSectionHeading,
  PluginWorksWith,
  ToggleSwitch,
  customizePublisherText,
  type PluginDetailContentPlugin,
} from '@canopy/ui-shared/components';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { PipelineReadDetail } from '@canopy/ui-app';
import {
  MarketplaceSourceDetail,
  type UseMarketplaceSourcesResult,
} from '@canopy/ui-app/marketplace-sources';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';
import { McpServerLogo as LabMcpServerLogo } from '@canopy/ui-shared/components';

const noop = (): void => undefined;

const LAB_DESCRIPTION =
  'Reviews a pull request the way a careful teammate would: it reads the diff, runs the checks that matter, and leaves short comments on what to fix first. It also drafts the summary for the PR body, names the riskiest change, and suggests which tests to add before merging so the reviewer can focus on behaviour rather than style.';

const LAB_ENTRY: UnifiedPluginEntry = {
  id: 'lab-detail-review',
  kind: 'plugin',
  origin: 'marketplace',
  name: 'PR Review',
  description: LAB_DESCRIPTION,
  categories: ['Development'],
  typeLabel: 'Plugin',
  authorName: 'Acme Tools',
  components: { skills: 2, mcpServers: 1, commands: 1, agents: 0 },
  providerSupport: { claude: true, codex: true },
  state: 'installed',
  recommended: false,
  ref: { type: 'marketplace-plugin', marketplaceId: 'lab', pluginName: 'pr' },
};

/** The shared layout on its own: every fact slot, a row error and sections. */
function LayoutPartsPage(): JSX.Element {
  return (
    <CapabilityDetailLayout
      dataTestId="lab-capability-detail"
      logo={
        <CustomizeEntryLogo
          entry={LAB_ENTRY}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      title="PR Review"
      publisher={customizePublisherText(LAB_ENTRY)}
      actions={
        <DetailActionBar
          share={
            <Button variant="secondary" size="compact" onClick={noop}>
              Share
            </Button>
          }
          primary={
            <Button variant="primary" size="compact" onClick={noop}>
              Try it
            </Button>
          }
        />
      }
      description={LAB_DESCRIPTION}
      facts={{
        source: <DetailFact label="Marketplace">Acme marketplace</DetailFact>,
        website: <DetailWebsiteFact href="https://www.example.com/pr-review" />,
        updated: <DetailFact label="Updated">Nov 12, 2026</DetailFact>,
        version: (
          <DetailVersionUpdateFact
            name="PR Review"
            update={{ version: '1.1.1', run: noop }}
          />
        ),
        entity: (
          <DetailFact label="Repository">
            github.com/acme/pr-review
            <DetailFactError error="Couldn’t fetch the repository" />
          </DetailFact>
        ),
      }}
      worksWith={
        <PluginWorksWith
          rows={[
            { id: 'claude', name: 'Claude', installation: 'Installed' },
            { id: 'codex', name: 'Codex', installation: 'Not installed' },
          ]}
        />
      }
      contents={
        <section className="flex flex-col gap-1">
          <PluginDetailSectionHeading>Contents</PluginDetailSectionHeading>
          <p className="text-s fg-secondary">2 skills and 1 command.</p>
        </section>
      }
    />
  );
}

const LAB_PLUGIN: PluginDetailContentPlugin = {
  name: 'pr-review',
  displayName: 'PR Review',
  description: LAB_DESCRIPTION,
  version: '1.1.1',
  author: 'Acme Tools',
  homepage: 'https://www.example.com/pr-review',
  marketplaceId: 'lab',
  providerSupport: { claude: 'native', codex: 'compat' },
  details: {
    hasReadme: true,
    skills: [
      {
        name: 'review-diff',
        description: 'Reads the diff and lists what to fix first.',
        path: 'skills/review-diff',
      },
    ],
    commands: [
      {
        name: 'review',
        description: 'Review the current branch.',
        filePath: 'commands/review.md',
      },
    ],
    agents: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
  },
};

function readComponent(): Promise<null> {
  return Promise.resolve(null);
}

/** The installed plugin page: Codex setting and its failure on its row. */
function InstalledPluginPage(): JSX.Element {
  return (
    <PluginDetailContent
      plugin={LAB_PLUGIN}
      onReadComponent={readComponent}
      publisher={customizePublisherText(LAB_ENTRY)}
      headerIcon={
        <CustomizeEntryLogo
          entry={LAB_ENTRY}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      headerActions={
        <DetailActionBar
          primary={
            <Button variant="primary" size="compact" onClick={noop}>
              Try it
            </Button>
          }
        />
      }
      facts={{
        source: <DetailFact label="Marketplace">Acme marketplace</DetailFact>,
        version: (
          <DetailVersionUpdateFact
            name="PR Review"
            update={{ version: '1.1.1', busy: true }}
          />
        ),
      }}
      harnessRows={[
        { id: 'claude', name: 'Claude', installation: 'Installed' },
        {
          id: 'codex',
          name: 'Codex',
          installation: 'Installed',
          control: (
            <ToggleSwitch
              label="Codex compatibility mode"
              checked
              onChange={noop}
            />
          ),
          error: 'Couldn’t change Codex compatibility',
        },
        { id: 'cursor', name: 'Cursor', installation: 'Not installed' },
      ]}
      worksWithNotice={
        <DetailFactError
          tone="attention"
          error="Added for Claude. Cursor needs Claude Code installed first."
        />
      }
    />
  );
}

const LAB_SKILL_ENTRY: UnifiedPluginEntry = {
  ...LAB_ENTRY,
  id: 'lab-detail-skill',
  kind: 'skill',
  name: 'Review Diff',
  typeLabel: 'Skill',
  ref: { type: 'skill', sourceId: 'lab', skillName: 'review-diff' },
};

/** The installed skill page: Version row with an update, Plugin row. */
function SkillPage(): JSX.Element {
  return (
    <SkillReadDetail
      skill={{ sourceId: 'lab', name: 'review-diff' }}
      header={{
        title: 'Review Diff',
        description: LAB_DESCRIPTION,
        version: 'v1.2.0',
        facts: { source: ['Acme marketplace'], updated: 'Nov 12, 2026' },
        logo: (
          <CustomizeEntryLogo
            entry={LAB_SKILL_ENTRY}
            McpServerLogoComponent={LabMcpServerLogo}
          />
        ),
        publisher: customizePublisherText(LAB_SKILL_ENTRY),
      }}
      updateAction={{
        status: 'ready',
        updateAvailable: true,
        pending: 'none',
        onCheck: noop,
        onApply: noop,
      }}
      onRemove={noop}
      content={{
        frontmatter: {},
        body: 'Read the diff first, then list the issues worth fixing.',
      }}
      files={['SKILL.md']}
      loading={false}
      error=""
      readFile={() => Promise.reject(new Error('Not in the lab.'))}
    />
  );
}

const LAB_MCP_ENTRY: UnifiedPluginEntry = mcpServerDetailEntry({
  id: 'lab-docs',
  name: 'Docs Search',
  description: 'Searches the team handbook and API docs.',
  url: 'https://mcp.example.com/mcp',
});

/** The installed MCP server page: Tools table and collapsed Configuration. */
function McpPage(): JSX.Element {
  return (
    <CuratedMcpDetail
      flush
      entry={{
        name: 'Docs Search',
        shortDescription: LAB_DESCRIPTION,
        docsUrl: 'https://example.com/docs',
      }}
      installedServerId="lab-docs"
      toolNames={['search_docs', 'get_page', 'list_spaces']}
      toolsLoading={false}
      toolsError=""
      logo={
        <CustomizeEntryLogo
          entry={LAB_MCP_ENTRY}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      publisher={customizePublisherText(LAB_MCP_ENTRY)}
      updated="Nov 12, 2026"
      actions={
        <DetailActionBar
          primary={
            <Button variant="primary" size="compact" onClick={noop}>
              Try it
            </Button>
          }
        />
      }
      configuration={
        <McpServerConfigurationSection
          summary={{
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headerNames: ['X-Team'],
            httpAuthHandler: 'provider',
          }}
        />
      }
    />
  );
}

/** A local collection: members grouped with counts, no Name/Description boxes. */
function CollectionPage(): JSX.Element {
  return (
    <CollectionReadDetail
      layout={{
        logo: (
          <CustomizeEntryLogo
            entry={{ ...LAB_ENTRY, kind: 'collection', name: 'Release kit' }}
            McpServerLogoComponent={LabMcpServerLogo}
          />
        ),
        publisher: 'You',
      }}
      collection={{
        name: 'Release kit',
        description: LAB_DESCRIPTION,
        memberRefs: [
          { kind: 'skill', sourceId: 'lab', skillName: 'review-diff' },
          { kind: 'plugin', marketplaceId: 'lab', pluginName: 'pr-review' },
        ],
      }}
      resolvedMembers={[
        {
          ref: { kind: 'skill', sourceId: 'lab', skillName: 'review-diff' },
          entryKey: 'skill:lab:review-diff',
          name: 'Review Diff',
          description: 'Reads the diff and lists what to fix first.',
          source: 'Acme marketplace',
        },
      ]}
      onEdit={noop}
    />
  );
}

const LAB_MARKETPLACE_STATE: UseMarketplaceSourcesResult = {
  sources: [
    {
      id: 'lab-acme',
      name: 'Acme marketplace',
      description:
        'Plugins the Acme team maintains for code review and releases.',
      kind: 'github',
      sourceLabel: 'acme/marketplace',
      sourceUrl: 'https://github.com/acme/marketplace',
      status: { state: 'valid', errors: [] },
      lastUpdatedAt: '2026-11-12T10:00:00.000Z',
      pluginCount: 4,
      actions: { update: true, remove: true },
      plugins: [],
    },
  ],
  lastRefreshedAt: null,
  loading: false,
  refreshing: false,
  listError: null,
  listProgress: null,
  operations: {},
  sourceErrors: {},
  sourceWarnings: { 'lab-acme': 'Two plugins could not be read.' },
  sourceProgress: {},
  installingPlugins: {},
  pluginErrors: {},
  recordedErrors: new Set(),
  canInstall: true,
  reload: () => Promise.resolve(),
  refresh: () => Promise.resolve(),
  update: () => Promise.resolve(true),
  remove: () => Promise.resolve(true),
  installPlugin: () => Promise.resolve(true),
  dismissSourceMessage: noop,
};

/** A marketplace: Update in the action bar, a warning under the facts. */
function MarketplacePage(): JSX.Element {
  return (
    <MarketplaceSourceDetail
      state={LAB_MARKETPLACE_STATE}
      sourceId="lab-acme"
      onNavigateBack={noop}
    />
  );
}

/** A workflow: Jobs table, collapsed YAML, Run with Open in editor. */
function WorkflowPage(): JSX.Element {
  return (
    <PipelineReadDetail
      definition={{
        name: 'Release check',
        description: LAB_DESCRIPTION,
        triggerSummary: 'On pull request',
        scopes: ['directory'],
        jobs: [
          { id: 'review', name: 'Review', dependencies: [], steps: [] },
          {
            id: 'notes',
            name: 'Release notes',
            dependencies: ['review'],
            steps: [],
          },
        ],
        canonicalYaml: 'pipeline:\n  name: Release check\n',
      }}
      layout={{
        logo: (
          <CustomizeEntryLogo
            entry={{ ...LAB_ENTRY, kind: 'pipeline', name: 'Release check' }}
            McpServerLogoComponent={LabMcpServerLogo}
          />
        ),
        publisher: 'You',
        source: 'Yours',
        updated: 'Nov 12, 2026',
        actions: (
          <DetailActionBar
            secondary={
              <Button size="compact" onClick={noop}>
                Open in editor
              </Button>
            }
            primary={
              <Button variant="primary" size="compact" onClick={noop}>
                Run
              </Button>
            }
          />
        ),
      }}
    />
  );
}

const LAB_AUTOMATION: UnifiedPluginEntry = {
  ...LAB_ENTRY,
  id: 'automation:local:lab',
  kind: 'automation',
  origin: 'installed-standalone',
  name: 'Morning triage',
  description: 'Scheduled · Ask App Advisor to sort new issues',
  typeLabel: 'Automation',
  sourceLabel: 'Local',
  ref: { type: 'automation', activityId: 'lab' },
};

/** A local automation: the tile's On as the primary, Update on its row. */
function LocalAutomationPage(): JSX.Element {
  return (
    <AutomationReadDetail
      name={LAB_AUTOMATION.name}
      description={LAB_AUTOMATION.description}
      logo={
        <CustomizeEntryLogo
          entry={LAB_AUTOMATION}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      publisher={<CustomizePublisher entry={LAB_AUTOMATION} />}
      actions={
        <DetailActionBar
          secondary={
            <Button size="compact" onClick={noop}>
              Open in Workflows
            </Button>
          }
          primary={
            <CustomizeRowSplitButton
              entryName={LAB_AUTOMATION.name}
              idPrefix="lab-automation"
              action={{
                label: 'On',
                tone: 'active',
                accessibleName: 'Morning triage is on',
                leadingItems: [
                  { id: 'toggle', label: 'Turn off', onSelect: noop },
                ],
              }}
              items={[]}
            />
          }
        />
      }
      actionsNotice={
        <DetailFactError error="Couldn't turn off Morning triage" />
      }
      source="Local"
      schedule={{ value: 'Weekdays at 09:00' }}
      lastRun="2 hours ago"
      nextRun="Nov 17, 2026, 9:00 AM"
      version={
        <DetailVersionUpdateFact
          name={LAB_AUTOMATION.name}
          update={{ run: noop }}
        />
      }
      summary="Ask App Advisor to sort new issues by area and urgency"
    />
  );
}

/** A team share: Add as the primary and the share's definition. */
function SharedAutomationPage(): JSX.Element {
  const entry: UnifiedPluginEntry = {
    ...LAB_AUTOMATION,
    id: 'automation:shared:lab',
    origin: 'shared',
    sourceLabel: 'Shared',
    ownershipLabel: 'Shared by Platform',
    state: 'available',
    ref: { type: 'shared-automation', automationId: 'lab' },
  };
  return (
    <AutomationReadDetail
      name={entry.name}
      description="Sorts new issues every weekday morning."
      logo={
        <CustomizeEntryLogo
          entry={entry}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      publisher={<CustomizePublisher entry={entry} />}
      actions={
        <DetailActionBar
          primary={
            <Button variant="primary" size="compact" onClick={noop}>
              Add
            </Button>
          }
        />
      }
      source="Shared"
      schedule={{ value: 'Weekdays at 09:00', suggested: true }}
      definition={{
        version: 6,
        name: entry.name,
        description: 'Sorts new issues every weekday morning.',
        trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Sort the new issues by area and urgency.',
          plugins: [],
        },
        hasRunCondition: false,
      }}
    />
  );
}

const LAB_AGENT: UnifiedPluginEntry = {
  ...LAB_ENTRY,
  id: 'agent:local:lab',
  kind: 'agent',
  origin: 'installed-standalone',
  name: 'Code reviewer',
  description: 'Reviews diffs for correctness first, then style.',
  typeLabel: 'Agent',
  sourceLabel: 'Local',
  ref: { type: 'local-agent', agentId: 'agent_model_code_reviewer' },
};

/** A local agent: Edit beside the tile's Installed, Instructions collapsed. */
function AgentPage(): JSX.Element {
  return (
    <AgentReadDetail
      name={LAB_AGENT.name}
      description={LAB_AGENT.description}
      logo={
        <CustomizeEntryLogo
          entry={LAB_AGENT}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      publisher={<CustomizePublisher entry={LAB_AGENT} />}
      actions={
        <DetailActionBar
          secondary={
            <Button size="compact" onClick={noop}>
              Edit
            </Button>
          }
          primary={
            <CustomizeRowSplitButton
              entryName="this agent"
              idPrefix="lab-agent"
              action={{
                label: 'Installed',
                tone: 'installed',
                accessibleName: 'This agent is installed',
              }}
              items={[]}
            />
          }
        />
      }
      source="Local"
      baseModel="Claude Opus"
      model="agent_model_code_reviewer"
      items={[
        { key: 'skill', label: 'Skill: code-review' },
        { key: 'plugin', label: 'Plugin: github' },
      ]}
      instructions="Read the whole diff before commenting. Lead with correctness."
    />
  );
}

/** A team share still loading its definition. */
function SharedAgentPage(): JSX.Element {
  const entry: UnifiedPluginEntry = {
    ...LAB_AGENT,
    id: 'agent:shared:lab',
    origin: 'shared',
    sourceLabel: 'Shared',
    ownershipLabel: 'Shared by Platform',
    state: 'available',
    ref: { type: 'shared-agent', agentId: 'lab' },
  };
  return (
    <AgentReadDetail
      name={entry.name}
      description={entry.description}
      logo={
        <CustomizeEntryLogo
          entry={entry}
          McpServerLogoComponent={LabMcpServerLogo}
        />
      }
      publisher={<CustomizePublisher entry={entry} />}
      actions={
        <DetailActionBar
          primary={
            <Button variant="primary" size="compact" onClick={noop}>
              Add
            </Button>
          }
        />
      }
      source="Shared"
      baseModel="Claude Opus"
      items={[]}
      instructions=""
      contentsNotice={<DetailFactError error="Couldn't load this agent" />}
    />
  );
}

/** Related, last on every page: why each item is listed, in its row. */
function RelatedPage(): JSX.Element {
  return (
    <CustomizeRelatedSection
      subject={LAB_ENTRY}
      entries={[
        {
          ...LAB_ENTRY,
          id: 'lab-related-lint',
          name: 'Lint Fixer',
          components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
        },
        { ...LAB_AGENT, authorName: 'Acme Tools' },
        {
          ...LAB_ENTRY,
          id: 'lab-related-other',
          name: 'Release Notes',
          authorName: 'Other Co',
        },
      ]}
      onOpenEntry={noop}
    />
  );
}

/** The catalog plugin page (not added yet), with Add as its primary. */
function CatalogPluginPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <DetailActionBar primary={<PluginCatalogAddButton onAdd={noop} />} />
      <PluginCatalogDetail
        layout
        entry={{
          name: 'PR Review',
          author: 'Acme Tools',
          publisher: customizePublisherText(LAB_ENTRY),
          description: LAB_DESCRIPTION,
          homepage: 'https://example.com',
          categories: ['Development'],
          components: { skills: 2, mcpServers: 1, commands: 1, agents: 0 },
        }}
        logo={
          <CustomizeEntryLogo
            entry={{ ...LAB_ENTRY, state: 'available' }}
            McpServerLogoComponent={LabMcpServerLogo}
          />
        }
      />
    </div>
  );
}

/**
 * New Customize's detail pages on the shared `CapabilityDetailLayout`: one
 * header, facts in the fixed order, Works with, Contents and Docs.
 */
export function CustomizeDetailPagesSpecimen(): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled>
      <SpecimenPanel title="Customize detail pages (New Customize)">
        <SpecimenGrid min={640}>
          <SpecimenCell label="Layout parts (update available, row error)" wide>
            <DetailEntityTypeProvider kind="plugin">
              <LayoutPartsPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="Plugin, installed (Codex row error)" wide>
            <DetailEntityTypeProvider kind="plugin">
              <InstalledPluginPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="Skill, update available" wide>
            <DetailEntityTypeProvider kind="skill">
              <SkillPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="MCP server, installed" wide>
            <DetailEntityTypeProvider kind="app">
              <McpPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="Collection" wide>
            <DetailEntityTypeProvider kind="collection">
              <CollectionPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="Marketplace (warning)" wide>
            <MarketplacePage />
          </SpecimenCell>
          <SpecimenCell label="Workflow" wide>
            <DetailEntityTypeProvider kind="pipeline">
              <WorkflowPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
          <SpecimenCell label="Automation, local (update, toggle error)" wide>
            <LocalAutomationPage />
          </SpecimenCell>
          <SpecimenCell label="Automation, shared" wide>
            <SharedAutomationPage />
          </SpecimenCell>
          <SpecimenCell label="Agent, local" wide>
            <AgentPage />
          </SpecimenCell>
          <SpecimenCell label="Agent, shared (definition read failed)" wide>
            <SharedAgentPage />
          </SpecimenCell>
          <SpecimenCell label="Related" wide>
            <RelatedPage />
          </SpecimenCell>
          <SpecimenCell label="Plugin, not added" wide>
            <DetailEntityTypeProvider kind="plugin">
              <CatalogPluginPage />
            </DetailEntityTypeProvider>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </CustomizeDiscoveryProvider>
  );
}
