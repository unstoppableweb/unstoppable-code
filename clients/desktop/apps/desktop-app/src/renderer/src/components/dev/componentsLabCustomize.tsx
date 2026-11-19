import type { ComponentType, JSX, ReactNode } from 'react';
import {
  TextLink,
  Button,
  CustomizeBreadcrumbs,
  CustomizeInstalledRow,
  CustomizeRowSplitButton,
  CustomizeWorksWithChips,
  InstalledItemStatusPicker,
  CustomizeInstalledUnavailable,
  CustomizeRowMenu,
  HarnessCatchUpNotice,
  McpRowHealth,
  McpRowCheckFeedback,
  McpServerLogo,
  type McpServerLogoProps,
  ItemStateMark,
  HelpHint,
  ITEM_STATE_LABEL_CLASS,
  StatusToneText,
  type ItemStateTone,
  type CustomizeBreadcrumbItem,
  type HarnessCatchUpNoticeState,
  type CustomizeRowSplitAction,
} from '@canopy/ui-shared/components';
import type { HarnessCompatibility } from '@canopy/protocol/plugins';
import { mcpRowHealthModel } from '@canopy/ui-shared/lib/mcp-row-health';
import { badgeClassName } from '@canopy/ui-shared/lib/badge';
import { CURATED_PLUGIN_LOGOS } from '@canopy/ui-shared/lib/curated-plugin-logos';
import type {
  UnifiedEntryAlternative,
  UnifiedEntryHarnessRow,
  UnifiedEntryPlacement,
  UnifiedPluginEntry,
} from '@canopy/ui-shared/lib/unified-plugin-entry';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// New Customize (CAN-6817): the offer to add existing installs to harnesses
// set up later, in each of its states.
const LAB_CATCH_UP_OFFER: HarnessCatchUpNoticeState['offer'] = {
  harnesses: ['cursor', 'opencode'],
  targets: [
    {
      entryId: 'lab-slack',
      name: 'Slack',
      record: {
        item: { kind: 'plugin', marketplaceId: 'lab', pluginName: 'slack' },
        harnesses: ['claude'],
      },
      harnesses: ['cursor', 'opencode'],
    },
    {
      entryId: 'lab-linear',
      name: 'Linear',
      record: {
        serverId: 'lab-linear',
        configId: 'default',
        harnesses: ['claude'],
      },
      harnesses: ['cursor', 'opencode'],
    },
  ],
  cannotAdd: [],
};

const LAB_CATCH_UP_STATES: readonly {
  readonly label: string;
  readonly state: HarnessCatchUpNoticeState;
}[] = [
  { label: 'Offer', state: { kind: 'offer', offer: LAB_CATCH_UP_OFFER } },
  { label: 'Adding', state: { kind: 'adding', offer: LAB_CATCH_UP_OFFER } },
  {
    label: 'Done: everything added',
    state: {
      kind: 'done',
      offer: LAB_CATCH_UP_OFFER,
      result: { added: 2, notAdded: [] },
    },
  },
  {
    label: 'Done: some not added, with why',
    state: {
      kind: 'done',
      offer: LAB_CATCH_UP_OFFER,
      result: {
        added: 1,
        notAdded: [
          {
            name: 'Slack',
            harness: 'opencode',
            reason: "It only has apps, and apps don't run in OpenCode.",
          },
        ],
      },
    },
  },
  {
    label: 'Done: nothing added',
    state: {
      kind: 'done',
      offer: LAB_CATCH_UP_OFFER,
      result: {
        added: 0,
        notAdded: [
          {
            name: 'Linear',
            harness: 'cursor',
            reason: "It couldn't be added. Try again from its row.",
          },
        ],
      },
    },
  },
  {
    label: 'Failed',
    state: {
      kind: 'failed',
      offer: LAB_CATCH_UP_OFFER,
      message: "Couldn't add your installs.",
    },
  },
];

const LAB_ALL_HARNESSES: HarnessCompatibility = {
  version: 1,
  rulesVersion: 1,
  harnesses: {
    claude: { level: 'native' },
    codex: { level: 'full' },
    cursor: { level: 'partial', missing: ['hooks'] },
    copilot: { level: 'full' },
    opencode: { level: 'partial', missing: ['agents'] },
  },
};

const LAB_ROW_ACTIONS: readonly {
  readonly label: string;
  readonly action: CustomizeRowSplitAction;
  readonly compatibility?: HarnessCompatibility;
}[] = [
  {
    label: 'Add, five harnesses (+2 more)',
    action: { label: 'Add', accessibleName: 'Add Sentry', onPrimary: noop },
    compatibility: LAB_ALL_HARNESSES,
  },
  {
    label: 'Add unavailable here, published harness only',
    action: {
      label: 'Add',
      accessibleName: 'Add Sentry',
      reason: 'Can’t be added here.',
    },
  },
  {
    label: 'Active, with status choices',
    action: {
      label: 'Active',
      accessibleName: 'Status for Sentry: Active',
      glyph: 'active',
      statuses: [{ current: 'active', onChange: noop }],
    },
    compatibility: LAB_ALL_HARNESSES,
  },
  {
    label: 'Disabled',
    action: {
      label: 'Disabled',
      accessibleName: 'Status for Sentry: Disabled',
      glyph: 'disabled',
      statuses: [{ current: 'disabled', onChange: noop }],
    },
  },
  {
    label: 'Available',
    action: {
      label: 'Available',
      accessibleName: 'Status for Sentry: Available',
      glyph: 'available',
      statuses: [{ current: 'available', onChange: noop }],
    },
  },
  {
    label: 'Run (workflow)',
    action: {
      label: 'Run',
      tone: 'run',
      accessibleName: 'Run Sentry',
      onPrimary: noop,
    },
  },
  {
    label: 'Installed, no status',
    action: {
      label: 'Installed',
      tone: 'installed',
      accessibleName: 'Sentry is installed',
    },
  },
  {
    label: 'Busy',
    action: {
      label: 'Installed',
      accessibleName: 'Sentry is installed',
      busy: true,
    },
  },
  {
    label: 'Read-only status',
    action: {
      label: 'Active',
      accessibleName: 'Status for Sentry: Active',
      glyph: 'active',
      reason: 'Follows the plugin it came with.',
    },
  },
];

