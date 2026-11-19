import type { JSX } from 'react';
import {
  DrawerInspectorAction,
  DrawerWatcherControl,
  EntrySourceLabel,
  EntrySurfaceIcon,
  type DrawerWatcherPreviewRow,
} from '@canopy/ui-shared/components';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const WATCHERS: readonly DrawerWatcherPreviewRow[] = [
  {
    id: 'w1',
    name: 'Wait for CI',
    details: ['Checks every 5 minutes', 'Until the pull request is green'],
  },
  { id: 'w2', name: 'Watch the branch', details: ['Pushes to main'] },
];

function pluginEntry(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id: 'plugin:lab',
    kind: 'plugin',
    origin: 'marketplace',
    name: 'Slack',
    description: 'Read and send Slack messages.',
    sourceLabel: 'Claude · slackapi',
    categories: [],
    components: { skills: 1, mcpServers: 1, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: false },
    state: 'available',
    recommended: false,
    ref: {
      type: 'marketplace-plugin',
      marketplaceId: 'lab',
      pluginName: 'slack',
    },
    ...overrides,
  };
}

/**
 * The activity drawer's footer actions and the small Customize entry
 * metadata: where an entry comes from and where it runs. Hover the watcher
 * actions for the preview, and the surface icons for their tooltips.
 */
export function DrawerAndEntriesSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="DrawerInspectorAction">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Trailing (default): lines up with the time column">
            <DrawerInspectorAction>Manage</DrawerInspectorAction>
          </SpecimenCell>
          <SpecimenCell label='alignment="leading"'>
            <DrawerInspectorAction alignment="leading">
              Manage
            </DrawerInspectorAction>
          </SpecimenCell>
          <SpecimenCell label="Disabled">
            <DrawerInspectorAction disabled>Manage</DrawerInspectorAction>
          </SpecimenCell>
          <SpecimenCell label="Long label">
            <DrawerInspectorAction>
              Manage every watcher in this chat
            </DrawerInspectorAction>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="DrawerWatcherControl" hint="Hover for the preview">
        <SpecimenGrid min={220}>
          <SpecimenCell label="Labelled action with a preview">
            <DrawerWatcherControl
              count={2}
              label="Manage watchers"
              rows={WATCHERS}
              ariaLabel="Manage 2 watchers"
              dataTestId="lab-watchers-labelled"
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Quiet “Watchers N” action">
            <DrawerWatcherControl
              count={2}
              rows={WATCHERS}
              ariaLabel="Show 2 watchers"
              dataTestId="lab-watchers-quiet"
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="More watchers than the preview lists (+5 more)">
            <DrawerWatcherControl
              count={7}
              label="Manage watchers"
              rows={WATCHERS}
              heading="Running now"
              ariaLabel="Manage 7 watchers"
              dataTestId="lab-watchers-more"
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Long watcher name and details wrap in the preview">
            <DrawerWatcherControl
              count={1}
              label="Manage watchers"
              rows={[
                {
                  id: 'w1',
                  name: 'Wait for the deployment of the release branch to finish and report back',
                  details: [
                    'Checks every 5 minutes until the deploy succeeds or fails, then posts the result to the channel',
                  ],
                },
              ]}
              ariaLabel="Manage 1 watcher"
              dataTestId="lab-watchers-long"
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="No watchers: renders nothing">
            <DrawerWatcherControl
              count={0}
              rows={[]}
              ariaLabel="Manage watchers"
              onClick={noop}
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="EntrySourceLabel">
        <SpecimenGrid min={220}>
          <SpecimenCell label="Marketplace plugin with a source">
            <EntrySourceLabel entry={pluginEntry()} testId="lab-entry-source" />
          </SpecimenCell>
          <SpecimenCell label="Shrinkable: truncates in a one-line row">
            <div className="flex w-40">
              <EntrySourceLabel
                entry={pluginEntry({
                  sourceLabel: 'Claude · a-marketplace-with-a-very-long-name',
                })}
                testId="lab-entry-source-shrinkable"
                shrinkable
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Curated plugin: renders nothing">
            <EntrySourceLabel
              entry={pluginEntry({ origin: 'curated' })}
              testId="lab-entry-source-curated"
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
          <SpecimenCell label="MCP app: renders nothing">
            <EntrySourceLabel
              entry={pluginEntry({ kind: 'app' })}
              testId="lab-entry-source-app"
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="EntrySurfaceIcon" hint="Hover for the tooltip">
        <SpecimenGrid min={180}>
          <SpecimenCell label="Cloud + desktop">
            <EntrySurfaceIcon
              surface="cloud"
              testId="lab-entry-surface-cloud"
            />
          </SpecimenCell>
          <SpecimenCell label="Desktop only">
            <EntrySurfaceIcon
              surface="desktop"
              testId="lab-entry-surface-desktop"
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