const LAB_STATUS_ITEMS = [
  { id: 'details', label: 'Open details', onSelect: noop },
  { id: 'remove', label: 'Remove…', destructive: true, onSelect: noop },
] as const;

function labStatus(
  status: 'active' | 'available' | 'disabled',
  name: string,
): CustomizeRowSplitAction {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return {
    label,
    accessibleName: `Status for ${name}: ${label}`,
    glyph: status,
    statuses: [{ current: status, onChange: noop }],
  };
}

function labEntry(
  id: string,
  fields: Partial<UnifiedPluginEntry> & Pick<UnifiedPluginEntry, 'name'>,
): UnifiedPluginEntry {
  return {
    id: `lab-tile-${id}`,
    kind: 'plugin',
    origin: 'marketplace',
    description: '',
    categories: [],
    typeLabel: 'Plugin',
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    harnessCompatibility: LAB_ALL_HARNESSES,
    state: 'installed',
    recommended: false,
    ref: { type: 'marketplace-plugin', marketplaceId: 'lab', pluginName: id },
    ...fields,
  };
}

/** Transparent artwork, as a catalog serves it: dark ink and light ink. */
const LAB_TRANSPARENT_DARK_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHBhdGggZD0iTTIwIDQ0YzAtNiA1LTkgMTMtOWg3di0yYzAtNC0yLTYtNy02LTQgMC03IDEtMTAgM2wtMi01YzQtMiA4LTMgMTMtMyA4IDAgMTIgNCAxMiAxMXYxOWgtNnYtM2MtMiAyLTUgNC0xMCA0LTYgMC0xMC00LTEwLTl6bTIwLTJ2LTNoLTZjLTUgMC04IDEtOCA0IDAgMiAyIDQgNSA0IDUgMCA5LTIgOS01eiIgZmlsbD0iIzExMTExMSIvPjxwYXRoIGQ9Ik0xNCA1MGMxMCA2IDI2IDcgMzggMSIgc3Ryb2tlPSIjMTExMTExIiBzdHJva2Utd2lkdGg9IjMiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==';
const LAB_TRANSPARENT_LIGHT_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMTQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTQyIDQybDEwIDEwIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+';

/**
 * Opaque artwork that fills its own square: a UD plugin's purple tile and a
 * photo avatar. Neither takes the light plate (it would show as a ring).
 */
const LAB_OPAQUE_UD_LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#6B3FD4"/><text x="32" y="41" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#FFFFFF">UD</text></svg>',
)}`;
const LAB_PHOTO_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8FB3C9"/><stop offset="1" stop-color="#3E5F73"/></linearGradient></defs><rect width="64" height="64" fill="url(#b)"/><circle cx="32" cy="25" r="11" fill="#E9C7A8"/><path d="M10 64c2-14 11-21 22-21s20 7 22 21Z" fill="#2F3B45"/></svg>',
)}`;

/** Harness rows as a host computes them, for the harness chip cases. */
function labHarnessRows(
  rows: Readonly<
    Record<string, 'Installed' | 'Not installed' | 'Not supported'>
  >,
): UnifiedEntryHarnessRow[] {
  const names: Readonly<Record<string, string>> = {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
  };
  return Object.entries(rows).map(([id, installation]) => ({
    id,
    name: names[id] ?? id,
    installation,
  }));
}

/** Slack's Claude copy, which serves Claude for the Codex copy's tile. */
const LAB_SLACK_CLAUDE_COPY: UnifiedEntryAlternative = {
  entryId: 'lab-tile-slack-claude',
  label: 'Claude official',
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'claude-plugins-official',
    pluginName: 'slack',
  },
  copyName: 'Slack (slackapi)',
  copyBase: { name: 'Slack', publisher: 'slackapi' },
  harnessRows: labHarnessRows({
    claude: 'Installed',
    codex: 'Not supported',
    cursor: 'Installed',
    opencode: 'Installed',
  }),
};

/** The label colors before Sergii's "only the icon is colored" rule. */
const LAB_COLORED_STATE_TEXT: Readonly<Record<ItemStateTone, string>> = {
  active: 'fg-success-strong',
  available: 'fg-primary',
  disabled: 'fg-tertiary',
  unavailable: 'fg-tertiary',
  add: 'fg-primary',
  run: 'fg-primary',
  installed: 'fg-secondary',
  'sign-in': 'fg-warning',
  failed: 'fg-destructive',
  update: 'fg-secondary',
};

/** The shared logo with the lab's data URIs read as remote logos. */
function LabRemoteLogo(props: McpServerLogoProps): JSX.Element {
  return <McpServerLogo {...props} useRemoteLogo={(url) => url} />;
}

const LAB_MCP = {
  kind: 'app',
  origin: 'curated',
  typeLabel: 'MCP server',
  components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
} as const;

/**
 * Sergii's Customize QA (item 7): every tile case on one fixed layout. Line
 * 1 is the name and type; line 2 the status or publisher (text only), the
 * version for plugins only, then the harness logos; line 3 exists only for
 * an update.
 */
const LAB_TILE_CASES: readonly {
  readonly label: string;
  readonly entry: UnifiedPluginEntry;
  readonly action: CustomizeRowSplitAction;
  readonly dimmed?: boolean;
  readonly signIn?: boolean;
  readonly update?: boolean;
  /** A logo host other than the shared default, for remote-logo cases. */
  readonly logo?: ComponentType<McpServerLogoProps>;
  /** The row's health line, as the host renders it. */
  readonly health?: ReactNode;
}[] = [
  {
    label: 'MCP connected (publisher, no health)',
    entry: labEntry('mcp-connected', {
      ...LAB_MCP,
      name: 'Sentry',
      authorName: 'Sentry',
      connection: { status: 'connected' },
      ref: { type: 'curated-mcp', key: 'sentry' },
    }),
    action: labStatus('active', 'Sentry'),
  },
  {
    label: 'MCP couldn’t connect',
    entry: labEntry('mcp-unreachable', {
      ...LAB_MCP,
      name: 'Linear',
      authorName: 'Linear',
      connection: { status: 'unreachable' },
      ref: { type: 'curated-mcp', key: 'linear' },
    }),
    action: labStatus('active', 'Linear'),
  },
  {
    label: 'MCP sign in needed',
    entry: labEntry('mcp-sign-in', {
      ...LAB_MCP,
      name: 'Notion',
      authorName: 'Notion',
      connection: { status: 'auth_required', signIn: 'connect' },
      pendingSignIns: 1,
      ref: { type: 'curated-mcp', key: 'notion' },
    }),
    action: labStatus('available', 'Notion'),
    signIn: true,
  },
  {
    label: 'MCP Test connection: checking',
    entry: labEntry('mcp-test-checking', {
      ...LAB_MCP,
      name: 'Sentry',
      authorName: 'Sentry',
      connection: { status: 'connected' },
      ref: { type: 'curated-mcp', key: 'sentry' },
    }),
    action: labStatus('active', 'Sentry'),
    health: (
      <McpRowCheckFeedback kind="checking" testId="lab-tile-test-checking" />
    ),
  },
  {
    label: 'MCP Test connection: connected (3 s, then publisher)',
    entry: labEntry('mcp-test-connected', {
      ...LAB_MCP,
      name: 'Sentry',
      authorName: 'Sentry',
      connection: { status: 'connected' },
      ref: { type: 'curated-mcp', key: 'sentry' },
    }),
    action: labStatus('active', 'Sentry'),
    health: (
      <McpRowCheckFeedback kind="connected" testId="lab-tile-test-connected" />
    ),
  },
  {
    label: 'MCP Test connection: failed (stays)',
    entry: labEntry('mcp-test-failed', {
      ...LAB_MCP,
      name: 'Linear',
      authorName: 'Linear',
      connection: { status: 'unreachable' },
      ref: { type: 'curated-mcp', key: 'linear' },
    }),
    action: labStatus('active', 'Linear'),
  },
  {
    label: 'MCP disabled',
    entry: labEntry('mcp-disabled', {
      ...LAB_MCP,
      name: 'Slack',
      authorName: 'Slack',
      connection: { status: 'connected', disabled: true },
      ref: { type: 'curated-mcp', key: 'slack' },
    }),
    action: labStatus('disabled', 'Slack'),
    dimmed: true,
  },
  {
    label: 'Plugin',
    entry: labEntry('plugin', {
      name: 'Azure DevOps',
      authorName: 'Microsoft',
      version: '2.4.1',
      components: { skills: 6, mcpServers: 1, commands: 0, agents: 0 },
    }),
    action: labStatus('active', 'Azure DevOps'),
  },
  {
    label: 'Curated plugin (Unstoppable Code logo)',
    entry: labEntry('curated', {
      origin: 'curated',
      name: 'Deep research',
      authorName: 'Unstoppable Domains',
      version: '1.0.0',
      ref: { type: 'curated-plugin', key: 'deep-research' },
    }),
    action: labStatus('available', 'Deep research'),
  },
  {
    label: 'Skill',
    entry: labEntry('skill', {
      kind: 'skill',
      origin: 'installed-standalone',
      typeLabel: 'Skill',
      name: 'Review changes',
      authorName: 'Anthropic',
    }),
    action: labStatus('available', 'Review changes'),
  },
  {
    label: 'Skill inside a plugin',
    entry: labEntry('bundled-skill', {
      kind: 'skill',
      typeLabel: 'Skill',
      name: 'Query insights',
      bundledBy: { entryId: 'lab-posthog', name: 'PostHog' },
    }),
    action: {
      ...labStatus('active', 'Query insights'),
      statuses: [],
      reason: 'Follows the PostHog plugin.',
    },
  },
  {
    label: 'Workflow',
    entry: labEntry('workflow', {
      kind: 'pipeline',
      origin: 'installed-standalone',
      typeLabel: 'Workflow',
      name: 'Nightly triage',
      authorName: 'You',
    }),
    action: {
      label: 'Run',
      tone: 'run',
      accessibleName: 'Run Nightly triage',
      onPrimary: noop,
    },
  },
  {
    label: 'Built-in workflow (product mark)',
    entry: labEntry('builtin-workflow', {
      kind: 'pipeline',
      origin: 'built-in',
      typeLabel: 'Workflow',
      name: 'Refine Plan',
      brandMark: true,
      ref: { type: 'pipeline', pipelineId: 'refine-plan', source: 'bundled' },
    }),
    action: {
      label: 'Run',
      tone: 'run',
      accessibleName: 'Run Refine Plan',
      onPrimary: noop,
    },
  },
  {
    label: 'Collection',
    entry: labEntry('collection', {
      kind: 'collection',
      typeLabel: 'Collection',
      name: 'Design team kit',
      authorName: 'Unstoppable Domains',
      components: {
        plugins: 3,
        skills: 5,
        mcpServers: 2,
        commands: 0,
        agents: 0,
      },
    }),
    action: labStatus('active', 'Design team kit'),
  },
  {
    label: 'ChatGPT app with a stand-in',
    entry: labEntry('chatgpt-stand-in', {
      name: 'Canva',
      authorName: 'Canva',
      sourceLabel: 'ChatGPT',
      providerSupport: { claude: false, codex: false },
      harnessCompatibility: undefined,
      chatGptAppStandIn: {
        endpoint: 'https://mcp.canva.com/mcp',
        name: 'Canva',
        harnesses: ['claude', 'codex', 'cursor'],
      },
    }),
    action: labStatus('active', 'Canva'),
  },
  {
    label: 'ChatGPT app only',
    entry: labEntry('chatgpt-only', {
      name: 'Instacart',
      authorName: 'Instacart',
      sourceLabel: 'ChatGPT',
      providerSupport: { claude: false, codex: false },
      harnessCompatibility: undefined,
    }),
    action: labStatus('available', 'Instacart'),
  },
  {
    label: 'Update available',
    entry: labEntry('update', {
      name: 'Figma',
      authorName: 'Figma',
      version: '1.3.0',
      updateAvailable: true,
    }),
    action: labStatus('active', 'Figma'),
    update: true,
  },
  {
    label: 'Shared with me',
    entry: labEntry('shared', {
      kind: 'skill',
      origin: 'shared',
      typeLabel: 'Skill',
      name: 'Release notes',
      sharedSource: { remoteId: 'lab', sharedBy: 'Alex Rivera' },
    }),
    action: labStatus('available', 'Release notes'),
  },
  {
    label: 'Transparent dark logo (light plate)',
    entry: labEntry('transparent-dark', {
      ...LAB_MCP,
      name: 'Amazon Selling Partner',
      authorName: 'Amazon',
      connection: { status: 'connected' },
      logoUrl: LAB_TRANSPARENT_DARK_LOGO,
    }),
    action: labStatus('active', 'Amazon Selling Partner'),
    logo: LabRemoteLogo,
  },
  {
    label: 'Harness chips: merged item (Claude via another copy)',
    entry: labEntry('harness-merged', {
      name: 'Slack',
      authorName: 'Slack',
      harnessRows: labHarnessRows({
        claude: 'Not supported',
        codex: 'Installed',
        cursor: 'Installed',
        opencode: 'Installed',
      }),
      alsoAvailableFrom: [LAB_SLACK_CLAUDE_COPY],
    }),
    action: labStatus('active', 'Slack'),
  },
  {
    label: 'Harness chips: single copy',
    entry: labEntry('harness-single', {
      name: 'Linear',
      authorName: 'Linear',
      harnessRows: labHarnessRows({
        claude: 'Installed',
        codex: 'Not installed',
        cursor: 'Installed',
        opencode: 'Installed',
      }),
    }),
    action: labStatus('active', 'Linear'),
  },
  {
    label: 'Harness chips: an unsupported harness (muted)',
    entry: labEntry('harness-unsupported', {
      name: 'Figma',
      authorName: 'Figma',
      harnessRows: labHarnessRows({
        claude: 'Installed',
        codex: 'Installed',
        cursor: 'Not supported',
        opencode: 'Not supported',
      }),
    }),
    action: labStatus('available', 'Figma'),
  },
  {
    label: 'Opaque UD logo (full-bleed, no plate)',
    entry: labEntry('opaque-ud', {
      name: 'Ud Alert Triage',
      authorName: 'Unstoppable Domains',
      logoUrl: LAB_OPAQUE_UD_LOGO,
    }),
    action: labStatus('active', 'Ud Alert Triage'),
    logo: LabRemoteLogo,
  },
  {
    label: 'Photo avatar (full-bleed, no plate)',
    entry: labEntry('photo-avatar', {
      name: 'Superpowers',
      authorName: 'Jesse Vincent',
      logoUrl: LAB_PHOTO_AVATAR,
    }),
    action: labStatus('available', 'Superpowers'),
    logo: LabRemoteLogo,
  },
  {
    label: 'Transparent light logo (light plate)',
    entry: labEntry('transparent-light', {
      name: 'Lens',
      authorName: 'Lens Labs',
      logoUrl: LAB_TRANSPARENT_LIGHT_LOGO,
    }),
    action: labStatus('available', 'Lens'),
    logo: LabRemoteLogo,
  },
  {
    label: 'Not installed (Browse)',
    entry: labEntry('browse', {
      name: 'Stripe',
      authorName: 'Stripe',
      state: 'available',
    }),
    action: {
      label: 'Add',
      tone: 'add',
      accessibleName: 'Add Stripe',
      onPrimary: noop,
    },
  },
];

/** Every Customize tile case side by side, at two widths, light or dark. */
export function CustomizeTileBenchmarkSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Customize tile benchmark">
        <SpecimenGrid min={460}>
          {LAB_TILE_CASES.map(
            ({
              label,
              entry,
              action,
              dimmed,
              signIn,
              update,
              logo,
              health,
            }) => (
              <SpecimenCell key={entry.id} label={label} wide>
                <div className="max-w-full" style={{ width: 560 }}>
                  <ul>
                    <CustomizeInstalledRow
                      entry={entry}
                      sectionId="benchmark"
                      onSelect={noop}
                      showEntryType
                      discovery
                      dimmed={dimmed}
                      splitAction={action}
                      menuItems={LAB_STATUS_ITEMS}
                      {...(logo ? { McpServerLogoComponent: logo } : {})}
                      health={health}
                      {...(signIn
                        ? {
                            signIn: {
                              accessibleName: `Sign in to ${entry.name}`,
                              run: noop,
                            },
                          }
                        : {})}
                      {...(update ? { update: { run: noop } } : {})}
                    />
                  </ul>
                </div>
              </SpecimenCell>
            ),
          )}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Curated plugin logos (row size and large)">
        <SpecimenGrid min={140}>
          {Object.entries(CURATED_PLUGIN_LOGOS).map(([key, src]) => (
            <SpecimenCell key={key} label={key}>
              <span className="flex items-center gap-3">
                {[28, 56].map((size) => (
                  <McpServerLogo
                    key={size}
                    bundledLogo={src}
                    size={size}
                    name={key}
                    shape="tile"
                  />
                ))}
              </span>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const LONG_NAME =
  'A custom skill with a name long enough that it cannot fit the page header';

const TRAIL: readonly CustomizeBreadcrumbItem[] = [
  { key: 'customize', label: 'Customize', onSelect: noop },
  { key: 'installed', label: 'Installed', onSelect: noop },
  { key: 'skill', label: 'Review changes' },
];

/**
 * The Customize page parts and compact MCP rows: the location trail, the
 * capability-gated Installed state and a row's secondary-action menu.
 * Hover and press are real pointer states here, not forced ones; point at a
 * crumb or open a menu to see them.
 */
export function CustomizePartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Item state icons (shared ItemStateMark)">
        <SpecimenGrid min={140}>
          {(
            [
              'active',
              'available',
              'disabled',
              'unavailable',
              'add',
              'run',
              'installed',
              'sign-in',
              'failed',
              'update',
            ] as const
          ).map((tone) => (
            <SpecimenCell key={tone} label={tone}>
              <span className="flex flex-col gap-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="fg-tertiary">Before</span>
                  <ItemStateMark tone={tone} />
                  <span className={LAB_COLORED_STATE_TEXT[tone]}>{tone}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="fg-tertiary">After</span>
                  <ItemStateMark tone={tone} />
                  <span className={ITEM_STATE_LABEL_CLASS[tone]}>{tone}</span>
                </span>
              </span>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Status text: colored icon, plain text (before / after)">
        <SpecimenGrid min={180}>
          {(
            [
              ['success', 'Installed'],
              ['success', 'Connected'],
              ['warning', 'Sign in required'],
              ['danger', 'Couldn’t connect'],
              ['neutral', 'Not checked'],
            ] as const
          ).map(([tone, label]) => (
            <SpecimenCell key={label} label={label}>
              <span className="flex flex-col gap-1 text-xs">
                <span className={badgeClassName(tone)}>{label}</span>
                <StatusToneText tone={tone}>{label}</StatusToneText>
              </span>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="HelpHint (filter section labels)">
        <SpecimenGrid min={220}>
          <SpecimenCell label="After a section label (hover or Tab to it)">
            <span className="flex items-center gap-1 text-xs fg-secondary">
              Works with
              <HelpHint
                label="Works with"
                help="Show only items that work with the selected harnesses."
              />
            </span>
          </SpecimenCell>
          <SpecimenCell label="Long help text">
            <span className="flex items-center gap-1 text-xs fg-secondary">
              Source
              <HelpHint
                label="Source"
                help="Who provides the workflow: Custom (made on this computer), Project (checked into this repo), Bundled (ships with the app), Shared (shared with you by a teammate or your organization), Curated (from the curated catalog)."
              />
            </span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="New-harness catch-up offer (New Customize)">
        <SpecimenGrid min={420}>
          {LAB_CATCH_UP_STATES.map(({ label, state }) => (
            <SpecimenCell key={label} label={label} wide>
              <div className="max-w-full" style={{ width: 560 }}>
                <HarnessCatchUpNotice
                  state={state}
                  onAdd={noop}
                  onDismiss={noop}
                />
              </div>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Compact MCP rows">
        <SpecimenGrid min={320}>
          {(
            ['desktop', 'account', 'both'] satisfies UnifiedEntryPlacement[]
          ).flatMap((placement) =>
            [320, 420].map((width) => {
              const entry: UnifiedPluginEntry = {
                id: `lab-mcp-${placement}-${width}`,
                kind: 'app',
                origin: 'installed-standalone',
                name: 'An MCP server with a long name that truncates before its controls',
                description: '',
                categories: [],
                typeLabel: 'MCP server',
                components: {
                  skills: 0,
                  mcpServers: 1,
                  commands: 0,
                  agents: 0,
                },
                providerSupport: { claude: true, codex: true },
                state: 'installed',
                recommended: false,
                ref: {
                  type: 'local-mcp',
                  serverId: 'lab-mcp',
                  configId: 'default',
                },
                placement,
              };
              const checking = placement === 'both';
              const model = mcpRowHealthModel({ status: 'connected' });
              return (
                <SpecimenCell
                  key={entry.id}
                  label={`${placement}, ${width}px; hover health for check time`}
                  wide
                >
                  <div className="max-w-full" style={{ width }}>
                    <CustomizeInstalledRow
                      entry={entry}
                      sectionId="installed"
                      onSelect={noop}
                      placement={placement}
                      health={
                        <McpRowHealth
                          name={entry.name}
                          model={
                            checking
                              ? { ...model, text: 'Checking…', tone: 'neutral' }
                              : model
                          }
                          checkedLabel="Checked 7m ago"
                          testId={`lab-row-health-${entry.id}`}
                        />
                      }
                      status={
                        <span className="flex min-w-28 shrink-0 justify-start">
                          <InstalledItemStatusPicker
                            itemName={entry.name}
                            status="active"
                            onChange={noop}
                          />
                        </span>
                      }
                      menuItems={[
                        {
                          id: 'test',
                          label: 'Test connection',
                          onSelect: noop,
                          disabled: checking,
                        },
                      ]}
                    />
                  </div>
                </SpecimenCell>
              );
            }),
          )}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Installed row Update badge (New Customize)">
        <SpecimenGrid min={320}>
          {[
            { label: 'Update available', name: 'Review changes' },
            { label: 'Long name truncates before the badge', name: LONG_NAME },
          ].map(({ label, name }) => {
            const entry: UnifiedPluginEntry = {
              id: `lab-update-${name.length}`,
              kind: 'skill',
              origin: 'installed-standalone',
              name,
              description: '',
              categories: [],
              typeLabel: 'Skill',
              components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
              providerSupport: { claude: true, codex: true },
              state: 'installed',
              updateAvailable: true,
              recommended: false,
              ref: {
                type: 'skill',
                skillName: 'review-changes',
                sourceId: 'lab',
              },
            };
            return (
              <SpecimenCell key={entry.id} label={label} wide>
                <div className="max-w-full" style={{ width: 420 }}>
                  <CustomizeInstalledRow
                    entry={entry}
                    sectionId="installed"
                    onSelect={noop}
                    showEntryType
                    updateBadge
                  />
                </div>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Plugin row skill match (New Customize search)">
        <SpecimenGrid min={320}>
          {[
            {
              label: 'Three matches, more skills',
              names: [
                'Assessing Heatmaps',
                'Building a Dashboard',
                'Querying PostHog Data',
              ],
              moreCount: 181,
            },
            {
              label: 'One match, one more',
              names: ['Session Replay'],
              moreCount: 1,
            },
            {
              label: 'Long skill name wraps',
              names: [LONG_NAME],
              moreCount: 0,
            },
          ].map(({ label, names, moreCount }) => {
            const entry: UnifiedPluginEntry = {
              id: `lab-skill-match-${label.length}`,
              kind: 'plugin',
              origin: 'marketplace',
              name: 'PostHog',
              description: '',
              categories: [],
              typeLabel: 'Plugin',
              components: {
                skills: names.length + moreCount,
                mcpServers: 1,
                commands: 0,
                agents: 0,
              },
              providerSupport: { claude: true, codex: true },
              state: 'installed',
              recommended: false,
              ref: {
                type: 'marketplace-plugin',
                marketplaceId: 'lab',
                pluginName: 'posthog',
              },
            };
            return (
              <SpecimenCell key={entry.id} label={label} wide>
                <div className="max-w-full" style={{ width: 420 }}>
                  <CustomizeInstalledRow
                    entry={entry}
                    sectionId="installed"
                    onSelect={noop}
                    showEntryType
                    skillMatch={{ names, moreCount }}
                  />
                </div>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Integration row installed line (New Customize)">
        <SpecimenGrid min={320}>
          {(
            [
              {
                label: 'One harness, two more copies',
                harness: 'codex',
                more: 2,
              },
              { label: 'One copy only', harness: 'claude', more: 0 },
              { label: 'MCP server, one more', harness: undefined, more: 1 },
            ] as const
          ).map(({ label, harness, more }) => {
            const entry: UnifiedPluginEntry = {
              id: `lab-integration-copies-${label.length}`,
              kind: harness === undefined ? 'app' : 'plugin',
              origin: 'marketplace',
              name: 'PostHog',
              description: '',
              categories: [],
              typeLabel: harness === undefined ? 'MCP server' : 'Plugin',
              components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
              providerSupport: { claude: true, codex: true },
              state: 'installed',
              recommended: false,
              integrationCopies: {
                memberIds: ['a', 'b', 'c'].slice(0, more + 1),
                installed: {
                  ...(harness !== undefined ? { harness } : {}),
                  moreCount: more,
                },
              },
              ref: {
                type: 'marketplace-plugin',
                marketplaceId: 'lab',
                pluginName: 'posthog',
              },
            };
            return (
              <SpecimenCell key={entry.id} label={label} wide>
                <div className="max-w-full" style={{ width: 420 }}>
                  <CustomizeInstalledRow
                    entry={entry}
                    sectionId="installed"
                    onSelect={noop}
                    showEntryType
                  />
                </div>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="One Add for every harness (CAN-6815)">
        <SpecimenGrid min={420}>
          {(
            [
              {
                label: 'Installed for every set-up harness',
                failed: false,
              },
              { label: 'One harness failed', failed: true },
            ] as const
          ).map(({ label, failed }) => {
            const entry: UnifiedPluginEntry = {
              id: `lab-harness-installs-${failed ? 'failed' : 'ok'}`,
              kind: 'app',
              origin: 'curated',
              name: 'Linear',
              description: '',
              categories: [],
              typeLabel: 'MCP server',
              components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
              providerSupport: { claude: true, codex: true },
              state: 'installed',
              recommended: false,
              harnessInstalls: {
                installed: failed
                  ? ['claude', 'codex', 'copilot', 'opencode']
                  : ['claude', 'codex', 'cursor', 'copilot', 'opencode'],
                failed: failed
                  ? [
                      {
                        harness: 'cursor',
                        reason:
                          'MCP server "Linear" needs HTTP MCP support that Cursor did not advertise and was skipped.',
                        serverId: 'lab',
                      },
                    ]
                  : [],
              },
              integrationCopies: {
                memberIds: ['lab'],
                installed: { harness: 'claude', moreCount: failed ? 3 : 4 },
              },
              ref: { type: 'curated-mcp', key: 'linear' },
            };
            return (
              <SpecimenCell key={entry.id} label={label} wide>
                <div className="max-w-full" style={{ width: 420 }}>
                  <CustomizeInstalledRow
                    entry={entry}
                    sectionId="installed"
                    onSelect={noop}
                    showEntryType
                    discovery
                    onRetryHarnessInstall={noop}
                  />
                </div>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Row action and Works with (CAN-6813)">
        <SpecimenGrid min={420}>
          {LAB_ROW_ACTIONS.map(({ label, action, compatibility }) => {
            const entry: UnifiedPluginEntry = {
              id: `lab-row-action-${label.length}`,
              kind: 'plugin',
              origin: 'marketplace',
              name: 'Sentry',
              description: '',
              authorName: 'Sentry',
              categories: [],
              typeLabel: 'Plugin',
              components: { skills: 9, mcpServers: 0, commands: 0, agents: 0 },
              providerSupport: { claude: true, codex: false },
              ...(compatibility ? { harnessCompatibility: compatibility } : {}),
              state: action.label === 'Add' ? 'available' : 'installed',
              recommended: false,
              ref: {
                type: 'marketplace-plugin',
                marketplaceId: 'lab',
                pluginName: 'sentry',
              },
            };
            return (
              <SpecimenCell key={entry.id} label={label} wide>
                <CustomizeRowSplitButton
                  entryName={entry.name}
                  idPrefix={`standalone-${entry.id}`}
                  action={action}
                  items={[
                    { id: 'details', label: 'Open details', onSelect: noop },
                    {
                      id: 'remove',
                      label: 'Remove…',
                      destructive: true,
                      onSelect: noop,
                    },
                  ]}
                />
                <CustomizeWorksWithChips entry={entry} />
                <div className="max-w-full" style={{ width: 520 }}>
                  <CustomizeInstalledRow
                    entry={entry}
                    sectionId="lab"
                    onSelect={noop}
                    showEntryType
                    discovery
                    splitAction={action}
                    menuItems={[
                      { id: 'details', label: 'Open details', onSelect: noop },
                      {
                        id: 'remove',
                        label: 'Remove…',
                        destructive: true,
                        onSelect: noop,
                      },
                    ]}
                  />
                </div>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="McpRowHealth">
        <SpecimenGrid min={240}>
          <SpecimenCell label="Plugin MCP: signed in, no connection check yet">
            <McpRowHealth
              name="Plugin MCP"
              model={{ text: 'Connected', tone: 'positive', action: null }}
              testId="lab-plugin-mcp-signed-in"
            />
          </SpecimenCell>
          {[
            mcpRowHealthModel({ status: 'connected' }),
            mcpRowHealthModel({ status: 'auth_required' }),
            mcpRowHealthModel({ status: 'unknown', signIn: 'reconnect' }),
            mcpRowHealthModel({ status: 'unreachable' }),
            mcpRowHealthModel({ status: 'unknown' }),
            mcpRowHealthModel({ status: 'unknown', disabled: true }),
          ].map((model) => (
            <SpecimenCell key={model.text} label={model.text}>
              <McpRowHealth
                name="Example MCP server"
                model={model}
                testId={`lab-health-${model.text}`}
              />
            </SpecimenCell>
          ))}
          {[false, true].map((busy) => (
            <SpecimenCell
              key={String(busy)}
              label={busy ? 'Sign-in in progress' : 'Sign-in needed'}
              wide
            >
              <div className="flex min-w-0 items-center gap-2">
                <McpRowHealth
                  name="Example MCP server"
                  model={
                    busy
                      ? {
                          ...mcpRowHealthModel({ status: 'auth_required' }),
                          text: 'Checking…',
                          tone: 'neutral',
                        }
                      : mcpRowHealthModel({ status: 'auth_required' })
                  }
                  testId={`lab-health-test-${busy}`}
                  checkedLabel="Checked just now"
                />
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={busy}
                  onClick={noop}
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="CustomizeBreadcrumbs">
        <SpecimenCell label="Navigable trail ending at the current page" wide>
          <CustomizeBreadcrumbs items={TRAIL} />
        </SpecimenCell>
        <SpecimenCell label="Only the current page" wide>
          <CustomizeBreadcrumbs
            items={[{ key: 'customize', label: 'Customize' }]}
          />
        </SpecimenCell>
        <SpecimenCell
          label="A crumb with no destination reads as plain text"
          wide
        >
          <CustomizeBreadcrumbs
            items={[
              { key: 'customize', label: 'Customize', onSelect: noop },
              { key: 'shared', label: 'Shared by me' },
              { key: 'skill', label: 'Review changes' },
            ]}
          />
        </SpecimenCell>
        <SpecimenCell
          label="Web: href crumbs go through the host's router link"
          wide
        >
          <CustomizeBreadcrumbs
            items={[
              { key: 'customize', label: 'Customize', href: '/customize' },
              {
                key: 'installed',
                label: 'Installed',
                href: '/customize/installed',
              },
              { key: 'skill', label: 'Review changes' },
            ]}
            renderLink={({ href, shrink, children }) => (
              <TextLink
                href={href}
                variant="breadcrumb"
                shrink={shrink}
                onClick={(event) => event.preventDefault()}
              >
                {children}
              </TextLink>
            )}
          />
        </SpecimenCell>
        <SpecimenCell
          label="Long user-authored label: shrinks, truncates, masked in replay"
          wide
        >
          <div className="w-80 max-w-full">
            <CustomizeBreadcrumbs
              items={[
                { key: 'customize', label: 'Customize', onSelect: noop },
                {
                  key: 'skill',
                  label: LONG_NAME,
                  title: LONG_NAME,
                  privateLabel: true,
                  shrink: true,
                },
              ]}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long shrinking crumb that is still navigable" wide>
          <div className="w-80 max-w-full">
            <CustomizeBreadcrumbs
              items={[
                {
                  key: 'collection',
                  label: LONG_NAME,
                  title: LONG_NAME,
                  shrink: true,
                  onSelect: noop,
                },
                { key: 'skill', label: 'Review changes' },
              ]}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="CustomizeInstalledUnavailable">
        <SpecimenCell label="With the host's pairing control" wide>
          <div className="w-full">
            <CustomizeInstalledUnavailable
              title="Installed items are on your desktop"
              body="Pair this browser with Acme on your computer to see what is installed there."
              action={<Button variant="primary">Pair a computer</Button>}
              dataTestId="lab-installed-unavailable-action"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="No action: neither pairing nor sign-in applies"
          wide
        >
          <div className="w-full">
            <CustomizeInstalledUnavailable
              title="Installed items can't be read here yet"
              body="This host does not read the installed inventory."
              dataTestId="lab-installed-unavailable-plain"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long copy wraps; the action drops below" wide>
          <div className="w-full max-w-md">
            <CustomizeInstalledUnavailable
              title="Installed items are on your desktop and need a paired computer to load"
              body="Pair this browser with Acme on your computer, keep that computer awake and online, and reload this page to see the skills, plugins and apps installed there."
              action={<Button>Pair a computer</Button>}
              dataTestId="lab-installed-unavailable-long"
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="CustomizeRowMenu (click the ⋯ to open)">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Actions, then a destructive item after a divider">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-default"
              testId="lab-row-menu-default"
              items={[
                { id: 'edit', label: 'Edit', onSelect: noop },
                { id: 'share', label: 'Share', onSelect: noop },
                {
                  id: 'remove',
                  label: 'Delete',
                  onSelect: noop,
                  destructive: true,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="A disabled item explains why">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-disabled"
              testId="lab-row-menu-disabled"
              items={[
                {
                  id: 'edit',
                  label: 'Edit',
                  onSelect: noop,
                  disabled: true,
                  disabledReason: 'Edit this skill in the desktop app.',
                },
                { id: 'share', label: 'Share', onSelect: noop },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="Destructive only: no divider">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-destructive"
              testId="lab-row-menu-destructive"
              items={[
                {
                  id: 'remove',
                  label: 'Uninstall',
                  onSelect: noop,
                  destructive: true,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="Long item label">
            <CustomizeRowMenu
              entryName={LONG_NAME}
              idPrefix="lab-menu-long"
              testId="lab-row-menu-long"
              items={[
                {
                  id: 'edit',
                  label: 'Open the original in the source repository',
                  onSelect: noop,
                },
              ]}
            />
          </SpecimenCell>
          <SpecimenCell label="No actions: renders nothing">
            <CustomizeRowMenu
              entryName="Review changes"
              idPrefix="lab-menu-empty"
              testId="lab-row-menu-empty"
              items={[]}
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
